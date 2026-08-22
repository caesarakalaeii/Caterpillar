/**
 * The gate that costs a command instead of a session. See DESIGN.md §22.
 *
 * A precheck exists because §11.1 admits a residual: work whose only blocker is external
 * state costs a whole session to discover there was nothing to do, and that session is
 * scored honestly as no progress. So the command runs first, in the environment the session
 * would have had — which is the property these tests pin, along with the two failures that
 * are NOT an answer about the work: a timeout and an environment that will not resolve.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RepoRef, TaskId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { parseSchedule } from "./definition.ts";
import { schedulePrecheck } from "./precheck.ts";

const TEST_IDENTITY = { name: "caterpillar", email: "caterpillar@example.invalid" };

const temporaries: string[] = [];

after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-precheck-"));
  temporaries.push(dir);
  return dir;
};

const scheduleWith = (command: string, timeoutSeconds = 30): ReturnType<typeof parseSchedule> =>
  parseSchedule(
    "deps-audit",
    [
      "version: 1",
      "trigger:",
      '  cron: "0 9 * * 1-5"',
      "  timezone: Europe/Berlin",
      "workspace: primary",
      "repos:",
      "  - github.com/acme/widget",
      "prompt: Audit dependency updates.",
      "acceptance:",
      "  - npm test",
      "precheck:",
      `  command: ${JSON.stringify(command)}`,
      `  timeoutSeconds: ${timeoutSeconds}`,
      "",
    ].join("\n"),
  );

const runnerFor = (
  worktree: string,
  baseEnv: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
): ReturnType<typeof schedulePrecheck> =>
  schedulePrecheck({
    worktrees: {
      ensureWorktree: (_repo: RepoRef, _task: TaskId): Promise<string> =>
        Promise.resolve(worktree),
    } as unknown as WorktreeManager,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      identity: TEST_IDENTITY,
      baseEnv,
    }),
    logger: SILENT_LOGGER,
  });

test("a command that exits 0 lets the occurrence become a task", async () => {
  const run = runnerFor(await scratch());

  const result = await run(scheduleWith("true"));

  assert.equal(result.ok, true);
  assert.match(result.detail, /exit 0/);
});

test("a command that exits non-zero skips the occurrence, and its output is recorded", async () => {
  // The detail is the whole reason a skip is legible in the ledger: "the precheck said no"
  // with no output is indistinguishable from a schedule nobody is polling.
  const run = runnerFor(await scratch());

  const result = await run(scheduleWith('echo "no updates pending" >&2; exit 1'));

  assert.equal(result.ok, false);
  assert.match(result.detail, /exit 1/);
  assert.match(result.detail, /no updates pending/);
});

test("the resolved environment reaches the precheck", async () => {
  // It has to be the environment the SESSION would have had, or the gate answers a
  // question about a different machine than the one that would do the work.
  const run = runnerFor(await scratch(), {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    CATERPILLAR_MARKER: "injected",
  });

  const result = await run(scheduleWith('test "$CATERPILLAR_MARKER" = injected'));

  assert.equal(result.ok, true);
});

test("the precheck runs in the task's worktree", async () => {
  const worktree = await scratch();
  const run = runnerFor(worktree);

  const result = await run(scheduleWith(`test "$PWD" = ${JSON.stringify(worktree)}`));

  assert.equal(result.ok, true);
});

test("a command that outruns its timeout is a skip, not a stalled housekeeping pass", async () => {
  // This runs on the housekeeping loop, which the chat drain, intake and the digest share.
  // An unbounded precheck would hold all of them, so the bound is enforced rather than
  // trusted — and a timeout is read as "no", because a check that cannot answer in its own
  // budget has not established that there is work.
  const run = runnerFor(await scratch());

  const result = await run(scheduleWith("sleep 30", 1));

  assert.equal(result.ok, false);
  assert.match(result.detail, /timed out|exit/i);
});

test("an environment that will not resolve is a throw, not a skip", async () => {
  // Distinct from a command that says no. This runner could not ask the question, so the
  // occurrence must stay available to one that can — `ScheduleRunner` releases the claim
  // on a throw and records nothing.
  const run = schedulePrecheck({
    worktrees: {
      ensureWorktree: (): Promise<string> => {
        throw new Error("the mirror is not on this volume");
      },
    } as unknown as WorktreeManager,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: await scratch(),
      identity: TEST_IDENTITY,
      baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    }),
    logger: SILENT_LOGGER,
  });

  await assert.rejects(run(scheduleWith("true")), /mirror is not on this volume/);
});

test("a schedule with no precheck is an error rather than a silent pass", async () => {
  // The caller checks `schedule.precheck` before calling this; reaching here without one
  // means the two have gone out of step, and answering "ok" would fire every occurrence of
  // every schedule without consulting anything.
  const run = runnerFor(await scratch());
  const noGate = parseSchedule(
    "deps-audit",
    [
      "version: 1",
      "trigger:",
      '  cron: "0 9 * * 1-5"',
      "  timezone: Europe/Berlin",
      "workspace: primary",
      "repos:",
      "  - github.com/acme/widget",
      "prompt: Audit dependency updates.",
      "acceptance:",
      "  - npm test",
      "",
    ].join("\n"),
  );

  await assert.rejects(run(noGate), /no precheck/);
});
