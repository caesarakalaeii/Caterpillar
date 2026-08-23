/**
 * The whole steering and guidance path, from a Discord gateway payload to a git commit.
 *
 * Everything below this file tests one seam. This tests that they JOIN, because the four
 * defects DESIGN.md §7.3 records were each in a different component and each one on its own
 * was invisible — a human who cannot type anywhere useful cannot discover that the typing was
 * going nowhere. `BS-1539374658363854934` was sent back 13 times against a cap of 3 with every
 * individual mechanism working exactly as written.
 *
 * So this drives the real gateway dispatcher over a fake socket, the real bridge, the real
 * in-process queue, and a real `Supervisor` over a real git remote. What is faked is the model
 * (a session runner that reports what it was handed) and Discord's REST API (a loopback
 * server), because neither has anything to say about whether the pieces line up.
 *
 * Two journeys, and they are the two the notifications promise:
 *
 *   a message typed in a RUNNING task's thread reaches the live session, and
 *   a message typed in a PARKED task's thread lands in git, resets the round count, and the
 *   Resume button in the same thread puts the task back.
 *
 * Asserted against the ORIGIN and against what the session was handed, never against a reply:
 * "noted" over a journal that was never written is the failure this replaced, with extra steps.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asRunnerId, asTaskId, EMPTY_USAGE, type TaskState } from "../domain/task.ts";
import type { SteeringFeed } from "../agent/steering.ts";

import type { RunnerConfig } from "../config/types.ts";
import { DiscordBot } from "../notify/bot.ts";
import { DiscordBridge } from "../notify/bridge.ts";
import { encodeCustomId } from "../notify/components.ts";
import { NullNotifier } from "../notify/discord.ts";
import { ThreadIndex } from "../notify/threads.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { InMemoryChatQueue } from "../redis/inbox.ts";
import { InMemorySnapshotStore } from "../redis/snapshot.ts";
import { InMemorySteeringInbox } from "../redis/steering.ts";
import { Git } from "../state/git.ts";
import { LeaseManager } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { DEFAULT_USAGE_CONFIG } from "../workspace/usage.ts";
import { DEFAULT_REAP_CONFIG } from "../workspace/worktree.ts";
import { ChatInbox } from "./inbox.ts";
import { Supervisor } from "./loop.ts";
import { summarise } from "./snapshot.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const CHANNEL = "1537550186388258866";
/** The task id IS the thread id (§14.3), which is what makes a thread addressable at all. */
const RUNNING_THREAD = "1539374658363854934";
const PARKED_THREAD = "1539374658363854935";
const RUNNING = asTaskId(`BS-${RUNNING_THREAD}`);
const PARKED = asTaskId(`BS-${PARKED_THREAD}`);

const SPEC = [
  "---",
  "workspace: test",
  "repos:",
  "  - github.com/acme/widget",
  "acceptance:",
  '  - "true"',
  "---",
  "",
  "Refine the intake change into a plan.",
  "",
].join("\n");

const state = (over: Partial<TaskState>): TaskState => ({
  id: RUNNING,
  status: "ready",
  phase: "planning",
  requires: ["linux"],
  sessions: 1,
  limits: { maxSessions: 20 },
  usage: EMPTY_USAGE,
  progress: { lastProgressSession: 1, noProgressStreak: 0 },
  createdAt: "2026-08-19T09:00:00.000Z",
  updatedAt: "2026-08-19T09:00:00.000Z",
  ...over,
});

const identify = async (git: Git): Promise<void> => {
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");
};

interface World {
  readonly config: RunnerConfig;
  readonly origin: string;
  readonly statePath: string;
  readonly stateGit: Git;
  readonly root: string;
}

