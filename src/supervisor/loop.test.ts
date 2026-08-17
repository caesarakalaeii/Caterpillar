/**
 * The supervisor's failure path, driven over a REAL git remote so the lease
 * compare-and-swap is the genuine article rather than a stub that always agrees.
 *
 * That matters here more than usual: the bug this pins was invisible precisely because
 * the losing step was a CAS against a ref that had already been deleted.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import {
  asRunnerId,
  asTaskId,
  asWorkspaceName,
  EMPTY_USAGE,
  type SessionOutcome,
  type TaskId,
  type TaskState,
} from "../domain/task.ts";
import type { Forge } from "../forge/types.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { type Notifier, NullNotifier } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import type { Council } from "../review/council.ts";
import { decide } from "../review/decide.ts";
import { Git } from "../state/git.ts";
import { LeaseManager, leaseRef } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { ChatInbox, type ChatOutcome } from "./inbox.ts";
import { Supervisor, type ProgressProbe, type SessionRunner, type Verifier } from "./loop.ts";

const TASK = asTaskId("SMOKE-1");
const DONE_TASK = asTaskId("SMOKE-2");

const root = await mkdtemp(join(tmpdir(), "caterpillar-loop-"));
const origin = join(root, "origin.git");
const statePath = join(root, "state");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = new Git(root);
await setup.run("init", "--bare", "--initial-branch=main", origin);
await setup.run("clone", origin, statePath);

const stateGit = new Git(statePath);
// Locally, never from the operator's global config — a machine runner would otherwise
// author the audit trail as whoever happens to be logged in.
await stateGit.run("config", "user.name", "caterpillar");
await stateGit.run("config", "user.email", "caterpillar@example.invalid");
await stateGit.run("symbolic-ref", "HEAD", "refs/heads/main");

const seed: TaskState = {
  id: TASK,
  status: "ready",
  phase: "implementing",
  requires: [],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
};

/**
 * Put a claimable task on the REMOTE.
 *
 * Called per test rather than once up front: every supervisor here claims whatever is
 * `ready`, so a task seeded before the test that wants it gets picked up — and failed —
 * by the test that ran first.
 */
