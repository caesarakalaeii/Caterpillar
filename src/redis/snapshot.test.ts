/**
 * Serialisation, caching, and the 3-second budget.
 *
 * `supervisor/snapshot.ts` exists because of one number: Discord gives an interaction
 * three seconds, and autocomplete has to be inside it on every keystroke. Everything
 * asserted here is that number wearing different clothes — one key not N, one round trip
 * per burst not one per character, and a stale answer in preference to no answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import { JsonLogger, SILENT_LOGGER } from "../obs/log.ts";
import { summarise, TaskSnapshot, type TaskSummary } from "../supervisor/snapshot.ts";
import { MemoryRedisClient } from "./memory.ts";
import {
  RedisSnapshotStore,
  SNAPSHOT_KEY,
  deserialise,
  serialise,
} from "./snapshot.ts";

const state = (over: Partial<TaskState> = {}): TaskState =>
  ({
    id: asTaskId("GH-acme-widget-1"),
    status: "ready",
    phase: "implementing",
    sessions: 3,
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 1.5 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as TaskState;

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  ...summarise(state()),
  ...over,
});

test("serialise/deserialise is a round trip, prUrl included and excluded", () => {
  const tasks: readonly TaskSummary[] = [
    summary(),
    summary({ id: asTaskId("GH-acme-widget-2"), prUrl: "https://example.invalid/pr/2" }),
  ];

  assert.deepEqual(deserialise(serialise(tasks)), tasks);
  // `exactOptionalPropertyTypes` is on, so an absent prUrl must stay absent rather than
  // becoming `undefined` — a `find()` result is rendered straight into a Discord message.
  assert.equal("prUrl" in (deserialise(serialise(tasks))?.[0] ?? {}), false);
});

test("the review record survives the round trip, reason and all", () => {
  // With Redis configured the process answering `/task` is the standalone bot, which holds
  // no state repo: this key is the only thing it knows. `parseSummary` rebuilds every field
  // by hand, so a field it forgets is dropped in silence — and "why does this keep getting
  // rejected" would be answerable on a single runner and unanswerable on the fleet.
  const tasks: readonly TaskSummary[] = [
    summary({
      review: {
        rounds: 3,
        last: "changes",
        reason: "**Decomposition** — the five proposed tasks are one task.",
      },
    }),
  ];

  const back = deserialise(serialise(tasks));
  assert.deepEqual(back, tasks);
  assert.equal(back?.[0]?.review?.reason, "**Decomposition** — the five proposed tasks are one task.");
});

test("a task with no review history keeps the field absent, not undefined", () => {
  // `exactOptionalPropertyTypes`, the same reason `prUrl` is asserted above.
  const back = deserialise(serialise([summary()]));
  assert.equal("review" in (back?.[0] ?? {}), false);
});

test("a malformed review record costs the history, not the task", () => {
  // The review history is the least important thing a summary carries. Dropping the whole
  // task to protect it would take it out of the autocomplete that names it.
  const raw = JSON.stringify([{ ...summary(), review: { rounds: "three", last: "nope" } }]);
  const back = deserialise(raw);

  assert.equal(back?.length, 1, "the task itself must survive");
  assert.equal(back?.[0]?.review, undefined);
});

test("suggest() keeps its ranking across the round trip", async () => {
  const redis = new MemoryRedisClient();
  const writer = new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });
  const reader = new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });

  const tasks = [
    summary({ id: asTaskId("GH-acme-widget-9"), status: "ready" }),
    summary({ id: asTaskId("GH-acme-widget-2"), status: "awaiting-human" }),
    summary({ id: asTaskId("GH-acme-widget-1"), status: "running" }),
    summary({ id: asTaskId("GH-acme-widget-7"), status: "awaiting-human" }),
  ];
  await writer.replace(tasks);

  // The ranking is `supervisor/snapshot.ts`'s and is asserted here rather than
  // reimplemented: awaiting-human first, then by id, capped at 25. Autocomplete exists
  // mostly to fill in `/answer`, and the task being answered is one that is waiting.
  const local = new TaskSnapshot();
  local.replace(tasks);

  assert.deepEqual(
    (await reader.suggest("widget")).map((task) => task.id),
    local.suggest("widget").map((task) => task.id),
  );
  assert.deepEqual(
    (await reader.suggest("widget")).map((task) => task.id),
    ["GH-acme-widget-2", "GH-acme-widget-7", "GH-acme-widget-1", "GH-acme-widget-9"],
  );
});

test("the cap of 25 survives the round trip", async () => {
  const redis = new MemoryRedisClient();
  const store = new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });

  await store.replace(
    Array.from({ length: 40 }, (_unused, index) =>
      summary({ id: asTaskId(`GH-acme-widget-${String(index).padStart(3, "0")}`) }),
    ),
  );

  // More than 25 is a 400 from Discord, so this is a hard limit rather than a preference.
  assert.equal((await store.suggest("widget")).length, 25);
  assert.equal((await store.all()).length, 40);
});

test("the whole list is one key, not one per task", async () => {
  const redis = new MemoryRedisClient();
  const store = new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });

  const reads: string[] = [];
  const counting = {
    ...redis,
    get: (key: string): Promise<string | undefined> => {
      reads.push(key);
      return redis.get(key);
    },
  };

  await store.replace([summary(), summary({ id: asTaskId("GH-acme-widget-2") })]);
  await new RedisSnapshotStore({
    redis: counting as typeof redis,
    logger: SILENT_LOGGER,
    cacheTtlMs: 0,
  }).all();

  // N round trips is a budget spent on latency before anything has been ranked. There is
  // no per-task layout that stays inside three seconds on a bad network.
  assert.deepEqual(reads, [SNAPSHOT_KEY]);
});

test("a burst of keystrokes costs one round trip, not one each", async () => {
  const redis = new MemoryRedisClient();
  await redis.set(SNAPSHOT_KEY, serialise([summary()]));

  let reads = 0;
  const counting = {
    ...redis,
    get: (key: string): Promise<string | undefined> => {
      reads += 1;
      return redis.get(key);
    },
  };

  let now = 1_000_000;
  const store = new RedisSnapshotStore({
    redis: counting as typeof redis,
    logger: SILENT_LOGGER,
    cacheTtlMs: 2000,
    now: () => now,
  });

  // Ten characters typed inside the cache window.
  for (const query of ["G", "GH", "GH-", "GH-a", "GH-ac", "GH-acm", "GH-acme", "GH-acme-"]) {
    assert.equal((await store.suggest(query)).length <= 1, true);
  }
  assert.equal(reads, 1, "the cache did not absorb the burst");

  now += 5000;
  await store.suggest("GH-acme-w");
  assert.equal(reads, 2, "the cache never expired");
});

test("concurrent reads in one tick share a single fetch", async () => {
  const redis = new MemoryRedisClient();
  await redis.set(SNAPSHOT_KEY, serialise([summary()]));

  let reads = 0;
  const counting = {
    ...redis,
    get: (key: string): Promise<string | undefined> => {
      reads += 1;
      return redis.get(key);
    },
  };

  const store = new RedisSnapshotStore({
    redis: counting as typeof redis,
    logger: SILENT_LOGGER,
    cacheTtlMs: 2000,
  });

  await Promise.all([store.all(), store.all(), store.all(), store.suggest("GH")]);
  assert.equal(reads, 1);
});

test("an absent key serves the last good value rather than blanking", async () => {
  const redis = new MemoryRedisClient();
  const store = new RedisSnapshotStore({ redis, logger: SILENT_LOGGER, cacheTtlMs: 0 });

  await store.replace([summary()]);
  // The key expires, and a rollout has a window where no supervisor has written one yet.
  // Serving [] there tells a human the fleet has lost every task.
  await redis.del(SNAPSHOT_KEY);

  assert.equal((await store.all()).length, 1);
});

test("an unparseable key is reported and the last good value kept", async () => {
  const lines: string[] = [];
  const redis = new MemoryRedisClient();
  const store = new RedisSnapshotStore({
    redis,
    logger: new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
    cacheTtlMs: 0,
  });

  await store.replace([summary()]);
  await redis.set(SNAPSHOT_KEY, "{{{ not json");

  assert.equal((await store.all()).length, 1);
  assert.equal(lines.filter((line) => line.includes("snapshot.unparseable")).length >= 1, true);
});

test("one malformed entry costs one task, not the whole list", () => {
  const good = summary();
  const raw = JSON.stringify([good, { id: "GH-acme-widget-2" }, summary({ id: asTaskId("GH-x-3") })]);

  // A fleet mid-upgrade can write a shape this build does not fully know. Losing one
  // task from an autocomplete list is better than losing the list.
  assert.equal(deserialise(raw)?.length, 2);
});

test("a body that is not an array at all is refused outright", () => {
  assert.equal(deserialise("{}"), undefined);
  assert.equal(deserialise("null"), undefined);
  assert.equal(deserialise("nonsense"), undefined);
});
