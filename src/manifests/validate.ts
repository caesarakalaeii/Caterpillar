/**
 * A STRUCTURAL validator for a tree of Kubernetes manifests.
 *
 * The manifests this exists for live in a separate, private repo where every Secret is
 * SOPS-encrypted and rendered by a ksops kustomize generator that needs an age private
 * key. An agent editing those manifests has to be able to prove its change is valid, and
 * the runner must never hold that key. So this reads YAML and nothing else: no
 * `kustomize`, no ksops, no `kubectl`, no decryption, no cluster, no network.
 *
 * The obvious alternative — `kustomize build` — was rejected deliberately. It needs the
 * key, and when the ksops plugin is absent it happily exits 0 having rendered *nothing*.
 * A gate that passes vacuously is worse than no gate at all.
 *
 * Everything here is a pure function over strings and already-parsed objects. File
 * walking, argv parsing and printing belong to `src/cli/verify-manifests.ts`; this module
 * must stay testable without a filesystem beyond the fixtures the tests build.
 */
import { LineCounter, parseAllDocuments } from "yaml";

/** Severity. A run fails on errors only — warnings are advice, not a veto. */
export type Severity = "error" | "warning";

export interface Finding {
  readonly severity: Severity;
  /** Path as the caller supplied it, so the message points at something they can open. */
  readonly file: string;
  /** 1-based line, when one can be named. Omitted when the finding is about a whole file. */
  readonly line?: number;
  /** 0-based index of the document within its file, for multi-document files. */
  readonly doc?: number;
  readonly message: string;
}

/** One parsed Kubernetes-ish document, kept alongside where it came from. */
export interface ManifestDoc {
  readonly file: string;
  readonly index: number;
  readonly line: number;
  /** `null` for an empty or comments-only document. */
  readonly value: Record<string, unknown> | null;
}

export interface ParsedFile {
  readonly file: string;
  readonly docs: readonly ManifestDoc[];
  readonly findings: readonly Finding[];
}

/** A file's contents keyed by path relative to the validated root, POSIX-separated. */
export type FileMap = ReadonlyMap<string, string>;

export interface RequiredObject {
  readonly kind: string;
  readonly name: string;
}

export interface ValidateOptions {
  readonly require?: readonly RequiredObject[];
  /** When set, `--require` also asserts `metadata.namespace` equals this. */
  readonly namespace?: string;
}

export interface ValidationResult {
  readonly files: number;
  readonly documents: number;
  readonly findings: readonly Finding[];
  /** Per-file findings in walk order, so the CLI can print a line per file. */
  readonly byFile: ReadonlyMap<string, readonly Finding[]>;
}

const error = (file: string, message: string, extra: Partial<Finding> = {}): Finding => ({
  severity: "error",
  file,
  message,
  ...extra,
});

const warning = (file: string, message: string, extra: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  file,
  message,
  ...extra,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

const dirName = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
};

/**
 * `a/b/../c` → `a/c`. Kustomization references are relative and routinely use `..`.
 *
 * A leading `..` is PRESERVED rather than popped off the front. An overlay saying
 * `../../base` means two levels up, and collapsing that to `base` silently resolves the
 * reference against the wrong directory — which reads as a dangling reference and an
 * orphan for every file in the real target. Only a `..` that has something to cancel is
 * cancelled.
 */
export const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = out.at(-1);
      if (last === undefined || last === "..") out.push("..");
      else out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
};

const joinPath = (dir: string, rel: string): string =>
  normalizePath(dir === "" ? rel : `${dir}/${rel}`);

/**
 * A kustomization by filename. `kind: Kustomization` legitimately has no
 * `metadata.name`, so these files are exempt from the apiVersion/kind/name rule.
 */
export const isKustomization = (file: string): boolean => {
  const name = baseName(file);
  return name === "kustomization.yaml" || name === "kustomization.yml";
};

const isKustomizeConfig = (file: string): boolean => {
  const name = baseName(file);
  return name === "kustomizeconfig.yaml" || name === "kustomizeconfig.yml";
};

