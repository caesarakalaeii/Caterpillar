/**
 * Tests for the structural manifest validator.
 *
 * The tree these rules are about lives in a private repo nobody here can see, and the
 * validator is about to be its acceptance gate — so every rule is exercised against a
 * fixture built here, in a temp directory, with no network, no cluster, no `kustomize`
 * binary and above all no age key. The `*.enc.yaml` carve-out in particular is tested by
 * feeding it a file whose values are ciphertext and asserting that nothing complains.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  countBySeverity,
  formatFinding,
  isEncrypted,
  kustomizationRefs,
  normalizePath,
  parseManifestFile,
  parseRequire,
  validateTree,
  type Finding,
  type FileMap,
} from "./validate.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Build a real temp-directory fixture, and read it back the way the CLI walks it. */
const fixture = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-manifests-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return root;
};

/** The same map the CLI builds by walking, without importing the walker. */
const asMap = (files: Readonly<Record<string, string>>): FileMap => new Map(Object.entries(files));

const errorsOf = (findings: readonly Finding[]): readonly Finding[] =>
  findings.filter((finding) => finding.severity === "error");

const messages = (findings: readonly Finding[]): string =>
  findings.map((finding) => formatFinding(finding)).join("\n");

const CLEAN_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: caterpillar
  namespace: caterpillar
spec:
  template:
    spec:
      containers:
        - name: app
          image: ghcr.io/acme/caterpillar:1.2.3
`;

const CLEAN_KUSTOMIZATION = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
`;

test("a clean tree passes with zero errors", async () => {
  const root = await fixture({
    "kustomization.yaml": CLEAN_KUSTOMIZATION,
    "deployment.yaml": CLEAN_DEPLOYMENT,
  });
  assert.ok(root.length > 0);

  const result = validateTree(
    asMap({ "kustomization.yaml": CLEAN_KUSTOMIZATION, "deployment.yaml": CLEAN_DEPLOYMENT }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
  assert.equal(result.files, 2);
  assert.equal(result.documents, 2);
});

test("a syntax error is reported with the file and the line", () => {
  const broken = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  bad: [1,\n";
  const parsed = parseManifestFile("broken.yaml", broken);

  const errors = errorsOf(parsed.findings);
  assert.equal(errors.length > 0, true, messages(parsed.findings));
  const first = errors[0];
  assert.equal(first?.file, "broken.yaml");
  assert.equal(typeof first?.line, "number");
  assert.equal((first?.line ?? 0) >= 5, true, `line was ${String(first?.line)}`);
  assert.match(formatFinding(first as Finding), /broken\.yaml:\d+:/);
});

test("a syntax error names the document index within a multi-document file", () => {
  const source = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n---\nbad: [1,\n";
  const parsed = parseManifestFile("multi.yaml", source);

  const errors = errorsOf(parsed.findings);
  assert.equal(errors.length, 1, messages(parsed.findings));
  assert.equal(errors[0]?.doc, 1);
});

test("a document missing kind is an error and a trailing empty document is not", () => {
  const source = "apiVersion: v1\nmetadata:\n  name: nameless\n---\n";
  const result = validateTree(asMap({ "a.yaml": source }));

  const errors = errorsOf(result.findings);
  assert.equal(errors.length, 1, messages(result.findings));
  assert.match(errors[0]?.message ?? "", /has no `kind`/);
  // The trailing `---` produced a document; it simply must not be flagged.
  assert.equal(result.documents, 2);
});

test("a comments-only document is not flagged", () => {
  const result = validateTree(
    asMap({ "a.yaml": "# nothing here but a note to the next reader\n" }),
  );
  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a kustomization needs no metadata.name", () => {
  const result = validateTree(asMap({ "kustomization.yaml": CLEAN_KUSTOMIZATION }));
  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a kustomizeconfig.yaml needs no metadata.name", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml": "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigurations:\n  - kustomizeconfig.yaml\n",
      "kustomizeconfig.yaml": "nameReference:\n  - kind: ConfigMap\n    fieldSpecs:\n      - path: spec/configMap\n",
    }),
  );
  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

// The carve-out that lets the whole validator run where the age key cannot go. If this
// test ever starts failing because the file "does not look like a Secret", the change
// that did it has made the gate un-runnable on a bare runner.
const SOPS_FILE = `apiVersion: v1
kind: Secret
metadata:
    name: ENC[AES256_GCM,data:Qk9HVVM=,iv:aaa=,tag:bbb=,type:str]
stringData:
    token: ENC[AES256_GCM,data:c2VjcmV0,iv:ccc=,tag:ddd=,type:str]
sops:
    age:
        - recipient: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            Y2lwaGVydGV4dA==
            -----END AGE ENCRYPTED FILE-----
    mac: ENC[AES256_GCM,data:bWFj,iv:eee=,tag:fff=,type:str]
    version: 3.9.0
`;

test("a *.enc.yaml with a sops block and ciphertext values passes untouched", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ngenerators:\n  - secret.enc.yaml\n",
      "secret.enc.yaml": SOPS_FILE,
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("an encrypted file is never faulted for a plaintext stringData lint", () => {
  // The very same shape that is an error in a plain file must be silent here — the value
  // is ciphertext, and the lint exists to catch the file that was NOT encrypted.
  const result = validateTree(asMap({ "secret.enc.yaml": SOPS_FILE }));
  const errors = errorsOf(result.findings).filter((f) => /stringData/.test(f.message));
  assert.equal(errors.length, 0, messages(result.findings));
});

test("a *.enc.yaml with no sops block is an error", () => {
  const result = validateTree(
    asMap({
      "secret.enc.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  token: hunter2\n",
    }),
  );
  const errors = errorsOf(result.findings);
  assert.equal(errors.length, 1, messages(result.findings));
  assert.match(errors[0]?.message ?? "", /no `sops:` block/);
});

test("isEncrypted recognises both .enc.yaml and .enc.yml", () => {
  assert.equal(isEncrypted("a/b/secret.enc.yaml"), true);
  assert.equal(isEncrypted("secret.enc.yml"), true);
  assert.equal(isEncrypted("secret.yaml"), false);
  assert.equal(isEncrypted("enc.yaml"), false);
});

test("an orphaned foo.yaml next to a kustomization that does not list it is reported", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml": CLEAN_KUSTOMIZATION,
      "deployment.yaml": CLEAN_DEPLOYMENT,
      "foo.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: foo\n",
    }),
  );

  const errors = errorsOf(result.findings);
  assert.equal(errors.length, 1, messages(result.findings));
  assert.equal(errors[0]?.file, "foo.yaml");
  assert.match(errors[0]?.message ?? "", /not referenced by/);
});

