/**
 * The standalone bot's wiring, over a Redis that is a heap.
 *
 * What is under test is the SPLIT itself rather than any one component: the bridge, the
 * gateway, the snapshot and the inbox all have their own suites, and this asserts that
 * the pieces joined together behave like a process with no state repo. So every fake here
 * is one of the existing ones — `MemoryRedisClient`, `InMemorySnapshotStore`, the
 * bridge's stubbed fetch — and there is deliberately no new harness.
 *
 * The scenario each test is really written against is two processes: a supervisor that
 * owns git and publishes, and a bot that owns Discord and consumes. Nothing may be passed
 * between them except through Redis, which is why the two sides are always built as
 * separate objects even where one would compile.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunnerId, asTaskId, type TaskState } from "./domain/task.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { DiscordBot } from "./notify/bot.ts";
import { DiscordBridge } from "./notify/bridge.ts";
import { RedisChatLock } from "./notify/leadership.ts";
import { threadBindings, ThreadIndex } from "./notify/threads.ts";
import { INTERACTION, type Interaction } from "./notify/interactions.ts";
import { SILENT_LOGGER } from "./obs/log.ts";
import { RedisChatQueue } from "./redis/inbox.ts";
import { MemoryRedisClient } from "./redis/memory.ts";
import { RedisSnapshotStore } from "./redis/snapshot.ts";
import { RedisThreadBindings } from "./redis/threads.ts";
import { InMemoryChatQueue } from "./redis/inbox.ts";
import { InMemorySnapshotStore } from "./redis/snapshot.ts";
import { summarise } from "./supervisor/snapshot.ts";
import type { ChatOutcome } from "./supervisor/inbox.ts";
import { refreshThreads, startHealthServer } from "./bot.ts";
import type { RunnerConfig } from "./config/types.ts";

const TASK = asTaskId("GH-acme-widget-42");
const CHANNEL = "1537550186388258866";
const THREAD = "1537785980415778816";
const API = "https://discord.test/api/v10";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const state = (over: Partial<TaskState> = {}): TaskState => ({
  id: TASK,
  status: "awaiting-human",
  phase: "implementing",
  requires: [],
  sessions: 3,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
  progress: { lastProgressSession: 2, noProgressStreak: 1 },
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T01:00:00.000Z",
  ...over,
});

/**
 * A bot process: the bridge, wired the way `src/bot.ts` wires it.
 *
 * Everything it can answer comes from `redis`; there is no `StateStore` in scope, which
 * is the point — a test that could reach one would not be testing the split.
 */
const botProcess = (
  redis: MemoryRedisClient,
  over: { readonly threads?: ThreadIndex; readonly leadership?: { held: () => boolean } } = {},
): {
  readonly bridge: DiscordBridge;
  readonly threads: ThreadIndex;
  readonly calls: Call[];
} => {
  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "999" }), { status: 200 }));
  };

  const threads = over.threads ?? new ThreadIndex();

  return {
    threads,
    calls,
    bridge: new DiscordBridge({
      bot: new DiscordBot({ token: "bot-token", channelId: CHANNEL, fetch, apiBase: API }),
      // Both halves are the REDIS ones. In the split these are the only things the bot
      // can see, and swapping either for its in-memory twin would quietly restore the
      // shared heap the split removes.
      inbox: new RedisChatQueue({ redis, logger: SILENT_LOGGER }),
      snapshot: new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }),
      threads,
      logger: SILENT_LOGGER,
      ...(over.leadership === undefined ? {} : { leadership: over.leadership }),
      fetch,
    }),
  };
};

const interaction = (over: Partial<Interaction>): Interaction => ({
  id: "i1",
  token: "interaction-token",
  type: INTERACTION.command,
  channel_id: CHANNEL,
  member: { user: { id: "u1", username: "operator" } },
  ...over,
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Stand in for the supervisor's poll loop: wait for the intent to appear, then take it.
 *
 * Polled rather than awaited because the two sides really are decoupled here — the bridge
 * pushes onto a list and subscribes for a reply, and nothing resolves on the bot side
 * until the supervisor settles it. That is the property being tested.
 */
const drainEventually = async (
  queue: RedisChatQueue,
): Promise<readonly Awaited<ReturnType<RedisChatQueue["drain"]>>[number][]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const drained = await queue.drain();
    if (drained.length > 0) return drained;
    await flush();
  }
  assert.fail("nothing ever reached the supervisor's inbox");
};

const callback = (calls: readonly Call[]): Call => {
  const found = calls.find((call) => call.url.includes("/callback"));
  assert.ok(found !== undefined, "the interaction was never acknowledged");
  return found;
};

const posted = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.url.endsWith("/messages"));

/* ───────────────────────── reads, without a state repo ───────────────────────── */