/**
 * A SOPS-encrypted file.
 *
 * THE CARVE-OUT: this exists so the validator can run where the age key cannot go. An
 * `*.enc.yaml` is checked for exactly two things — that it parses, and that it carries a
 * `sops:` block — and then left alone. Every value in it is ciphertext; requiring the
 * plaintext Kubernetes shape (or a `stringData` that reads like a password) would mean
 * the file could only be validated by something holding the private key, which is
 * precisely the thing this design refuses to put on a runner.
 */
export const isEncrypted = (file: string): boolean => {
  const name = baseName(file);
  return name.endsWith(".enc.yaml") || name.endsWith(".enc.yml");
};

/**
 * Parse one file into its documents, reporting syntax errors with file, document index
 * and line.
 *
 * A single manifest file routinely holds several `---`-separated objects, so the parse is
 * multi-document and a broken document does not hide the ones after it.
 */
export const parseManifestFile = (file: string, source: string): ParsedFile => {
  const lineCounter = new LineCounter();
  const findings: Finding[] = [];
  const docs: ManifestDoc[] = [];

  let documents;
  try {
    documents = parseAllDocuments(source, { lineCounter });
  } catch (cause: unknown) {
    // parseAllDocuments collects errors rather than throwing, but a malformed input can
    // still escape as an exception; a thrown error must not take down the whole walk.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { file, docs: [], findings: [error(file, `could not be parsed as YAML: ${message}`)] };
  }

  documents.forEach((document, index) => {
    const start = document.range?.[0] ?? 0;
    const line = lineCounter.linePos(start).line;

    if (document.errors.length > 0) {
      for (const parseError of document.errors) {
        const at = parseError.linePos?.[0]?.line ?? line;
        findings.push(
          error(file, `YAML syntax error: ${parseError.message.split("\n")[0] ?? ""}`, {
            line: at,
            doc: index,
          }),
        );
      }
      return;
    }

    let value: unknown;
    try {
      value = document.toJS();
    } catch (cause: unknown) {
      findings.push(
        error(file, `document could not be materialised: ${String(cause)}`, {
          line,
          doc: index,
        }),
      );
      return;
    }

    if (value === null || value === undefined) {
      // An empty document (a trailing `---`) or one that is only comments. Both are
      // legal YAML and neither is a mistake; record it as a document with no value so the
      // required-fields check can skip it deliberately rather than by accident.
      docs.push({ file, index, line, value: null });
      return;
    }

    if (!isRecord(value)) {
      findings.push(
        error(file, `document ${index} is a ${Array.isArray(value) ? "list" : typeof value}, not a mapping`, {
          line,
          doc: index,
        }),
      );
      return;
    }

    docs.push({ file, index, line, value });
  });

  return { file, docs, findings };
};

/** `apiVersion`, `kind` and `metadata.name`, with the documented exceptions. */
export const checkRequiredFields = (doc: ManifestDoc): readonly Finding[] => {
  if (doc.value === null) return []; // empty or comments-only: legal, see parseManifestFile
  if (isEncrypted(doc.file)) return []; // see isEncrypted — never inspect ciphertext shape

  const findings: Finding[] = [];
  const at = { line: doc.line, doc: doc.index };
  const kind = asString(doc.value["kind"]);

  // kustomize's own configuration is not an object sent to an apiserver. A
  // `kustomization.yaml` legitimately carries no `metadata.name`, and a
  // `kustomizeconfig.yaml` carries no apiVersion or kind either — it is a bare mapping of
  // field specs. Neither is a mistake, so neither is checked against the object shape.
  if (isKustomizeConfig(doc.file)) return [];
  const isKustomizationDoc = isKustomization(doc.file) || kind === "Kustomization";

  if (asString(doc.value["apiVersion"]) === undefined && !isKustomizationDoc) {
    findings.push(error(doc.file, `document ${doc.index} has no \`apiVersion\``, at));
  }
  if (kind === undefined && !isKustomization(doc.file)) {
    findings.push(error(doc.file, `document ${doc.index} has no \`kind\``, at));
  }

  if (isKustomizationDoc) return findings;

  const metadata = doc.value["metadata"];
  const name = isRecord(metadata) ? asString(metadata["name"]) : undefined;
  const generateName = isRecord(metadata) ? asString(metadata["generateName"]) : undefined;
  if (name === undefined && generateName === undefined) {
    findings.push(error(doc.file, `document ${doc.index} has no \`metadata.name\``, at));
  }

  return findings;
};

