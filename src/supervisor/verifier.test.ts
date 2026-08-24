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
 *
 * And the evidence a gate leaves behind. `acceptance: ["npx playwright test"]`
 * is the honest end-to-end test for a change that renders something, and it was impossible
 * while a gate could only return an exit code.
 *
 * The last block of the file covers a different gate entirely: §20's post-merge
 * re-verification, which asks whether the alert a remediation task was created for actually
 * stopped. It shares this file with §12's gates because it is the same kind of thing — a
 * check the SUPERVISOR performs and the agent cannot influence — and it has its own header
 * comment where it starts.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { ARTIFACT_BYTES, ARTIFACT_COUNT } from "../state/store.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import type { AlertRefusal } from "../state/store.ts";
import {
  AcceptanceVerifier,
  AlertReverifier,
  type EvidenceStore,
  type ReverifyStore,
} from "./verifier.ts";

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
    // A branch that merges, which is what every test using this harness assumes. The
    // conflict cases have their own verifier at the bottom of the file.
    defaultBranch: () => Promise.resolve("main"),
    conflictsWithBase: () => Promise.resolve(undefined),
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

/* ───────────────────────────── gate 2: CI, per repo ───────────────────────────── */

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
      // These tests are about CI, and a branch that merges is the state they all assume.
      // The conflict cases have their own verifier below.
      defaultBranch: () => Promise.resolve("main"),
      conflictsWithBase: () => Promise.resolve(undefined),
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

/* ────────────────── an amended criterion says so in the report (§12.3) ────────────────── */

/**
 * The gate the verifier ran is `readSpec`'s EFFECTIVE list, so an amended criterion is
 * graded silently: the report names the command and nothing says the command is not the
 * one `spec.md` filed. "How did this pass?" six months later is then answerable only by
 * diffing the state repo, which is exactly what the amendment record exists to avoid.
 *
 * The amendment is THREADED IN rather than re-derived here: the verifier is handed the list
 * as filed alongside the records, so nothing in this file has to guess which entry moved.
 */
const AMENDED = {
  filed: ["true", "npm run lint"],
  history: [
    {
      index: 1,
      acceptance: ["true", "npm test -- src/widget"],
      why: "the repo-wide lint predates this branch and fails on files it does not touch",
      author: "operator",
      at: "2026-08-19T09:14:02.113Z",
    },
  ],
} as const;

test("a passing report says which criterion came from an amendment", async () => {
  const worktree = await scratch();
  const { bindings } = ciForge({});
  const result = await ciVerifier(worktree, bindings).verify(
    { ...specWith(["true"]), acceptance: ["true"] },
    { ...state, prs: [{ number: 1, url: "https://example.invalid/r/1", repo: PRIMARY }] },
    { filed: ["npm run lint"], history: [{ ...AMENDED.history[0], acceptance: ["true"] }] },
  );

  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /amended/i, "a green report must not hide that the gate moved");
  assert.match(result.detail, /`true`/, "naming the criterion the amendment introduced");
  assert.match(result.detail, /npm run lint/, "and the one it replaced");
  assert.ok(result.detail.includes(AMENDED.history[0].why), "with the reason verbatim");
  assert.match(result.detail, /operator/);
});

test("a rejection on an amended criterion says the criterion was amended", async () => {
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(
    { ...specWith(["true"]), acceptance: ["true", "exit 4"] },
    state,
    { filed: ["true"], history: [{ ...AMENDED.history[0], acceptance: ["true", "exit 4"] }] },
  );

  assert.equal(result.passed, false);
  assert.match(result.detail, /exited 4/);
  assert.match(result.detail, /amended/i);
  assert.match(result.detail, /exit 4/, "the failing criterion is the amended one");
  assert.ok(result.detail.includes(AMENDED.history[0].why));
});

test("a criterion that survived the amendment is not reported as amended", async () => {
  // The distinction the report has to get right: an amendment replaces the whole list, so
  // most entries in it are the ones `spec.md` filed. Calling every command in an amended
  // task's gate "amended" would make the label mean nothing.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(
    { ...specWith(["true"]), acceptance: ["exit 5", "true"] },
    state,
    { filed: ["exit 5"], history: [{ ...AMENDED.history[0], acceptance: ["exit 5", "true"] }] },
  );

  assert.equal(result.passed, false);
  assert.match(result.detail, /exited 5/);
  assert.doesNotMatch(
    result.detail,
    /`exit 5` (is|was) .*amend/,
    "a criterion as filed must not be labelled amended",
  );
});

