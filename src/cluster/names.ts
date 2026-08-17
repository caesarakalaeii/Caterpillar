/**
 * Validation for the two strings a session is allowed to name: a namespace and a pod.
 *
 * Separate from `client.ts` so it can be read in one sitting, because it is the only thing
 * standing between a model-supplied string and a URL path or a LogQL query. NOTHING from
 * the model reaches either without passing through here first.
 *
 * The grammar is Kubernetes' own RFC 1123 label-ish name form,
 * `[a-z0-9]([-a-z0-9]*[a-z0-9])?` with a 253-character ceiling. Deliberately not a
 * blocklist of `"`, `}` and `../`: a blocklist is a claim about every character an
 * attacker might use, and an allowlist is a claim about the ones Kubernetes actually
 * accepts. Only the second one can be checked by reading it.
 */

/** Longest a Kubernetes object name may be. */
const MAX_NAME = 253;

const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export class InvalidNameError extends Error {
  constructor(field: string, value: string, expected: string) {
    super(`${field} '${value}' is not accepted. Expected ${expected}`);
    this.name = "InvalidNameError";
  }
}

/** The one sentence that describes the accepted shape, so every refusal says the same thing. */
const NAME_SHAPE =
  `lowercase letters, digits and dashes, starting and ending with a letter or digit, ` +
  `at most ${MAX_NAME} characters (the Kubernetes object name grammar)`;

const valid = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_NAME && NAME.test(value);

/** A namespace, or a typed refusal that tells the agent the accepted shape. */
export const validateName = (field: string, value: string): string => {
  if (!valid(value)) throw new InvalidNameError(field, value, NAME_SHAPE);
  return value;
};

/**
 * A pod name, optionally with a single trailing `.*`.
 *
 * The wildcard is the one pattern a diagnosis genuinely needs and cannot get another way:
 * a ReplicaSet's pods are `<deployment>-<hash>-<hash>`, the hashes change on every roll,
 * and an alert names the Deployment. So `caterpillar-.*` is accepted and every other
 * regex construct is not — no alternation, no character classes, no anchors, nothing that
 * could match outside the prefix it appears to be about.
 *
 * A prefix may end in a DASH when a wildcard follows it — `caterpillar-abc-.*` — which a
 * bare name may not. That is not a loosening for its own sake: the prefix an alert hands
 * you is a ReplicaSet name, and the pod names under it are that plus `-<suffix>`, so
 * refusing the trailing dash would refuse the only spelling anyone would write.
 *
 * The returned value is still not safe to interpolate on its own; `escapeForLogQL` in
 * `client.ts` is what makes it safe. This function's job is to make sure there is nothing
 * left to escape.
 */
export const validatePodPattern = (field: string, value: string): string => {
  const wildcard = isPodPattern(value);
  const body = wildcard ? value.slice(0, -2) : value;
  // A bare `.*` would select every pod in the namespace, which the namespace-wide form of
  // `cluster_logs` (no `pod` at all) already expresses more honestly — so the prefix has
  // to be a name, and an empty one is not.
  const prefix = wildcard && body.endsWith("-") ? body.slice(0, -1) : body;
  if (!valid(prefix)) {
    throw new InvalidNameError(
      field,
      value,
      `${NAME_SHAPE}, optionally followed by a single trailing '.*' to match a ` +
        `replica-set suffix (e.g. 'caterpillar-.*'). No other pattern syntax is accepted`,
    );
  }
  return value;
};

/** True when the value ends in the one permitted wildcard. */
export const isPodPattern = (value: string): boolean => value.endsWith(".*");

const KIND = /^[A-Z][A-Za-z0-9]{0,62}$/;

/**
 * A Kubernetes KIND, for the `involvedObject.kind` half of an events field selector.
 *
 * Not the describe allowlist: an event's involved object is routinely something
 * `cluster_describe` will not read — a HorizontalPodAutoscaler, a ReplicaSet, an
 * Endpoints — and a filter narrower than the events that exist would hide the very
 * evidence the tool is for. Filtering is not access: the request reads the namespace's
 * events either way, and the guard has already decided whether that is allowed. So the
 * check here is only that the string is shaped like a kind and therefore safe to put in a
 * query parameter.
 */
export const validateKind = (field: string, value: string): string => {
  if (!KIND.test(value)) {
    throw new InvalidNameError(
      field,
      value,
      `a CamelCase Kubernetes kind, e.g. 'Pod', 'Deployment' or 'ReplicaSet'`,
    );
  }
  return value;
};
