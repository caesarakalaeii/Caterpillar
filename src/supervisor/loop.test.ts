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
  isTerminal,
  type RepoRef,
  type RunnerId,
  type SessionOutcome,
  type TaskId,
  type TaskState,
} from "../domain/task.ts";
import type { Forge } from "../forge/types.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { type Notifier, NullNotifier } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import type { FiringAlert } from "../remediation/receiver.ts";
import type { Council } from "../review/council.ts";
import { decide } from "../review/decide.ts";
import { Git } from "../state/git.ts";
import { type Lease, LeaseLostError, LeaseManager, leaseRef } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { DEFAULT_USAGE_CONFIG, type WorkspaceUsage } from "../workspace/usage.ts";
import { DEFAULT_REAP_CONFIG, type ReapResult } from "../workspace/worktree.ts";
import { InMemoryCancelSignals } from "../redis/cancel.ts";
import { type ChatDrainer, InMemoryChatQueue } from "../redis/inbox.ts";
import { InMemorySnapshotStore } from "../redis/snapshot.ts";
import { InMemoryThreadBindings } from "../redis/threads.ts";
import { type ChatOutcome, type ChatRequest } from "./inbox.ts";
import { FleetActivity } from "../notify/activity.ts";
import { TaskSnapshot } from "./snapshot.ts";
import {
  Supervisor,
  type ProgressProbe,
  type SessionRunner,
  type SupervisorDeps,
  type Verifier,
  type WorktreeReaper,
} from "./loop.ts";

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
  paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks"), root },
  usage: DEFAULT_USAGE_CONFIG,
  workspace: { reap: DEFAULT_REAP_CONFIG },
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
  // The default, stated. Every existing test describes a one-task-at-a-time runner and
  // must keep describing one — see DESIGN.md §6.4.
  concurrency: 1,
  housekeepingSeconds: 1,
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
  remediation: { enabled: false, port: 8081 },
  redis: {
    enabled: false,
    url: "redis://localhost:6379",
    commandTimeoutMs: 1000,
    keyPrefix: "caterpillar:",
  },
  bot: { mode: "in-process" as const, port: 9091 },
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

/**
 * The journal as it exists ON THE REMOTE, every shard concatenated.
 *
 * The journal is one file per entry (§4.1), so "was the entry pushed" is a question
 * about a directory rather than about a blob. Empty string when nothing was written,
 * which is what lets a caller assert that a session which never ran wrote no history.
 */