test("a task with no amendments gets exactly the report it got before", async () => {
  const worktree = await scratch();
  const { bindings } = ciForge({});
  const spec = { ...specWith(["true"]), acceptance: ["true"] };
  const withPr = {
    ...state,
    prs: [{ number: 1, url: "https://example.invalid/r/1", repo: PRIMARY }],
  };

  const plain = await ciVerifier(worktree, bindings).verify(spec, withPr);
  const empty = await ciVerifier(worktree, bindings).verify(spec, withPr, {
    filed: spec.acceptance,
    history: [],
  });

  assert.equal(plain.passed, true, plain.detail);
  assert.doesNotMatch(plain.detail, /amend/i);
  // An empty history is what `listAmendments` returns for almost every task, so passing it
  // must be indistinguishable from passing nothing.
  assert.equal(empty.detail, plain.detail);
});

/* ─────────────────── the branch is gone because the work landed ─────────────────── */

/**
 * A forge whose ref does not exist — the shape both forges report for a deleted branch.
 *
 * `BS-1540288291008684052-04`'s work was merged by hand through the GitHub UI, which
 * deletes the head branch by default. Nine sessions later the task was still parked, with
 * every acceptance criterion passing on the default branch, because the gate could not be
 * run at all: `checks` threw and the session died before it could reach a verdict.
 */
const absentRefForge = (): WorkspaceBindings => {
  const forge = {
    kind: "stub",
    checks: (_repo: RepoRef, ref: string) =>
      Promise.resolve({
        conclusion: "none" as const,
        summary: `ref '${ref}' does not exist`,
        refAbsent: true,
      }),
    revoke: () => Promise.resolve(),
  } as unknown as Forge;

  return {
    forges: new Map([
      [asWorkspaceName("test"), { forTask: () => Promise.resolve(forge) }],
    ]) as never,
    trackers: new Map(),
  };
};

test("a task whose branch is gone reaches a verdict instead of crashing", async () => {
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings: absentRefForge(),
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, true, result.detail);
  assert.notEqual(result.pending, true);
});

test("a gone branch is reported as work that landed, not as a repo without CI", async () => {
  // The two are both `none` and they are not the same event. "Completion rests on
  // acceptance criteria alone where CI is absent" is a true sentence about a repo that
  // configured no CI and a false one about a merged pull request whose CI ran and passed
  // — it sends a reader looking for a missing workflow that was never missing.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings: absentRefForge(),
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.match(result.detail, /branch no longer exists/);
  assert.match(result.detail, /merged/, "the reader has to be told why it is gone");
  assert.doesNotMatch(
    result.detail,
    /acceptance criteria alone/,
    "that warning is about a repo with no CI, which this is not",
  );
});