test("the bot answers /tasks from the redis snapshot, with no state repo in reach", async () => {
  const redis = new MemoryRedisClient();

  // The SUPERVISOR side: it is the only process that reads git, and all it does with what
  // it finds is publish summaries.
  await new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }).replace([
    summarise(state()),
    summarise(state({ id: asTaskId("GH-acme-widget-7"), status: "ready" })),
  ]);

  const bot = botProcess(redis);
  await bot.bridge.handleInteraction(interaction({ data: { name: "tasks" } }));

  const data = callback(bot.calls).body["data"] as { readonly content: string };
  assert.match(data.content, /GH-acme-widget-42/);
  assert.match(data.content, /GH-acme-widget-7/);
});

test("autocomplete is served from the snapshot, inside the interaction budget", async () => {
  // The 3-second rule. Going through the inbox for a suggestion list would mean waiting on
  // the supervisor's poll loop, which can be mid-session for hours.
  const redis = new MemoryRedisClient();
  await new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }).replace([
    summarise(state()),
  ]);

  const bot = botProcess(redis);
  await bot.bridge.handleInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "task", options: [{ name: "task", value: "widget", focused: true }] },
    }),
  );

  const data = callback(bot.calls).body["data"] as {
    readonly choices: readonly { readonly value: string }[];
  };
  assert.deepEqual(data.choices.map((choice) => choice.value), [TASK]);
});

/* ───────────────────── writes, round-tripped through the inbox ───────────────────── */

test("a write intent round-trips through the redis inbox and the outcome reaches Discord", async () => {
  const redis = new MemoryRedisClient();
  const bot = botProcess(redis);

  // The supervisor's half of the queue — a different object over the same server, because
  // in production it is a different process.
  const supervisor = new RedisChatQueue({ redis, logger: SILENT_LOGGER });

  const handled = bot.bridge.handleInteraction(
    interaction({ data: { name: "resume", options: [{ name: "task", value: TASK }] } }),
  );

  // The click is acknowledged immediately, before the supervisor has seen anything: the
  // interaction token dies in 3 seconds and the loop may be hours away.
  await flush();
  assert.ok(
    bot.calls.some((call) => call.url.includes("/callback")),
    "the click was not acknowledged inside the interaction budget",
  );

  const drained = await drainEventually(supervisor);
  assert.equal(drained.length, 1, "the intent never reached the supervisor");
  // `ChatRequest` spreads the intent's own fields and adds `settle`; there is no nested
  // `intent`. Asserted field by field so a future field on the union cannot silently
  // change what the bot is understood to have sent.
  assert.equal(drained[0]?.kind, "resume");
  assert.equal(drained[0]?.task, TASK);

  // Settled on the supervisor side; the answer has to travel back over the reply channel.
  drained[0]?.settle({ kind: "resumed", from: "parked" } satisfies ChatOutcome);
  await handled;

  const said = posted(bot.calls);
  assert.equal(said.length, 1, "the outcome never reached the channel");
  assert.match(String(said[0]?.body["content"]), /Resumed \*\*GH-acme-widget-42\*\*/);
});

/* ─────────────────────────── the thread index, over redis ─────────────────────────── */

test("a binding published by the supervisor becomes routable in the bot", async () => {
  const redis = new MemoryRedisClient();
  const bot = botProcess(redis);

  // Cold start: the bot is up before any supervisor has published.
  assert.equal(bot.threads.knows(THREAD), false);

  // The supervisor derives bindings from task state exactly as it does in-process, and
  // publishes them. `threadBindings` is the same pure function both sides use.
  const published = threadBindings([{ id: TASK, status: "awaiting-human", threadId: THREAD }]);
  await new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }).publish(
    published.map(([threadId, task]) => ({ threadId, task })),
  );

  // ...and the bot pulls them in, which is what `refreshThreads` does on its timer.
  const bindings =
    (await new RedisThreadBindings({
      redis,
      logger: SILENT_LOGGER,
      cacheTtlMs: 0,
    }).read()) ?? [];
  bot.threads.replace(bindings.map((binding) => [binding.threadId, binding.task] as const));

  assert.equal(bot.threads.knows(THREAD), true);
  assert.equal(bot.threads.taskFor(THREAD), TASK);

  // And now a bare message in that thread is an answer to that task, with no id typed.
  const supervisor = new RedisChatQueue({ redis, logger: SILENT_LOGGER });
  const handled = bot.bridge.handleMessage("use the existing migration path", "operator", THREAD);

  const drained = await drainEventually(supervisor);
  assert.equal(drained[0]?.kind, "answer");
  assert.equal(drained[0]?.task, TASK);
  // The thread is the id: nothing in the message named the task.
  assert.equal(
    (drained[0] as unknown as { readonly text?: string }).text,
    "use the existing migration path",
  );
  drained[0]?.settle({ kind: "applied", index: 1 });
  await handled;
});

