/**
 * Verifies a Vikunja agent API token and its per-route scopes, without printing it.
 *
 *   VIKUNJA_TOKEN=... npm run verify:vikunja -- --api-base https://vikunja.example.com/api/v1
 *   VIKUNJA_TOKEN=... npm run verify:vikunja -- ... --task 42   # also writes (see below)
 *
 * Read-only by default:
 *   1. the token authenticates                        (projects: read)
 *   2. agent-labelled items are discoverable          (tasks: read)
 *   3. the lifecycle labels exist                     (labels: read)
 *
 * With `--task <id>` it additionally performs a full WRITE round trip against that
 * item — comment, apply `agent-wip`, comment, remove `agent-wip` — which is the only
 * way to prove `comments: create` and `tasksLabels: create` before a real task does.
 * It leaves two comments behind; use a scratch item.
 *
 * `tasks: update` (the `done` flag) is deliberately never exercised here: marking an
 * item done is a §12 completion, not a connectivity check.
 *
 * Scope failures surface as TrackerScopeError — that means "re-grant in the UI", not
 * "the token is wrong". Do not retry, and do not debug the token.
 */
import { asTaskId } from "../domain/task.ts";
import { TrackerScopeError } from "../tracker/types.ts";
import { VikunjaTracker } from "../tracker/vikunja.ts";

const TOKEN_ENVS = ["VIKUNJA_TOKEN", "VIKUNJA_API_TOKEN"] as const;

/**
 * Where the instance is. REQUIRED, with no default, and that is the point.
 *
 * Vikunja is self-hosted: there is no vikunja.com every deployment shares, so any
 * default here would be one operator's hostname wearing the word "default". The old one
 * was — and a token verified against somebody else's instance either 401s confusingly or,
 * far worse, succeeds against the wrong data.
 */
const API_BASE_ENV = "VIKUNJA_API_BASE";

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };

  const apiBase = arg("--api-base") ?? process.env[API_BASE_ENV];
  if (apiBase === undefined || apiBase.length === 0) {
    throw new Error(
      `pass --api-base <url> or set ${API_BASE_ENV} — e.g. https://vikunja.example.com/api/v1`,
    );
  }
  const ingestLabel = arg("--ingest-label") ?? "agent";
  const wipLabel = arg("--wip-label") ?? "agent-wip";
  const needsHumanLabel = arg("--needs-human-label") ?? "needs-human";

  const tokenEnv = TOKEN_ENVS.find((name) => (process.env[name] ?? "").length > 0);
  if (tokenEnv === undefined) {
    throw new Error(`set one of ${TOKEN_ENVS.join(", ")} in the environment`);
  }
  console.log(`✓ token found in ${tokenEnv}`);

  const tracker = new VikunjaTracker({
    apiBase,
    token: process.env[tokenEnv] ?? "",
    ingestLabel,
    wipLabel,
    needsHumanLabel,
  });

  // 1: /projects, never /user — the latter is session-only and would 401 on a token
  // whose scopes are entirely correct.
  const projects = await tracker.whoami();
  console.log(`✓ authenticated to ${apiBase} — ${projects} project(s) visible`);

  // 2: aggregated per project, since /tasks/all is unreachable by any API token.
  const items = await tracker.listAgentItems();
  console.log(`✓ task listing reachable — ${items.length} item(s) labelled '${ingestLabel}'`);
  for (const item of items.slice(0, 5)) {
    console.log(`    ${item.ref.id}  ${item.title}`);
  }

  // 3: a lifecycle label that does not exist only fails mid-transition otherwise, by
  // which point git already says the task moved.
  const labels = await tracker.labelNames();
  for (const label of [wipLabel, needsHumanLabel]) {
    const present = labels.includes(label.toLowerCase());
    console.log(
      present
        ? `✓ label '${label}' exists`
        : `⚠ label '${label}' does NOT exist — create it in the UI, or transitions ` +
          `will fail (the token has no labels:create scope, by design)`,
    );
  }

  const taskArg = arg("--task");
  if (taskArg === undefined) {
    console.log(
      "\nRead-only checks passed. Re-run with --task <id> against a scratch item to " +
        "also verify comments:create and tasksLabels:create (it writes two comments).",
    );
    return;
  }

  const ref = { kind: "vikunja" as const, id: taskArg };
  console.log(`\nWriting to task ${taskArg} …`);

  await tracker.transition(ref, { kind: "claimed", runner: "verify-vikunja" }, asTaskId("VERIFY"));
  console.log(`✓ commented and applied '${wipLabel}'`);

  await tracker.transition(ref, { kind: "parked", reason: "verification complete" }, asTaskId("VERIFY"));
  console.log(`✓ commented and removed '${wipLabel}' via the bulk route`);

  console.log(
    `\nToken works for intake and for supervisor lifecycle mirroring. Not verified ` +
      `here: tasks:update, which only a real completion exercises.`,
  );
};

main().catch((error: unknown) => {
  if (error instanceof TrackerScopeError) {
    console.error(`✗ ${error.message}`);
    console.error(`  Re-grant '${error.requiredScope}' in Settings → API Tokens.`);
    process.exitCode = 1;
    return;
  }
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