test("an existing ref that simply reported nothing keeps the no-CI warning", async () => {
  // The other half of the distinction, and the reason it needs a flag rather than a
  // conclusion: a repo with no CI must not start reading as a landed change.
  const worktree = await scratch();
  const { bindings } = ciForge({ "o/r": "none" });
  const result = await ciVerifier(worktree, bindings).verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /acceptance criteria alone/);
  assert.doesNotMatch(result.detail, /branch no longer exists/);
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

test("the last poll waits out the budget, not a whole interval past it", async () => {
  // The budget is not a multiple of the interval, which is the only case where the
  // deadline clamp binds. Without `Math.min(pollMs, remaining)` the second sleep runs a
  // full 2s from 1.5s and the wait ends at 3.5s — 40% past a budget an operator set.
  // The existing bounded-wait test cannot see this: 5_000/1_000 divides exactly.
  const worktree = await scratch();
  const { bindings } = forgeAnswering(["pending"]);
  let clock = 0;
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, {
    bindings,
    ci: {
      settleMs: 2_500,
      pollMs: 2_000,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  });

  const result = await verifier.verify(specWith(["true"]), stateWithPr);

  assert.equal(result.pending, true);
  assert.equal(clock, 2_500, "the wait must stop at the deadline, not at the next poll");
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

test("a silent exit 127 is annotated on the code alone", async () => {
  // The predicate has two arms and the text arm carries every other test here, because a
  // real missing binary prints "command not found". This pins the exit-code arm: a wrapper
  // that swallows stderr, or a shell whose message is localised, still exits 127 and still
  // means the same thing. Without the `code === 127` arm the note silently stops appearing.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["exit 127"]), state);

  assert.equal(result.passed, false);
  assert.match(result.detail, /no acceptance command installs dependencies/);
});

test("a not-found failure still fails the gate", async () => {
  // The note explains; it must never excuse. A command that cannot run has not passed.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(["definitely-not-a-real-binary"]), state);

  assert.equal(result.passed, false);
});

/* ─────────────────────── evidence a gate leaves behind (§12) ─────────────────────── */

/**
 * A recording stand-in for the state repo's artifact side.
 *
 * `StateStore` satisfies `EvidenceStore` structurally, so this is the whole surface the
 * verifier is given — no git, no mutex, no clone. The caps are enforced here rather than
 * asserted about, because it is the store that owns them (§17) and a fake that let
 * everything through would test the wrong half.
 */
const evidenceStore = (
  limits: { readonly bytes?: number; readonly count?: number } = {},
): {
  readonly store: EvidenceStore;
  readonly stored: Map<string, Buffer>;
} => {
  const stored = new Map<string, Buffer>();
  const maxBytes = limits.bytes ?? ARTIFACT_BYTES;
  const maxCount = limits.count ?? ARTIFACT_COUNT;

  return {
    stored,
    store: {
      writeArtifact: (_task, name, contents) => {
        if (contents.byteLength > maxBytes) {
          return Promise.reject(
            new Error(`'${name}' is ${contents.byteLength} bytes; the limit is ${maxBytes}`),
          );
        }
        if (!stored.has(name) && stored.size >= maxCount) {
          return Promise.reject(new Error(`already has ${stored.size} artifacts`));
        }
        stored.set(name, contents);
        return Promise.resolve();
      },
    },
  };
};

/** A verifier that collects evidence, with the evidence directory under the test's control. */
const evidenceVerifier = (
  worktree: string,
  evidence: EvidenceStore,
  evidenceDir: string,
): AcceptanceVerifier =>
  new AcceptanceVerifier({
    worktrees: {
      ensureWorktree: () => Promise.resolve(worktree),
    } as unknown as WorktreeManager,
    bindings: { forges: new Map(), trackers: new Map() },
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      identity: TEST_IDENTITY,
      baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    }),
    evidence: { store: evidence, dir: () => evidenceDir },
  });

/**
 * A branch that no longer merges (DESIGN.md §12.3).
 *
 * Reported HERE rather than left to the council's merge. Both gates passing and then the
 * merge failing is a terminal-looking failure caused by ordinary drift, arriving at the
 * one point in the task where nothing is left to fix it.
 */
const conflictVerifier = (
  worktree: string,
  bindings: WorkspaceBindings,
  conflicts: Awaited<ReturnType<WorktreeManager["conflictsWithBase"]>>,
): AcceptanceVerifier =>
  new AcceptanceVerifier({
    worktrees: {
      ensureWorktree: () => Promise.resolve(worktree),
      defaultBranch: () => Promise.resolve("main"),
      conflictsWithBase: () => Promise.resolve(conflicts),
    } as unknown as WorktreeManager,
    bindings,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: worktree,
      identity: TEST_IDENTITY,
      baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    }),
  });

test("a gate is told where to leave evidence", async () => {
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store, stored } = evidenceStore();

  await evidenceVerifier(worktree, store, dir).verify(
    specWith([`test "$CATERPILLAR_EVIDENCE_DIR" = ${dir} && echo shot > "$CATERPILLAR_EVIDENCE_DIR/shot.png"`]),
    state,
  );

  assert.deepEqual([...stored.keys()], ["shot.png"]);
  assert.equal(String(stored.get("shot.png")).trim(), "shot");
});