const pushedJournal = async (task: TaskId): Promise<string> => {
  const git = new Git(origin);
  const listed = await git.tryRun("ls-tree", "-r", "--name-only", "main", `tasks/${task}/journal/`);
  if (listed.code !== 0) return "";

  const names = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();

  const bodies: string[] = [];
  for (const name of names) {
    const shard = await git.tryRun("show", `main:${name}`);
    if (shard.code === 0) bodies.push(shard.stdout);
  }
  return bodies.join("\n");
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
    // TERMINAL, not merely "no longer ready". `running` is pushed on the way in, and the
    // lease ref is absent for a moment before the claim creates it as well as after the
    // session drops it — so "not ready and unleased" also describes the instant before
    // the session starts. Under load the poll lands in that window, settles on `running`,
    // and the assertion below fails 3s into a 30s budget: an early observation, not a
    // timeout. Waiting for a terminal status is what the surrounding comment already
    // means by "after every write the supervisor is going to make".
    if (state !== undefined && isTerminal(state.status) && held.code !== 0) {
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

  const inbox = new InMemoryChatQueue();
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
  const inbox = new InMemoryChatQueue();
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
  let convenedWhenParked: number | undefined;
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
      // Sampled WITH the state, not read after the loop stops. `convened` is a live
      // counter and `settled` is a snapshot, so reading them at different moments lets
      // them describe different instants: `abort()` is only a request — `workLoop` tests
      // the signal between iterations, so a pass already inside `workOnce` runs on. Under
      // load that pass can convene the council again between the observation here and the
      // assertions below, which is why this failed as `4 !== 2` while the two assertions
      // about `settled` — taken from the snapshot — still passed.
      convenedWhenParked = convened;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.equal(settled?.status, "parked", "a task the council keeps rejecting must not run forever");
  assert.equal(settled?.review?.rounds, 2, "the round cap is what stops it");
  assert.equal(convenedWhenParked, 2, "the council must be convened once per completion claim");

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
    reviewers: new Map([
      [
        asWorkspaceName("test"),
        // The reviewer identity never checks anything out, so reachability is not its
        // question — it approves and merges through the API alone (§12.1).
        {
          forTask: () => Promise.resolve(reviewerForge),
          unreachable: () => Promise.resolve([]),
          reachable: () => Promise.resolve([]),
        },
      ],
    ]),
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
  let convenedWhenDone: number | undefined;
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
      // Sampled WITH the state. `abort()` only asks the loop to stop between iterations,
      // so a pass already inside `workOnce` runs on and can convene the council again
      // after `done` was observed — reading this live after `await running` measured a
      // later instant than `settled` did. The regression this test guards still fails
      // it: a push lost during the review re-claims the task and convenes a second
      // council BEFORE `done` ever appears, so the count is already 2 when sampled here.
      convenedWhenDone = convened;
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
    convenedWhenDone,
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
  inbox: InMemoryChatQueue,
  over: Partial<RunnerConfig> = {},
  extra: Partial<SupervisorDeps> = {},
): Supervisor =>
  new Supervisor({
    config: { ...config, ...over },
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
    ...extra,
  });

/** Run one inbox request against a live supervisor and stop it again. */
const throughInbox = async (
  store: StateStore,
  intent: Parameters<InMemoryChatQueue["submit"]>[0],
  over: Partial<RunnerConfig> = {},
  extra: Partial<SupervisorDeps> = {},
): Promise<ChatOutcome> => {
  const inbox = new InMemoryChatQueue();
  const supervisor = resumeSupervisor(store, inbox, over, extra);
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

  const journal = await pushedJournal(RESUMED);
  assert.notEqual(journal, "", "the journal entry must be pushed, not just written");
  assert.match(journal, /Resumed/);
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

  const journal = await pushedJournal(OUTAGE);
  assert.doesNotMatch(
    journal,
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

  const journal = await pushedJournal(WORKED);
  assert.match(journal, /Interrupted/);
  assert.doesNotMatch(
    journal,
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

  // Waiting for the SECOND provider notification rather than for a fixed five seconds.
  // The sequence under test costs a session, a cooldown and a second session, and a
  // fixed budget has to guess how long that takes on the busiest machine that will ever
  // run it — guess low and the recovery has simply not been announced yet, which failed
  // here as `['provider-unavailable']` against the expected pair. Polling for the
  // condition ends as soon as it holds, so the fast path stays fast, and a recovery that
  // never comes still fails the assertion below rather than hanging.
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    notifications.filter((kind) => kind.startsWith("provider-")).length < 2
  ) {
    await sleep(50);
  }

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

test("/cancel stops a session running on this runner instead of refusing it", async (t) => {
  // `applyPark` used to refuse a running task outright, so the only way to stop a
  // session was deleting the pod — which then stranded the task, because an interrupted
  // task is pushed as `running` and nothing moved it back (§6.2). The two bugs made
  // each other unfixable from the operator's side.
  const CANCELLED = asTaskId("SMOKE-CANCEL");
  await seedTask(CANCELLED);

  const store = new StateStore(statePath, stateGit);
  const inbox = new InMemoryChatQueue();

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
  //
  // It is cleared from `t.after` as well as on abort, and THAT is not decoration either.
  // Clearing it only on abort means the one run where the abort never arrives leaves a
  // live interval behind: the assertions below fail, and then node cannot exit, so the
  // whole suite HANGS after reporting the failure instead of finishing. That is not
  // hypothetical — it is what wedged a review council reviewer for 2h42m in the cluster
  // (DESIGN.md §6.4), because the reviewer ran `npm test` and this interval outlived the
  // failure. A test that fails must fail, not hang.
  let keepalive: NodeJS.Timeout | undefined;
  t.after(() => {
    if (keepalive !== undefined) clearInterval(keepalive);
  });

  let sawAbort = false;
  const runner: SessionRunner = {
    run: (_spec, _state, signal) =>
      new Promise<SessionOutcome>((resolve) => {
        keepalive = setInterval(() => {}, 1_000);
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

test("a cancel from another process reaches a session in flight, without the queue", async () => {
  // The cross-process half of the test above (DESIGN.md §21). Nothing is submitted to the
  // inbox at all — the standalone bot is not this process and has no reference to it — so
  // the ONLY path to the abort is the signal. `takeWhere` returns nothing throughout,
  // which is exactly what the supervisor sees when a bot on another pod typed the command.
  const CANCELLED = asTaskId("SMOKE-CANCEL-SIGNAL");
  await seedTask(CANCELLED);

  const store = new StateStore(statePath, stateGit);
  const cancels = new InMemoryCancelSignals();

  // See the test above for why `keepalive` is load-bearing: a promise waiting on an abort
  // event holds nothing open, and every timer the supervisor arms for a session is unref'd.
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
            summary: "stopped from another process",
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
    cancels,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const started = Date.now() + 30_000;
  while (Date.now() < started) {
    const state = await store.tryReadState(CANCELLED);
    if (state?.status === "running") break;
    await sleep(50);
  }

  assert.equal(await cancels.request(CANCELLED), true);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !sawAbort) await sleep(50);

  // Parked, not merely interrupted. An interrupted task is left `running`, which is
  // claimable, so the very next poll would start the session it was meant to stop again.
  let parked = false;
  const settled = Date.now() + 30_000;
  while (Date.now() < settled) {
    if ((await store.tryReadState(CANCELLED))?.status === "parked") {
      parked = true;
      break;
    }
    await sleep(50);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(sawAbort, "the signal must reach the session, not only the key");
  assert.ok(parked, "a cancelled task must end up parked, not re-claimed");
  // And the signal is CLEARED, so a task cancelled and then resumed inside the TTL does
  // not immediately cancel itself again on the session that resumes it.
  assert.equal(await cancels.requested(CANCELLED), false);
});

test("the poll advertises this runner, and a presence failure never reaches the loop", async () => {
  // Presence is advisory (§21). What is asserted is that it happens once a poll and that
  // a registry which throws cannot stop the runner — a DISPLAY must never be able to take
  // down the thing it displays.
  const heartbeats: string[] = [];
  const registry = {
    heartbeat: (runner: RunnerId): Promise<void> => {
      heartbeats.push(runner);
      // Every call rejects. `RedisGuard` sits between a real registry and the loop, so
      // this is the harsher version: nothing between it and `pollOnce`.
      return Promise.reject(new Error("redis is unreachable"));
    },
    alive: () => Promise.resolve([]),
    depart: () => Promise.resolve(),
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
    runners: registry,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && heartbeats.length === 0) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(heartbeats.slice(0, 1), [config.runnerId]);
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
  const inbox = new InMemoryChatQueue();

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
    repos: ["acme/widget"],
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

/**
 * A brainstorm may read several repos, as long as they are all in ONE workspace.
 *
 * The payoff is downstream: `materialise` passes `defaultRepos: spec.repos` to every
 * child, so a two-repo brainstorm cuts two-repo tasks. The bound is the containment one
 * (§3.1/§9.1) — a workspace is one credential bundle, and a session holding two is the
 * blast-radius expansion the workspace model exists to prevent.
 */
const workspace = (name: string, host: string, owner: string) => ({
  name: asWorkspaceName(name),
  forge: {
    kind: (host === "codeberg.org" ? "forgejo" : "github") as "github" | "forgejo",
    host,
    owner,
    apiBase: `https://${host}`,
  },
  secretRef: `caterpillar-${name}`,
});

const TWO_WORKSPACES: Partial<RunnerConfig> = {
  workspaces: new Map(
    [workspace("caesar", "github.com", "acme"), workspace("boogaloo", "codeberg.org", "eb")].map(
      (profile) => [profile.name, profile],
    ),
  ),
};

test("a brainstorm over several repos in one workspace carries all of them", async () => {
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "split the client out of the server",
      repos: ["acme/widget", "acme/api", "acme/widget"],
      threadId: "1538626232302960802",
      author: "caesar",
    },
    TWO_WORKSPACES,
  );

  const BRAINSTORM = asTaskId("BS-1538626232302960802");
  assert.deepEqual(outcome, { kind: "started", task: BRAINSTORM });

  const spec = await store.readSpec(BRAINSTORM);
  assert.deepEqual(
    spec.repos,
    [
      { host: "github.com", owner: "acme", name: "widget" },
      { host: "github.com", owner: "acme", name: "api" },
    ],
    "both repos, in the order typed, and the duplicate collapsed",
  );
  assert.equal(spec.workspace, "caesar");
  assert.match(spec.goal, /acme\/api/, "the agent is told what it may read");

  await retire(BRAINSTORM);
});

test("a brainstorm that spans two workspaces is refused, and says which went where", async () => {
  // Not narrowed to one workspace and not silently truncated: one session with
  // credentials for two bundles is exactly what §9.1 bounds, and dropping a repo the
  // human asked for produces a plan about half a system without saying so.
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "port the client to the other forge",
      repos: ["acme/widget", "codeberg.org/eb/api"],
      threadId: "1538626232302960803",
      author: "caesar",
    },
    TWO_WORKSPACES,
  );

  assert.equal(outcome.kind, "refused");
  const reason = outcome.kind === "refused" ? outcome.reason : "";
  assert.match(reason, /caesar/);
  assert.match(reason, /boogaloo/);
  assert.match(reason, /acme\/widget/);
  assert.match(reason, /codeberg\.org\/eb\/api/);

  assert.equal(
    await store.hasTask(asTaskId("BS-1538626232302960803")),
    false,
    "a refused brainstorm must not leave a task behind",
  );
});

test("a brainstorm naming a repo no workspace owns is refused, not guessed at", async () => {
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "read someone else's code",
      repos: ["acme/widget", "stranger/thing"],
      threadId: "1538626232302960804",
      author: "caesar",
    },
    TWO_WORKSPACES,
  );

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.reason : "", /stranger/);
});

/**
 * A repo nobody can reach is refused at the door (DESIGN.md §9.1).
 *
 * 2026-08-18: `/brainstorm caesarakalaeii/allchat` — for a repo called `all-chat` — was
 * accepted, claimed, and spent its session reaching `git clone --mirror`, where the App's
 * 422 became `fatal: could not read Username`. The name was one dash out and nothing on
 * the way in had asked the only question that would have caught it.
 */
const reachStub = (unreachable: readonly string[]): Partial<SupervisorDeps> => ({
  forges: new Map([
    [
      asWorkspaceName("caesar"),
      {
        unreachable: (repos: readonly RepoRef[]) =>
          Promise.resolve(
            repos
              .filter((repo) => unreachable.includes(`${repo.owner}/${repo.name}`))
              .map((repo) => ({
                repo,
                reason: `\`${repo.owner}/${repo.name}\` is not one of the 65 repositories this workspace's GitHub App can see. Did you mean \`acme/widget\`?`,
              })),
          ),
      },
    ],
  ]),
});

test("a brainstorm naming a repo the credential cannot reach is refused with the near miss", async () => {
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "refine the widget",
      repos: ["acme/widgit"],
      threadId: "1539331435477860432",
      author: "caesar",
    },
    TWO_WORKSPACES,
    reachStub(["acme/widgit"]),
  );

  assert.equal(outcome.kind, "refused");
  const reason = outcome.kind === "refused" ? outcome.reason : "";
  assert.match(reason, /acme\/widgit/, "the refusal names what was typed");
  assert.match(reason, /acme\/widget/, "and what to type instead");

  assert.equal(
    await store.hasTask(asTaskId("BS-1539331435477860432")),
    false,
    "a brainstorm nothing can clone must not become a task",
  );
});

test("a reachable brainstorm is unaffected by the check", async () => {
  const store = new StateStore(statePath, stateGit);
  const BRAINSTORM = asTaskId("BS-1539331435477860433");
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "refine the widget",
      repos: ["acme/widget"],
      threadId: "1539331435477860433",
      author: "caesar",
    },
    TWO_WORKSPACES,
    reachStub(["acme/widgit"]),
  );

  assert.deepEqual(outcome, { kind: "started", task: BRAINSTORM });
  await retire(BRAINSTORM);
});

