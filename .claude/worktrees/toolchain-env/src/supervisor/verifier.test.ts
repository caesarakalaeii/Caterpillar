/**
 * Gate 1 of §12, and specifically the environment it runs in.
 *
 * The acceptance gate and the agent's own shell used to disagree — pi's `sh -c` with the
 * inherited environment on one side, a LOGIN `bash -lc` on the other. These tests pin the
 * two properties that stop them diverging again: the resolved environment reaches the
 * command, and the shell does not source a profile that could replace it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkspaceBindings } from "../agent/runner.ts";
import {
  asTaskId,
  asWorkspaceName,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { AcceptanceVerifier } from "./verifier.ts";

const temporaries: string[] = [];

after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-verifier-"));
  temporaries.push(dir);
  return dir;
};

const specWith = (acceptance: readonly string[]): TaskSpec => ({
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("test"),
  goal: "goal",
  repos: [{ host: "github.com", owner: "o", name: "r" }],
  requires: [],
  acceptance,
});

/** No PR, so gate 2 refuses without touching a forge — gate 1 is what these tests read. */
const state: TaskState = {
  id: asTaskId("TASK-1"),
  status: "running",
  phase: "verifying",
  requires: [],
  sessions: 1,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const NO_PR = "no pull request has been opened — call open_pr before claiming done";

const verifierFor = (worktree: string, baseEnv: NodeJS.ProcessEnv): AcceptanceVerifier => {
  const worktrees = {
    ensureWorktree: (_repo: RepoRef, _task: TaskId): Promise<string> =>
      Promise.resolve(worktree),
  } as unknown as WorktreeManager;
  const bindings: WorkspaceBindings = { forges: new Map(), trackers: new Map() };

  return new AcceptanceVerifier({
    worktrees,
    bindings,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      baseEnv,
    }),
  });
};

test("the resolved environment reaches the acceptance command", async () => {
  const worktree = await scratch();
  const verifier = verifierFor(worktree, {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    CATERPILLAR_MARKER: "injected",
  });

  const result = await verifier.verify(
    specWith(['test "$CATERPILLAR_MARKER" = injected']),
    state,
  );

  // Reaching gate 2's missing-PR refusal is how gate 1 reports success here.
  assert.equal(result.detail, NO_PR);
});

test("a failing acceptance command is reported with its output", async () => {
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["echo nope >&2; exit 3"]), state);

  assert.equal(result.passed, false);
  assert.match(result.detail, /Acceptance criteria failed/);
  assert.match(result.detail, /exited 3/);
  assert.match(result.detail, /nope/);
});

test("the acceptance shell does not source a login profile", async () => {
  // A login shell reads ~/.profile, and on alpine /etc/profile ASSIGNS PATH outright —
  // it would overwrite the environment the resolver just produced. With `bash -lc` this
  // test fails; that is the regression it exists to catch.
  const worktree = await scratch();
  const home = await scratch();
  await writeFile(join(home, ".profile"), "export CATERPILLAR_PROFILE=sourced\n", "utf8");

  const verifier = verifierFor(worktree, {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
  });

  const result = await verifier.verify(specWith(['test -z "$CATERPILLAR_PROFILE"']), state);

  assert.equal(result.detail, NO_PR);
});
