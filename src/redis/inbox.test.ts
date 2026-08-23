/**
 * The request → outcome round trip, and what happens when it does not complete.
 *
 * `contract.test.ts` proves the happy path against both implementations. This file is
 * about the parts that only exist over Redis: two processes, a reply that may arrive
 * before anyone is listening, an entry written by a different build, and a submitter that
 * gives up.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { JsonLogger, SILENT_LOGGER } from "../obs/log.ts";
import { INBOX_KEY, REPLY_PREFIX, RedisChatQueue } from "./inbox.ts";
import { MemoryRedisClient } from "./memory.ts";

const TASK = asTaskId("GH-acme-widget-1");

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("two separate queues over one server complete the round trip", async () => {
  // The arrangement this whole structure exists for: the bot submits, the supervisor
  // drains, and neither holds a reference to the other.
  const redis = new MemoryRedisClient();
  const bot = new RedisChatQueue({ redis, logger: SILENT_LOGGER });
  const supervisor = new RedisChatQueue({ redis, logger: SILENT_LOGGER });

  const submitted = bot.submit({ kind: "answer", task: TASK, text: "use the migration path" });

  let drained = await supervisor.drain();
  for (let attempt = 0; attempt < 50 && drained.length === 0; attempt += 1) {
    await flush();
    drained = await supervisor.drain();
  }

  const request = drained[0];
  assert.ok(request !== undefined && request.kind === "answer");
  assert.equal(request.text, "use the migration path");

  request.settle({ kind: "applied", index: 3 });
  assert.deepEqual(await submitted, { kind: "applied", index: 3 });
});

test("every intent in the union survives the round trip unchanged", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER });

  const intents = [
    { kind: "answer", task: TASK, text: "hello" },
    { kind: "park", task: TASK },
    { kind: "resume", task: TASK },
    { kind: "merge", task: TASK },
    { kind: "force-done", task: TASK, reason: "obsolete", author: "ada" },
    {
      kind: "brainstorm",
      topic: "a shared cache",
      repos: ["acme/widget", "acme/gadget"],
      threadId: "1234",
      author: "operator",
    },
  ] as const;

  for (const intent of intents) void queue.submit(intent);
  await flush();

  const drained = await queue.drain();
  assert.equal(drained.length, intents.length);
  // Order is preserved: a brainstorm queued before an answer to it must stay that way,
  // or the answer applies to a task that does not exist yet (`supervisor/loop.ts`).
  assert.deepEqual(
    drained.map(({ settle: _settle, ...rest }) => rest),
    intents.map((intent) => ({ ...intent })),
  );

  for (const request of drained) request.settle({ kind: "parked" });
});

test("an outcome published before the submitter listens is still delivered", async () => {
  // Redis pub/sub is fire-and-forget, so the key is the catch-up path. Simulated by
  // settling with no subscriber at all, then reading as a submitter would.
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER });

  await redis.rpush(INBOX_KEY, JSON.stringify({ id: "req-1", intent: { kind: "park", task: TASK } }));
  const drained = await queue.drain();
  drained[0]?.settle({ kind: "not-parkable", status: "done" });
  await flush();

  const stored = await redis.get(`${REPLY_PREFIX}req-1`);
  assert.ok(stored !== undefined, "the durable half of the reply was not written");
  assert.deepEqual(JSON.parse(stored), { kind: "not-parkable", status: "done" });
});

test("a submitter that is never answered gives up and says so", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER, submitTimeoutMs: 20 });

  const outcome = await queue.submit({ kind: "park", task: TASK });

  assert.equal(outcome.kind, "failed");
  // The wording matters: the request IS still queued, and telling the human it failed
  // outright would invite them to type it again and park the task twice.
  assert.match(
    outcome.kind === "failed" ? outcome.error : "",
    /may still be queued/,
    "the give-up message must not claim the request was lost",
  );
});

test("an unparseable entry is dropped, not thrown", async () => {
  const lines: string[] = [];
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({
    redis,
    logger: new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
  });

  await redis.rpush(INBOX_KEY, "not json at all");
  await redis.rpush(INBOX_KEY, JSON.stringify({ id: "x", intent: { kind: "detonate" } }));
  await redis.rpush(INBOX_KEY, JSON.stringify({ id: "y", intent: { kind: "park", task: TASK } }));

  const drained = await queue.drain();

  // One malformed push must not wedge the drain forever, and a rolling upgrade means the
  // writer really can be a different build from the reader.
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.kind, "park");
  assert.equal(
    lines.filter((line) => line.includes("chat.unparseable-request")).length,
    2,
    "both bad entries should be reported",
  );

  drained[0]?.settle({ kind: "parked" });
});

test("an intent missing a required field is refused rather than half-applied", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER });

  // An `answer` with no text would reach `applyAnswer` and write an empty answer file to
  // the state repo — a commit nobody can interpret and a human who thinks they replied.
  await redis.rpush(INBOX_KEY, JSON.stringify({ id: "a", intent: { kind: "answer", task: TASK } }));
  await redis.rpush(INBOX_KEY, JSON.stringify({ id: "b", intent: { kind: "park" } }));
  await redis.rpush(
    INBOX_KEY,
    JSON.stringify({
      id: "c",
      intent: { kind: "brainstorm", topic: "x", repos: [7], threadId: "1", author: "me" },
    }),
  );
  // A `force-done` with no reason is the one this file cares about most: the reason is the
  // only record of WHY a task was marked done without either gate, so a blank one would
  // leave an unauditable `done` behind.
  await redis.rpush(
    INBOX_KEY,
    JSON.stringify({ id: "d", intent: { kind: "force-done", task: TASK, author: "ada" } }),
  );
  await redis.rpush(
    INBOX_KEY,
    JSON.stringify({
      id: "e",
      intent: { kind: "force-done", task: TASK, reason: "  ", author: "ada" },
    }),
  );
  await redis.rpush(
    INBOX_KEY,
    JSON.stringify({ id: "f", intent: { kind: "force-done", task: TASK, reason: "obsolete" } }),
  );

  assert.deepEqual(await queue.drain(), []);
});

test("every outcome the loop can publish is rendered rather than timed out", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER, submitTimeoutMs: 200 });

  // `forced-done` and `not-forceable` are the two the loop publishes for `/done`. Missing
  // from the parser's set, they would be dropped and the submitter told the request may
  // still be queued — for a task that was in fact already marked done, inviting a retry.
  const outcomes = [{ kind: "forced-done" }, { kind: "not-forceable", reason: "it is running" }] as const;

  for (const outcome of outcomes) {
    const submitted = queue.submit({ kind: "force-done", task: TASK, reason: "obsolete", author: "ada" });
    await flush();

    const drained = await queue.drain();
    assert.equal(drained.length, 1, JSON.stringify(outcome));
    drained[0]?.settle(outcome);

    assert.deepEqual(await submitted, outcome);
  }
});

test("an outcome kind this build does not know falls through to the give-up path", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER, submitTimeoutMs: 30 });

  const outcome = queue.submit({ kind: "park", task: TASK });
  await flush();

  const drained = await queue.drain();
  assert.equal(drained.length, 1);

  // A newer supervisor publishing a kind this build cannot render. Showing the human
  // `[object Object]` is worse than telling them nobody answered in time, so the parser
  // refuses it and the submitter falls through to the give-up path.
  drained[0]?.settle({ kind: "invented-in-a-later-build" } as never);

  const settled = await outcome;
  assert.equal(settled.kind, "failed");
});

test("the list is capped, so a crash-looping submitter cannot grow it without limit", async () => {
  const redis = new MemoryRedisClient();
  const queue = new RedisChatQueue({ redis, logger: SILENT_LOGGER, submitTimeoutMs: 5 });

  // Far past the cap would take a while at one submit per await, so the cap itself is
  // exercised through the client — what matters is that `rpush` is called WITH one.
  const pushes: number[] = [];
  const spy = {
    ...redis,
    rpush: (key: string, value: string, cap?: number): Promise<void> => {
      pushes.push(cap ?? -1);
      return redis.rpush(key, value, cap);
    },
  };

  await new RedisChatQueue({ redis: spy as typeof redis, logger: SILENT_LOGGER, submitTimeoutMs: 5 })
    .submit({ kind: "park", task: TASK });

  assert.ok(pushes[0] !== undefined && pushes[0] > 0, "the inbox list must be pushed with a cap");
  await queue.drain();
});