/** The `sops:` block, and nothing more. See isEncrypted for why this stops here. */
export const checkEncryptedFile = (parsed: ParsedFile): readonly Finding[] => {
  const findings: Finding[] = [];
  const hasSops = parsed.docs.some((doc) => doc.value !== null && "sops" in doc.value);
  if (!hasSops) {
    findings.push(
      error(
        parsed.file,
        "is named `*.enc.yaml` but has no `sops:` block — either it was never encrypted " +
          "(and may contain plaintext secrets) or it is not a SOPS file and should be renamed",
      ),
    );
  }
  return findings;
};

const CONTAINER_FIELDS = ["containers", "initContainers", "ephemeralContainers"] as const;

/** Every `image:` under any container list anywhere in the document, with its owner path. */
const collectImages = (value: unknown, out: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const field of CONTAINER_FIELDS) {
    const containers = value[field];
    if (!Array.isArray(containers)) continue;
    for (const container of containers) {
      if (!isRecord(container)) continue;
      const image = asString(container["image"]);
      if (image !== undefined) out.push(image);
    }
  }
  for (const nested of Object.values(value)) collectImages(nested, out);
};

/**
 * `registry:5000/repo:tag` — the tag is the last `:` segment AFTER the last `/`, so a
 * registry port is not mistaken for a tag.
 */
const imageTag = (image: string): string | undefined => {
  if (image.includes("@")) return image.slice(image.indexOf("@") + 1); // a digest pins harder than a tag
  const lastSlash = image.lastIndexOf("/");
  const colon = image.indexOf(":", lastSlash + 1);
  return colon < 0 ? undefined : image.slice(colon + 1);
};

/**
 * The short list of mistakes that are certain.
 *
 * Deliberately short. A lint with false positives makes the gate untrustworthy, and the
 * moment someone starts reaching for `--quiet` to get past it the whole validator has
 * stopped being a gate.
 */
export const checkLints = (doc: ManifestDoc): readonly Finding[] => {
  if (doc.value === null) return [];
  if (isEncrypted(doc.file)) return []; // see isEncrypted
  const findings: Finding[] = [];
  const at = { line: doc.line, doc: doc.index };
  const kind = asString(doc.value["kind"]) ?? "";
  const metadata = isRecord(doc.value["metadata"]) ? doc.value["metadata"] : {};
  const name = asString(metadata["name"]) ?? "(unnamed)";

  // A cluster-scoped object with a namespace: the field is silently ignored by the
  // apiserver, so this is always someone believing they scoped something they did not.
  if (kind === "ClusterRole" || kind === "ClusterRoleBinding") {
    if (asString(metadata["namespace"]) !== undefined) {
      findings.push(
        error(
          doc.file,
          `${kind}/${name} sets \`metadata.namespace\` — it is cluster-scoped, so the ` +
            "field is ignored and the object is not scoped the way this reads",
          at,
        ),
      );
    }
  }

  // A ServiceAccount subject with no namespace does not default to the binding's
  // namespace in every path, and the binding then silently grants nothing.
  if (kind === "RoleBinding" || kind === "ClusterRoleBinding") {
    const subjects = doc.value["subjects"];
    if (Array.isArray(subjects)) {
      subjects.forEach((subject, subjectIndex) => {
        if (!isRecord(subject)) return;
        if (asString(subject["kind"]) !== "ServiceAccount") return;
        if (asString(subject["namespace"]) !== undefined) return;
        findings.push(
          error(
            doc.file,
            `${kind}/${name} subject ${subjectIndex} is a ServiceAccount with no ` +
              "`namespace` — the binding will not grant what it reads as granting",
            at,
          ),
        );
      });
    }
  }

  const images: string[] = [];
  collectImages(doc.value, images);
  for (const image of images) {
    const tag = imageTag(image);
    if (tag === undefined) {
      findings.push(
        error(
          doc.file,
          `image '${image}' has no tag — it resolves to whatever \`latest\` points at today`,
          at,
        ),
      );
      continue;
    }
    if (tag === "latest") {
      findings.push(
        error(doc.file, `image '${image}' is pinned to \`:latest\`, which pins nothing`, at),
      );
    }
  }

  // The exact mistake the encryption exists to prevent: a Secret with plaintext in a
  // file that was never encrypted. Loud, because it is a credential in git history.
  if (kind === "Secret" && !isEncrypted(doc.file)) {
    const stringData = doc.value["stringData"];
    if (isRecord(stringData) && Object.keys(stringData).length > 0) {
      findings.push(
        error(
          doc.file,
          `Secret/${name} has plaintext \`stringData\` (${Object.keys(stringData).join(", ")}) ` +
            "in a file that is not `*.enc.yaml` — encrypt it with SOPS before this reaches git",
          at,
        ),
      );
    }
  }

  return findings;
};

