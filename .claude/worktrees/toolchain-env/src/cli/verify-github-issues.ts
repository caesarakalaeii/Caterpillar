/**
 * Verifies the GitHub Issues tracker against a live installation, without printing
 * the minted token.
 *
 *   npm run verify:github-issues -- --pem <key.pem> --app-id <id> --installation <id>
 *   npm run verify:github-issues -- ... --issue caesarakalaeii/widget#7   # also writes
 *
 * Read-only by default:
 *   1. an installation token mints with issues:write + metadata:read only
 *   2. the installation's repos enumerate      (no search API — see the adapter)
 *   3. agent-labelled issues are discoverable, with pull requests excluded
 *   4. the lifecycle labels exist on each repo carrying agent work
 *
 * With `--issue <owner>/<name>#<number>` it performs a full WRITE round trip against
 * that issue — comment, apply `agent-wip`, comment, remove `agent-wip` — which is the
 * only way to prove the installation really granted `issues: write`. It leaves two
 * comments behind; use a scratch issue.
 *
 * Closing is deliberately never exercised: closing an issue is a §12 completion, not a
 * connectivity check.
 *
 * A 403 surfaces as TrackerScopeError — that means the App installation was granted
 * fewer permissions than the route needs. Re-grant it on the installation settings
 * page; do not retry, and do not debug the private key.
 */
import { readFile } from "node:fs/promises";
import { asTaskId } from "../domain/task.ts";
import { trackerTokenSource } from "../forge/github-app.ts";
import { GitHubIssuesTracker } from "../tracker/github-issues.ts";
import { TrackerScopeError } from "../tracker/types.ts";

const DEFAULT_API_BASE = "https://api.github.com";

/** `owner/name#123` → the pieces the tracker needs. */
const parseIssue = (
  value: string,
): { readonly slug: string; readonly number: string } => {
  const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`--issue must look like 'owner/name#123', got '${value}'`);
  }
  return { slug: match[1], number: match[2] };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };

  const required = (flag: string): string => {
    const value = arg(flag);
    if (value === undefined || value.length === 0) {
      throw new Error(`${flag} is required`);
    }
    return value;
  };

  const apiBase = arg("--api-base") ?? DEFAULT_API_BASE;
  const ingestLabel = arg("--ingest-label") ?? "agent";
  const wipLabel = arg("--wip-label") ?? "agent-wip";
  const needsHumanLabel = arg("--needs-human-label") ?? "needs-human";

  const pemPath = required("--pem");
  const appId = required("--app-id");
  const installationId = required("--installation");
  const owner = arg("--owner");

  // Read from a file rather than an env var or argv: a key on the command line ends up
  // in shell history and in the process table.
  const privateKeyPem = await readFile(pemPath, "utf8");
  console.log(`✓ private key read from ${pemPath}`);

  const source = trackerTokenSource({ appId, installationId, privateKeyPem, apiBase });

  // 1: minting proves the App, the key, and the installation all line up. A 422 here
  // means the App is not installed where it was asked to act.
  await source.token();
  console.log(`✓ installation token minted (issues:write, metadata:read — no contents)`);

  const tracker = new GitHubIssuesTracker({
    apiBase,
    // Default to the installation's own owner when not narrowed by hand.
    owner: owner ?? (await inferOwner(source, apiBase, installationId)),
    ingestLabel,
    wipLabel,
    needsHumanLabel,
    token: () => source.token(),
  });

  // 2: enumerated, not searched — the search API is eventually consistent, so a
  // freshly labelled issue can be invisible to it for a minute.
  const repos = await tracker.repos();
  console.log(`✓ ${repos.length} repo(s) visible to this installation`);
  for (const repo of repos.slice(0, 10)) console.log(`    ${repo}`);

  // 3: pull requests are issues in GitHub's data model; the adapter drops them.
  const items = await tracker.listAgentItems();
  console.log(`✓ issue listing reachable — ${items.length} item(s) labelled '${ingestLabel}'`);
  for (const item of items.slice(0, 5)) {
    console.log(`    ${item.ref.container}#${item.ref.id}  ${item.title}`);
  }

  // 4: a missing lifecycle label only fails mid-transition otherwise, by which point
  // git already says the task moved. Checked per repo — labels are repo-scoped.
  const checked = new Set(items.map((item) => item.ref.container ?? ""));
  for (const slug of checked) {
    const labels = await tracker.labelNames(slug);
    for (const label of [wipLabel, needsHumanLabel]) {
      console.log(
        labels.includes(label.toLowerCase())
          ? `✓ label '${label}' exists on ${slug}`
          : `⚠ label '${label}' does NOT exist on ${slug} — create it, or transitions ` +
            `will fail (the adapter refuses to create labels, by design)`,
      );
    }
  }
  if (checked.size === 0) {
    console.log(
      `ℹ no agent-labelled issues, so no repo's lifecycle labels were checked — ` +
        `label an issue '${ingestLabel}' and re-run to verify them`,
    );
  }

  const issueArg = arg("--issue");
  if (issueArg === undefined) {
    console.log(
      "\nRead-only checks passed. Re-run with --issue <owner>/<name>#<n> against a " +
        "scratch issue to also verify issues:write (it writes two comments).",
    );
    return;
  }

  const { slug, number } = parseIssue(issueArg);
  const ref = { kind: "github-issues" as const, id: number, container: slug };
  console.log(`\nWriting to ${slug}#${number} …`);

  await tracker.transition(ref, { kind: "claimed", runner: "verify-github-issues" }, asTaskId("VERIFY"));
  console.log(`✓ commented and applied '${wipLabel}'`);

  await tracker.transition(ref, { kind: "parked", reason: "verification complete" }, asTaskId("VERIFY"));
  console.log(`✓ commented and removed '${wipLabel}'`);

  console.log(
    `\nInstallation works for intake and for supervisor lifecycle mirroring. Not ` +
      `verified here: closing an issue, which only a real completion exercises.`,
  );
};

/**
 * Owner of the installation, for when `--owner` is not supplied.
 *
 * Uses the first repository the installation can see rather than `GET /app/
 * installations/{id}`, which needs the App JWT rather than the installation token and
 * would mean minting a second credential just to read a name.
 */
const inferOwner = async (
  source: { token: () => Promise<string> },
  apiBase: string,
  installationId: string,
): Promise<string> => {
  const response = await fetch(`${apiBase}/installation/repositories?per_page=1`, {
    headers: {
      authorization: `Bearer ${await source.token()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `could not list installation ${installationId}'s repositories (${response.status}) — ` +
        `pass --owner explicitly`,
    );
  }

  const body = (await response.json()) as {
    readonly repositories?: readonly { readonly owner?: { readonly login?: string } }[];
  };
  const login = body.repositories?.[0]?.owner?.login;
  if (login === undefined) {
    throw new Error(
      `installation ${installationId} can see no repositories — install the App on at ` +
        `least one, or pass --owner explicitly`,
    );
  }
  return login;
};

main().catch((error: unknown) => {
  if (error instanceof TrackerScopeError) {
    console.error(`✗ ${error.message}`);
    console.error(
      `  The installation was granted fewer permissions than this route needs. ` +
        `Re-grant '${error.requiredScope}' on the App installation, then re-run.`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