test("the evidence directory exists before the gate runs", async () => {
  // A gate cannot be asked to create it: `npx playwright test` writes where its config
  // says and fails if the parent is missing, which would read as a broken test run.
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store, stored } = evidenceStore();

  const result = await evidenceVerifier(worktree, store, dir).verify(
    specWith(['test -d "$CATERPILLAR_EVIDENCE_DIR" && cp /dev/null "$CATERPILLAR_EVIDENCE_DIR/empty.txt"']),
    state,
  );

  assert.match(result.detail, new RegExp(NO_PR), "the gate itself must have passed");
  assert.deepEqual([...stored.keys()], ["empty.txt"]);
});

test("a FAILED gate's evidence is published too", async () => {
  // The whole point. A screenshot matters most when the gate went red, and the old
  // behaviour — nothing at all — threw away the one thing that explains the failure.
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store, stored } = evidenceStore();

  const result = await evidenceVerifier(worktree, store, dir).verify(
    specWith(['echo broken > "$CATERPILLAR_EVIDENCE_DIR/diff.png"; exit 1']),
    state,
  );

  assert.equal(result.passed, false);
  assert.deepEqual([...stored.keys()], ["diff.png"]);
  assert.match(result.detail, /diff\.png/, "the failure has to name the evidence it left");
});

test("evidence over the cap is named and refused, never silently dropped", async () => {
  // §17's caps are the design. The failure has to be legible: an operator reading the
  // journal must be able to tell "too big to commit" from "the gate wrote nothing".
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store, stored } = evidenceStore({ bytes: 16 });

  const result = await evidenceVerifier(worktree, store, dir).verify(
    specWith([`printf '%0.s-' {1..64} > "$CATERPILLAR_EVIDENCE_DIR/huge.png"`]),
    state,
  );

  assert.equal(stored.size, 0);
  assert.match(result.detail, /huge\.png/);
  assert.match(result.detail, /64 bytes/, "how big it was");
  assert.match(result.detail, /the limit is 16/, "and what the limit is");
});

test("evidence over the cap does not change the verdict", async () => {
  // An image is evidence, never the pass condition. A gate that exited 0 and wrote a
  // 4 MB screenshot has passed; a gate that exited 1 and wrote a small one has not.
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store } = evidenceStore({ bytes: 4 });

  const passed = await evidenceVerifier(worktree, store, dir).verify(
    specWith(['echo far-too-big > "$CATERPILLAR_EVIDENCE_DIR/big.png"']),
    state,
  );

  // Gate 1 passed, so the only thing left to refuse is gate 2's missing PR. The oversized
  // file is reported alongside it rather than instead of it.
  assert.match(passed.detail, new RegExp(NO_PR));
  assert.match(passed.detail, /big\.png/);
  assert.doesNotMatch(passed.detail, /Acceptance criteria failed/);
});

test("a gate that leaves nothing behind says nothing about evidence", async () => {
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  const { store, stored } = evidenceStore();

  const result = await evidenceVerifier(worktree, store, dir).verify(
    specWith(["echo nope >&2; exit 3"]),
    state,
  );

  assert.equal(stored.size, 0);
  assert.doesNotMatch(result.detail, /evidence/i);
});

test("evidence from a previous run is not republished as this run's", async () => {
  // The directory lives on the PVC beside the worktree and survives between sessions, so
  // a stale screenshot would otherwise be offered to the council as evidence about a diff
  // it predates.
  const worktree = await scratch();
  const dir = join(await scratch(), "evidence");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "stale.png"), "from last session", "utf8");
  const { store, stored } = evidenceStore();

  await evidenceVerifier(worktree, store, dir).verify(specWith(["true"]), state);

  assert.deepEqual([...stored.keys()], []);
});

test("a verifier with no evidence collaborator behaves exactly as before", async () => {
  // The seam is optional: a runner wired without it must not start failing gates, and
  // `CATERPILLAR_EVIDENCE_DIR` must be absent rather than empty so `test -d` is honest.
  const worktree = await scratch();
  const verifier = verifierFor(worktree, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });

  const result = await verifier.verify(specWith(['test -z "$CATERPILLAR_EVIDENCE_DIR"']), state);

  assert.equal(result.detail, NO_PR);
});