/**
 * Everything a kustomization references, as paths relative to its own directory.
 *
 * `generators` matters as much as `resources`: it is how ksops is wired in, and a
 * validator that does not count it reports every SOPS file in the tree as orphaned.
 */
const REFERENCE_LISTS = [
  "resources",
  "patches",
  "patchesStrategicMerge",
  "patchesJson6902",
  "generators",
  "components",
  "transformers",
  "crds",
  "bases", // deprecated but still in the wild, and an unrecognised base looks like an orphan
  "configurations",
] as const;

const GENERATOR_LISTS = ["configMapGenerator", "secretGenerator"] as const;

/** The fields whose entries are patches rather than whole objects. See findDuplicates. */
const PATCH_LISTS = ["patches", "patchesStrategicMerge", "patchesJson6902"] as const;

/**
 * Files referenced as patches, root-relative.
 *
 * Collected separately from every other reference because duplicate detection has to
 * skip them: a strategic-merge patch shares its target's apiVersion, kind and name by
 * design.
 */
export const findPatchFiles = (
  files: FileMap,
  parsedByFile: ReadonlyMap<string, ParsedFile>,
): ReadonlySet<string> => {
  const patches = new Set<string>();
  for (const kustomization of files.keys()) {
    if (!isKustomization(kustomization)) continue;
    const dir = dirName(kustomization);
    const doc = parsedByFile.get(kustomization)?.docs.find((candidate) => candidate.value !== null);
    const value = doc?.value;
    if (value === undefined || value === null) continue;
    for (const field of PATCH_LISTS) {
      const list = value[field];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const path = typeof entry === "string" ? entry : isRecord(entry) ? asString(entry["path"]) : undefined;
        if (path !== undefined) patches.add(joinPath(dir, path));
      }
    }
  }
  return patches;
};

export interface KustomizationRefs {
  /** Paths, relative to the kustomization's directory, normalised. */
  readonly paths: ReadonlySet<string>;
  /** Reference forms that could not be resolved to a path — reported as warnings. */
  readonly unresolved: readonly string[];
}

/**
 * Read the references out of a parsed kustomization.
 *
 * A reference form that cannot be resolved confidently (a remote URL, an inline patch
 * with no `path`) becomes an `unresolved` note rather than being dropped: a false orphan
 * failure on a pre-existing tree is worse than a missed orphan, so the caller downgrades
 * these to warnings.
 */