// The ksops case. A validator that does not count `generators:` reports every SOPS file
// in the deployment repo as orphaned, which would make the gate useless on day one.
test("a file referenced only via generators is not reported as orphaned", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ngenerators:\n  - ksops.yaml\n",
      "ksops.yaml":
        "apiVersion: viaduct.ai/v1\nkind: ksops\nmetadata:\n  name: secret-generator\nfiles:\n  - ./secret.enc.yaml\n",
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

// The real ksops layout is two hops, not one: the kustomization names the generator, and
// the GENERATOR names the encrypted files. Getting this wrong makes every secret in the
// deployment repo read as orphaned, which is the false failure that would get the gate
// switched off in a week.
test("a *.enc.yaml named only by a ksops generator's own files: is not orphaned", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ngenerators:\n  - ksops.yaml\n",
      "ksops.yaml":
        "apiVersion: viaduct.ai/v1\nkind: ksops\nmetadata:\n  name: gen\nfiles:\n  - ./secret.enc.yaml\n",
      "secret.enc.yaml": SOPS_FILE,
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
  assert.equal(countBySeverity(result.findings).warnings, 0, messages(result.findings));
});

test("a generator's files: entry is resolved relative to the generator, not the root", () => {
  const result = validateTree(
    asMap({
      "overlay/kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ngenerators:\n  - ksops.yaml\n",
      "overlay/ksops.yaml":
        "apiVersion: viaduct.ai/v1\nkind: ksops\nmetadata:\n  name: gen\nfiles:\n  - ./secret.enc.yaml\n",
      "overlay/secret.enc.yaml": SOPS_FILE,
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
  assert.equal(countBySeverity(result.findings).warnings, 0, messages(result.findings));
});

test("a file referenced only via components is not reported as orphaned", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ncomponents:\n  - component.yaml\n",
      "component.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: component\n",
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a file referenced only via a patch list is not reported as orphaned", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\npatches:\n  - path: patch.yaml\n    target:\n      kind: Deployment\n",
      "deployment.yaml": CLEAN_DEPLOYMENT,
      "patch.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: caterpillar\nspec:\n  replicas: 2\n",
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a file referenced only via secretGenerator files is not reported as orphaned", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nsecretGenerator:\n  - name: s\n    files:\n      - token=token.yaml\n",
      "token.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: token\n",
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a directory entry in resources covers the subtree — recurse, do not flag", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - base\n",
      "base/kustomization.yaml": CLEAN_KUSTOMIZATION,
      "base/deployment.yaml": CLEAN_DEPLOYMENT,
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("a directory with no kustomization at all orphans nothing", () => {
  const result = validateTree(
    asMap({ "loose/one.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n" }),
  );
  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("an unresolvable reference form is a warning, never an error", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - 42\n",
    }),
  );

  const { errors, warnings } = countBySeverity(result.findings);
  assert.equal(errors, 0, messages(result.findings));
  assert.equal(warnings > 0, true, messages(result.findings));
  assert.match(messages(result.findings), /warning, not a failure/);
});

test("a remote base is not mistaken for a missing local path", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - https://example.invalid/base?ref=v1\n  - github.com/acme/base//overlay\n",
    }),
  );
  assert.equal(countBySeverity(result.findings).warnings, 0, messages(result.findings));
});