const seedTask = async (id: TaskId, over: Partial<TaskState> = {}): Promise<void> => {
  await stateGit.tryRun("pull", "--ff-only", "origin", "main");
  await mkdir(join(statePath, "tasks", id), { recursive: true });
  await writeFile(
    join(statePath, "tasks", id, "spec.md"),
    [
      "---",
      "workspace: test",
      "repos:",
      "  - github.com/acme/widget",
      "acceptance:",
      '  - "true"',
      "---",
      "",
      "Prove the pipeline runs.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(statePath, "tasks", id, "state.json"),
    `${JSON.stringify({ ...seed, id, ...over }, null, 2)}\n`,
  );
  await stateGit.run("add", "-A");
  await stateGit.run("commit", "-m", `seed ${id}`);
  await stateGit.run("push", "origin", "HEAD:main");
};

await seedTask(TASK);

const config: RunnerConfig = {
  runnerId: "test-runner",
  capabilities: ["linux"],
  identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  toolchain: DEFAULT_TOOLCHAIN_CONFIG,
  stateRepo: { url: origin, branch: "main", path: statePath },
  paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks") },
  // A heartbeat long enough never to fire: this test is about the failure path, and a
  // renewal landing mid-park would muddy which CAS was under test.
  lease: { heartbeatSeconds: 3600, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: { maxSessionsPerTask: 20, noProgressLimit: 3, maxReviewRounds: 3, maxSessionSeconds: 3600, commandTimeoutSeconds: 900 },
  log: { level: "info" },
  intake: { intervalSeconds: 300 },
  llm: {
    auth: "proxy",
    baseUrl: "http://localhost",
    modelId: "test",
    providerId: "test",
    contextWindow: 100_000,
    maxTokens: 4096,
    // Longer than the outage test's observation window, so "did it claim again" is a
    // question about the cooldown rather than a race with it.
    cooldown: { initialSeconds: 30, maxSeconds: 60 },
  },
  workspaces: new Map(),
  pollSeconds: 1,
  secretsDir: join(root, "secrets"),
  // No web view in the loop's tests: these exercise the supervisor, and a listening
  // socket per fixture is a port collision waiting for a parallel run.
  digest: { enabled: false, hour: 18, timeZone: "Europe/Berlin", summarise: true },
  cluster: {
    enabled: false,
    namespaces: [],
    lokiUrl: "http://loki.invalid",
    kubeApiUrl: "https://kube.invalid",
    maxLogLines: 2000,
  },
  web: {
    enabled: false,
    port: 8080,
    logCapacity: 500,
    refreshSeconds: 10,
    requireForwardedUser: false,
    forwardedUserHeader: "remote-user",
  },
};

/**
 * Every task here declares no toolchain, so this only ever answers "inherited".
 *
 * `gcIntervalHours: 0` would make the idle branch collect the store on the second poll,
 * which these tests hit constantly at `pollSeconds: 1` — the default keeps it out of the
 * way. The first call only stamps the clock, so no collection happens either way.
 */
const TEST_TOOLCHAIN = new ToolchainResolver({
  logger: SILENT_LOGGER,
  config: DEFAULT_TOOLCHAIN_CONFIG,
  tasksDir: join(root, "tasks"),
});

/**
 * Take a task out of circulation once a test is done with it.
 *
 * Only the outage tests need this, and they need it for the reason they exist: an outage
 * deliberately leaves the task `ready`, and every supervisor in this file claims whatever
 * is `ready`. Without it, one test's released task becomes the next test's first claim.
 */
const retire = (id: TaskId): Promise<void> => seedTask(id, { status: "done" });

/** What the state repo's REMOTE says — the only evidence a push actually landed. */
const pushedState = async (task: TaskId = TASK): Promise<TaskState | undefined> => {
  const result = await new Git(origin).tryRun("show", `main:tasks/${task}/state.json`);
  if (result.code !== 0) return undefined;
  return JSON.parse(result.stdout) as TaskState;
};

test("a task whose session throws is parked on the REMOTE, not just locally", async () => {
  // The bug: `workTask` released the lease in its `finally`, and only then did the
  // caller try to park. `park` -> `push` -> `assertHeld` therefore CAS'd against a
  // lease ref that had just been deleted, threw LeaseLostError, and `parkFailed`
  // swallowed it. The supervisor logged "lease is no longer held by this runner" and
  // the task stayed `ready` on the remote — so the very next poll re-claimed it and
  // failed again, forever.
  //
  // Asserted against the REMOTE deliberately. `park` writes state.json locally BEFORE
  // pushing, so the working tree says "parked" either way — a test reading the
  // checkout passes with the bug still in place, and the next `pull` would reset it
  // back anyway.
  const runner: SessionRunner = {
    run: () => Promise.reject(new Error("mirror clone failed: Repository not found")),
  };
  const verifier: Verifier = {
    verify: () => Promise.resolve({ passed: false, detail: "unused" }),
  };
  const progress: ProgressProbe = {
    probe: () =>
      Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier,
    progress,
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  let parked: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState();
    if (state?.status === "parked") {
      parked = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    parked !== undefined,
    "a failing task must reach `parked` on the remote, or it is re-claimed every poll",
  );
});

test("a notification that fails does not undo a task that finished", async () => {
  // Discord is a signal channel, not a source of truth (DESIGN.md §11). `notify` used to
  // be called bare inside `applyOutcome`, so once DiscordNotifier stopped being a stub
  // that threw unconditionally and started making a real request, a webhook outage —
  // or a webhook deleted in the UI — unwound into the catch in `workTask` and parked a
  // task the supervisor had just verified and pushed as `done`.
  //
  // The verifier passes here, so `done` is the CORRECT terminal state; anything else on
  // the remote means the notification rewrote it.
  await seedTask(DONE_TASK);

  const outcome: SessionOutcome = {
    reason: "done-claimed",
    usage: EMPTY_USAGE,
    contextTokens: 0,
    summary: "claiming completion",
  };
  const runner: SessionRunner = { run: () => Promise.resolve(outcome) };
  const verifier: Verifier = {
    verify: () =>
      Promise.resolve({
        passed: true,
        detail: "acceptance commands exited 0",
        prUrl: "https://example.invalid/pr/1",
      }),
  };
  const progress: ProgressProbe = {
    probe: () =>
      Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
  };
  const notifier: Notifier = {
    notify: () => Promise.reject(new Error("Discord webhook rejected the message with 404")),
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier,
    progress,
    notifier,
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Waiting for the LEASE to be released, not merely for a terminal status: with the
  // bug, `done` is pushed first and only then overwritten by the park, so a poll that
  // stops at the first terminal state it sees passes either way. The lease is dropped
  // in `workTask`'s finally, after every write the supervisor is going to make.
  let settled: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState(DONE_TASK);
    const held = await new Git(origin).tryRun("show-ref", "--verify", leaseRef(DONE_TASK));
    if (state !== undefined && state.status !== "ready" && held.code !== 0) {
      settled = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(settled?.status, "done", "a failed notification must not rewrite task state");
});

test("an answer from the bridge unparks the task on the REMOTE", async () => {
  // The inbound half of DESIGN.md §7, which until now was a human editing the state
  // repo by hand. Asserted on the remote for the same reason as every other test here:
  // the working copy says `ready` whether or not the push landed.
  //
  // The streak reset is not cosmetic. `awaiting-human` is reached from a session that
  // produced no commit, so a task answered at the no-progress limit would park again on
  // the very next claim WITHOUT running — the answer would be silently pointless.
  const ANSWERED = asTaskId("SMOKE-3");
  await seedTask(ANSWERED);

  const store = new StateStore(statePath, stateGit);
  const parked: TaskState = {
    ...seed,
    id: ANSWERED,
    status: "awaiting-human",
    sessions: 4,
    progress: { lastProgressSession: 1, noProgressStreak: 3 },
  };
  await store.writeQuestion(ANSWERED, 4, "Which migration path?");
  await store.writeState(parked);
  await store.commitAndPush(`chore(${ANSWERED}): awaiting human`, "origin", "main");

  const inbox = new ChatInbox();
  const runner: SessionRunner = {
    // Claiming it is proof enough that the answer took effect; the session itself is
    // not what this test is about.
    run: () => Promise.reject(new Error("session not under test")),
  };
  const supervisor = new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    inbox,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  const outcome = await inbox.submit({ kind: "answer", task: ANSWERED, text: "Use the existing migration path." });

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(outcome, { kind: "applied", index: 4 });

  const pushed = await pushedState(ANSWERED);
  assert.notEqual(pushed?.status, "awaiting-human", "the answer must unpark the task");
  assert.equal(
    pushed?.progress.noProgressStreak,
    0,
    "an answered task must not park again before it runs",
  );

  const answer = await new Git(origin).tryRun(
    "show",
    `main:tasks/${ANSWERED}/questions/004-answer.md`,
  );
  assert.equal(answer.code, 0, "the answer file must be pushed, not just written locally");
  assert.match(answer.stdout, /existing migration path/);
});

test("an answer for a task that is not waiting is refused, not written", async () => {
  const inbox = new ChatInbox();
  const store = new StateStore(statePath, stateGit);
  const supervisor = new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: { run: () => Promise.reject(new Error("session not under test")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    inbox,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // TASK is `parked` from the first test in this file — a real state, and not one an
  // answer may resurrect: nothing asked a question.
  const outcome = await inbox.submit({ kind: "answer", task: TASK, text: "please continue" });
  const unknown = await inbox.submit({ kind: "answer", task: asTaskId("NO-SUCH-TASK"), text: "hello?" });

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(outcome.kind, "not-waiting");
  assert.deepEqual(unknown, { kind: "unknown-task" });
});

test("a blocking verdict sends the task back, and a stalemate parks it", async () => {
  // The council is the third gate, not a second opinion: `done-claimed` with both §12
  // gates green must still not reach `done` while a reviewer is objecting. And because
  // the task goes back to the SAME agent, which claims done again, the pair can trade it
  // forever — so the round cap is the thing that actually terminates this, and it is
  // asserted here rather than assumed.
  const STUBBORN = asTaskId("SMOKE-COUNCIL-1");
  await seedTask(STUBBORN, { pr: { number: 9, url: "https://example.invalid/pr/9" } });

  let convened = 0;
  const council: Council = {
    reviewPlan: () => Promise.reject(new Error("not a brainstorm")),
    review: () => {
      convened += 1;
      return Promise.resolve({
        usage: EMPTY_USAGE,
        verdict: decide([
          {
            lens: "correctness",
            title: "Correctness",
            decision: "changes",
            blocking: true,
            summary: "Throws on an empty repo list.",
            findings: [{ where: "runner.ts:107", what: "spec.repos[0] is undefined" }],
          },
        ]),
      });
    },
  };

  const supervisor = new Supervisor({
    // Two rounds rather than the default three, so the stalemate is reached before the
    // test's own deadline rather than because of it.
    config: { ...config, limits: { ...config.limits, maxReviewRounds: 2 } },
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: () =>
        Promise.resolve({
          reason: "done-claimed",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "claiming completion",
        } satisfies SessionOutcome),
    },
    verifier: { verify: () => Promise.resolve({ passed: true, detail: "acceptance passed" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    council,
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  let settled: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState(STUBBORN);
    if (state?.status === "parked") {
      settled = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(settled?.status, "parked", "a task the council keeps rejecting must not run forever");
  assert.equal(settled?.review?.rounds, 2, "the round cap is what stops it");
  assert.equal(convened, 2, "the council must be convened once per completion claim");

  // The verdict is a document, not just a log line: the next session reads the journal,
  // and a human reads the file.
  const verdict = await new Git(origin).tryRun(
    "show",
    `main:tasks/${STUBBORN}/reviews/001-verdict.md`,
  );
  assert.equal(verdict.code, 0, "each verdict must be pushed, not just written locally");
  assert.match(verdict.stdout, /CHANGES REQUESTED/);
  assert.match(verdict.stdout, /runner\.ts:107/);
});

test("a passing verdict is approved and merged by the reviewer identity", async () => {
  // The order is the point. GitHub refuses a merge on a protected branch until an
  // approving review exists, and refuses that review from the PR's own author — so
  // approve-then-merge through a SECOND identity is the only sequence that works
  // (DESIGN.md §9.1, §12.1).
  const MERGED = asTaskId("SMOKE-COUNCIL-2");
  await seedTask(MERGED, { pr: { number: 11, url: "https://example.invalid/pr/11" } });

  const calls: string[] = [];
  const reviewerForge: Forge = {
    kind: "fake-reviewer",
    credential: () => Promise.reject(new Error("the reviewer never checks anything out")),
    openPr: () => Promise.reject(new Error("the reviewer never opens PRs")),
    checks: () => Promise.reject(new Error("unused")),
    approve: (_repo, pr) => {
      calls.push(`approve:${pr}`);
      return Promise.resolve();
    },
    merge: (_repo, pr) => {
      calls.push(`merge:${pr}`);
      return Promise.resolve();
    },
    revoke: () => Promise.resolve(),
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: () =>
        Promise.resolve({
          reason: "done-claimed",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "claiming completion",
        } satisfies SessionOutcome),
    },
    verifier: {
      verify: () =>
        Promise.resolve({
          passed: true,
          detail: "acceptance passed",
          prUrl: "https://example.invalid/pr/11",
        }),
    },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    council: {
      reviewPlan: () => Promise.reject(new Error("not a brainstorm")),
      review: () =>
        Promise.resolve({
          usage: EMPTY_USAGE,
          verdict: decide([
            {
              lens: "correctness",
              title: "Correctness",
              decision: "pass",
              blocking: false,
              summary: "Reads correctly.",
              findings: [],
            },
          ]),
        }),
    },
    reviewers: new Map([[asWorkspaceName("test"), { forTask: () => Promise.resolve(reviewerForge) }]]),
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  let settled: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState(MERGED);
    const held = await new Git(origin).tryRun("show-ref", "--verify", leaseRef(MERGED));
    if (state !== undefined && state.status !== "ready" && held.code !== 0) {
      settled = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(settled?.status, "done");
  assert.deepEqual(calls, ["approve:11", "merge:11"], "approve must come first, or the merge is refused");
});

test("a blocked task is not claimed until its blocker is done", async () => {
  // The property that makes waves safe. Without it two agents can work a task and its
  // dependency at the same time on different branches, which on a multi-replica runner
  // is two sessions editing the same code — the exact hazard the graph exists to prevent.
  //
  // Both tasks are `ready`. Only the ordering and the blocker filter decide which is
  // claimable, and the blocked one sorts FIRST alphabetically, so `readdir` order alone
  // would pick the wrong one.
  const FIRST = asTaskId("SMOKE-WAVE-1");
  const SECOND = asTaskId("SMOKE-WAVE-0");

  await seedTask(FIRST, { plan: { parent: asTaskId("BS-1"), wave: 0, blockedBy: [] } });
  await seedTask(SECOND, {
    plan: { parent: asTaskId("BS-1"), wave: 1, blockedBy: [FIRST] },
  });

  const claimed: TaskId[] = [];
  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: (spec) => {
        claimed.push(spec.id);
        // Park it immediately, so the loop moves on rather than looping on one task.
        return Promise.resolve({
          reason: "limit",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "parked by the test",
        } satisfies SessionOutcome);
      },
    },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await pushedState(FIRST))?.status !== "parked") {
    await sleep(100);
  }
  // One more poll's worth of grace, so a wrongly-claimed blocked task has every chance
  // to show up before the assertion.
  await sleep(1500);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(claimed.includes(FIRST), "the unblocked task must be claimed");
  assert.equal(
    claimed.includes(SECOND),
    false,
    "a task whose blocker is not `done` must not be claimed, however it sorts",
  );
  assert.equal(
    (await pushedState(SECOND))?.status,
    "ready",
    "the blocked task stays ready — blocked is not a status, it is a predicate",
  );
});

test("a council slower than the heartbeat still lands its verdict on the remote", async () => {
  // THE REGRESSION. `applyOutcome` was handed a `Lease` VALUE read out of the heartbeat
  // before the council ran. A review takes minutes, a heartbeat rotates the fencing token
  // every 60s, and `assertHeld` compares the oid exactly — so `convene`'s push CAS'd
  // against a token three renewals old, threw LeaseLostError, and the task unwound. The
  // next poll's `pull()` (`git reset --hard`) then reverted every tracked write the
  // council had made, and the plan it had just approved existed only on the PVC.
  //
  // Every other test in this file sets `heartbeatSeconds: 3600` so the heartbeat never
  // fires, which is precisely why this survived. Here it MUST fire during the review.
  const SLOW = asTaskId("SMOKE-COUNCIL-2");
  await seedTask(SLOW, { pr: { number: 11, url: "https://example.invalid/pr/11" } });

  let convened = 0;
  const council: Council = {
    reviewPlan: () => Promise.reject(new Error("not a brainstorm")),
    review: async () => {
      convened += 1;
      // Comfortably longer than the 1s heartbeat below, so several renewals land while
      // the review is in flight — the real condition, not a simulated one.
      await sleep(2_500);
      return {
        usage: EMPTY_USAGE,
        verdict: decide([
          {
            lens: "correctness",
            title: "Correctness",
            decision: "pass",
            blocking: false,
            summary: "Reads correctly.",
            findings: [],
          },
        ]),
      };
    },
  };

  const supervisor = new Supervisor({
    config: { ...config, lease: { heartbeatSeconds: 1, staleAfterSeconds: 300 } },
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: () =>
        Promise.resolve({
          reason: "done-claimed",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "claiming completion",
        } satisfies SessionOutcome),
    },
    verifier: { verify: () => Promise.resolve({ passed: true, detail: "acceptance passed" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    council,
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  let settled: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState(SLOW);
    if (state?.status === "done") {
      settled = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(
    settled?.status,
    "done",
    "a passing council must reach `done` on the REMOTE — a renewal during the review is " +
      "normal, not a stolen lease",
  );
  assert.equal(settled?.review?.last, "pass", "the council's own state write must survive");
  assert.equal(
    convened,
    1,
    "one completion claim convenes one council — re-convening means the push was lost and " +
      "the task got re-claimed",
  );

  // The verdict document is the artifact a human and the next session both read, and it
  // is written before the push that was failing.
  const verdict = await new Git(origin).tryRun(
    "show",
    `main:tasks/${SLOW}/reviews/001-verdict.md`,
  );
  assert.equal(verdict.code, 0, "the verdict must be pushed, not left on the runner's disk");
});

/**
 * `/resume` — the inverse of `/cancel`, and the reason it has to exist.
 *
 * `parked` is terminal, so before this command the only way back was an operator editing
 * `state.json` in the state repo by hand. That is not a manual version of this: the loop
 * owns the working copy, so an out-of-band push lands between its pull and its push and
 * the push is rejected. It happened, and it took a task's session with it.
 *
 * Driven through the real inbox against a real remote, and asserted on the PUSHED state,
 * for the same reason the park test is: a resume that only writes locally is undone by
 * the next `pull()`.
 */
const resumeSupervisor = (
  store: StateStore,
  inbox: ChatInbox,
): Supervisor =>
  new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    // Claiming it is the proof; the session itself is not what these tests are about.
    runner: { run: () => Promise.reject(new Error("session not under test")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    inbox,
  });

/** Run one inbox request against a live supervisor and stop it again. */
const throughInbox = async (
  store: StateStore,
  intent: Parameters<ChatInbox["submit"]>[0],
): Promise<ChatOutcome> => {
  const inbox = new ChatInbox();
  const supervisor = resumeSupervisor(store, inbox);
  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  const outcome = await inbox.submit(intent);
  controller.abort();
  await running.catch(() => undefined);
  return outcome;
};

test("/resume puts a parked task back on the REMOTE, not just locally", async () => {
  const RESUMED = asTaskId("RESUME-1");
  await seedTask(RESUMED, { status: "parked", sessions: 2 });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: RESUMED });

  assert.deepEqual(outcome, { kind: "resumed", from: "parked" });

  const pushed = await pushedState(RESUMED);
  assert.equal(pushed?.status, "ready", "a resumed task must be `ready` on the remote");

  const journal = await new Git(origin).tryRun("show", `main:tasks/${RESUMED}/journal.md`);
  assert.equal(journal.code, 0, "the journal entry must be pushed, not just written");
  assert.match(journal.stdout, /Resumed/);
});

test("/resume refuses a task that is not parked, and writes nothing", async () => {
  // The opposite refusal from `/cancel`'s, which is why it is its own outcome: `done`
  // and `ready` are both wrong to resume, for opposite reasons.
  const LIVE = asTaskId("RESUME-2");
  await seedTask(LIVE, { status: "ready" });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: LIVE });

  assert.deepEqual(outcome, { kind: "not-resumable", status: "ready" });
  assert.equal((await pushedState(LIVE))?.status, "ready", "nothing should have been written");
});

test("/resume on an unknown task says so rather than creating one", async () => {
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, {
    kind: "resume",
    task: asTaskId("NO-SUCH-TASK-RESUME"),
  });

  assert.deepEqual(outcome, { kind: "unknown-task" });
});

test("/resume warns when the task will meet the same limit again", async () => {
  // Resuming deliberately does not reset the counters — the fix for "it used its twenty
  // sessions" is a human raising the limit, not a command that quietly forgives it. So
  // the reply has to say so, or the human finds out when it parks itself again.
  const SPENT = asTaskId("RESUME-3");
  await seedTask(SPENT, { status: "parked", sessions: 20 });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: SPENT });

  assert.equal(outcome.kind, "resumed");
  if (outcome.kind !== "resumed") return;
  assert.match(outcome.exhausted ?? "", /20 of 20 sessions/);
  assert.equal((await pushedState(SPENT))?.status, "ready", "it is still resumed, just warned about");
});

test("a provider outage releases the task and stops the runner claiming the next one", async () => {
  // 2026-08-15: the account's monthly spend limit was reached mid-session. pi does not
  // throw on a provider refusal — it ends the turn — so the supervisor read a 429 as
  // "session ended without a control-plane decision", started a fresh session two
  // seconds later, and did it again. Five sessions in nine seconds, three of them
  // without a single token, and the task parked citing "no measurable progress": a
  // verdict about the agent, for something the agent never saw. Every other ready task
  // was next in line for the same treatment.
  //
  // What must be true instead: the task is released untouched, and the RUNNER waits.
  const OUTAGE = asTaskId("OUTAGE-1");
  await seedTask(OUTAGE, { sessions: 1 });

  let sessions = 0;
  const runner: SessionRunner = {
    run: () => {
      sessions += 1;
      return Promise.resolve({
        reason: "provider-unavailable",
        usage: EMPTY_USAGE,
        contextTokens: 0,
        error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
        outage: { kind: "exhausted", status: 429, detail: "monthly spend limit" },
        summary: "the model provider stopped answering",
      } satisfies SessionOutcome);
    },
  };
  const verifier: Verifier = {
    verify: () => Promise.resolve({ passed: false, detail: "unused" }),
  };
  const progress: ProgressProbe = {
    probe: () =>
      assert.fail("the progress probe must not run for a session the provider refused"),
  };

  const notifications: string[] = [];
  const notifier: Notifier = {
    notify: (notification) => {
      notifications.push(notification.kind);
      return Promise.resolve();
    },
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier,
    progress,
    notifier,
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Long enough for several polls at `pollSeconds: 1`. Without the cooldown this is a
  // session per poll; with it, one session and then silence.
  await sleep(3_000);
  controller.abort();
  await running.catch(() => undefined);

  assert.equal(sessions, 1, "the runner must not start a session per poll during an outage");

  const pushed = await pushedState(OUTAGE);
  assert.equal(pushed?.status, "ready", "an outage is not the task's fault — it stays claimable");
  assert.equal(pushed?.sessions, 1, "a session that got no tokens back did not happen");
  assert.equal(
    pushed?.progress.noProgressStreak,
    0,
    "the no-progress detector judges the agent, and the agent never ran",
  );
  assert.deepEqual(
    notifications,
    ["provider-unavailable"],
    "one message per incident, not one per attempt",
  );

  const journal = await new Git(origin).tryRun("show", `main:tasks/${OUTAGE}/journal.md`);
  assert.doesNotMatch(
    journal.stdout,
    /Interrupted|Exit:/,
    "a session that never ran writes no history",
  );

  await retire(OUTAGE);
});

test("a session interrupted mid-work keeps its tokens and its history", async () => {
  // The other half of an outage: session 2 of the real incident had already run
  // twenty-three tool-using turns when the limit hit. Its tokens were spent and its
  // commits are on the branch, so pretending it never happened would lose the
  // accounting and re-run the work. It counts — the PROBE is what must not run, because
  // "did the agent make progress" is not a question about a truncated session.
  const WORKED = asTaskId("OUTAGE-2");
  await seedTask(WORKED, { sessions: 3 });

  const runner: SessionRunner = {
    run: () =>
      Promise.resolve({
        reason: "provider-unavailable",
        usage: { inputTokens: 40_000, outputTokens: 900, costUsd: 1.25 },
        contextTokens: 38_854,
        outage: { kind: "exhausted", status: 429, detail: "monthly spend limit" },
        summary: "the model provider stopped answering",
      } satisfies SessionOutcome),
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: { probe: () => assert.fail("the probe must not run for an interrupted session") },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  await sleep(2_000);
  controller.abort();
  await running.catch(() => undefined);

  const pushed = await pushedState(WORKED);
  assert.equal(pushed?.status, "ready");
  assert.equal(pushed?.sessions, 4, "a session that got tokens back happened");
  assert.equal(pushed?.usage.costUsd, 1.25, "spend is charged to the task that spent it");
  assert.equal(pushed?.progress.noProgressStreak, 0, "the streak is the agent's, not the provider's");

  const journal = await new Git(origin).tryRun("show", `main:tasks/${WORKED}/journal.md`);
  assert.match(journal.stdout, /Interrupted/);
  assert.doesNotMatch(
    journal.stdout,
    /Parked/,
    "an outage never parks a task — a park needs a human to undo",
  );

  await retire(WORKED);
});

test("the runner says when the provider came back, once", async () => {
  const BACK = asTaskId("OUTAGE-3");
  await seedTask(BACK);

  // The only test that waits a cooldown out, so it gets its own short one.
  const quick: RunnerConfig = {
    ...config,
    llm: { ...config.llm, cooldown: { initialSeconds: 1, maxSeconds: 2 } },
  };

  let calls = 0;
  const runner: SessionRunner = {
    run: () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? ({
              reason: "provider-unavailable",
              usage: EMPTY_USAGE,
              contextTokens: 0,
              outage: { kind: "exhausted", status: 429, detail: "monthly spend limit" },
              summary: "the model provider stopped answering",
            } satisfies SessionOutcome)
          : ({
              reason: "ask-human",
              usage: EMPTY_USAGE,
              contextTokens: 100,
              question: "Which database?",
              summary: "needs a decision",
            } satisfies SessionOutcome),
      );
    },
  };

  const notifications: string[] = [];
  const supervisor = new Supervisor({
    config: quick,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(quick.runnerId),
      staleAfterSeconds: quick.lease.staleAfterSeconds,
    }),
    runner,
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: {
      notify: (notification) => {
        notifications.push(notification.kind);
        return Promise.resolve();
      },
    },
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  await sleep(5_000);
  controller.abort();
  await running.catch(() => undefined);

  // Paused, then resumed: an incident with a beginning and an end, rather than a
  // silence someone has to go and interpret. Asserted as a PREFIX because the state
  // repo is shared with every other test in this file, so whatever the supervisor does
  // with the leftovers afterwards is not this test's business.
  assert.deepEqual(
    notifications.slice(0, 2),
    ["provider-unavailable", "provider-recovered"],
  );
  assert.equal(
    notifications.filter((kind) => kind.startsWith("provider-")).length,
    2,
    "one message when it broke and one when it came back — not one per attempt",
  );
});

test("/resume clears the no-progress streak, or the task parks again without running", async () => {
  // 2026-08-16, in the state repo, five seconds apart:
  //
  //   09:41:20  chore(BS-…-01): resumed from chat
  //   09:41:25  chore(BS-…-01): parked
  //
  // `/resume` sets the task `ready` but left `noProgressStreak` at 3, and `workTask`
  // runs `checkLimits` BEFORE the first session — so the task parked itself on the very
  // next claim, having run nothing. The command reported success and did nothing.
  //
  // `applyAnswer` already solved this and says why: the streak that made a task park is
  // not the next session's fault. Answering is progress; so is a human looking at a
  // parked task and saying keep going. The SESSION limit is deliberately not forgiven —
  // that is a budget, and raising it is a decision, not a side effect of resuming.
  const STUCK = asTaskId("RESUME-4");
  await seedTask(STUCK, {
    status: "parked",
    sessions: 5,
    progress: { lastProgressSession: 2, noProgressStreak: 3 },
  });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: STUCK });
  assert.equal(outcome.kind, "resumed");

  const pushed = await pushedState(STUCK);
  assert.equal(pushed?.status, "ready");
  assert.equal(pushed?.progress.noProgressStreak, 0, "resuming into an exhausted limit is a no-op");
  assert.equal(
    pushed?.progress.lastProgressSession,
    2,
    "the high-water mark is history and stays; only the streak is forgiven",
  );

  // ...and prove it end to end: the next claim must run a SESSION, not re-park.
  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: () =>
        Promise.resolve({
          reason: "ask-human",
          usage: EMPTY_USAGE,
          contextTokens: 100,
          question: "Still stuck on the same thing — which way?",
          summary: "needs a decision",
        } satisfies SessionOutcome),
    },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Polled rather than slept: this supervisor claims every `ready` task in the shared
  // state repo, so how many claims come before this one is not this test's business.
  //
  // `running` is deliberately not a stopping point. `recordSession` pushes it before
  // `applyOutcome` decides anything, so waiting for "no longer ready" catches a state
  // that is about to change — which passed on a fast machine and failed in CI.
  let settled: TaskState | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await pushedState(STUCK);
    if (state !== undefined && state.status !== "ready" && state.status !== "running") {
      settled = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(
    settled?.status,
    "awaiting-human",
    "a resumed task must reach a session — parking again without running is the bug",
  );
});

test("a git failure in the poll loop is logged and retried, not fatal", async () => {
  // `store.pull`, `applyChatRequests`, `maybeIngest`, `survey` and `claimNext` all sat
  // OUTSIDE any try — only `workTask` was wrapped. `Git.run` throws on every non-zero
  // exit, and `resolveEnv` awaits a token mint over an untimed fetch roughly hourly, so
  // one blip unwound out of `run()` into main's `finally`. That closes /healthz and the
  // credential socket, then blocks forever on `await bridge` — a live process, still
  // answering Discord from a frozen snapshot, polling nothing, that systemd would never
  // restart because it never exited.
  const store = new StateStore(statePath, stateGit);
  let pulls = 0;
  const flaky: StateStore = Object.create(store, {
    pull: {
      value: async (remote: string, branch: string): Promise<void> => {
        pulls += 1;
        // Fail the first two, exactly as a transient network or credential blip would.
        if (pulls <= 2) throw new Error("fatal: unable to access 'origin': network is down");
        await store.pull(remote, branch);
      },
    },
  });

  const supervisor = new Supervisor({
    config,
    store: flaky,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: { run: () => Promise.reject(new Error("unused")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && pulls < 3) await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    pulls >= 3,
    `the loop must survive a failing pull and try again — it stopped after ${pulls}`,
  );
});

test("/cancel stops a session running on this runner instead of refusing it", async () => {
  // `applyPark` used to refuse a running task outright, so the only way to stop a
  // session was deleting the pod — which then stranded the task, because an interrupted
  // task is pushed as `running` and nothing moved it back (§6.2). The two bugs made
  // each other unfixable from the operator's side.
  const CANCELLED = asTaskId("SMOKE-CANCEL");
  await seedTask(CANCELLED);

  const store = new StateStore(statePath, stateGit);
  const inbox = new ChatInbox();

  // A session that runs until something aborts it — a hung `bash` call, in effect.
  //
  // `keepalive` is load-bearing, not decoration. A real hung session holds a live child
  // process, and that handle keeps the event loop alive; a promise waiting on an abort
  // event holds NOTHING. Every timer the supervisor arms for the duration of a session
  // is deliberately unref'd — `watchCancels`, the wall clock, the heartbeat — so that a
  // process with nothing left to do is never held up by one. In production that is safe
  // because `index.ts` is always listening on a metrics port and a credential socket.
  // A bare Supervisor has neither, so without this the loop drains mid-session and node
  // ends the test with "Promise resolution is still pending" before the cancel is ever
  // answered. That is the stub being unfaithful to a hang, not the supervisor misbehaving
  // — it failed on node 22 and passed on 26.
  let sawAbort = false;
  const runner: SessionRunner = {
    run: (_spec, _state, signal) =>
      new Promise<SessionOutcome>((resolve) => {
        const keepalive = setInterval(() => {}, 1_000);
        signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          sawAbort = true;
          resolve({
            reason: "interrupted",
            usage: EMPTY_USAGE,
            contextTokens: 0,
            summary: "stopped from outside",
          });
        });
      }),
  };

  const supervisor = new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    inbox,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Wait until the session is actually in flight, or the cancel would find nothing.
  const started = Date.now() + 30_000;
  while (Date.now() < started) {
    const state = await store.tryReadState(CANCELLED);
    if (state?.status === "running") break;
    await sleep(50);
  }

  const outcome = await inbox.submit({ kind: "park", task: CANCELLED });
  assert.equal(outcome.kind, "cancelling", "a running session must be stoppable");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !sawAbort) await sleep(50);

  // ...and the task must actually END UP parked. Aborting the session is only half of
  // a cancel: an interrupted task is left `running`, which is claimable again, so
  // without the park the very next poll would start the session over.
  let parked: TaskState | undefined;
  const settled = Date.now() + 30_000;
  while (Date.now() < settled) {
    const state = await store.tryReadState(CANCELLED);
    if (state?.status === "parked") {
      parked = state;
      break;
    }
    await sleep(50);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(sawAbort, "the abort must reach the session, not just the reply");
  assert.ok(parked !== undefined, "a cancelled task must end up parked, not re-claimed");
});

test("a digest that is due is published from the poll loop, and a failing one is not fatal", async () => {
  // The digest runs on the poll loop (§19), which is the only clock the supervisor has.
  // That puts it on the same thread as claiming, so the two properties that matter are
  // that it is actually reached on an ordinary poll, and that it can never be the reason
  // the loop stops — a report ABOUT the fleet must not be able to stop the fleet.
  const calls: Date[] = [];
  const digest = {
    maybePublish: (now: Date): Promise<void> => {
      calls.push(now);
      return Promise.reject(new Error("the state repo rejected the digest push"));
    },
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: { run: () => Promise.reject(new Error("unused")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    digest,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && calls.length < 2) await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    calls.length >= 2,
    `the loop must keep polling after a digest throws — it called it ${calls.length} time(s)`,
  );
});

test("a queued brainstorm gets the runner at the next session boundary", async () => {
  // The defect, observed live: `workTask` drives ONE task through as many sessions as it
  // needs, and the poll loop — and with it the chat drain — is blocked for all of them.
  // A task that keeps handing off therefore holds the runner indefinitely, so a human
  // typing `/brainstorm` got a thread that opened and then said nothing, for as long as
  // the current task felt like running. Twenty minutes and six sessions, in the case
  // this test is written from.
  //
  // The fix is deliberately NOT an interrupt. A session that is aborted records nothing
  // (§6.4), so cutting one short to answer a chat command would throw away real work; the
  // runner finishes the session it is in and hands back at the boundary instead.
  const BUSY = asTaskId("SMOKE-YIELD");
  // A session ceiling out of reach, so the runner is released by the fix under test and
  // by nothing else. At the shared fixture's 20 the stub burns through the lot in a
  // couple of seconds, the task parks itself on the limit, and the brainstorm then gets
  // claimed by an ordinary idle poll — which is the bug passing the test.
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const inbox = new ChatInbox();

  // Hands off forever: without a yield this task never gives the runner back.
  let sessions = 0;
  const runner: SessionRunner = {
    run: async (spec) => {
      if (spec.id === BUSY) sessions += 1;
      // Long enough that "did it stop after this one" is a question about the boundary
      // check rather than a race with it.
      await sleep(100);
      return {
        reason: "handoff",
        usage: EMPTY_USAGE,
        contextTokens: 0,
        summary: "more to do",
      } satisfies SessionOutcome;
    },
  };

  const supervisor = new Supervisor({
    // `applyBrainstorm` has to resolve the repo to a workspace, and the shared fixture
    // configures none.
    config: {
      ...config,
      workspaces: new Map([
        [
          asWorkspaceName("test"),
          {
            name: asWorkspaceName("test"),
            forge: {
              kind: "github" as const,
              host: "github.com",
              owner: "acme",
              apiBase: "https://api.github.com",
            },
            secretRef: "test",
          },
        ],
      ]),
    },
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    inbox,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Wait until the runner is genuinely stuck on it, so the brainstorm arrives mid-task
  // rather than into an idle poll — which would prove nothing.
  const busy = Date.now() + 30_000;
  while (Date.now() < busy && sessions < 2) await sleep(50);
  assert.ok(sessions >= 2, "the fixture must actually occupy the runner");

  const BRAINSTORM = asTaskId("BS-1538626232302960801");
  const outcome = await inbox.submit({
    kind: "brainstorm",
    topic: "make the thing faster",
    repo: "acme/widget",
    threadId: "1538626232302960801",
    author: "caesar",
  });

  const held = sessions;

  // The brainstorm must reach the state repo — which only happens on a poll, which only
  // happens once the runner has let go of `BUSY`.
  let created: TaskState | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    created = await store.tryReadState(BRAINSTORM);
    if (created !== undefined) break;
    await sleep(50);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(outcome.kind, "started", "the request must be settled, not left hanging");
  assert.ok(created !== undefined, "a queued brainstorm must not wait for the task to finish");
  assert.ok(
    sessions <= held + 1,
    `the runner must stop after the session it was in, not run on (${held} -> ${sessions})`,
  );

  await seedTask(BUSY, { status: "done" });
  await seedTask(BRAINSTORM, { status: "done" });
});

test("/resume brings back a task that FAILED, not only one that parked", async () => {
  // The gap this closes, found the hard way. `applyResume` accepted `parked` and nothing
  // else, so `failed` was terminal with no route back from chat at all — the only way
  // out was an operator editing state.json by hand, which is the exact race `/resume`
  // was introduced to remove. §7 makes that argument for `parked`; it is the same
  // argument, word for word, for `failed`.
  //
  // It stopped being theoretical when a misconfigured runner marked six tasks `failed`
  // in ninety seconds for `Provider is not configured: anthropic` — nothing to do with
  // any of them — and took two more down with them, because a plan's later waves are
  // blocked by whatever failed. Eight tasks, no command that could touch one.
  const BROKEN = asTaskId("RESUME-FAILED");
  await seedTask(BROKEN, { status: "failed", progress: { lastProgressSession: 1, noProgressStreak: 2 } });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: BROKEN });

  assert.deepEqual(outcome, { kind: "resumed", from: "failed" }, "the reply must say what it came back from");

  const pushed = await pushedState(BROKEN);
  assert.equal(pushed?.status, "ready", "and it must be claimable on the REMOTE, not just locally");
  assert.equal(pushed?.progress.noProgressStreak, 0, "the streak is forgiven, as it is for a park");
  assert.equal(pushed?.progress.lastProgressSession, 1, "history is not");

  const journal = await new Git(origin).run("show", `main:tasks/${BROKEN}/journal.md`);
  assert.match(journal, /Resumed/);

  await retire(BROKEN);
});

test("/resume still refuses a task that finished", async () => {
  // `done` stays refused. Resuming it would re-run work that already passed every gate
  // and merged — the one terminal status where coming back is not a recovery.
  const FINISHED = asTaskId("RESUME-DONE");
  await seedTask(FINISHED, { status: "done" });

  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(store, { kind: "resume", task: FINISHED });

  assert.deepEqual(outcome, { kind: "not-resumable", status: "done" });
  assert.equal((await pushedState(FINISHED))?.status, "done", "nothing should have been written");
});
