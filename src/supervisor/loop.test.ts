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
import { DEFAULT_TOOLCHAIN_CONFIG } from "../workspace/toolchain.ts";
import { ChatInbox } from "./inbox.ts";
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
  toolchain: DEFAULT_TOOLCHAIN_CONFIG,
  stateRepo: { url: origin, branch: "main", path: statePath },
  paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks") },
  // A heartbeat long enough never to fire: this test is about the failure path, and a
  // renewal landing mid-park would muddy which CAS was under test.
  lease: { heartbeatSeconds: 3600, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: { maxSessionsPerTask: 20, noProgressLimit: 3, maxReviewRounds: 3 },
  log: { level: "info" },
  intake: { intervalSeconds: 300 },
  llm: {
    auth: "proxy",
    baseUrl: "http://localhost",
    modelId: "test",
    providerId: "test",
    contextWindow: 100_000,
    maxTokens: 4096,
  },
  workspaces: new Map(),
  pollSeconds: 1,
  secretsDir: join(root, "secrets"),
};

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
