/**
 * Unconfigured falls back, and a Redis that is down degrades rather than throws.
 *
 * The two properties the whole design rests on. Together they say: turning Redis off, and
 * Redis turning itself off, produce the same runner — the one that has always worked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedisConfig } from "../config/types.ts";
import { asRunnerId, asTaskId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { ChatInbox } from "../supervisor/inbox.ts";
import { summarise, TaskSnapshot } from "../supervisor/snapshot.ts";
import type { TaskState } from "../domain/task.ts";
import { FailingRedisClient, MemoryRedisClient } from "./memory.ts";
import { createEphemeralPlane, inMemoryPlane, redisPlane } from "./plane.ts";
import { RedisChatQueue } from "./inbox.ts";
import { RedisSnapshotStore } from "./snapshot.ts";
import { RedisPresenceRegistry } from "./presence.ts";
import { RedisCancelSignals } from "./cancel.ts";

const config = (over: Partial<RedisConfig> = {}): RedisConfig => ({
  enabled: false,
  url: "redis://localhost:6379",
  commandTimeoutMs: 100,
  keyPrefix: "caterpillar:",
  ...over,
});

const state = (over: Partial<TaskState> = {}): TaskState =>
  ({
    id: asTaskId("GH-acme-widget-1"),
    status: "ready",
    phase: "implementing",
    sessions: 1,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 1.25 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as TaskState;

test("unconfigured builds the in-process plane and touches no client", async () => {
  const plane = await createEphemeralPlane({
    config: config({ enabled: false }),
    secretsDir: "/nonexistent",
    // Every call on this one rejects. Passing it and having the plane work proves the
    // fallback is a different object, not the same object with a try/catch around it.
    client: new FailingRedisClient(),
    logger: SILENT_LOGGER,
  });

  assert.equal(plane.backed, false);
  assert.ok(plane.inbox instanceof ChatInbox, "the concrete inbox must stay reachable");
  assert.ok(plane.tasks instanceof TaskSnapshot);

  // A full round trip through the fallback, with the failing client sitting unused.
  const submitted = plane.chat.submit({ kind: "park", task: asTaskId("GH-acme-widget-1") });
  const drained = await plane.chat.drain();
  assert.equal(drained.length, 1);
  drained[0]?.settle({ kind: "parked" });
  assert.deepEqual(await submitted, { kind: "parked" });

  await plane.snapshot.replace([summarise(state())]);
  assert.equal((await plane.snapshot.all()).length, 1);

  await plane.runners.heartbeat(asRunnerId("runner-a"));
  assert.equal((await plane.runners.alive()).length, 1);

  await plane.close();
});

test("configured with an injected client builds the redis plane", async () => {
  const plane = await createEphemeralPlane({
    config: config({ enabled: true }),
    secretsDir: "/nonexistent",
    client: new MemoryRedisClient(),
    logger: SILENT_LOGGER,
  });

  assert.equal(plane.backed, true);
  // `takeWhere`/`some` have no Redis equivalent, so the concrete objects are NOT handed
  // back — a caller reaching for them must not silently get one that nothing writes to.
  assert.equal(plane.inbox, undefined);
  assert.equal(plane.tasks, undefined);

  await plane.snapshot.replace([summarise(state())]);
  assert.equal((await plane.snapshot.all()).length, 1);

  await plane.close();
});

test("the unconfigured plane is exactly the objects it hands back", async () => {
  const plane = inMemoryPlane();

  // The supervisor keeps using `plane.inbox` for `takeWhere` during a session while the
  // bridge submits through `plane.chat`. They have to be one queue, or a `/cancel` typed
  // mid-session would go somewhere the session never looks.
  const submitted = plane.chat.submit({ kind: "park", task: asTaskId("GH-acme-widget-2") });
  await new Promise((resolve) => setImmediate(resolve));

  const taken = plane.inbox?.takeWhere((request) => request.kind === "park") ?? [];
  assert.equal(taken.length, 1);
  taken[0]?.settle({ kind: "cancelling" });
  assert.deepEqual(await submitted, { kind: "cancelling" });

  await plane.close();
});

test("every structure degrades rather than throwing when redis is unreachable", async () => {
  const redis = new FailingRedisClient();
  const logger = SILENT_LOGGER;

  // A supervisor poll touches all four. None of these may reject: `pollOnce`'s catch is
  // for failures that belong to the poll, and an optional cache is not one of them.
  const chat = new RedisChatQueue({ redis, logger, submitTimeoutMs: 10 });
  assert.deepEqual(await chat.drain(), []);
  const outcome = await chat.submit({ kind: "park", task: asTaskId("GH-acme-widget-1") });
  // Told, not left hanging. "The queue is unreachable, try again" is advice; silence is
  // a human staring at a Discord thread wondering whether the command landed.
  assert.equal(outcome.kind, "failed");

  const snapshot = new RedisSnapshotStore({ redis, logger, cacheTtlMs: 0 });
  await snapshot.replace([summarise(state())]);
  // The LOCAL copy survives a failed write, so this runner's own view stays right.
  assert.equal((await snapshot.all()).length, 1);
  assert.equal((await snapshot.suggest("widget")).length, 1);

  const presence = new RedisPresenceRegistry({ redis, logger });
  await presence.heartbeat(asRunnerId("runner-a"));
  assert.deepEqual(await presence.alive(), []);
  await presence.depart(asRunnerId("runner-a"));

  const cancels = new RedisCancelSignals({ redis, logger });
  assert.equal(await cancels.request(asTaskId("GH-acme-widget-1")), false);
  // FALSE, emphatically. "I could not reach Redis" must never be read as "the human
  // asked me to stop" — that would abort a session on every network blip.
  assert.equal(await cancels.requested(asTaskId("GH-acme-widget-1")), false);
  await cancels.clear(asTaskId("GH-acme-widget-1"));

  // `watch` still returns a handle, so the session's `finally` has something to close.
  const watch = await cancels.watch(asTaskId("GH-acme-widget-1"), () => {
    assert.fail("an unreachable redis must not report a cancel");
  });
  await watch.close();
});

test("a plane over a failing client still closes cleanly", async () => {
  const plane = redisPlane(new FailingRedisClient(), SILENT_LOGGER);
  await plane.close();
});
