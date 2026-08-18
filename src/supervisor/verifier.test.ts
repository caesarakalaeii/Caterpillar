/**
 * Gate 1 of §12 and the environment it runs in, and gate 2 now that it counts repos.
 *
 * The acceptance gate and the agent's own shell used to disagree — pi's `sh -c` with the
 * inherited environment on one side, a LOGIN `bash -lc` on the other. These tests pin the
 * two properties that stop them diverging again: the resolved environment reaches the
 * command, and the shell does not source a profile that could replace it.
 *
 * Gate 2 is here too, since it learned to count. It checked `repos[0]` alone, so a task spanning
 * two repos passed on the strength of the primary while the sibling's CI was red — or absent
 * entirely. The work is one change and half of it being green is not it passing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkspaceBindings } from "../agent/runner.ts";
import type { CheckConclusion, Forge } from "../forge/types.ts";
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

/**
 * Who the resolved environment commits as. Any address will do here — what the
 * verifier's tests care about is that the resolver demands one at all (DESIGN.md §9.7).
 */
const TEST_IDENTITY = { name: "caterpillar", email: "caterpillar@example.invalid" };

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

/** A task with a PR recorded, so gate 2 actually consults the forge. */
const stateWithPr: TaskState = {
  ...state,
  pr: { number: 1, url: "https://example.invalid/pr/1" },
};

/**
 * A forge whose CI answers come from a script, one per call, so a run that is pending
 * and then finishes can be expressed without a clock.
 */
const forgeAnswering = (
  script: readonly CheckConclusion[],
): { readonly bindings: WorkspaceBindings; readonly calls: () => number } => {
  let calls = 0;
  const forge = {
    kind: "fake",
    checks: () => {
      const conclusion = script[Math.min(calls, script.length - 1)] ?? "pending";
      calls += 1;
      return Promise.resolve({ conclusion, summary: `${conclusion}: 1 check` });
    },
    revoke: () => Promise.resolve(),
  } as unknown as Forge;

  return {
    bindings: {
      // `as never` like the sibling stub below: `ForgeFactory` also carries the repo-reach
      // and catalogue methods, and none of them is on the path these tests exercise.
      forges: new Map([[asWorkspaceName("test"), { forTask: () => Promise.resolve(forge) }]]) as never,
      trackers: new Map(),
    },
    calls: () => calls,
  };
};

const verifierFor = (
  worktree: string,
  baseEnv: NodeJS.ProcessEnv,
  extra: {
    readonly bindings?: WorkspaceBindings;
    readonly ci?: ConstructorParameters<typeof AcceptanceVerifier>[0]["ci"];
  } = {},
): AcceptanceVerifier => {
  const worktrees = {
    ensureWorktree: (_repo: RepoRef, _task: TaskId): Promise<string> =>
      Promise.resolve(worktree),
  } as unknown as WorktreeManager;
  const bindings: WorkspaceBindings =
    extra.bindings ?? { forges: new Map(), trackers: new Map() };

  return new AcceptanceVerifier({
    worktrees,
    bindings,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      identity: TEST_IDENTITY,
      baseEnv,
    }),
    ...(extra.ci !== undefined ? { ci: extra.ci } : {}),
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


const PRIMARY: RepoRef = { host: "github.com", owner: "o", name: "r" };
const SIBLING: RepoRef = { host: "github.com", owner: "o", name: "r-extension" };

const twoRepoSpec: TaskSpec = { ...specWith(["true"]), repos: [PRIMARY, SIBLING] };

/** A forge whose CI answer is chosen per repo, and which records what it was asked. */
const ciForge = (
  answers: Record<string, "success" | "failure" | "pending" | "none">,
): { readonly bindings: WorkspaceBindings; readonly asked: string[] } => {
  const asked: string[] = [];
  const forge = {
    kind: "stub",
    credential: () => Promise.resolve({ username: "x", password: "y" }),
    openPr: () => Promise.resolve({ number: 1, url: "u" }),
    checks: (repo: RepoRef) => {
      asked.push(`${repo.owner}/${repo.name}`);
      const conclusion = answers[`${repo.owner}/${repo.name}`] ?? "success";
      return Promise.resolve({ conclusion, summary: `${repo.name} ${conclusion}` });
    },
    approve: () => Promise.resolve(),
    merge: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
  };
  const bindings: WorkspaceBindings = {
    forges: new Map([[asWorkspaceName("test"), { forTask: () => Promise.resolve(forge) }]]) as never,
    trackers: new Map(),
  };
  return { bindings, asked };
};

const ciVerifier = (worktree: string, bindings: WorkspaceBindings): AcceptanceVerifier =>
  new AcceptanceVerifier({
    worktrees: {
      ensureWorktree: () => Promise.resolve(worktree),
    } as unknown as WorktreeManager,
    bindings,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      identity: TEST_IDENTITY,
    }),
  });

test("gate 2 checks EVERY repo the task opened a PR in", async () => {
  const worktree = await scratch();
  const { bindings, asked } = ciForge({});
  const result = await ciVerifier(worktree, bindings).verify(twoRepoSpec, {
    ...state,
    pr: { number: 1, url: "https://example.invalid/r/1" },
    prs: [
      { number: 1, url: "https://example.invalid/r/1", repo: PRIMARY },
      { number: 2, url: "https://example.invalid/r-extension/2", repo: SIBLING },
    ],
  });

  assert.equal(result.passed, true, result.detail);
  assert.deepEqual(asked, ["o/r", "o/r-extension"]);
  assert.match(result.detail, /r-extension/, "the sibling's status belongs in the detail");
});