test("a forge that cannot answer lets the brainstorm through rather than refusing it", async () => {
  // Fail OPEN, deliberately. A 500 from GitHub is not evidence about an installation, and
  // refusing work because the forge hiccuped is worse than the clone failure this avoids.
  const store = new StateStore(statePath, stateGit);
  const BRAINSTORM = asTaskId("BS-1539331435477860434");
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "refine the widget",
      repos: ["acme/widget"],
      threadId: "1539331435477860434",
      author: "caesar",
    },
    TWO_WORKSPACES,
    {
      forges: new Map([
        [
          asWorkspaceName("caesar"),
          { unreachable: () => Promise.reject(new Error("GitHub /installation/repositories failed with 500")) },
        ],
      ]),
    },
  );

  assert.deepEqual(outcome, { kind: "started", task: BRAINSTORM });
  await retire(BRAINSTORM);
});

test("a brainstorm with no repos at all is refused by the loop too", async () => {
  // The slash layer already refuses it, but the inbox is a public seam — anything that
  // can submit a request can submit an empty list, and creating a brainstorm with nothing
  // to read produces a plan about an imaginary codebase.
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "read nothing",
      repos: [],
      threadId: "1538626232302960806",
      author: "caesar",
    },
    TWO_WORKSPACES,
  );

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.reason : "", /at least one repo/);
});

test("a brainstorm with an unparseable repo is refused by name", async () => {
  const store = new StateStore(statePath, stateGit);
  const outcome = await throughInbox(
    store,
    {
      kind: "brainstorm",
      topic: "read the code",
      repos: ["acme/widget", "widget"],
      threadId: "1538626232302960805",
      author: "caesar",
    },
    TWO_WORKSPACES,
  );

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.reason : "", /`widget`/);
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

  const journal = await pushedJournal(BROKEN);
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

test("the alert queue is drained on the poll loop, and a failure there is not fatal", async () => {
  // The wiring half of DESIGN.md §20. The receiver hands alerts over in memory, and the
  // only thread of control allowed to write the state repo is this one — so an alert that
  // is accepted and never drained is a task that silently never exists. Asserted through a
  // running supervisor rather than by calling the private method, because "on every tick"
  // is the property, and it is the sort of thing a later refactor drops.
  const alerts: FiringAlert[] = [
    {
      alertname: "CaterpillarNoProgress",
      fingerprint: "abc123",
      labels: [{ key: "alertname", value: "CaterpillarNoProgress" }],
      annotations: [],
    },
  ];
  const passes: number[] = [];

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
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
    alerts: {
      queue: {
        drain: () => alerts.splice(0, alerts.length),
      },
      ingester: (() => {
        let first = true;
        return {
          process: (queued: readonly FiringAlert[]) => {
            passes.push(queued.length);
            // The first pass throws, which is what a state repo that rejects a push looks
            // like from here. The loop must keep polling: a task the fleet cannot file is
            // not a reason to stop working the tasks it already has.
            if (first) {
              first = false;
              return Promise.reject(new Error("push rejected"));
            }
            return Promise.resolve({ seen: queued.length, created: 0, duplicate: 0, refused: 0 });
          },
        };
      })(),
    },
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && passes.length === 0) await sleep(50);

  // A second delivery after the failed pass, to prove the loop is still running.
  alerts.push({
    alertname: "CaterpillarBudget",
    fingerprint: "def456",
    labels: [{ key: "alertname", value: "CaterpillarBudget" }],
    annotations: [],
  });
  while (Date.now() < deadline && passes.length < 2) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(passes, [1, 1], "every tick with a queued alert must produce exactly one pass");
});

test("the usage measurement runs on the idle branch, and a failing one is not fatal", async () => {
  // Same argument as the digest above, one notch stronger: this is OBSERVABILITY, so the
  // moment it is most likely to fail — a filesystem answering `stat` with an error — is
  // exactly the moment somebody is looking at it. A monitor that could take the poll loop
  // with it would fail first and loudest during the incident it was installed to explain.
  //
  // It is also reached only from the IDLE branch, next to `maybeCollectGarbage` and for
  // the same reason: the walk is one `stat` per file over a tree with a `node_modules`
  // per task, on the single thread that claims work. There is always another idle poll.
  const calls: number[] = [];
  const usage = {
    maybeMeasure: (): Promise<WorkspaceUsage | undefined> => {
      calls.push(Date.now());
      return Promise.reject(new Error("statfs: EIO"));
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
    usage,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && calls.length < 2) await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    calls.length >= 2,
    `the loop must keep polling after the measurement throws — it called it ${calls.length} time(s)`,
  );
});

