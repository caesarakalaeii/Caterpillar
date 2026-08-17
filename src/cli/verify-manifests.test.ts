/**
 * End-to-end tests for `verify:manifests`.
 *
 * The exit code is the entire contract. Every downstream acceptance command in the
 * deployment repo is `node .../verify-manifests.ts <dir> --require ...` and nothing else,
 * so a validator that finds every error and still exits 0 is worse than none at all.
 * These tests run the real CLI as a real child process over real temp directories, which
 * is the only way to assert on the number the shell actually sees.
 *
 * No network, no cluster, no `kustomize` binary, and above all no age key — that is the
 * property under test as much as any individual rule.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const CLI = fileURLToPath(new URL("./verify-manifests.ts", import.meta.url));

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-verify-manifests-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return root;
};

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cli = async (...args: readonly string[]): Promise<Run> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (cause: unknown) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const CLEAN = {
  "kustomization.yaml":
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - configmap.yaml\ngenerators:\n  - ksops.yaml\n",
  "configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: probe\ndata:\n  a: b\n",
  "ksops.yaml":
    "apiVersion: viaduct.ai/v1\nkind: ksops\nmetadata:\n  name: gen\nfiles:\n  - ./secret.enc.yaml\n",
  "secret.enc.yaml":
    "apiVersion: v1\nkind: Secret\nmetadata:\n    name: ENC[AES256_GCM,data:Qk9HVVM=,type:str]\nstringData:\n    token: ENC[AES256_GCM,data:c2VjcmV0,type:str]\nsops:\n    mac: ENC[AES256_GCM,data:bWFj,type:str]\n    version: 3.9.0\n",
} as const;

test("a clean tree exits 0", async () => {
  const root = await fixture(CLEAN);
  const result = await cli(root);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ no errors/);
  assert.match(result.stdout, /4 file\(s\)/);
});

test("--require exits 0 when the object is present and non-zero when it is absent", async () => {
  const root = await fixture(CLEAN);

  const present = await cli(root, "--require", "ConfigMap/probe");
  assert.equal(present.code, 0, present.stdout + present.stderr);

  const absent = await cli(root, "--require", "ConfigMap/absent");
  assert.equal(absent.code, 1, absent.stdout + absent.stderr);
  assert.match(absent.stdout + absent.stderr, /ConfigMap\/absent was not found/);
});

test("--namespace is asserted against the required object", async () => {
  const root = await fixture({
    "sa.yaml": "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: agent\n  namespace: caterpillar\n",
  });

  const ok = await cli(root, "--require", "ServiceAccount/agent", "--namespace", "caterpillar");
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  const wrong = await cli(root, "--require", "ServiceAccount/agent", "--namespace", "elsewhere");
  assert.equal(wrong.code, 1, wrong.stdout + wrong.stderr);
});

test("a syntax error exits non-zero and names the file and line", async () => {
  const root = await fixture({
    "broken.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  bad: [1,\n",
  });
  const result = await cli(root);

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /broken\.yaml:\d+: YAML syntax error/);
});

// The property the whole design rests on: this runs where the age key cannot go.
test("an encrypted file passes without anything resembling decryption", async () => {
  const root = await fixture({ "secret.enc.yaml": CLEAN["secret.enc.yaml"] });
  const result = await cli(root);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /stringData/);
});

test("--quiet suppresses clean files but never a file with a finding", async () => {
  const root = await fixture({
    ...CLEAN,
    "orphan.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: orphan\n",
  });
  const result = await cli(root, "--quiet");

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ configmap\.yaml/);
  assert.match(result.stdout, /orphan\.yaml/);
  assert.match(result.stdout, /not referenced by/);
});

test("warnings alone do not fail the run", async () => {
  const root = await fixture({
    "kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../outside/base\n",
  });
  const result = await cli(root);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /warning\(s\)/);
});

test("a directory with no YAML at all fails rather than passing vacuously", async () => {
  const root = await fixture({ "README.md": "nothing to see\n" });
  const result = await cli(root);

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is the path right/);
});

test("a path that is not a directory fails", async () => {
  const root = await fixture(CLEAN);
  const result = await cli(join(root, "configmap.yaml"));

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is not a directory/);
});

test("no arguments prints the usage and fails", async () => {
  const result = await cli();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /usage: node src\/cli\/verify-manifests\.ts/);
});

test("an unknown option fails rather than being ignored", async () => {
  const root = await fixture(CLEAN);
  const result = await cli(root, "--decrypt");

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown option --decrypt/);
});

test("a malformed --require fails before anything is walked", async () => {
  const root = await fixture(CLEAN);
  const result = await cli(root, "--require", "ConfigMap");

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /--require expects Kind\/name/);
});

test("--require is repeatable and every one of them must hold", async () => {
  const root = await fixture(CLEAN);

  const both = await cli(root, "--require", "ConfigMap/probe", "--require", "Secret/nope");
  assert.equal(both.code, 1, both.stdout + both.stderr);
  assert.match(both.stdout + both.stderr, /Secret\/nope was not found/);
  assert.doesNotMatch(both.stdout + both.stderr, /ConfigMap\/probe was not found/);
});

test("the walk recurses into subdirectories", async () => {
  const root = await fixture({
    "kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - base\n",
    "base/kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\n",
    "base/deployment.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\n  namespace: ns\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n          image: ghcr.io/acme/app:1.0.0\n",
  });

  const result = await cli(root, "--require", "Deployment/d", "--namespace", "ns");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /base\/deployment\.yaml/);
});