/* a branch that no longer merges into its base (DESIGN.md §12.3) */

test("a branch that no longer merges fails the gate, naming the files", async () => {
  const worktree = await scratch();
  const { bindings } = ciForge({});
  const result = await conflictVerifier(worktree, bindings, {
    tree: "abc123",
    files: [{ path: "src/forge/types.ts", hunks: 3 }],
  }).verify(specWith(["true"]), stateWithPr);

  assert.equal(result.passed, false);
  assert.match(result.detail, /src\/forge\/types\.ts/);
  // Not `pending`: nothing settles by waiting, and the next session has real work to do.
  assert.notEqual(result.pending, true);
});

test("a branch that merges cleanly passes the gate as before", async () => {
  const worktree = await scratch();
  const { bindings } = ciForge({});
  const result = await conflictVerifier(worktree, bindings, undefined).verify(
    specWith(["true"]),
    stateWithPr,
  );

  assert.equal(result.passed, true, result.detail);
});

test("a mergeability question git could not answer does not fail the gate", async () => {
  // Same rule the merge-queue detection follows: an unanswerable question must not be
  // what stops a change that passed everything else.
  const worktree = await scratch();
  const { bindings } = ciForge({});
  const result = await conflictVerifier(worktree, bindings, "unknown").verify(
    specWith(["true"]),
    stateWithPr,
  );

  assert.equal(result.passed, true, result.detail);
});

/* ---- post-merge re-verification of a remediation task (§20) ---------------------- */

/**
 * The second gate this file now covers, and it is a different one.
 *
 * §12 asks "is this change any good"; §20 asks "did it work" — whether the alert the task
 * was created for actually stopped once the fix merged. `remediation/verify.ts` decides
 * from the evidence; `AlertReverifier` is what the fleet then does about it, and the two
 * properties worth asserting here are the ones that make the loop close honestly:
 *
 *   a failed re-verification RESETS the fingerprint's record, so a subsequent firing can
 *   become work again — without that, `ALERT-<fingerprint>` dedup means an ineffective fix
 *   permanently suppresses its own alert, which is worse than never having checked;
 *
 *   a re-verification that could not be performed reports exactly that and clears nothing.
 *
 * The store is a fake: what these tests assert is the sequence of record writes and
 * deletions, and a real `StateStore` would put a git invocation between every one of them.
 */
const ALERT_TASK = asTaskId("ALERT-a1b2c3d4");
const FINGERPRINT = "a1b2c3d4";
const MERGED_AT = "2026-08-23T12:00:00.000Z";

/** `MERGED_AT` plus some minutes, as an ISO string. */
const at = (minutes: number): string =>
  new Date(Date.parse(MERGED_AT) + minutes * 60_000).toISOString();

class FakeAlertStore implements ReverifyStore {
  readonly records = new Map<string, AlertRefusal>();
  readonly cleared: string[] = [];

  constructor(record?: AlertRefusal) {
    if (record !== undefined) this.records.set(record.fingerprint, record);
  }

  listAlertRefusals(): Promise<readonly AlertRefusal[]> {
    return Promise.resolve([...this.records.values()]);
  }

  readAlertRefusal(fingerprint: string): Promise<AlertRefusal | undefined> {
    return Promise.resolve(this.records.get(fingerprint));
  }

  writeAlertRefusal(fingerprint: string, record: AlertRefusal): Promise<void> {
    this.records.set(fingerprint, record);
    return Promise.resolve();
  }

  clearAlertRefusal(fingerprint: string): Promise<void> {
    this.cleared.push(fingerprint);
    this.records.delete(fingerprint);
    return Promise.resolve();
  }
}

const alertRecord = (over: Partial<AlertRefusal> = {}): AlertRefusal => ({
  fingerprint: FINGERPRINT,
  alertname: "CaterpillarNoProgress",
  reason: "created",
  task: ALERT_TASK,
  ...over,
});

const reverifier = (
  store: ReverifyStore,
  now: () => number = () => Date.parse(at(20)),
): AlertReverifier => new AlertReverifier({ store, logger: SILENT_LOGGER, now });