test("a measurement that comes back is published to the metrics the scrape reads", async () => {
  // The whole point of the walk is the series. A snapshot that reached the loop and never
  // reached the registry would be a measurement nobody can graph, which is the state this
  // work exists to end.
  const measured: WorkspaceUsage = {
    measuredAt: "2026-08-18T09:00:00.000Z",
    durationMs: 12,
    partial: true,
    fs: { totalBytes: 1000, freeBytes: 400 },
    mirrorBytes: 100,
    taskBytes: 300,
    nixBytes: 50,
    otherBytes: 25,
    mirrors: [{ name: "acme/widget", bytes: 100 }],
    tasks: [{ name: "TASK-BIG", bytes: 300 }],
  };

  let served = 0;
  const metrics = new AgentMetrics();
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
    metrics,
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    // Once, then nothing — the real monitor's own rate limit does the same.
    usage: { maybeMeasure: () => Promise.resolve(served++ === 0 ? measured : undefined) },
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !metrics.render().includes("caterpillar_work_bytes")) {
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  const rendered = metrics.render();
  assert.match(rendered, /caterpillar_work_bytes\{.*category="tasks".*\} 300/);
  assert.match(rendered, /caterpillar_work_fs_bytes\{.*kind="free".*\} 400/);
  assert.match(rendered, /caterpillar_work_entry_bytes\{.*name="TASK-BIG".*\} 300/);
  // Its own series rather than a label on the bytes: a label that changed value would
  // start a new time series and break every byte graph at the moment it went partial.
  assert.match(rendered, /caterpillar_work_partial\{[^}]*\} 1/);
});

/**
 * A `WorktreeReaper` that records rather than deletes.
 *
 * Records instead of standing up a real `WorktreeManager` because the question these four
 * tests ask is entirely about the LOOP: which terminal paths call the removal, and which
 * deliberately do not. `worktree.test.ts` owns whether the removal removes the right
 * things. Building a mirror per case here would test that twice and the wiring once.
 */
const recordingReaper = (): {
  readonly reaper: WorktreeReaper;
  readonly reaped: TaskId[];
  readonly swept: (readonly TaskId[])[];
} => {
  const reaped: TaskId[] = [];
  const swept: (readonly TaskId[])[] = [];
  return {
    reaped,
    swept,
    reaper: {
      removeTaskWorktrees: (task: TaskId): Promise<ReapResult> => {
        reaped.push(task);
        return Promise.resolve({ worktrees: 1, bytes: 4096, tasks: [task] });
      },
      reapStaleWorktrees: (opts: { readonly live: ReadonlySet<TaskId> }): Promise<ReapResult> => {
        swept.push([...opts.live]);
        return Promise.resolve({ worktrees: 0, bytes: 0, tasks: [] });
      },
    },
  };
};

test("a task that is done has its worktree reaped", async () => {
  // The point of the whole feature. `removeWorktree` had no production caller at all, so
  // every task the fleet ever finished left its checkout — plus `node_modules`, plus build
  // output, per repo it declared — on a 20Gi ReadWriteOnce volume forever.
  //
  // Asserted after the lease is released rather than after the status flips, because the
  // reap is deliberately the LAST thing `applyOutcome` does: a reap that fails must not be
  // what stops a completed task from being recorded as one.
  const REAPED = asTaskId("REAP-DONE");
  await seedTask(REAPED);

  const { reaper, reaped } = recordingReaper();
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
      verify: () => Promise.resolve({ passed: true, detail: "acceptance commands exited 0" }),
    },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await pushedState(REAPED))?.status === "done") break;
    await sleep(100);
  }
  // The reap follows the push, so give the same iteration a moment to finish.
  while (Date.now() < deadline && reaped.length === 0) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  // WHICH task was reaped, not how many times. The reap of a terminal task runs from the
  // idle branch of every poll, and `recordingReaper` only records — unlike the real
  // reaper it never removes the directory, so the task stays reapable and a second idle
  // poll records it again. `abort()` does not close that window either: `workLoop` tests
  // the signal between iterations, so a pass already inside `workOnce` runs to
  // completion. An exact-length assertion therefore encodes the poll timing rather than
  // the behaviour, and fails under load for a reason that says nothing about the code.
  assert.deepEqual(
    [...new Set(reaped)],
    [REAPED],
    "a finished task's worktree must be thrown away, and no other task's",
  );
});

test("a handoff keeps its worktree — the next session resumes in it", async () => {
  // The counterweight, and the reason this is not simply "reap on every terminal path".
  // A handoff is the same task on the same branch in the same directory; `ensureWorktree`
  // reuses one precisely so a session that hands off does not pay for a clone and a
  // dependency install. Reaping here would make every handoff cost both.
  //
  // Driven to a park so the test has a terminal state to wait for: the session hands off
  // until the no-progress limit stops it, and NEITHER exit may reap.
  const KEPT = asTaskId("REAP-HANDOFF");
  await seedTask(KEPT, { progress: { lastProgressSession: 0, noProgressStreak: 2 } });

  const { reaper, reaped } = recordingReaper();
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
          reason: "handoff",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "context is filling; the next session continues",
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
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState(KEPT);
    // Past the first handoff at minimum — otherwise "it did not reap" is only true
    // because nothing happened yet.
    if (state !== undefined && state.sessions > 0 && state.status === "parked") break;
    await sleep(100);
  }
  await sleep(500);

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(
    reaped,
    [],
    "a handoff — and the park that follows one — must keep the checkout the next " +
      "session was going to resume in",
  );
});

test("a task awaiting a human keeps its worktree", async () => {
  // The clearest no-reap case in the switch. The session that answers the question is the
  // same task on the same branch, claimed as often as not by this same runner, so
  // deleting the checkout buys disk for exactly as long as it takes a human to type.
  const ASKED = asTaskId("REAP-ASK");
  await seedTask(ASKED);

  const { reaper, reaped } = recordingReaper();
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
          contextTokens: 0,
          question: "which of the two migrations should this follow?",
          summary: "asking",
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
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await pushedState(ASKED))?.status === "awaiting-human") break;
    await sleep(100);
  }
  // Long enough for a reap to have happened if one were going to.
  await sleep(500);

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(reaped, [], "a question is not a reason to delete the work behind it");

  await retire(ASKED);
});