test("a thread the bot has no binding for gets an honest message, never silence", async () => {
  // The staleness window, which is ROUTINE here and unreachable in the unsplit process:
  // the bot may start before any supervisor has published, and a binding written seconds
  // ago has not arrived yet.
  const redis = new MemoryRedisClient();
  const bot = botProcess(redis);

  await bot.bridge.handleMessage("we want B", "operator", THREAD);

  const said = posted(bot.calls);
  assert.equal(said.length, 1, "a human typing into an unknown thread was told nothing");
  assert.match(String(said[0]?.body["content"]), /do not know which task this thread/i);
  // In the thread, where the person is looking.
  assert.match(String(said[0]?.url), new RegExp(`/channels/${THREAD}/messages$`));
});

test("a brainstorm thread the bot just opened survives the next refresh", async () => {
  // The window between creating a thread and the supervisor publishing a binding for it is
  // several refreshes wide: the task does not exist until the intent is drained, and the
  // mapping only carries tasks. A refresh in that window says nothing about the thread, and
  // if that unbound it the human invited to type there would get silence — the gateway
  // drops messages from threads the index does not know, so not even the honest message
  // above would be reached.
  const redis = new MemoryRedisClient();
  const bot = botProcess(redis);

  // What `startBrainstorm` does the moment the thread exists, before any task does.
  bot.threads.bind(THREAD, asTaskId("BS-1537785980415778816"));

  // Meanwhile the supervisor publishes the fleet's OTHER threads, knowing nothing of this
  // one yet, and the bot's timer pulls them in.
  const supervisorSide = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  const botSide = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  await supervisorSide.publish([{ threadId: "9999", task: TASK }]);
  await refreshThreads(botSide, bot.threads, SILENT_LOGGER);

  assert.equal(bot.threads.knows(THREAD), true, "the fresh brainstorm thread was unbound");
  assert.equal(bot.threads.knows("9999"), true, "the published binding never arrived");

  // ...and once the task exists and the supervisor publishes it, the published value wins.
  await supervisorSide.publish([
    { threadId: "9999", task: TASK },
    { threadId: THREAD, task: asTaskId("BS-1537785980415778816-01") },
  ]);
  await refreshThreads(botSide, bot.threads, SILENT_LOGGER);

  assert.equal(bot.threads.taskFor(THREAD), asTaskId("BS-1537785980415778816-01"));
});

/* ────────────────────────── one process acts, during a rollout ────────────────────────── */

test("of two overlapping bot processes exactly one acts", async () => {
  // The rolling-update window. Both are connected; both see the same message; only the
  // lock holder may answer it, or a `/brainstorm` mints two threads and two tasks.
  const redis = new MemoryRedisClient();

  const incoming = new RedisChatLock({
    redis,
    runner: asRunnerId("caterpillar-bot-1"),
    logger: SILENT_LOGGER,
  });
  const outgoing = new RedisChatLock({
    redis,
    runner: asRunnerId("caterpillar-bot-2"),
    logger: SILENT_LOGGER,
  });
  await incoming.refresh();
  await outgoing.refresh();

  const first = botProcess(redis, { leadership: incoming });
  const second = botProcess(redis, { leadership: outgoing });

  await first.bridge.handleInteraction(interaction({ data: { name: "tasks" } }));
  await second.bridge.handleInteraction(interaction({ data: { name: "tasks" } }));

  assert.equal(first.calls.length, 1, "the holder must answer");
  assert.deepEqual(second.calls, [], "the other must not — silence, not a second reply");
});

/* ───────────────────────────── health and readiness ───────────────────────────── */

const config = (port: number): RunnerConfig =>
  ({ bot: { mode: "external", port }, log: { level: "error" } }) as unknown as RunnerConfig;

const probe = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

/** A plane stub exposing only what the health check reads. */
const planeWith = (redisUp: boolean): Parameters<typeof startHealthServer>[0]["plane"] =>
  ({
    threads: {
      read: () =>
        redisUp ? Promise.resolve([]) : Promise.reject(new Error("redis is unreachable")),
    },
  }) as unknown as Parameters<typeof startHealthServer>[0]["plane"];