export const kustomizationRefs = (value: Record<string, unknown>): KustomizationRefs => {
  const paths = new Set<string>();
  const unresolved: string[] = [];

  const addEntry = (field: string, entry: unknown): void => {
    if (typeof entry === "string") {
      // A remote base (`github.com/...`, `https://...`) is a real reference but not a
      // local path; it cannot orphan a local file, so it is simply not a local path.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.startsWith("github.com/")) return;
      paths.add(normalizePath(entry));
      return;
    }
    if (!isRecord(entry)) {
      unresolved.push(`${field}: a ${Array.isArray(entry) ? "list" : typeof entry} entry`);
      return;
    }
    // `patches: [{ path: x.yaml, target: ... }]` and `patchesJson6902: [{ path: ... }]`.
    const path = asString(entry["path"]);
    if (path !== undefined) {
      paths.add(normalizePath(path));
      return;
    }
    // An inline patch (`patch: |`) references no file at all — nothing to resolve, and
    // nothing that could be orphaned by it.
    if (asString(entry["patch"]) !== undefined) return;
    unresolved.push(`${field}: an entry with neither \`path\` nor \`patch\``);
  };

  for (const field of REFERENCE_LISTS) {
    const list = value[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      unresolved.push(`${field}: not a list`);
      continue;
    }
    for (const entry of list) addEntry(field, entry);
  }

  for (const field of GENERATOR_LISTS) {
    const list = value[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      for (const source of ["files", "envs", "env"] as const) {
        const items = entry[source];
        if (items === undefined) continue;
        if (typeof items === "string") {
          paths.add(normalizePath(items));
          continue;
        }
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (typeof item !== "string") continue;
          // `files:` entries may be `key=path`; the path is what matters.
          const equals = item.indexOf("=");
          paths.add(normalizePath(equals < 0 ? item : item.slice(equals + 1)));
        }
      }
    }
  }

  return { paths, unresolved };
};

/**
 * The files a generator manifest itself points at.
 *
 * `generators: [ksops.yaml]` is one hop, not two: the kustomization names the generator,
 * and the GENERATOR names the `*.enc.yaml` files in its own `files:` list. A validator
 * that only reads the kustomization sees the encrypted file as referenced by nobody and
 * reports every secret in the deployment repo as orphaned — the precise false failure
 * that would get this gate switched off in a week. So a document sitting in a directory
 * that has a kustomization also contributes its `files:` entries as references.
 */
export const generatorRefs = (value: Record<string, unknown>): ReadonlySet<string> => {
  const paths = new Set<string>();
  const files = value["files"];
  if (!Array.isArray(files)) return paths;
  for (const entry of files) {
    if (typeof entry !== "string") continue;
    paths.add(normalizePath(entry));
  }
  return paths;
};

/**
 * Orphan detection: a `*.yaml` sibling of a `kustomization.yaml` that the kustomization
 * never mentions. It is the most common way a manifest change silently does nothing —
 * the file is committed, reviewed, merged, and never rendered.
 *
 * A directory entry in `resources` counts as referencing that whole subtree: the
 * subdirectory has its own kustomization, and its contents are that kustomization's
 * problem, not this one's.
 */