test("kustomizationRefs reads every documented field", () => {
  const refs = kustomizationRefs({
    resources: ["a.yaml"],
    patches: [{ path: "b.yaml" }, { patch: "- op: remove\n  path: /spec" }],
    patchesStrategicMerge: ["c.yaml"],
    patchesJson6902: [{ path: "d.yaml" }],
    generators: ["e.yaml"],
    components: ["f.yaml"],
    transformers: ["g.yaml"],
    crds: ["h.yaml"],
    configMapGenerator: [{ name: "cm", files: ["i.yaml"], envs: ["j.env"] }],
    secretGenerator: [{ name: "s", files: ["k=k.yaml"] }],
  });

  for (const path of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "k"]) {
    assert.equal(refs.paths.has(`${path}.yaml`), true, `missing ${path}.yaml`);
  }
  assert.equal(refs.paths.has("j.env"), true);
  assert.equal(refs.unresolved.length, 0, refs.unresolved.join("; "));
});

test("normalizePath collapses . and .. but keeps a leading ..", () => {
  assert.equal(normalizePath("./a/../b/c.yaml"), "b/c.yaml");
  assert.equal(normalizePath("a/b/../../c.yaml"), "c.yaml");
  // An overlay's `../../base` means two levels up. Collapsing it to `base` would resolve
  // the reference against the wrong directory and orphan every file in the real target.
  assert.equal(normalizePath("../../base"), "../../base");
  assert.equal(normalizePath("../a/../b"), "../b");
});

test("an overlay referencing ../../base resolves it and orphans nothing", () => {
  const result = validateTree(
    asMap({
      "overlays/prod/kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../base\n",
      "base/kustomization.yaml": CLEAN_KUSTOMIZATION,
      "base/deployment.yaml": CLEAN_DEPLOYMENT,
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
  assert.equal(countBySeverity(result.findings).warnings, 0, messages(result.findings));
});

// A strategic-merge patch carries its target's apiVersion, kind and name by design — that
// identity is how kustomize knows what to patch. Flagging it would fail every overlay.
test("a patch sharing its target's identity is not a duplicate", () => {
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\npatches:\n  - path: replicas.yaml\n    target:\n      kind: Deployment\n",
      "deployment.yaml": CLEAN_DEPLOYMENT,
      "replicas.yaml":
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: caterpillar\n  namespace: caterpillar\nspec:\n  replicas: 2\n",
    }),
  );

  assert.equal(countBySeverity(result.findings).errors, 0, messages(result.findings));
});

