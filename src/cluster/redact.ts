/**
 * Redaction for `cluster_describe`. See DESIGN.md §20 and §9.2.
 *
 * Pure: an object in, an object out, no IO. That is deliberate, because this module is a
 * security boundary and a boundary that needs a cluster to test is a boundary nobody
 * tests. `redact.test.ts` is adversarial for the same reason.
 *
 * The boundary it is:
 *
 *   Kubernetes RBAC cannot express "read a Secret's keys but not its values". `get` on a
 *   Secret returns the whole object or nothing, so a supervisor that can tell a session
 *   *which keys exist* — which is genuinely the answer to a whole class of alerts, a
 *   missing key or an empty one — necessarily holds a token that can read the values too.
 *   There is no RBAC arrangement that fixes this, so THIS FUNCTION is the entire boundary
 *   between that token and a model's transcript. Nothing else stands between them.
 *
 * The kind allowlist is a literal in this file and not a config field, on purpose:
 * widening what a remediation session may read should require a code review, not an edit
 * to a ConfigMap that nobody diffs.
 */
import { stringify as stringifyYaml } from "yaml";

/**
 * Kinds `cluster_describe` may read, and no others.
 *
 * Chosen as "what explains an alert about a workload": the workload kinds, the two
 * configuration kinds, and the three objects that explain why traffic or storage is not
 * arriving. Absent by intent: `Node`, `Namespace`, and everything cluster-scoped or
 * RBAC-shaped. A node-pressure alert is real, but a session that can enumerate nodes and
 * ServiceAccounts is doing reconnaissance rather than diagnosis, and the way to change
 * that judgement is a pull request against this line.
 */
export const DESCRIBABLE_KINDS = [
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "ConfigMap",
  "Secret",
  "Service",
  "Ingress",
  "PersistentVolumeClaim",
] as const;

export type DescribableKind = (typeof DESCRIBABLE_KINDS)[number];

/**
 * Cap on one serialized object, in bytes.
 *
 * A ~64 KB ceiling is well above any object a diagnosis needs and well below the point
 * where one describe eats the session's context. Truncation is ANNOUNCED in the output
 * rather than silent: a model reading a half object with no marker concludes the field it
 * wanted does not exist, which is a wrong diagnosis rather than a missing one.
 */
export const MAX_OBJECT_BYTES = 64 * 1024;

/** The annotation whose contents are a previous apply's manifest, values included. */
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

export class UnsupportedKindError extends Error {
  constructor(kind: string) {
    super(
      `cluster_describe cannot read kind '${kind}'. Allowed kinds are: ` +
        `${DESCRIBABLE_KINDS.join(", ")}. This list is a code-level decision, so asking ` +
        `again with the same kind will fail the same way`,
    );
    this.name = "UnsupportedKindError";
  }
}

/** Narrow a model-supplied kind, or refuse it with the whole allowlist in the message. */
export const assertKindDescribable = (kind: string): DescribableKind => {
  // Case-SENSITIVE, matching Kubernetes' own kinds: `secret` is not a kind, and accepting
  // it would mean guessing what the caller meant on the one path where guessing is worst.
  const found = DESCRIBABLE_KINDS.find((allowed) => allowed === kind);
  if (found === undefined) throw new UnsupportedKindError(kind);
  return found;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Byte length of a Secret value, from whichever encoding it arrived in.
 *
 * `data` is base64 in the API's own representation and `stringData` is plaintext, so the
 * number an operator recognises — "the token is 40 characters, this one is 41" — needs
 * the decode. `undefined` means "not a string", which the API server never sends; a
 * length invented for it would be a fact this function does not have.
 */
const valueLength = (value: unknown, encoded: boolean): number | undefined => {
  if (typeof value !== "string") return undefined;
  if (!encoded) return Buffer.byteLength(value, "utf8");
  return Buffer.from(value, "base64").byteLength;
};

/** key → `"<n> bytes"`, the only thing a Secret's values are ever rendered as. */
const lengths = (source: unknown, encoded: boolean): Json | undefined => {
  if (!isObject(source)) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    const length = valueLength(value, encoded);
    out[key] = length === undefined ? "<redacted>" : `${length} bytes`;
  }
  return out;
};

/**
 * Strip metadata that is noise at best and a leak at worst.
 *
 * `managedFields` is a per-field apply ledger that is frequently larger than the object it
 * annotates and has never once explained an alert. `last-applied-configuration` is the
 * dangerous one: it holds a verbatim copy of the last applied manifest, so on a Secret
 * that was ever `kubectl apply`d it contains the values this module just removed from
 * `data` — an obvious leak, one annotation away, if it were forgotten.
 */
const cleanMetadata = (metadata: unknown): unknown => {
  if (!isObject(metadata)) return metadata;
  const { managedFields: _dropped, annotations, ...rest } = metadata;
  void _dropped;
  if (!isObject(annotations)) return rest;

  const kept: Json = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (key !== LAST_APPLIED) kept[key] = value;
  }
  return Object.keys(kept).length === 0 ? rest : { ...rest, annotations: kept };
};

/**
 * Redact one object for return to the agent. Never mutates its argument.
 *
 * Copied rather than edited in place because the caller is a client that may well have
 * logged or cached the response, and a redactor that reached back into someone else's
 * object would make the guarantee depend on call order.
 */
export const redactObject = (kind: string, object: Json): Json => {
  const { metadata, data, stringData, ...rest } = object;
  const redacted: Json = { ...rest };
  if (metadata !== undefined) redacted["metadata"] = cleanMetadata(metadata);

  if (kind === "Secret") {
    // The whole boundary, in three lines. The values never leave the supervisor; what
    // leaves is which keys exist and how big each one is, which is what diagnoses a
    // missing or empty key without disclosing a working one.
    const fromData = lengths(data, true);
    const fromStringData = lengths(stringData, false);
    if (fromData !== undefined) redacted["data"] = fromData;
    if (fromStringData !== undefined) redacted["stringData"] = fromStringData;
    return redacted;
  }

  // ConfigMap keeps its data in full, deliberately (§20): most misconfigurations live
  // there, and a redacted ConfigMap would make the common case unanswerable. An operator
  // who puts a credential in a ConfigMap has already published it to everything that can
  // read the namespace, and this tool is not where that gets fixed.
  if (data !== undefined) redacted["data"] = data;
  if (stringData !== undefined) redacted["stringData"] = stringData;
  return redacted;
};

/**
 * Serialize a redacted object as YAML, capped and honest about the cap.
 *
 * YAML rather than JSON because it is what an operator reads a Kubernetes object in, and
 * a model that has read ten thousand `kubectl get -o yaml` outputs parses it more
 * reliably than a wall of braces.
 */
export const renderObject = (object: Json): string => {
  const yaml = stringifyYaml(object, { lineWidth: 0 });
  if (Buffer.byteLength(yaml, "utf8") <= MAX_OBJECT_BYTES) return yaml;

  // Cut on a byte boundary and then on a line, so the tail is not half a key. The note
  // goes last, where a truncated read ends and the reader is looking.
  const clipped = Buffer.from(yaml, "utf8").subarray(0, MAX_OBJECT_BYTES).toString("utf8");
  const lastNewline = clipped.lastIndexOf("\n");
  const body = lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped;
  return `${body}\n# … truncated: this object is larger than the ${MAX_OBJECT_BYTES}-byte cap on one describe. Fields after this point were not returned.\n`;
};