export const findOrphans = (
  files: FileMap,
  parsedByFile: ReadonlyMap<string, ParsedFile>,
): readonly Finding[] => {
  const findings: Finding[] = [];

  // Every directory that holds at least one walked file, so a reference to a directory
  // can be told apart from a reference to something that is not in the tree at all.
  const directories = new Set<string>();
  for (const path of files.keys()) directories.add(dirName(path));
  const isDirectory = (path: string): boolean =>
    directories.has(path) || [...directories].some((dir) => dir.startsWith(`${path}/`));

  for (const kustomization of files.keys()) {
    if (!isKustomization(kustomization)) continue;
    const dir = dirName(kustomization);
    const doc = parsedByFile.get(kustomization)?.docs.find((candidate) => candidate.value !== null);
    const value = doc?.value;
    if (value === undefined || value === null) continue;

    const direct = kustomizationRefs(value);

    // Resolved to root-relative paths once, here, so nothing downstream has to reason
    // about which directory a `../` was written relative to.
    const referenced = new Set<string>();
    for (const rel of direct.paths) referenced.add(joinPath(dir, rel));

    // Follow ONE hop through each referenced generator. `generators: [ksops.yaml]` names
    // the generator; the generator's own `files:` names the `*.enc.yaml`. Without this
    // hop every SOPS file in the deployment repo reads as orphaned. See generatorRefs.
    for (const target of [...referenced]) {
      const generator = parsedByFile.get(target);
      if (generator === undefined) continue;
      const generatorDir = dirName(target);
      for (const generatorDoc of generator.docs) {
        if (generatorDoc.value === null) continue;
        for (const nested of generatorRefs(generatorDoc.value)) {
          referenced.add(joinPath(generatorDir, nested));
        }
      }
    }

    for (const note of direct.unresolved) {
      findings.push(
        warning(
          kustomization,
          `could not resolve a reference form (${note}) — orphan detection for this ` +
            "directory may be incomplete, so this is a warning, not a failure",
        ),
      );
    }

    // A reference to something not in the tree. A warning, never an error: the target may
    // legitimately live outside <dir>, and a false failure on a pre-existing tree is
    // worse than a missed orphan.
    for (const resolved of referenced) {
      if (files.has(resolved) || isDirectory(resolved)) continue;
      findings.push(
        warning(
          kustomization,
          `references '${resolved}', which is not in the validated tree — either it is ` +
            "outside <dir> or the reference is stale",
        ),
      );
    }

    for (const path of files.keys()) {
      if (dirName(path) !== dir) continue;
      if (isKustomization(path) || isKustomizeConfig(path)) continue;
      if (referenced.has(path)) continue;
      findings.push(
        error(
          path,
          `is not referenced by ${kustomization} — it will never be rendered. Add it to ` +
            "`resources` (or `generators`, `components`, a patch list, ...) or delete it",
        ),
      );
    }
  }

  return findings;
};

const identity = (value: Record<string, unknown>): string | undefined => {
  const apiVersion = asString(value["apiVersion"]);
  const kind = asString(value["kind"]);
  const metadata = isRecord(value["metadata"]) ? value["metadata"] : {};
  const name = asString(metadata["name"]);
  if (apiVersion === undefined || kind === undefined || name === undefined) return undefined;
  const namespace = asString(metadata["namespace"]) ?? "";
  return `${apiVersion}\u0000${kind}\u0000${namespace}\u0000${name}`;
};

const describe = (value: Record<string, unknown>): string => {
  const metadata = isRecord(value["metadata"]) ? value["metadata"] : {};
  const namespace = asString(metadata["namespace"]);
  const kind = asString(value["kind"]) ?? "?";
  const name = asString(metadata["name"]) ?? "?";
  return namespace === undefined ? `${kind}/${name}` : `${kind}/${name} in ${namespace}`;
};

/**
 * Two objects that will fight over the same name — the second silently wins.
 *
 * `patchFiles` are excluded, and must be. A strategic-merge patch deliberately carries
 * the same apiVersion, kind and name as the object it patches — that identity is how
 * kustomize knows what to patch. Counting it as a duplicate would fail every overlay in
 * existence, which is exactly the kind of false positive that makes a gate untrustworthy.
 */
export const findDuplicates = (
  docs: readonly ManifestDoc[],
  patchFiles: ReadonlySet<string> = new Set(),
): readonly Finding[] => {
  const findings: Finding[] = [];
  const seen = new Map<string, ManifestDoc>();
  for (const doc of docs) {
    if (doc.value === null) continue;
    if (isEncrypted(doc.file)) continue; // see isEncrypted
    if (isKustomization(doc.file) || isKustomizeConfig(doc.file)) continue;
    if (patchFiles.has(doc.file)) continue; // see above: a patch shares its target's identity
    const key = identity(doc.value);
    if (key === undefined) continue;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, doc);
      continue;
    }
    findings.push(
      error(
        doc.file,
        `duplicate ${describe(doc.value)} — already defined at ${first.file}:${first.line}. ` +
          "Two objects with the same apiVersion, kind, namespace and name will fight over it",
        { line: doc.line, doc: doc.index },
      ),
    );
  }
  return findings;
};

/**
 * `--require Kind/name`: the named object must exist.
 *
 * This is what turns a parser into an acceptance gate. Without it a run proves only that
 * the YAML still parses; with it, it proves the *specific* object the task was about was
 * actually added.
 */
