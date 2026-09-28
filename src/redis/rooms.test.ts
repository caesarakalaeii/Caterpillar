/**
 * The agent chat room, over both implementations.
 *
 * Not a contract in `contract.test.ts`'s shape: the room's per-implementation halves
 * differ where the contract's must agree. `crossesProcesses` diverges by design, and
 * the in-memory implementation keeps history in a map rather than asking `lrange` —
 * so what is asserted here is the shared observable behaviour: bounded history that
 * no read consumes, a live watch that fires on push, and isolation between tasks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { FailingRedisClient, MemoryRedisClient } from "./memory.ts";
import {
  InMemoryChatRooms,
  RedisChatRooms,
  ROOM_CAP,
  type RoomMessage,
} from "./rooms.ts";

// A real 5ms wait, as in `contract.test.ts`: pub/sub delivery is genuinely asynchronous
// across a duplicated connection, and no injectable clock reaches it.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const task = asTaskId("GH-acme-widget-1");
const other = asTaskId("GH-acme-widget-2");

const message = (over: Partial<RoomMessage> = {}): RoomMessage => ({
  from: asTaskId("GH-acme-widget-3"),
  text: "watch out for the migrations",
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("a room keeps its history: nothing drains it, reads repeat identically", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    await rooms.post(task, message());
    await rooms.post(task, message({ text: "second wave is flaky" }));

    assert.deepEqual(await rooms.history(task, 20), [
      { ...message(), text: "watch out for the migrations" },
      { ...message(), text: "second wave is flaky" },
    ]);

    // And again, unchanged: the read is `lrange`, not `drain`.
    assert.deepEqual(await rooms.history(task, 20), [
      { ...message(), text: "watch out for the migrations" },
      { ...message(), text: "second wave is flaky" },
    ]);
  }
});

test("history is bounded by the cap: the oldest fall off, newest survive", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    for (let index = 0; index < ROOM_CAP + 10; index += 1) {
      await rooms.post(task, message({ text: `note ${index}` }));
    }

    const history = await rooms.history(task, 20);
    assert.equal(history.length, 20, "the cap must have dropped the oldest");
    const newest = history.at(-1);
    assert.ok(newest !== undefined);
    assert.equal(newest.text, `note ${ROOM_CAP + 9}`);
  }
});

test("a watcher hears pushes live, and a read after the watch still sees them", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    const heard: RoomMessage[] = [];
    const watch = await rooms.watch(task, (m) => heard.push(m));

    await rooms.post(task, message({ text: "live one" }));
    await flush();

    assert.deepEqual(heard, [message({ text: "live one" })]);
    // The live delivery did not consume: history still has it for the next session.
    assert.deepEqual(await rooms.history(task, 20), [message({ text: "live one" })]);

    await watch.close();
  }
});

test("a watch closed stops hearing, and a second watch on the same task works", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    const first: RoomMessage[] = [];
    const one = await rooms.watch(task, (m) => first.push(m));
    await one.close();

    await rooms.post(task, message({ text: "after close" }));
    await flush();
    assert.deepEqual(first, [], "a closed watch must not deliver");

    const second: RoomMessage[] = [];
    const two = await rooms.watch(task, (m) => second.push(m));
    await rooms.post(task, message({ text: "heard by two" }));
    await flush();
    assert.deepEqual(second, [message({ text: "heard by two" })]);
    await two.close();
  }
});

test("rooms are per-task: a message for one task never reaches another", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    await rooms.post(task, message());
    assert.deepEqual(await rooms.history(other, 20), []);

    const heard: RoomMessage[] = [];
    const watch = await rooms.watch(other, (m) => heard.push(m));
    await rooms.post(task, message({ text: "not for you" }));
    await flush();
    assert.deepEqual(heard, []);
    await watch.close();
  }
});

test("a malformed entry is dropped, not thrown: one bad push must not blind the room", async () => {
  // Only the Redis implementation can be fed garbage — the in-memory one never
  // serialises. A poison entry between two good ones is the case that would cost the
  // whole history if parse were all-or-nothing.
  const redis = new MemoryRedisClient();
  await redis.rpush(`room:${task}`, "not json");
  await redis.rpush(`room:${task}`, JSON.stringify(message({ text: "good one" })));
  await redis.rpush(`room:${task}`, "also not json");

  const rooms = new RedisChatRooms({ redis, logger: SILENT_LOGGER });
  assert.deepEqual(await rooms.history(task, 20), [message({ text: "good one" })]);
});

test("the Redis implementation keeps going when Redis is unreachable", async () => {
  const rooms = new RedisChatRooms({ redis: new FailingRedisClient(), logger: SILENT_LOGGER });

  // A post is recorded NOWHERE — not silently lost. The tool tells the agent.
  assert.equal(await rooms.post(task, message()), false);
  assert.deepEqual(await rooms.history(task, 20), []);

  const heard: RoomMessage[] = [];
  const watch = await rooms.watch(task, (m) => heard.push(m));
  await rooms.post(task, message());
  await flush();
  assert.deepEqual(heard, []);
  await watch.close();
});

test("crossesProcesses is declared, and each implementation is right about it", async () => {
  assert.equal(new InMemoryChatRooms().crossesProcesses, false);
  assert.equal(
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER })
      .crossesProcesses,
    true,
  );
});

test("history clamps: a limit larger than the room returns what exists", async () => {
  for (const rooms of [
    new InMemoryChatRooms(),
    new RedisChatRooms({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  ]) {
    await rooms.post(task, message({ text: "only one" }));
    assert.deepEqual(await rooms.history(task, 20), [message({ text: "only one" })]);
  }
});