/** A bare origin holding the two tasks, and a runner clone of it. */
const world = async (tasks: readonly TaskState[]): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-steer-e2e-"));
  roots.push(root);

  const origin = join(root, "origin.git");
  const setup = new Git(root);
  await setup.run("init", "--bare", "--quiet", "--initial-branch=main", origin);

  const seedPath = join(root, "seed");
  await setup.run("clone", "--quiet", origin, seedPath);
  const seed = new Git(seedPath);
  await identify(seed);
  for (const task of tasks) {
    await mkdir(join(seedPath, "tasks", task.id), { recursive: true });
    await writeFile(join(seedPath, "tasks", task.id, "spec.md"), SPEC, "utf8");
    await writeFile(
      join(seedPath, "tasks", task.id, "state.json"),
      `${JSON.stringify(task, null, 2)}\n`,
      "utf8",
    );
  }
  await seed.run("add", "-A");
  await seed.run("commit", "-m", "seed");
  await seed.run("push", "origin", "HEAD:main");

  const statePath = join(root, "state");
  await setup.run("clone", "--quiet", origin, statePath);
  const stateGit = new Git(statePath);
  await identify(stateGit);

  return {
    origin,
    statePath,
    stateGit,
    root,
    config: {
      runnerId: "e2e-runner",
      capabilities: ["linux"],
      identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
      toolchain: DEFAULT_TOOLCHAIN_CONFIG,
      stateRepo: { url: origin, branch: "main", path: statePath },
      paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks"), root },
      usage: DEFAULT_USAGE_CONFIG,
      workspace: { reap: DEFAULT_REAP_CONFIG },
      lease: { heartbeatSeconds: 3600, staleAfterSeconds: 300 },
      handoff: { thresholdFraction: 0.7 },
      limits: {
        maxSessionsPerTask: 20,
        noProgressLimit: 3,
        maxReviewRounds: 3,
        maxSessionSeconds: 3600,
        commandTimeoutSeconds: 900,
        commandOutputMaxLines: 2000,
        commandOutputMaxBytes: 51200,
        sabotageMaxCommands: 40,
        sabotageMinFreeGb: 5,
        ciSettleSeconds: 1200,
        ciPollSeconds: 30,
      },
      log: { level: "info" },
      intake: { intervalSeconds: 300 },
      llm: {
        auth: "proxy",
        baseUrl: "http://localhost",
        modelId: "test",
        providerId: "test",
        contextWindow: 100_000,
        maxTokens: 4096,
        cooldown: { initialSeconds: 30, maxSeconds: 60 },
      },
      workspaces: new Map(),
      pollSeconds: 1,
      concurrency: 1,
      housekeepingSeconds: 1,
      secretsDir: join(root, "secrets"),
      digest: { enabled: false, hour: 18, timeZone: "Europe/Berlin", summarise: true },
      schedule: { enabled: false },
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
      bot: { mode: "in-process", port: 9091 },
      web: {
        enabled: false,
        port: 8080,
        logCapacity: 500,
        refreshSeconds: 10,
        requireForwardedUser: false,
        forwardedUserHeader: "remote-user",
      },
    },
  };
};

interface Posted {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** The bot, over a fetch that records instead of calling Discord. */
const discord = (): { readonly bot: DiscordBot; readonly posted: Posted[] } => {
  const posted: Posted[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    posted.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "1" }), { status: 200 }));
  };
  return {
    bot: new DiscordBot({
      token: "tok",
      channelId: CHANNEL,
      fetch,
      apiBase: "https://discord.test/api/v10",
    }),
    posted,
  };
};

/** Wait for a condition, and say so rather than assert — see `settle`. */
const waitFor = async (done: () => boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 300 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return done();
};

/**
 * Wait, then assert.
 *
 * Never used inside the fake session runner. A `throw` from there is a session that ERRORED,
 * which the supervisor answers by parking and re-claiming — so a broken expectation would come
 * back as a poll loop that never settles instead of as a failing assertion, and the file would
 * hang rather than fail. Verified by reverting the bridge fix and watching it do exactly that.
 */
const settle = async (done: () => boolean, what: string): Promise<void> => {
  assert.ok(await waitFor(done), what);
};

test("a message in a running task's thread reaches the live session", async () => {
  const { config, statePath, stateGit } = await world([state({ id: RUNNING, status: "ready" })]);
  const store = new StateStore(statePath, stateGit);
  const inbox = new ChatInbox();
  const queue = new InMemoryChatQueue(inbox);

  // The index a supervisor would have published. Bound BEFORE anything is typed, exactly as
  // `survey` does it — and it is bound at all only because the task is not `done`.
  const threads = new ThreadIndex();
  threads.bind(RUNNING_THREAD, RUNNING);

  const snapshot = new InMemorySnapshotStore();
  const { bot, posted } = discord();
  const bridge = new DiscordBridge({
    bot,
    inbox: queue,
    snapshot,
    threads,
    logger: SILENT_LOGGER,
    fetch: (url: string, init?: RequestInit) => {
      posted.push({
        url,
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });

  const handed: string[] = [];
  let feed: SteeringFeed | undefined;

  const supervisor = new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: async (_spec, _state, _signal, steering) => {
        // Stand in for pi's turn boundary: subscribe, then hold the session open until
        // something arrives — which is the only window in which a steer can be delivered.
        feed = steering;
        steering?.subscribe((text) => handed.push(text));
        // Bounded and silent: the test asserts on `handed`, and throwing here would park the
        // task and re-claim it forever instead of failing (see `settle`).
        await waitFor(() => handed.length > 0);
        return {
          reason: "handoff" as const,
          usage: EMPTY_USAGE,
          contextTokens: 10,
          summary: "took the operator's advice",
        };
      },
    },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: join(config.paths.tasks),
      identity: config.identity,
    }),
    inbox: queue,
    steering: new InMemorySteeringInbox(),
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);
  await settle(() => feed !== undefined, "no session ever started");

  // IN THROUGH DISCORD. Not `inbox.submit` — the point of this file is the join, and the
  // bridge is where "every message in a thread is for that task" is decided.
  await bridge.handleMessage("use the existing migration path", "operator", RUNNING_THREAD, "77");

  await settle(() => handed.length > 0, "the steer never reached the session");
  assert.deepEqual(handed, ["use the existing migration path"]);

  // Acknowledged on the human's own message, and nowhere else: a conversation of many short
  // replies must not gain a line per reply (§7.3).
  const reaction = posted.find((call) => call.url.includes("/reactions/"));
  assert.ok(reaction !== undefined, "the steer was not acknowledged at all");
  assert.equal(reaction?.method, "PUT");
  assert.equal(
    posted.filter((call) => call.url.endsWith("/messages")).length,
    0,
    "a steer must not post into the thread",
  );

  controller.abort();
  await running.catch(() => undefined);

  // And it is in git, because the journal is what the NEXT session reads — a steer pi never
  // polled would otherwise be lost with the session that queued it.
  const after = new StateStore(statePath, stateGit);
  await after.pull("origin", config.stateRepo.branch);
  const journal = await after.readJournal(RUNNING);
  assert.match(String(journal), /Steered by the operator/);
  assert.match(String(journal), /use the existing migration path/);
});