test("two real objects are still a duplicate even when a patch list exists", () => {
  const object = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: same\n";
  const result = validateTree(
    asMap({
      "kustomization.yaml":
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - a.yaml\n  - b.yaml\npatches:\n  - path: p.yaml\n",
      "a.yaml": object,
      "b.yaml": object,
      "p.yaml": object,
    }),
  );

  const duplicates = errorsOf(result.findings).filter((f) => /duplicate/.test(f.message));
  assert.equal(duplicates.length, 1, messages(result.findings));
  assert.equal(duplicates[0]?.file, "b.yaml");
});

test("a duplicate name, kind and namespace across two files is an error", () => {
  const object = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: same\n  namespace: ns\n";
  const result = validateTree(asMap({ "a.yaml": object, "b.yaml": object }));

  const errors = errorsOf(result.findings).filter((f) => /duplicate/.test(f.message));
  assert.equal(errors.length, 1, messages(result.findings));
  assert.equal(errors[0]?.file, "b.yaml");
  assert.match(errors[0]?.message ?? "", /already defined at a\.yaml:1/);
});

test("the same name in two namespaces is not a duplicate", () => {
  const result = validateTree(
    asMap({
      "a.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: same\n  namespace: one\n",
      "b.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: same\n  namespace: two\n",
    }),
  );
  const errors = errorsOf(result.findings).filter((f) => /duplicate/.test(f.message));
  assert.equal(errors.length, 0, messages(result.findings));
});

test("--require passes when the object is present and fails when it is absent", () => {
  const files = asMap({
    "role.yaml": "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: foo\nrules: []\n",
  });

  const present = validateTree(files, { require: [parseRequire("ClusterRole/foo")] }, "tree");
  assert.equal(countBySeverity(present.findings).errors, 0, messages(present.findings));

  const absent = validateTree(files, { require: [parseRequire("ClusterRole/bar")] }, "tree");
  const errors = errorsOf(absent.findings);
  assert.equal(errors.length, 1, messages(absent.findings));
  assert.match(errors[0]?.message ?? "", /ClusterRole\/bar was not found under tree/);
});

test("--require with --namespace asserts metadata.namespace", () => {
  const files = asMap({
    "sa.yaml": "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: agent\n  namespace: caterpillar\n",
  });

  const ok = validateTree(
    files,
    { require: [parseRequire("ServiceAccount/agent")], namespace: "caterpillar" },
    "tree",
  );
  assert.equal(countBySeverity(ok.findings).errors, 0, messages(ok.findings));

  const wrong = validateTree(
    files,
    { require: [parseRequire("ServiceAccount/agent")], namespace: "other" },
    "tree",
  );
  const errors = errorsOf(wrong.findings);
  assert.equal(errors.length, 1, messages(wrong.findings));
  assert.match(errors[0]?.message ?? "", /not in namespace 'other'/);
  assert.match(errors[0]?.message ?? "", /namespace caterpillar/);
});

test("parseRequire rejects anything that is not Kind/name", () => {
  assert.throws(() => parseRequire("ConfigMap"), /Kind\/name/);
  assert.throws(() => parseRequire("/name"), /Kind\/name/);
  assert.throws(() => parseRequire("Kind/"), /Kind\/name/);
  assert.deepEqual(parseRequire("ConfigMap/probe"), { kind: "ConfigMap", name: "probe" });
});

test("a name containing a slash still parses as Kind/name", () => {
  // `rbac.authorization.k8s.io/v1` style kinds never contain a slash, but a name can, so
  // the split is on the FIRST slash and the rest is the name.
  assert.deepEqual(parseRequire("Ingress/a/b"), { kind: "Ingress", name: "a/b" });
});

// ---- §7 lints: each one fires on a crafted fixture and is silent on a clean one ----

const lintErrors = (files: Readonly<Record<string, string>>): readonly Finding[] =>
  errorsOf(validateTree(asMap(files)).findings);