test("beginning a re-verification stamps the merge instant and the window", async () => {
  const store = new FakeAlertStore(alertRecord());

  const began = await reverifier(store).begin(ALERT_TASK, 900);

  assert.equal(began, true);
  const verify = store.records.get(FINGERPRINT)?.verify;
  assert.equal(verify?.settleSeconds, 900);
  // The supervisor's clock at the moment of the merge, so every later comparison has one
  // fixed instant to be relative to.
  assert.equal(verify?.mergedAt, at(20));
  // Nothing else about the record moves: `alertname` and `task` are what
  // `countOpenAlertTasks` joins on, and losing either would free the alert's slot early.
  assert.equal(store.records.get(FINGERPRINT)?.alertname, "CaterpillarNoProgress");
  assert.equal(store.records.get(FINGERPRINT)?.task, ALERT_TASK);
});

test("a task with no alert record cannot be re-verified and says so", async () => {
  // A remediation task whose record an operator deleted, or one from before this existed.
  // It must not be held open forever waiting for evidence that will never be filed.
  const store = new FakeAlertStore();

  assert.equal(await reverifier(store).begin(ALERT_TASK, 900), false);
  assert.equal(await reverifier(store).pending(ALERT_TASK), false);
});

test("a task id that is not an alert's is not re-verified at all", async () => {
  // Every other intake path produces tasks with no alert behind them. Asking about them
  // must be free and must never touch the store.
  const store = new FakeAlertStore(alertRecord());

  assert.equal(await reverifier(store).begin(asTaskId("GH-acme-widget-12"), 900), false);
  assert.equal(await reverifier(store).pending(asTaskId("GH-acme-widget-12")), false);
});

test("a re-verification is pending from the merge until a verdict is reached", async () => {
  const store = new FakeAlertStore(alertRecord());
  const clock = { now: Date.parse(at(0)) };
  const subject = new AlertReverifier({ store, logger: SILENT_LOGGER, now: () => clock.now });

  assert.equal(await subject.pending(ALERT_TASK), false);
  await subject.begin(ALERT_TASK, 600);
  // Held: nothing has been delivered and the window has not run out. This is what stops a
  // session being started on a task whose fix has merged and is settling.
  assert.equal(await subject.pending(ALERT_TASK), true);

  clock.now = Date.parse(at(11));
  const verdict = await subject.settle(ALERT_TASK);
  assert.equal(verdict?.kind, "unverifiable");
  // Decided, so no longer pending: `settle` is what ends the hold, either way.
  assert.equal(await subject.pending(ALERT_TASK), false);
});

test("an alert that cleared settles as cleared and leaves the record in place", async () => {
  const store = new FakeAlertStore(
    alertRecord({ verify: { mergedAt: MERGED_AT, settleSeconds: 600, resolvedAt: at(4) } }),
  );

  const verdict = await reverifier(store).settle(ALERT_TASK);

  assert.equal(verdict?.kind, "cleared");
  // NOT deleted. The record is what `countOpenAlertTasks` joins to `tasks/`, and removing
  // it on the success path would free the alertname's slot while the task is still being
  // recorded as done — so a firing in that window would open a second task for an incident
  // that was just fixed.
  assert.deepEqual(store.cleared, []);
  // The `verify` block goes, though: the question has been answered, and a record still
  // carrying one would hold the task open again after a restart.
  assert.equal(store.records.get(FINGERPRINT)?.verify, undefined);
});

test("an alert still firing resets the record so a re-fire becomes work again", async () => {
  const store = new FakeAlertStore(
    alertRecord({ verify: { mergedAt: MERGED_AT, settleSeconds: 600, lastFiringAt: at(9) } }),
  );

  const verdict = await reverifier(store).settle(ALERT_TASK);

  assert.equal(verdict?.kind, "still-firing");
  // THE POINT OF THE WHOLE FEATURE. The task id is `ALERT-<fingerprint>`, so without this
  // the next firing of the same alert is deduped against a task that already exists and
  // never becomes work — the fix that did not work would permanently suppress its own
  // alert, which is a worse outcome than never having checked.
  assert.deepEqual(store.cleared, [FINGERPRINT]);
});

