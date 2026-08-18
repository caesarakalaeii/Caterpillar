/**
 * The thread↔task mapping the supervisor publishes and the standalone bot consumes.
 *
 * Every assertion here is about a window rather than a happy path, because the happy path
 * is a JSON round trip and the windows are what break a bot: it starts before any
 * supervisor has published, the key expires under it, the supervisor writes a field this
 * build does not know. Getting any of those wrong does not throw — it unbinds a thread,
 * and an unbound thread swallows what a human types into it in silence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { JsonLogger, SILENT_LOGGER } from "../obs/log.ts";
import { FailingRedisClient, MemoryRedisClient } from "./memory.ts";
import {
  InMemoryThreadBindings,
  RedisThreadBindings,
  THREADS_KEY,
  deserialise,
  serialise,
  type ThreadBinding,
} from "./threads.ts";

const BINDINGS: readonly ThreadBinding[] = [
  { threadId: "1537785980415778816", task: asTaskId("BS-1537785980415778816") },
  { threadId: "1537785980415778999", task: asTaskId("GH-acme-widget-42") },
];

test("serialise/deserialise is a round trip", () => {
  assert.deepEqual(deserialise(serialise(BINDINGS)), BINDINGS);
});

test("a binding published by the supervisor is visible to a separate reader", async () => {
  const redis = new MemoryRedisClient();
  // Two stores over one server: the supervisor's writer and the bot's reader are
  // different processes, so nothing may be carried between them in a closure.
  const supervisor = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  const bot = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });

  await supervisor.publish(BINDINGS);

  assert.deepEqual(await bot.read(), BINDINGS);
});

test("a bot that starts before any supervisor has published reads empty, not stale", async () => {
  const bot = new RedisThreadBindings({
    redis: new MemoryRedisClient(),
    logger: SILENT_LOGGER,
    cacheTtlMs: 0,
  });

  // Cold start. The honest answer is "I know of no threads", which the bridge turns into
  // a message saying so — never silence.
  assert.deepEqual(await bot.read(), []);
});

test("a failed read serves the last good mapping rather than unbinding every thread", async () => {
  const redis = new MemoryRedisClient();
  const bot = new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  await new RedisThreadBindings({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 }).publish(BINDINGS);

  assert.deepEqual(await bot.read(), BINDINGS);

  // The key expiring, or Redis going away, must not be read as "the fleet has no threads".
  // Blanking here would silently stop the bot listening to every live thread at once.
  await redis.del(THREADS_KEY);
  assert.deepEqual(await bot.read(), BINDINGS);
});

test("a Redis that is down degrades rather than throwing", async () => {
  const bot = new RedisThreadBindings({
    redis: new FailingRedisClient(),
    logger: SILENT_LOGGER,
    cacheTtlMs: 0,
  });

  assert.deepEqual(await bot.read(), []);
  // A write that cannot land is dropped with a warn, not raised: nothing here is
  // authoritative, and a housekeeping pass must not fail because Redis blinked.
  await bot.publish(BINDINGS);
  // ...and the publisher's own view is still correct, because the local copy is written
  // first and unconditionally.
  assert.deepEqual(await bot.read(), BINDINGS);
});

test("one unparseable entry costs one thread, not the whole index", () => {
  const raw = JSON.stringify([
    { threadId: "111", task: "GH-acme-widget-1" },
    { threadId: 222, task: "GH-acme-widget-2" },
    { threadId: "333", task: "" },
    { threadId: "444", task: "GH-acme-widget-4" },
  ]);

  // A fleet mid-upgrade may write something this build does not understand. Losing one
  // thread from the index is recoverable; losing the index is not.
  assert.deepEqual(deserialise(raw), [
    { threadId: "111", task: asTaskId("GH-acme-widget-1") },
    { threadId: "444", task: asTaskId("GH-acme-widget-4") },
  ]);
});

test("a corrupt key is logged and keeps the last good mapping", async () => {
  const lines: string[] = [];
  const redis = new MemoryRedisClient();
  const bot = new RedisThreadBindings({
    redis,
    logger: new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
    cacheTtlMs: 0,
  });

  await bot.publish(BINDINGS);
  await redis.set(THREADS_KEY, "{not json");

  assert.deepEqual(await bot.read(), BINDINGS);
  assert.equal(
    lines.some((line) => (JSON.parse(line) as Record<string, unknown>)["event"] === "threads.unparseable"),
    true,
  );
});

test("the in-memory store is the same contract, for the unsplit path", async () => {
  const store = new InMemoryThreadBindings();

  assert.deepEqual(await store.read(), []);
  await store.publish(BINDINGS);
  assert.deepEqual(await store.read(), BINDINGS);
});

test("a burst of reads inside the cache window is one round trip", async () => {
  let gets = 0;
  const redis = new MemoryRedisClient();
  const counting = {
    ...redis,
    get: (key: string): Promise<string | undefined> => {
      gets += 1;
      return redis.get(key);
    },
  } as unknown as MemoryRedisClient;

  await redis.set(THREADS_KEY, serialise(BINDINGS));
  const bot = new RedisThreadBindings({ redis: counting, logger: SILENT_LOGGER, now: () => 1000 });

  // Read on every inbound message, so ten messages in a tick must not be ten round trips.
  await Promise.all([bot.read(), bot.read(), bot.read()]);
  await bot.read();

  assert.equal(gets, 1);
});
