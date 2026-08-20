/**
 * Verifies a tree of Kubernetes manifests structurally, with no SOPS in the path.
 *
 *   node src/cli/verify-manifests.ts <dir> [--require Kind/name ...] [--namespace ns] [--quiet]
 *   npm run verify:manifests -- ../deployment/apps --require ConfigMap/caterpillar
 *
 * The manifests this exists for live in a separate private repo where Secrets are
 * SOPS-encrypted and rendered by a ksops generator that needs an age private key. An
 * agent editing them has to prove its change is valid; the runner must never hold that
 * key. So this reads YAML and nothing else — no kustomize, no ksops, no kubectl, no
 * decryption, no cluster, no network. `*.enc.yaml` files are checked for a `sops:` block
 * and then left strictly alone (see `isEncrypted` in ../manifests/validate.ts).
 *
 * The exit code is the entire contract: 0 when there are zero errors, 1 otherwise.
 * Warnings never fail the run — they exist for the reference forms this cannot resolve
 * confidently, and a false failure on a pre-existing tree would be worse than a missed
 * orphan.
 *
 * All the logic lives in ../manifests/validate.ts. This file is argv, file walking and
 * printing, so the rules stay unit-testable without a filesystem.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  countBySeverity,
  formatFinding,
  parseRequire,
  validateTree,
  type FileMap,
  type RequiredObject,
} from "../manifests/validate.ts";

interface Args {
  readonly dir: string;
  readonly require: readonly RequiredObject[];
  readonly namespace?: string;
  readonly quiet: boolean;
}

const USAGE =
  "usage: node src/cli/verify-manifests.ts <dir> [--require Kind/name ...] " +
  "[--namespace <ns>] [--quiet]";

export const parseArgs = (argv: readonly string[]): Args => {
  let dir: string | undefined;
  let namespace: string | undefined;
  let quiet = false;
  const required: RequiredObject[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--require" || arg === "--namespace") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}\n${USAGE}`);
      i += 1;
      if (arg === "--require") required.push(parseRequire(value));
      else namespace = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    if (dir !== undefined) throw new Error(`more than one directory given\n${USAGE}`);
    dir = arg;
  }

  if (dir === undefined) throw new Error(USAGE);
  return { dir, require: required, quiet, ...(namespace !== undefined ? { namespace } : {}) };
};

/** Directories that hold no manifests and only slow the walk down. */
const SKIP_DIRS = new Set([".git", "node_modules", ".terraform", "dist"]);

/** Walk for `*.yaml`/`*.yml`, keyed by POSIX path relative to the root. */
const walk = async (root: string): Promise<FileMap> => {
  const files = new Map<string, string>();

  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    // Sorted so the output — and therefore any diff of it — is stable across platforms.
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
      files.set(relative(root, path).split(sep).join("/"), await readFile(path, "utf8"));
    }
  };

  await visit(root);
  return files;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  const info = await stat(args.dir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`'${args.dir}' is not a directory`);
  }

  const files = await walk(args.dir);
  console.log(`Scanning ${args.dir} — ${files.size} YAML file(s), structurally only.`);
  if (files.size === 0) {
    // An empty tree is almost always a wrong path, and silently passing on it is exactly
    // the vacuous green this validator exists to avoid.
    console.error(`✗ no *.yaml or *.yml files under ${args.dir} — is the path right?`);
    process.exitCode = 1;
    return;
  }

  const result = validateTree(files, {
    require: args.require,
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
  }, args.dir);

  for (const [file, findings] of result.byFile) {
    // `byFile` is also keyed by the root for tree-level findings (`--require`); those are
    // printed separately below so they are not attributed to a file that was walked.
    if (!files.has(file)) continue;
    if (findings.length === 0) {
      if (!args.quiet) console.log(`  ✓ ${file}`);
      continue;
    }
    // A file with a finding is always printed, `--quiet` or not: suppressing the line
    // that explains the exit code would make the gate unreadable.
    console.log(`  · ${file}`);
    for (const finding of findings) console.log(formatFinding(finding));
  }

  // Findings that belong to the tree rather than to a walked file (`--require`).
  for (const finding of result.findings) {
    if (files.has(finding.file)) continue;
    console.log(formatFinding(finding));
  }

  const { errors, warnings } = countBySeverity(result.findings);
  console.log(
    `\n${result.files} file(s), ${result.documents} document(s), ` +
      `${errors} error(s), ${warnings} warning(s).`,
  );
  for (const want of args.require) {
    console.log(`  required: ${want.kind}/${want.name}`);
  }

  if (errors > 0) {
    console.error(`\n✗ ${errors} error(s). These manifests are not valid.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    warnings > 0
      ? `\n✓ no errors. ${warnings} warning(s) above are reference forms this validator ` +
          "could not resolve confidently; they do not fail the run."
      : "\n✓ no errors.",
  );
  console.log(
    "Not verified here, and not verifiable without the age key or a cluster: that the " +
      "encrypted values decrypt, that kustomize renders, that the apiserver accepts it.",
  );
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