test("an alert that could not be re-verified resets the record too", async () => {
  const store = new FakeAlertStore(
    alertRecord({ verify: { mergedAt: MERGED_AT, settleSeconds: 600 } }),
  );

  const verdict = await reverifier(store).settle(ALERT_TASK);

  assert.equal(verdict?.kind, "unverifiable");
  // Reset for the same reason as a failure, and deliberately not treated like a clear:
  // nothing established that this alert stopped, so the next firing must be allowed to
  // open work. Treating "could not check" as "cleared" is what would make the silent
  // success this feature removes reappear one layer up.
  assert.deepEqual(store.cleared, [FINGERPRINT]);
});

test("settling a task with no pending re-verification answers nothing", async () => {
  const store = new FakeAlertStore(alertRecord());

  assert.equal(await reverifier(store).settle(ALERT_TASK), undefined);
  assert.deepEqual(store.cleared, []);
});

test("every task now due a verdict is listed, and one still waiting is not", async () => {
  const store = new FakeAlertStore();
  store.records.set("aaaa", {
    fingerprint: "aaaa",
    alertname: "A",
    reason: "created",
    task: asTaskId("ALERT-aaaa"),
    verify: { mergedAt: MERGED_AT, settleSeconds: 600, lastFiringAt: at(9) },
  });
  store.records.set("bbbb", {
    fingerprint: "bbbb",
    alertname: "B",
    reason: "created",
    task: asTaskId("ALERT-bbbb"),
    // Merged much later: still inside its window at the clock below.
    verify: { mergedAt: at(19), settleSeconds: 600 },
  });
  // No `verify` at all: an ordinary open remediation task, not a settling one.
  store.records.set("cccc", {
    fingerprint: "cccc",
    alertname: "C",
    reason: "created",
    task: asTaskId("ALERT-cccc"),
  });

  const due = await reverifier(store).due();

  assert.deepEqual(
    due.map((entry) => entry.task),
    [asTaskId("ALERT-aaaa")],
  );
  assert.equal(due[0]?.verdict.kind, "still-firing");
});

test("a store that cannot be read reports nothing due rather than throwing", async () => {
  // This runs on the housekeeping pass, which must survive a filesystem that is answering
  // errors — that is exactly when it is most worth having.
  const broken: ReverifyStore = {
    listAlertRefusals: () => Promise.reject(new Error("EIO")),
    readAlertRefusal: () => Promise.reject(new Error("EIO")),
    writeAlertRefusal: () => Promise.reject(new Error("EIO")),
    clearAlertRefusal: () => Promise.reject(new Error("EIO")),
  };
  const subject = reverifier(broken);

  assert.deepEqual(await subject.due(), []);
  // And a task whose record cannot be read is NOT reported as pending: holding it open on
  // the strength of an unreadable record would wedge it on every poll.
  assert.equal(await subject.pending(ALERT_TASK), false);
  assert.equal(await subject.begin(ALERT_TASK, 600), false);
});

test("a record whose task id does not match its own file is not acted on", async () => {
  // The fingerprint is the file name and `ALERT-<fingerprint>` is the task id, so the two
  // agreeing is an invariant of the write path — but the record is JSON in a git repo a
  // human can edit, and acting on a mismatch would let one record settle another's task.
  const store = new FakeAlertStore(
    alertRecord({
      task: asTaskId("ALERT-deadbeef"),
      verify: { mergedAt: MERGED_AT, settleSeconds: 600, lastFiringAt: at(9) },
    }),
  );

  assert.deepEqual(await reverifier(store).due(), []);
  assert.equal(await reverifier(store).settle(ALERT_TASK), undefined);
  assert.deepEqual(store.cleared, []);
});

test("the window comes from the record, not from whatever the caller believes now", async () => {
  // The policy entry can change while a fix is in review. The window a task is held for is
  // the one that was in force when its fix merged, because that is the number the journal
  // entry and the digest line already quoted.
  const store = new FakeAlertStore(
    alertRecord({ verify: { mergedAt: MERGED_AT, settleSeconds: 7200 } }),
  );

  assert.equal(
    await reverifier(store, () => Date.parse(at(30))).settle(ALERT_TASK),
    undefined,
    "still inside a two-hour window",
  );
  assert.equal((await reverifier(store, () => Date.parse(at(130))).settle(ALERT_TASK))?.kind, "unverifiable");
});