export const checkRequired = (
  docs: readonly ManifestDoc[],
  required: readonly RequiredObject[],
  namespace: string | undefined,
  root: string,
): readonly Finding[] => {
  const findings: Finding[] = [];
  for (const want of required) {
    const matches = docs.filter((doc) => {
      if (doc.value === null) return false;
      if (asString(doc.value["kind"]) !== want.kind) return false;
      const metadata = isRecord(doc.value["metadata"]) ? doc.value["metadata"] : {};
      return asString(metadata["name"]) === want.name;
    });

    if (matches.length === 0) {
      findings.push(
        error(root, `required object ${want.kind}/${want.name} was not found under ${root}`),
      );
      continue;
    }

    if (namespace === undefined) continue;

    const inNamespace = matches.filter((doc) => {
      const metadata = isRecord(doc.value?.["metadata"]) ? doc.value["metadata"] : {};
      return asString(metadata["namespace"]) === namespace;
    });
    if (inNamespace.length > 0) continue;

    const found = matches
      .map((doc) => {
        const metadata = isRecord(doc.value?.["metadata"]) ? doc.value["metadata"] : {};
        return `${doc.file}:${doc.line} (namespace ${asString(metadata["namespace"]) ?? "unset"})`;
      })
      .join(", ");
    findings.push(
      error(
        root,
        `required object ${want.kind}/${want.name} exists but not in namespace ` +
          `'${namespace}' — found at ${found}`,
      ),
    );
  }
  return findings;
};

/** `Kind/name`, as `--require` takes it. */
export const parseRequire = (spec: string): RequiredObject => {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`--require expects Kind/name, got '${spec}'`);
  }
  return { kind: spec.slice(0, slash), name: spec.slice(slash + 1) };
};

/**
 * Validate a whole tree, given its files already read.
 *
 * The caller does the walking so this stays pure and testable; `root` is only used to
 * name the tree in messages that are about the tree rather than a file.
 */
export const validateTree = (
  files: FileMap,
  options: ValidateOptions = {},
  root = ".",
): ValidationResult => {
  const parsedByFile = new Map<string, ParsedFile>();
  const byFile = new Map<string, Finding[]>();
  const allDocs: ManifestDoc[] = [];
  const findings: Finding[] = [];

  const push = (finding: Finding): void => {
    findings.push(finding);
    const list = byFile.get(finding.file);
    if (list === undefined) byFile.set(finding.file, [finding]);
    else list.push(finding);
  };

  for (const [path, source] of files) {
    const parsed = parseManifestFile(path, source);
    parsedByFile.set(path, parsed);
    if (!byFile.has(path)) byFile.set(path, []);
    for (const finding of parsed.findings) push(finding);
    allDocs.push(...parsed.docs);

    if (isEncrypted(path)) {
      // See isEncrypted: parses, has a `sops:` block, and nothing further is asked of it.
      for (const finding of checkEncryptedFile(parsed)) push(finding);
      continue;
    }

    for (const doc of parsed.docs) {
      for (const finding of checkRequiredFields(doc)) push(finding);
      for (const finding of checkLints(doc)) push(finding);
    }
  }

  for (const finding of findOrphans(files, parsedByFile)) push(finding);
  for (const finding of findDuplicates(allDocs, findPatchFiles(files, parsedByFile))) push(finding);
  for (const finding of checkRequired(allDocs, options.require ?? [], options.namespace, root)) {
    push(finding);
  }

  return {
    files: files.size,
    documents: allDocs.length,
    findings,
    byFile,
  };
};

export const countBySeverity = (
  findings: readonly Finding[],
): { readonly errors: number; readonly warnings: number } => ({
  errors: findings.filter((finding) => finding.severity === "error").length,
  warnings: findings.filter((finding) => finding.severity === "warning").length,
});

/** `file:line: message`, the form an editor and a human both know how to follow. */
export const formatFinding = (finding: Finding): string => {
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  const mark = finding.severity === "error" ? "✗" : "!";
  return `  ${mark} ${where}: ${finding.message}`;
};