test("guidance in a parked task's thread lands in git, and the Resume button works", async () => {
  // The `BS-1539374658363854934` journey, end to end. Its plan was refused 13 times because
  // the guidance went nowhere and `/resume` bought exactly one more round each time.
  const parked = state({
    id: PARKED,
    status: "parked",
    chat: { threadId: PARKED_THREAD },
    review: { rounds: 3, last: "changes", reason: "**Criteria** — none are measurable." },
  });
  const { config, statePath, stateGit } = await world([parked]);
  const store = new StateStore(statePath, stateGit);
  const inbox = new ChatInbox();
  const queue = new InMemoryChatQueue(inbox);

  // Deliberately EMPTY. A parked task's thread used to be dropped from the index, and the
  // bridge resolves it from `BS-<threadId>` plus the snapshot — so this proves the path that
  // does not depend on a binding having been published.
  const threads = new ThreadIndex();
  const snapshot = new InMemorySnapshotStore();
  await snapshot.replace([summarise(parked)]);

  const { bot, posted } = discord();
  const bridge = new DiscordBridge({
    bot,
    inbox: queue,
    snapshot,
    threads,
    logger: SILENT_LOGGER,
  });

  const claimed: string[] = [];
  const supervisor = new Supervisor({
    config,
    store,
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: {
      run: (spec) => {
        claimed.push(spec.id);
        return Promise.resolve({
          reason: "handoff" as const,
          usage: EMPTY_USAGE,
          contextTokens: 10,
          summary: "read the guidance and started over",
        });
      },
    },
    verifier: { verify: () => Promise.resolve({ passed: false, detail: "unused" }) },
    progress: {
      probe: () =>
        Promise.resolve({ committed: true, acceptanceImproved: true, stepCompleted: true }),
    },
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: join(config.paths.tasks),
      identity: config.identity,
    }),
    inbox: queue,
    steering: new InMemorySteeringInbox(),
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  // 1. The human types in the thread the park notification pointed at.
  await bridge.handleMessage("cut it into two tasks, and make the criteria commands", "operator", PARKED_THREAD, "88");

  const reply = posted.find((call) => call.url.endsWith("/messages"));
  assert.ok(reply !== undefined, "guidance in a parked thread must be answered");
  assert.match(String(reply?.body["content"]), /round count/);
  const attached = reply?.body["components"] as readonly { components: { label?: string }[] }[];
  assert.deepEqual(
    attached?.flatMap((row) => row.components.map((c) => c.label)),
    ["Resume"],
    "the way back belongs in the message that acknowledged the guidance",
  );

  // 2. It is in git before anything is resumed, and the round count is forgiven — without
  //    which the next rejection is round 14 against a cap of 3 and the advice is never tested.
  const mid = new StateStore(statePath, stateGit);
  await mid.pull("origin", config.stateRepo.branch);
  assert.match(String(await mid.readJournal(PARKED)), /Guidance from the operator/);
  assert.match(String(await mid.readJournal(PARKED)), /make the criteria commands/);
  const guided = await mid.readState(PARKED);
  assert.equal(guided.status, "parked", "guidance alone does not restart anything");
  assert.equal(guided.review?.rounds, 0);
  assert.match(String(guided.review?.reason), /measurable/, "what the council said is kept");

  // 3. The button in that same message. A component interaction, from the thread, with the
  //    task encoded in the `custom_id` — the same `Command` a typed `/resume` produces.
  const customId = encodeCustomId({ verb: "res", task: PARKED });
  assert.ok(customId !== undefined);
  await bridge.handleInteraction({
    id: "i1",
    token: "t",
    type: 3,
    channel_id: PARKED_THREAD,
    channel: { id: PARKED_THREAD, parent_id: CHANNEL },
    data: { custom_id: customId },
    member: { user: { id: "u1", username: "operator" } },
  });

  await settle(() => claimed.includes(PARKED), "the resumed task was never claimed");

  controller.abort();
  await running.catch(() => undefined);
});