test("a red sibling fails the gate, and the detail names which repo", async () => {
  // THE defect. This passed, on the primary's green alone.
  const worktree = await scratch();
  const { bindings } = ciForge({ "o/r-extension": "failure" });
  const result = await ciVerifier(worktree, bindings).verify(twoRepoSpec, {
    ...state,
    pr: { number: 1, url: "https://example.invalid/r/1" },
    prs: [
      { number: 1, url: "https://example.invalid/r/1", repo: PRIMARY },
      { number: 2, url: "https://example.invalid/r-extension/2", repo: SIBLING },
    ],
  });

  assert.equal(result.passed, false);
  assert.match(result.detail, /CI is red/);
  assert.match(result.detail, /o\/r-extension/, "which repo is the whole of what the fix needs");
});

test("a state written before `prs` existed is read as the primary repo's PR", async () => {
  // A rolling deploy has both shapes in the state repo at once, so this is a live path. The
  // legacy `pr` has no repo, and the one it meant is `repos[0]` — the only one reachable then.
  const worktree = await scratch();
  const { bindings, asked } = ciForge({});
  const result = await ciVerifier(worktree, bindings).verify(twoRepoSpec, {
    ...state,
    pr: { number: 1, url: "https://example.invalid/r/1" },
  });

  assert.equal(result.passed, true, result.detail);
  assert.deepEqual(asked, ["o/r"], "it must not invent a PR for a repo that has none");
});

test("a repo with no CI still passes, and says so once per repo", async () => {
  const worktree = await scratch();
  const { bindings } = ciForge({ "o/r-extension": "none" });
  const result = await ciVerifier(worktree, bindings).verify(twoRepoSpec, {
    ...state,
    prs: [
      { number: 1, url: "https://example.invalid/r/1", repo: PRIMARY },
      { number: 2, url: "https://example.invalid/r-extension/2", repo: SIBLING },
    ],
  });

  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /NOTE:/);
  assert.match(result.detail, /acceptance criteria alone/);
});

/**
 * The pending-CI regression. BS-...-07 was parked with a green branch and an open PR
 * because a CI run that had not finished was reported as a failed gate, the completion
 * claim was journalled as REJECTED, and the supervisor spent a fresh session on a task
 * whose only blocker was a queue. Each of those sessions had nothing to do, committed
 * nothing, and was scored no-progress — truthfully. The sessions were the bug.
 */
test("a pending CI run is reported as pending, not as a failed gate", async () => {
  const worktree = await scratch();
  const { bindings } = forgeAnswering(["pending"]);
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, false);
  // The flag is the whole point: `passed: false` alone cannot be told apart from red CI,
  // and it was that conflation that turned a wait into a park.
  assert.equal(result.pending, true);
  assert.match(result.detail, /CI has not finished/);
});

test("red CI is a real rejection and is never marked pending", async () => {
  const worktree = await scratch();
  const { bindings } = forgeAnswering(["failure"]);
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, false);
  assert.notEqual(result.pending, true);
  assert.match(result.detail, /CI is red/);
});

test("the gate waits for a pending CI run and passes when it goes green", async () => {
  const worktree = await scratch();
  const { bindings, calls } = forgeAnswering(["pending", "pending", "success"]);
  let clock = 0;
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
    ci: {
      settleMs: 60_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, true);
  assert.equal(calls(), 3);
});

test("waiting for CI is bounded — a run that never settles still reports pending", async () => {
  const worktree = await scratch();
  const { bindings } = forgeAnswering(["pending"]);
  let clock = 0;
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
    ci: {
      settleMs: 5_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.pending, true);
  // Bounded by the budget, not left to spin: a check that never settles must reach an
  // agent rather than pin the runner forever.
  assert.equal(clock, 5_000);
});

test("a failing acceptance command is never blamed on CI", async () => {
  // Gate 1 short-circuits, so a red acceptance run must not consult the forge at all —
  // otherwise a broken build would wait out the CI budget before reporting itself.
  const worktree = await scratch();
  const { bindings, calls } = forgeAnswering(["pending"]);
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
    ci: { settleMs: 60_000, pollMs: 1_000 },
  });

  const result = await verifier.verify(specWith(["exit 1"]), stateWithPr);

  assert.equal(result.passed, false);
  assert.notEqual(result.pending, true);
  assert.equal(calls(), 0);
});

/**
 * `BS-...-07`'s acceptance list was `npm run check` and `npm test` with no install step.
 * `npm run check` exited 127 with `tsc: command not found`, and four consecutive sessions
 * read that as a code defect because the gate reported the exit code and nothing else.
 * The list was simply grading whatever a previous session had left in the worktree.
 */
test("a not-found failure with no install step says so", async () => {
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["definitely-not-a-real-binary"]), state);

  assert.equal(result.passed, false);
  assert.match(result.detail, /no acceptance command installs dependencies/);
  assert.match(result.detail, /not to the repository/);
});

test("a not-found failure is NOT annotated when the list does install", async () => {
  // The list is reproducible, so a missing binary is a real finding about the repo and
  // the note would be actively misleading.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(
    specWith(["npm ci --ignore-scripts", "definitely-not-a-real-binary"]),
    state,
  );

  assert.equal(result.passed, false);
  assert.doesNotMatch(result.detail, /installs dependencies/);
});

test("an ordinary failure is not annotated", async () => {
  // Exit 3 from a command that ran is a genuine test failure; nothing to do with install.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["echo nope >&2; exit 3"]), state);

  assert.equal(result.passed, false);
  assert.doesNotMatch(result.detail, /installs dependencies/);
});

test("a not-found failure still fails the gate", async () => {
  // The note explains; it must never excuse. A command that cannot run has not passed.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["definitely-not-a-real-binary"]), state);

  assert.equal(result.passed, false);
});