test("losing the lease reaps this runner's copy, because another runner owns the task", async () => {
  // The third reaping trigger, and the one that is easiest to argue with. Nothing about
  // this runner's checkout is wrong — it may hold uncommitted work — but the task has
  // moved: whoever holds the lease now is working it in their own `tasksDir`, from the
  // branch on the remote. This copy will never be resumed and nothing will ever name it
  // again, which is exactly the orphan the periodic sweep would find days later. Catching
  // it here costs one `rm -rf` and saves the disk in between.
  const STOLEN = asTaskId("REAP-LOST");
  await seedTask(STOLEN);

  // A heartbeat that always fails is what a stolen lease looks like from inside a session:
  // the renewal's CAS finds a ref another runner has moved. Subclassed rather than faked
  // wholesale so the CLAIM is still the real compare-and-swap.
  class LosingLeases extends LeaseManager {
    override renew(lease: Lease): Promise<Lease> {
      return Promise.reject(new LeaseLostError(lease.task));
    }
  }

  const { reaper, reaped } = recordingReaper();
  const supervisor = new Supervisor({
    config: { ...config, lease: { heartbeatSeconds: 1, staleAfterSeconds: 300 } },
    store: new StateStore(statePath, stateGit),
    leases: new LosingLeases({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      // Runs until the heartbeat gives up on it, then returns something that is NOT
      // `interrupted` — `workTask` returns early on that reason, and the throw this test
      // is about happens at the top of the next iteration.
      run: async (_spec, _state, signal) => {
        while (!signal.aborted) await sleep(50);
        return {
          reason: "handoff",
          usage: EMPTY_USAGE,
          contextTokens: 0,
          summary: "stopped",
        } satisfies SessionOutcome;
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
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && reaped.length === 0) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(
    reaped,
    [STOLEN],
    "a runner that has lost the lease is holding a checkout nothing will ever read",
  );

  await retire(STOLEN);
});

test("the idle sweep runs, and is told which tasks are live rather than guessing", async () => {
  // The safety net's wiring, and the guard that makes it safe. Two properties in one test
  // because they are one behaviour: the sweep must actually be reached from the idle
  // branch — a collector nobody calls is the defect this whole task is about — and the
  // live set it is handed must contain every task the state repo does not consider
  // finished, because inferring that from mtimes is how a running session loses its work.
  //
  // `intervalHours: 0` so the second idle poll sweeps. The FIRST only starts the clock,
  // deliberately, so that a runner crash-looping every few minutes does not sweep on every
  // boot — which is the one moment its worktrees are most likely to be wanted.
  const LIVE = asTaskId("REAP-SWEEP-LIVE");
  const GONE = asTaskId("REAP-SWEEP-DONE");
  await seedTask(LIVE, { status: "awaiting-human" });
  await seedTask(GONE, { status: "done" });

  const { reaper, swept } = recordingReaper();
  const supervisor = new Supervisor({
    config: { ...config, workspace: { reap: { intervalHours: 0, keepHours: 72 } } },
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: { run: () => Promise.reject(new Error("no task should be claimed here")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && swept.length === 0) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  const live = swept[0];
  assert.ok(live !== undefined, "the idle branch must reach the sweep at all");
  assert.ok(
    live.includes(LIVE),
    "a task awaiting a human resumes against its checkout and must be declared live",
  );
  assert.ok(
    !live.includes(GONE),
    "a task the state repo calls done is not live, or the sweep can never remove anything",
  );
});

test("a survey that came back empty does not sweep the whole volume", async () => {
  // The one way the live-task guard can be true and useless at the same time. `survey`
  // skips a state that will not parse, and `listTasks` walks a CHECKOUT that a failed pull
  // can leave empty — so "no tasks" and "the state repo is unreadable right now" arrive at
  // the sweep as the same value, and one of those two readings means every directory on
  // the volume is an orphan. A real state repo always holds at least the task this runner
  // has been working, so an empty survey is evidence about the repo and not about disk.
  //
  // `listTasks` is the exact surface that goes quiet: it walks `tasks/` on disk and
  // answers `[]` when the directory is not there. Overridden rather than staged with a
  // real broken checkout because `pull` runs first on every poll and would heal it — which
  // is itself worth knowing, and is why this failure is transient and easy to miss.
  class BlindStore extends StateStore {
    override listTasks(): Promise<readonly TaskId[]> {
      return Promise.resolve([]);
    }
  }

  const { reaper, swept } = recordingReaper();
  const supervisor = new Supervisor({
    config: { ...config, workspace: { reap: { intervalHours: 0, keepHours: 72 } } },
    store: new BlindStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: { run: () => Promise.reject(new Error("no task should be claimed here")) },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: TEST_TOOLCHAIN,
    worktrees: reaper,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  // Several idle polls at `pollSeconds: 1` — long past the point the interval would have
  // let a sweep through if the guard were not there.
  await sleep(4_000);
  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(
    swept,
    [],
    "an unreadable state repo must never be read as 'every worktree here is an orphan'",
  );
});

/**
 * Housekeeping on its own timer (DESIGN.md §6.4).
 *
 * Everything below shares one shape, because the defect had one shape: a session runs for
 * hours, and while it does, something a human or a tracker is waiting on must still happen.
 * Before the split it did not — `pollOnce` ran `store.pull` → `chat.refresh` →
 * `applyChatRequests` → `maybeIngest` → `drainAlerts` → `maybeDigest` → `claimNext` →
 * `workTask` in one `while`, so every step before `workTask` was blocked for the whole of it.
 *
 * Each test therefore occupies the runner with a session that does not end on its own, and
 * asserts the housekeeping step happens ANYWAY. A test that only proves the step runs at
 * all passes with the bug in place, so the "is the session actually in flight" wait before
 * each assertion is load-bearing rather than defensive.
 */

/**
 * A session that runs until aborted — a task that takes hours, in one stub.
 *
 * `keepalive` is the same load-bearing interval `/cancel`'s test documents: every timer the
 * supervisor arms for a session is unref'd, so a bare Supervisor with no metrics port and
 * no credential socket would otherwise let node end the test with the loop half-drained.
 */
/**
 * How long a test may wait for this runner to claim something and start a session.
 *
 * `npm test` also carries `--test-timeout`, which is the backstop for a wait that never
 * ends; this is the budget for one that is merely slow. Both exist because the failure mode
 * they cover is not a red test — it is a green-looking job that never finishes.
 */
const CLAIM_BUDGET_MS = 90_000;

const hangingSession = (): { readonly runner: SessionRunner; started: () => boolean } => {
  let begun = false;
  return {
    started: () => begun,
    runner: {
      run: (_spec, _state, signal) =>
        new Promise<SessionOutcome>((resolve) => {
          begun = true;
          // Ref'd deliberately: it is what keeps the process alive while this fake session
          // "runs", and an unref'd one would let node exit out from under the test.
          const keepalive = setInterval(() => {}, 1_000);
          const stop = (): void => {
            clearInterval(keepalive);
            resolve({
              reason: "interrupted",
              usage: EMPTY_USAGE,
              contextTokens: 0,
              summary: "stopped from outside",
            });
          };

          // A signal that is ALREADY aborted never fires the event, and this promise is what
          // `run()` awaits — so without this line an abort landing between the claim and this
          // call left the supervisor unable to unwind, the keepalive holding the loop open,
          // and the whole FILE hanging rather than failing. That is not hypothetical: it is
          // what turned one failed assertion in the presence test into a 20-minute CI job,
          // and because `build` needs `check` to pass, a deploy that silently did not happen.
          if (signal.aborted) {
            stop();
            return;
          }
          signal.addEventListener("abort", stop, { once: true });
        }),
    },
  };
};

/** Everything the loop tests fill in identically, so each test only states its subject. */
const busySupervisor = (
  store: StateStore,
  runner: SessionRunner,
  extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
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
    ...extra,
  });

test("a /resume submitted during a long session is served without waiting for it", async () => {
  // The headline case. `/resume` and `/answer` are the two commands a human types and then
  // watches for, and before the split both sat unread in the ChatInbox for the whole of a
  // session — hours, for a task that keeps handing off. The Discord interaction hung with
  // them.
  const BUSY = asTaskId("HK-BUSY-1");
  const WAITING = asTaskId("HK-PARKED-1");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });
  await seedTask(WAITING, { status: "parked", sessions: 2 });

  const store = new StateStore(statePath, stateGit);
  const inbox = new InMemoryChatQueue();
  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner, { inbox });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // The session must genuinely be in flight, or this is a test of an idle poll.
  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  // No timeout dance: `submit` resolves when the loop has dealt with it, so if
  // housekeeping were still behind the session this would simply never settle and the
  // test runner would fail on the pending promise.
  const outcome = await inbox.submit({ kind: "resume", task: WAITING });

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(outcome, { kind: "resumed", from: "parked" });
  assert.equal(
    (await pushedState(WAITING))?.status,
    "ready",
    "and it must be pushed, not merely answered",
  );

  await seedTask(BUSY, { status: "done" });
  await seedTask(WAITING, { status: "done" });
});

test("intake keeps running while a session holds the runner", async () => {
  // `maybeIngest` has always had its own interval, but the interval was only CONSULTED
  // when the one loop reached it — so a labelled GitHub issue was not ingested until the
  // current session ended. An interval nothing checks is not an interval.
  const BUSY = asTaskId("HK-BUSY-2");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const session = hangingSession();
  let passes = 0;
  const supervisor = busySupervisor(store, session.runner, {
    // One second, so several buckets pass inside the test's window. `intakeRef` keys the
    // fleet-wide claim on the bucket, so a longer interval would make this a test of
    // whether one pass happened to fall before the session started.
    config: { ...config, intake: { intervalSeconds: 1 } },
    intake: {
      ingest: () => {
        passes += 1;
        return Promise.resolve({ seen: 0, created: 0, rejected: 0, failed: 0 });
      },
    },
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  // Passes from BEFORE the session do not count: the first one fires at boot, and the
  // question is whether a LATER one does.
  const before = passes;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && passes <= before) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(passes > before, `intake must run during a session (${before} -> ${passes})`);

  await seedTask(BUSY, { status: "done" });
});

test("the Discord holder claim is refreshed during a session, not after it", async () => {
  // Per `ChatLeadership`'s own docstring this is refreshed from the supervisor's loop, and
  // both halves of it — renewing and STEPPING DOWN — happen in the one `refresh` call. So
  // a replica that took the claim and then started a four-hour session did neither for
  // four hours: it kept believing it was the holder while the claim went stale, and the
  // bot sat online answering nothing. Nothing about that is fixed by the claim itself; it
  // is fixed by the loop that renews it also being the loop that answers.
  const BUSY = asTaskId("HK-BUSY-3");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const session = hangingSession();
  let refreshes = 0;
  const supervisor = busySupervisor(store, session.runner, {
    chat: {
      refresh: () => {
        refreshes += 1;
        return Promise.resolve();
      },
    },
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  const before = refreshes;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && refreshes <= before + 1) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    refreshes > before + 1,
    `the claim must keep being refreshed during a session (${before} -> ${refreshes})`,
  );

  await seedTask(BUSY, { status: "done" });
});

test("what Discord reads stays current while a session runs", async () => {
  // `/tasks`, `/task` and autocomplete are served from an in-memory snapshot rather than
  // through the inbox, precisely so a read never waits on a session (DESIGN.md §7). The
  // snapshot is published by `survey`, and `survey` is what the WORK loop calls on its way
  // to claiming — so leaving it there alone would have reintroduced the defect through the
  // reader instead of the writer: a session claims, the sweep never comes round again, and
  // `/tasks` answers for hours from a view taken before the session started. It would still
  // answer in milliseconds, which is what makes it worth pinning.
  const BUSY = asTaskId("HK-SNAP-1");
  const LATER = asTaskId("HK-SNAP-2");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const view = new TaskSnapshot();
  const snapshot = new InMemorySnapshotStore(view);
  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner, { snapshot });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  // A task that did not exist when the session began. Only a sweep that runs DURING the
  // session can ever put it in front of a human.
  await seedTask(LATER, { status: "awaiting-human" });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && view.find(LATER) === undefined) await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(view.find(LATER) !== undefined, "`/task` must see a task created mid-session");
  assert.ok(
    view.suggest("HK-SNAP").some((task) => task.id === LATER),
    "and autocomplete, which is the whole reason the snapshot exists",
  );
  // The running task's status moved too, so this is a live view rather than one stale
  // entry appended to a frozen one.
  assert.equal(view.find(BUSY)?.status, "running");

  await seedTask(BUSY, { status: "done" });
  await seedTask(LATER, { status: "done" });
});

test("a failing housekeeping pass belongs to that pass, never to the process", async () => {
  // The containment the single loop already had, now needed twice — and the reason it
  // matters is unchanged: a throw out of `run()` reaches main's `finally`, which closes
  // /healthz and the credential socket and then blocks forever on `await bridge`. A live
  // process, still answering Discord from a frozen snapshot, that polls nothing and that
  // systemd never restarts because it never exited.
  //
  // Asserted through the WORK loop, not just by counting failures: the two loops are
  // awaited together, so a housekeeping throw that escaped would take claiming with it.
  const SURVIVOR = asTaskId("HK-SURVIVE-1");
  await seedTask(SURVIVOR);

  const store = new StateStore(statePath, stateGit);
  let refreshes = 0;
  const supervisor = busySupervisor(
    store,
    { run: () => Promise.reject(new Error("session not under test")) },
    {
      chat: {
        refresh: () => {
          refreshes += 1;
          return Promise.reject(new Error("ls-remote: could not read from remote repository"));
        },
      },
    },
  );

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Both conditions, and neither may short-circuit the other. The work loop parks the
  // task — which it cannot, if the housekeeping throw killed `run` — and housekeeping
  // keeps coming round after throwing, which is only visible over more than one interval.
  let parked: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (parked === undefined || refreshes <= 1)) {
    const state = await pushedState(SURVIVOR);
    if (state?.status === "parked") parked = state;
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(refreshes > 1, "housekeeping must keep going round after a throw");
  assert.ok(parked !== undefined, "and the work loop must be unaffected by it");
});

test("housekeeping does not reset over a session's uncommitted state", async () => {
  // The half the mutex does not cover, at the level the two loops actually meet.
  // `store.pull` does `reset --hard` and `clean -ffdq` over `tasks/`; before the split it
  // could only run between sessions, and now it runs on a timer that knows nothing about
  // them. The window between a session's `writeState` and the `commitAndPush` that
  // persists it is minutes wide and contains no git at all, so serialising git calls says
  // nothing about it. `StateStore.pull` therefore declines while the tree is dirty.
  //
  // Driven through a real supervisor with a real remote that MOVES, so a pull that ran
  // would genuinely have something to reset to.
  const BUSY = asTaskId("HK-DIRTY-1");
  const OTHER = asTaskId("HK-DIRTY-2");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner);

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  // What a session writes between its commit points: a journal entry, and state the
  // supervisor has not pushed yet. Written directly, because the point is the CONTENT
  // being on disk and uncommitted — which is exactly what it looks like mid-`recordSession`.
  await store.appendJournal(BUSY, 1, "half a session's work, not yet committed");

  // And the remote moves, so there is something for a pull to reset onto.
  await seedTask(OTHER);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const journal = await store.readJournal(BUSY);
    assert.match(
      journal ?? "",
      /not yet committed/,
      "a housekeeping pull must not destroy a session's uncommitted work",
    );
    await sleep(200);
  }

  controller.abort();
  await running.catch(() => undefined);

  await seedTask(BUSY, { status: "done" });
  await seedTask(OTHER, { status: "done" });
});

test("two concurrent store writes are serialised, not interleaved", async () => {
  // The mutex, asserted on ORDER rather than on the absence of a crash. Two writers
  // interleaving `git add` and `git commit` in one checkout produce `index.lock` at best
  // and a commit carrying the other writer's half-written state at worst, and only the
  // first of those two throws — so "nothing blew up" is exactly the assertion that would
  // have passed while the real damage happened.
  //
  // Observed through `Git`, because that is where interleaving is visible: the sequence of
  // subcommands must contain no other writer's `commit` between one writer's `add` and its
  // own `commit`.
  const A = asTaskId("SERIAL-A");
  const B = asTaskId("SERIAL-B");
  await seedTask(A);
  await seedTask(B);

  const calls: string[] = [];
  const traced = new Git(statePath);
  const realRun = traced.run.bind(traced);
  Object.defineProperty(traced, "run", {
    value: async (...args: string[]): Promise<string> => {
      const [subcommand] = args;
      if (subcommand === "add" || subcommand === "commit") calls.push(String(subcommand));
      return realRun(...args);
    },
  });

  const store = new StateStore(statePath, traced);
  await store.pull("origin", "main");

  // Both started in the same tick, which is the case the mutex has to get right: if the
  // chain's tail were advanced after an await rather than synchronously, both would see
  // the same predecessor and both would run at once.
  //
  // Each writer takes the tree for its WHOLE write-then-commit unit, which is the atomic
  // shape a session has and the reason `exclusively` exists. Writing outside the lock and
  // committing inside it would serialise the git calls and still lose: `git add -A` stages
  // the whole tree, so whichever writer commits first carries both journals under its own
  // message and the second commits nothing. Serialising the git is necessary and is not
  // sufficient — that distinction is the subject here.
  const sleepy = async (ms: number): Promise<void> => sleep(ms);
  await Promise.all([
    store.exclusively(async (tree) => {
      await store.appendJournal(A, 1, "writer A");
      // A real session's gap between its write and its commit is minutes. One tick is
      // enough to hand control to the other writer if the lock were not held across it.
      await sleepy(20);
      await tree.commitAndPush(`chore(${A}): writer A`, "origin", "main");
    }),
    store.exclusively(async (tree) => {
      await store.appendJournal(B, 1, "writer B");
      await sleepy(1);
      await tree.commitAndPush(`chore(${B}): writer B`, "origin", "main");
    }),
  ]);

  // Each unit stages up to four paths and commits once. Interleaving shows up as an `add`
  // after the first `commit` but before the second — the second writer entering while the
  // first was still between its stage and its commit.
  const firstCommit = calls.indexOf("commit");
  assert.ok(firstCommit > 0, "both writers must have staged and committed");
  assert.ok(
    calls.slice(0, firstCommit).every((call) => call === "add"),
    `nothing may commit while another writer is staging: ${calls.join(",")}`,
  );
  assert.equal(
    calls.filter((call) => call === "commit").length,
    2,
    "two writers, two commits — a merged one would mean a mixed commit",
  );

  // And the two commits say what each writer wrote, rather than one of them carrying the
  // other's file. This is the assertion that fails when only the git calls are serialised.
  const log = await stateGit.run("log", "-2", "--name-only", "--format=%s");
  assert.match(log, new RegExp(`chore\\(${A}\\): writer A`));
  assert.match(log, new RegExp(`chore\\(${B}\\): writer B`));

  await seedTask(A, { status: "done" });
  await seedTask(B, { status: "done" });
});

/**
 * A queue whose `takeWhere`/`some` are stubs, exactly as `RedisChatQueue`'s are.
 *
 * The in-memory queue every other test here uses CAN take selectively, and that is what
 * let a real outage through CI: `applyChatRequests` routed the whole drain through
 * `takeWhere` whenever a session was in flight, which against the Redis queue returns
 * empty unconditionally. So on a Redis-backed fleet nothing at all was drained for the
 * duration of every session — the exact defect the housekeeping split exists to remove,
 * on the multi-replica path it was aimed at. Reproducing the stub locally is what stops
 * that being invisible again; it deliberately does not use Redis, because the property
 * under test is `selective`, not the transport.
 */
class NonSelectiveChatQueue implements ChatDrainer {
  readonly selective = false;

  private readonly inner: InMemoryChatQueue;

  constructor(inner: InMemoryChatQueue) {
    this.inner = inner;
  }

  drain(): Promise<readonly ChatRequest[]> {
    return this.inner.drain();
  }

  takeWhere(): Promise<readonly ChatRequest[]> {
    return Promise.resolve([]);
  }

  some(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

test("a queue with no selective take is still drained during a session", async () => {
  // The Redis case. `takeWhere` is a stub there, so a drain routed through it returns
  // nothing — and it was routed through it for precisely as long as a session was in
  // flight. `/resume`, `/answer`, `/merge` and `/brainstorm` all went unserved for hours,
  // silently, with DESIGN.md and three docstrings asserting the opposite.
  const BUSY = asTaskId("HK-NOSEL-1");
  const WAITING = asTaskId("HK-NOSEL-2");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });
  await seedTask(WAITING, { status: "parked", sessions: 2 });

  const store = new StateStore(statePath, stateGit);
  const submitter = new InMemoryChatQueue();
  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner, {
    inbox: new NonSelectiveChatQueue(submitter),
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  // Never settles if the drain went through the stub — which is how this failed before.
  const outcome = await submitter.submit({ kind: "resume", task: WAITING });

  controller.abort();
  await running.catch(() => undefined);

  assert.deepEqual(outcome, { kind: "resumed", from: "parked" });
  assert.equal(
    (await pushedState(WAITING))?.status,
    "ready",
    "and pushed, not merely answered",
  );

  await seedTask(BUSY, { status: "done" });
  await seedTask(WAITING, { status: "done" });
});

test("a /cancel for the running task is served even when the queue cannot take selectively", async () => {
  // The other half of the same defect, and the worse half. On a selective queue this
  // request is left queued for the in-session `CANCEL_POLL_MS` watcher. That watcher polls
  // `takeWhere`, which is the very method a Redis queue stubs out — and nothing in the
  // process calls `CancelSignals.request` — so a `/cancel` for the in-flight task had NO
  // path at all: not the drain, not the watcher. Deleting the pod was the only way to stop
  // a session, which strands the task (DESIGN.md §6.2).
  //
  // So housekeeping drains it and routes it to the session directly. `cancelling` rather
  // than `parked`, because the session unwinds at a turn boundary and the park lands after.
  const BUSY = asTaskId("HK-NOSEL-3");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const submitter = new InMemoryChatQueue();
  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner, {
    inbox: new NonSelectiveChatQueue(submitter),
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  const outcome = await submitter.submit({ kind: "park", task: BUSY });

  // `cancelling`, and NOT `not-parkable: running` — that answer is the symptom of the
  // request having reached `applyPark`, which cannot claim the lease its own session holds.
  assert.deepEqual(outcome, { kind: "cancelling" }, "the human must be told it is stopping");

  // And it must actually stop, rather than merely being told so: the session's signal is
  // what `stop` aborts, so the hanging fixture resolves without the controller being
  // touched.
  const stopped = Date.now() + 30_000;
  while (Date.now() < stopped && (await pushedState(BUSY))?.status === "running") await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  await seedTask(BUSY, { status: "done" });
});

test("the work loop refreshes the checkout before it decides what to claim", async () => {
  // Splitting the loops silently broke an ordering the single loop had for free. `pollOnce`
  // did pull -> claim in one pass, so a claim was always decided from a checkout refreshed
  // moments earlier. Afterwards the only pull was on the housekeeping loop — and `pull`
  // declines while the tree is dirty, which it is for the WHOLE of a session. So the first
  // claim after every session was made from a view of `tasks/` predating that session.
  //
  // `isClaimable` is a filter over local state and says so; only the lease CAS is
  // exclusive, and the CAS succeeds freely once another runner has released. A task
  // finished and released elsewhere therefore looked ready and claimable, and this runner
  // would open a session on already-merged work — §6.2's worst outcome.
  //
  // Pinned on a task that exists ONLY on the remote: nothing local can see it, so a claim
  // proves a pull happened first.
  const REMOTE_ONLY = asTaskId("WL-PULL-1");

  const store = new StateStore(statePath, stateGit);
  const claimed: TaskId[] = [];
  const supervisor = busySupervisor(store, {
    run: (spec) => {
      claimed.push(spec.id);
      return Promise.reject(new Error("session not under test"));
    },
  });

  // Created after the store exists and never pulled into it by this test — the supervisor
  // has to do that itself, on the work loop, on its way to claiming.
  await seedTask(REMOTE_ONLY);

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !claimed.includes(REMOTE_ONLY)) await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    claimed.includes(REMOTE_ONLY),
    "a claim must be decided from a freshly pulled checkout, not a stale one",
  );

  await seedTask(REMOTE_ONLY, { status: "done" });
});

test("the Discord presence keeps up with a session it is describing", async () => {
  // The whole point of §7.2: someone looking at the member list should see what the fleet is
  // working on without opening the web view. `survey` publishes it, and `survey` is on the
  // HOUSEKEEPING loop — so this is the same defect class the tests above pin, arriving
  // through the presence: a status that said "for work · 1 ready" for the entire length of a
  // session would be worse than no status, because it would be confidently wrong.
  //
  // The wait for the session to actually start is load-bearing. Without it this passes on
  // the first housekeeping pass, before anything is claimed, and proves nothing.
  const BUSY = asTaskId("HK-PRESENCE-1");
  await seedTask(BUSY, { limits: { maxSessions: 1_000_000 } });

  const store = new StateStore(statePath, stateGit);
  const published: string[] = [];
  const activity = new FleetActivity({ now: () => 1_000 });
  activity.attach((payload) => {
    const name = payload.activities[0]?.name;
    if (name !== undefined) published.push(name);
  });

  const session = hangingSession();
  const supervisor = busySupervisor(store, session.runner, { activity });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // Generous, because what is being waited for is a whole claim: a pull, a lease CAS, a
  // toolchain resolution and a session start, all git-heavy, on a runner sharing four cores
  // with three other test files. 30s was enough locally and not in CI, where this failed —
  // BEFORE the abort below, which is how it hung the file rather than failing it.
  const busy = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < busy && !session.started()) await sleep(50);
  assert.ok(session.started(), "the fixture must actually occupy the runner");

  const deadline = Date.now() + CLAIM_BUDGET_MS;
  while (Date.now() < deadline && !published.some((name) => name.startsWith(`${BUSY} · `)))
    await sleep(100);

  controller.abort();
  await running.catch(() => undefined);

  // Asserted on the PREFIX rather than the whole line. The phase is the session's to move,
  // and the suffix counts tasks the other tests in this file left behind — pinning either
  // here would make this test fail for reasons that have nothing to do with what it is
  // about, which is that the running task reaches the presence at all.
  assert.ok(
    published.some((name) => name.startsWith(`${BUSY} · `)),
    `the presence must name the running task, got ${JSON.stringify(published)}`,
  );

  await seedTask(BUSY, { status: "done" });
});

test("the survey publishes thread bindings for a bot that is not in this process", async () => {
  // The channel the split depends on (DESIGN.md §7). The standalone bot has no state repo,
  // so unless the supervisor puts the thread↔task mapping on the ephemeral plane, a reply
  // typed in a task's thread reaches a process that cannot tell which task it belongs to.
  const BOUND = asTaskId("SMOKE-THREAD-1");
  const FINISHED = asTaskId("SMOKE-THREAD-2");
  await seedTask(BOUND);
  await seedTask(FINISHED);

  const store = new StateStore(statePath, stateGit);
  await store.writeState({
    ...seed,
    id: BOUND,
    status: "awaiting-human",
    chat: { threadId: "1537785980415778816" },
  } as TaskState);
  await store.writeState({
    ...seed,
    id: FINISHED,
    status: "done",
    chat: { threadId: "1537785980415778999" },
  } as TaskState);
  await store.commitAndPush("chore: threads", "origin", "main");

  const published = new InMemoryThreadBindings();
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
    inbox: new InMemoryChatQueue(),
    threadBindings: published,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  // Generous, and generous on purpose: the first survey is behind a git fetch against a
  // real remote, and this file runs alongside every other suite. A tight budget here fails
  // as "the binding was never published" when the truth is "the machine was busy", which is
  // the least useful failure a test can produce.
  for (let attempt = 0; attempt < 1000 && ((await published.read()) ?? []).length === 0; attempt++) {
    await sleep(10);
  }
  controller.abort();
  await running.catch(() => undefined);

  const bindings = (await published.read()) ?? [];
  assert.notEqual(bindings.length, 0, "the survey never published any thread binding");
  assert.deepEqual(
    bindings.find((binding) => binding.task === BOUND),
    { threadId: "1537785980415778816", task: BOUND },
  );
  // A terminal task's thread is NOT published. Every message in a bound thread is read as
  // an answer, so leaving a finished conversation bound means the bot silently swallows
  // whatever is typed into it.
  assert.equal(
    bindings.some((binding) => binding.task === FINISHED),
    false,
    "a done task's thread must not stay bound",
  );
});