test("readiness reflects the gateway and redis, not merely that the port is bound", async () => {
  // `supervisor/loop.ts:~287`'s lesson: a process that answers probes while doing nothing
  // useful is worse than one that exits, because nothing restarts it and nothing pages.
  const stop = startHealthServer({
    config: config(19_311),
    metrics: new AgentMetrics(),
    gateway: { connected: () => false },
    plane: planeWith(true),
    logger: SILENT_LOGGER,
  });

  try {
    await flush();
    const ready = await probe(19_311, "/readyz");

    assert.equal(ready.status, 503, "a disconnected gateway must not read as ready");
    const body = JSON.parse(ready.body) as Record<string, unknown>;
    assert.equal(body["gateway"], false);
    assert.equal(body["redis"], true);

    // Liveness stays true: restarting the process does not reconnect a gateway any faster,
    // and a liveness probe that reacted to this would be a crash loop.
    assert.equal((await probe(19_311, "/healthz")).status, 200);
  } finally {
    stop();
  }
});

test("an unreachable redis makes the bot unready, because it can answer nothing", async () => {
  const stop = startHealthServer({
    config: config(19_312),
    metrics: new AgentMetrics(),
    gateway: { connected: () => true },
    plane: planeWith(false),
    logger: SILENT_LOGGER,
  });

  try {
    await flush();
    const ready = await probe(19_312, "/readyz");

    assert.equal(ready.status, 503);
    const body = JSON.parse(ready.body) as Record<string, unknown>;
    assert.equal(body["redis"], false);
  } finally {
    stop();
  }
});

test("a connected gateway and a reachable redis is ready, and metrics are served", async () => {
  const stop = startHealthServer({
    config: config(19_313),
    metrics: new AgentMetrics(),
    gateway: { connected: () => true },
    plane: planeWith(true),
    logger: SILENT_LOGGER,
  });

  try {
    await flush();
    assert.equal((await probe(19_313, "/readyz")).status, 200);

    // The same registry the supervisor uses, not a fork of it.
    const metrics = await probe(19_313, "/metrics");
    assert.equal(metrics.status, 200);
    assert.match(metrics.body, /caterpillar_/);
  } finally {
    stop();
  }
});

/* ──────────────────────── the unsplit path is untouched ──────────────────────── */

test("with redis unconfigured the in-process wiring behaves exactly as before", async () => {
  // The single-replica and development path. It shares no code with the split above
  // beyond the bridge itself, which is the whole reason the existing suite stays
  // meaningful: the bridge cannot tell which side of the interfaces it is on.
  const inbox = new InMemoryChatQueue();
  const snapshot = new InMemorySnapshotStore();
  await snapshot.replace([summarise(state())]);

  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "999" }), { status: 200 }));
  };

  const bridge = new DiscordBridge({
    bot: new DiscordBot({ token: "bot-token", channelId: CHANNEL, fetch, apiBase: API }),
    inbox,
    snapshot,
    threads: new ThreadIndex(),
    logger: SILENT_LOGGER,
    // No leadership object at all, which is what a single supervisor has always passed.
    fetch,
  });

  await bridge.handleInteraction(interaction({ data: { name: "tasks" } }));

  assert.equal(inbox.size, 0, "a read still never queues work for the loop");
  const data = callback(calls).body["data"] as { readonly content: string };
  assert.match(data.content, /GH-acme-widget-42/);
});

test("an empty publish before any supervisor has spoken does not unbind a local thread", async () => {
  // The bot binds a brainstorm thread the moment it creates one, before any task exists.
  // Clearing on a cold-start empty read would unbind the thread a human was just invited
  // to type in, between the invitation and their first message.
  const redis = new MemoryRedisClient();
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);

  await refreshThreads(
    new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }),
    threads,
    SILENT_LOGGER,
  );

  assert.equal(threads.taskFor(THREAD), TASK, "a cold-start empty read must not unbind");
});

test("an empty publish AFTER a real one clears, so a finished thread stops swallowing", async () => {
  // The other half of the same shape: once the fleet has published, empty means the last
  // task went terminal. Leaving it bound means every message in a finished conversation is
  // still read as an answer, and silently goes nowhere.
  const redis = new MemoryRedisClient();
  const store = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  const threads = new ThreadIndex();

  await store.publish([{ threadId: THREAD, task: TASK }]);
  await refreshThreads(store, threads, SILENT_LOGGER);
  assert.equal(threads.taskFor(THREAD), TASK);

  // The task finishes; `threadBindings` drops it and the supervisor publishes nothing.
  await store.publish([]);
  await refreshThreads(store, threads, SILENT_LOGGER);

  assert.equal(threads.taskFor(THREAD), undefined, "a terminal task's thread must unbind");
});

test("an unreachable redis leaves the index exactly as it was", async () => {
  // Neither branch: a failed read is not an empty one. Unbinding on a Redis blip would
  // make the bot stop listening to every live thread until it recovered.
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);

  await refreshThreads(
    { read: () => Promise.reject(new Error("redis is unreachable")) },
    threads,
    SILENT_LOGGER,
  );

  assert.equal(threads.taskFor(THREAD), TASK);
});