test("a ClusterRole with a metadata.namespace is an error", () => {
  const bad = lintErrors({
    "a.yaml": "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\n  namespace: ns\nrules: []\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /cluster-scoped/);

  const good = lintErrors({
    "a.yaml": "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\nrules: []\n",
  });
  assert.equal(good.length, 0, messages(good));
});

test("a ClusterRoleBinding with a metadata.namespace is an error", () => {
  const bad = lintErrors({
    "a.yaml":
      "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: b\n  namespace: ns\nsubjects:\n  - kind: ServiceAccount\n    name: sa\n    namespace: ns\nroleRef:\n  kind: ClusterRole\n  name: r\n  apiGroup: rbac.authorization.k8s.io\n",
  });
  assert.equal(bad.filter((f) => /cluster-scoped/.test(f.message)).length, 1, messages(bad));
});

test("a RoleBinding ServiceAccount subject with no namespace is an error", () => {
  const bad = lintErrors({
    "a.yaml":
      "apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: b\n  namespace: ns\nsubjects:\n  - kind: ServiceAccount\n    name: sa\nroleRef:\n  kind: Role\n  name: r\n  apiGroup: rbac.authorization.k8s.io\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /ServiceAccount with no `namespace`/);

  const good = lintErrors({
    "a.yaml":
      "apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: b\n  namespace: ns\nsubjects:\n  - kind: ServiceAccount\n    name: sa\n    namespace: ns\n  - kind: Group\n    name: devs\nroleRef:\n  kind: Role\n  name: r\n  apiGroup: rbac.authorization.k8s.io\n",
  });
  assert.equal(good.length, 0, messages(good));
});

test("an image with no tag is an error", () => {
  const bad = lintErrors({
    "a.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n          image: ghcr.io/acme/app\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /has no tag/);
});

test("an image pinned to :latest is an error", () => {
  const bad = lintErrors({
    "a.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      initContainers:\n        - name: c\n          image: busybox:latest\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /pins nothing/);
});

test("a registry port is not mistaken for a tag, and a digest counts as pinned", () => {
  const good = lintErrors({
    "a.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n        - name: a\n          image: registry.local:5000/acme/app:1.0.0\n        - name: b\n          image: ghcr.io/acme/app@sha256:0000000000000000000000000000000000000000000000000000000000000000\n",
  });
  assert.equal(good.length, 0, messages(good));

  const bad = lintErrors({
    "a.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n        - name: a\n          image: registry.local:5000/acme/app\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /has no tag/);
});

test("a Secret with plaintext stringData outside a *.enc.yaml is an error", () => {
  const bad = lintErrors({
    "secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  token: hunter2\n",
  });
  assert.equal(bad.length, 1, messages(bad));
  assert.match(bad[0]?.message ?? "", /plaintext `stringData`/);
  assert.match(bad[0]?.message ?? "", /token/);

  // `data:` is base64, not plaintext, and is not what this lint is about.
  const good = lintErrors({
    "secret.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  token: aHVudGVyMg==\n",
  });
  assert.equal(good.length, 0, messages(good));
});

test("a clean fixture fires none of the §7 lints", () => {
  const good = lintErrors({
    "kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\n  - rbac.yaml\ngenerators:\n  - secret.enc.yaml\n",
    "deployment.yaml": CLEAN_DEPLOYMENT,
    "rbac.yaml":
      "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\nrules: []\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: b\n  namespace: caterpillar\nsubjects:\n  - kind: ServiceAccount\n    name: sa\n    namespace: caterpillar\nroleRef:\n  kind: ClusterRole\n  name: r\n  apiGroup: rbac.authorization.k8s.io\n",
    "secret.enc.yaml": SOPS_FILE,
  });
  assert.equal(good.length, 0, messages(good));
});

test("findings are grouped by file for the CLI to print", () => {
  const result = validateTree(
    asMap({
      "a.yaml": "apiVersion: v1\nmetadata:\n  name: x\n",
      "b.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: y\n",
    }),
  );

  assert.equal(result.byFile.get("a.yaml")?.length, 1);
  assert.equal(result.byFile.get("b.yaml")?.length, 0);
});

test("formatFinding names the file, and the line when there is one", () => {
  assert.equal(
    formatFinding({ severity: "error", file: "a.yaml", line: 7, message: "boom" }),
    "  ✗ a.yaml:7: boom",
  );
  assert.equal(
    formatFinding({ severity: "warning", file: "a.yaml", message: "hmm" }),
    "  ! a.yaml: hmm",
  );
});
