/**
 * ONE contract, run against every implementation of it.
 *
 * The point of a wrapper interface is that callers cannot tell which side of it they are
 * on. That claim is only worth anything if it is checked, so each of the four structures
 * has a `contract` function here and each one is executed twice: once against the
 * in-memory implementation and once against the Redis one over `MemoryRedisClient` — the
 * same code path the real client takes, with a heap where the socket would be.
 *
 * And once MORE against a genuine server when `REDIS_TEST_URL` names one. That third run
 * is skipped when the variable is absent, which is the whole reason `npm test` stays
 * green on a machine with nothing listening on 6379. A contract that could only be
 * verified against a running server would be a contract nobody ran.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asRunnerId, asTaskId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import type { ChatRequest } from "../supervisor/inbox.ts";
import type { TaskSummary } from "../supervisor/snapshot.ts";
import { IoRedisClient, type RedisClient, type RedisConnection } from "./client.ts";
import { InMemoryCancelSignals, RedisCancelSignals, type CancelSignals } from "./cancel.ts";
import { InMemoryChatQueue, RedisChatQueue, type ChatQueue } from "./inbox.ts";
import { MemoryRedisClient } from "./memory.ts";
import {
  InMemoryPresenceRegistry,
  RedisPresenceRegistry,
  type PresenceRegistry,
} from "./presence.ts";
import { createDriver } from "./plane.ts";
import {
  InMemorySnapshotStore,
  RedisSnapshotStore,
  type SnapshotStore,
} from "./snapshot.ts";
import {
  InMemoryThreadBindings,
  RedisThreadBindings,
  type ThreadBindingStore,
} from "./threads.ts";

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: asTaskId("GH-acme-widget-1"),
  status: "ready",
  phase: "implementing",
  sessions: 2,
  costUsd: 0.5,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** Yield to the microtask queue, for a pub/sub delivery that is not synchronous. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/* ────────────────────────────── the four contracts ────────────────────────────── */

const chatContract = async (queue: ChatQueue): Promise<void> => {
  // A submitted intent reaches the drainer, unchanged.
  const submitted = queue.submit({ kind: "park", task: asTaskId("GH-acme-widget-3") });

  let drained: readonly ChatRequest[] = [];
  for (let attempt = 0; attempt < 50 && drained.length === 0; attempt += 1) {
    await flush();
    drained = await queue.drain();
  }

  assert.equal(drained.length, 1, "the intent never reached the drainer");
  const request = drained[0];
  assert.ok(request !== undefined);
  assert.ok(request.kind === "park", "the intent arrived as a different kind");
  assert.equal(request.task, "GH-acme-widget-3");

  // And the outcome reaches the submitter — the round trip the whole structure exists for.
  request.settle({ kind: "parked" });
  assert.deepEqual(await submitted, { kind: "parked" });

  // A second drain takes nothing: the first one consumed it.
  assert.deepEqual(await queue.drain(), []);
};

const snapshotContract = async (store: SnapshotStore): Promise<void> => {
  const waiting = summary({ id: asTaskId("GH-acme-widget-9"), status: "awaiting-human" });
  const ready = summary({ id: asTaskId("GH-acme-widget-1"), status: "ready" });
  const done = summary({ id: asTaskId("GH-acme-widget-5"), status: "done" });

  await store.replace([ready, done, waiting]);

  assert.equal((await store.all()).length, 3);
  assert.deepEqual((await store.withStatus("ready")).map((task) => task.id), [ready.id]);
  assert.deepEqual((await store.find(waiting.id))?.status, "awaiting-human");
  assert.equal(await store.find(asTaskId("GH-acme-nothing-0")), undefined);

  // `suggest`'s ranking is the contract: awaiting-human first, then by id. It matters
  // here rather than in `snapshot.test.ts` alone because a Redis round trip in the middle
  // is exactly where an ordering quietly stops being preserved.
  const suggested = await store.suggest("widget");
  assert.deepEqual(
    suggested.map((task) => task.id),
    [waiting.id, ready.id, done.id],
  );

  // Replacing is a replacement, not a merge.
  await store.replace([ready]);
  assert.deepEqual((await store.all()).map((task) => task.id), [ready.id]);
};

const presenceContract = async (registry: PresenceRegistry): Promise<void> => {
  const alpha = asRunnerId("runner-alpha");
  const beta = asRunnerId("runner-beta");

  assert.deepEqual(await registry.alive(), []);

  await registry.heartbeat(alpha, "polling");
  await registry.heartbeat(beta);

  const alive = await registry.alive();
  assert.deepEqual([...alive.map((entry) => entry.runner)].sort(), [alpha, beta]);
  assert.equal(alive.find((entry) => entry.runner === alpha)?.note, "polling");
  assert.equal(alive.find((entry) => entry.runner === beta)?.note, undefined);

  // A second heartbeat updates rather than duplicating — otherwise a runner changing its
  // note would appear twice in the display this exists to serve.
  await registry.heartbeat(alpha, "working GH-acme-widget-1");
  const updated = await registry.alive();
  assert.equal(updated.filter((entry) => entry.runner === alpha).length, 1);
  assert.equal(updated.find((entry) => entry.runner === alpha)?.note, "working GH-acme-widget-1");

  await registry.depart(alpha);
  assert.deepEqual((await registry.alive()).map((entry) => entry.runner), [beta]);
};

const cancelContract = async (signals: CancelSignals): Promise<void> => {
  const task = asTaskId("GH-acme-widget-4");
  assert.equal(await signals.requested(task), false);

  let notified = 0;
  const watch = await signals.watch(task, () => {
    notified += 1;
  });

  assert.equal(await signals.request(task), true);
  await flush();

  assert.equal(await signals.requested(task), true);
  assert.ok(notified >= 1, "the watcher was never told");

  await signals.clear(task);
  assert.equal(await signals.requested(task), false);

  // A cancel for a DIFFERENT task must not reach this watcher.
  const before = notified;
  await signals.request(asTaskId("GH-acme-widget-7"));
  await flush();
  assert.equal(notified, before);

  await watch.close();

  // A watcher that subscribes AFTER the request still learns of it, from the durable
  // half. Without that a session starting a millisecond after a `/cancel` was published
  // would run to completion with a human waiting on it.
  await signals.request(task);
  let late = 0;
  const second = await signals.watch(task, () => {
    late += 1;
  });
  await flush();
  assert.equal(late, 1, "the durable half did not catch a cancel published before the watch");
  await second.close();
  await signals.clear(task);
};

const threadsContract = async (store: ThreadBindingStore): Promise<void> => {
  // Cold start: no supervisor has published, and both implementations must say so rather
  // than claim the fleet has no threads. The difference is load-bearing — empty CLEARS the
  // bot's index and undefined leaves it alone, which is what stops a refresh unbinding a
  // brainstorm thread the bot opened seconds ago.
  assert.equal(await store.read(), undefined);

  const bindings = [
    { threadId: "1537785980415778816", task: asTaskId("BS-1537785980415778816") },
    { threadId: "1537785980415778999", task: asTaskId("GH-acme-widget-42") },
  ];
  await store.publish(bindings);
  assert.deepEqual(await store.read(), bindings);

  // Publishing REPLACES. A task going terminal unbinds its thread (`threadBindings`), and
  // a store that merged would keep listening to a conversation that is over.
  await store.publish([bindings[1] as (typeof bindings)[number]]);
  assert.deepEqual(await store.read(), [bindings[1]]);

  // ...and once something HAS been published, empty is a real answer: the last live task
  // went terminal. This is the case that must not collapse back into the cold-start one,
  // or a finished conversation stays bound and silently swallows what is typed into it.
  await store.publish([]);
  assert.deepEqual(await store.read(), []);
};

/* ─────────────────────────────── running them ─────────────────────────────── */

interface Implementations {
  readonly label: string;
  readonly chat: () => ChatQueue;
  readonly snapshot: () => SnapshotStore;
  readonly presence: () => PresenceRegistry;
  readonly cancels: () => CancelSignals;
  readonly threads: () => ThreadBindingStore;
  readonly teardown?: () => Promise<void>;
}

const runContracts = (impl: Implementations): void => {
  describe(impl.label, () => {
    test("chat inbox: submit, drain, settle, and the outcome comes back", async () => {
      await chatContract(impl.chat());
      await impl.teardown?.();
    });

    test("task snapshot: reads round trip and suggest() keeps its ranking", async () => {
      await snapshotContract(impl.snapshot());
      await impl.teardown?.();
    });

    test("presence: heartbeats appear, update in place, and depart", async () => {
      await presenceContract(impl.presence());
      await impl.teardown?.();
    });

    test("cancel signals: fast path, durable path, and per-task isolation", async () => {
      await cancelContract(impl.cancels());
      await impl.teardown?.();
    });

    test("thread bindings: cold start is empty, publish replaces", async () => {
      await threadsContract(impl.threads());
      await impl.teardown?.();
    });
  });
};

runContracts({
  label: "in-memory implementations",
  chat: () => new InMemoryChatQueue(),
  snapshot: () => new InMemorySnapshotStore(),
  presence: () => new InMemoryPresenceRegistry(),
  cancels: () => new InMemoryCancelSignals(),
  threads: () => new InMemoryThreadBindings(),
});

/**
 * The Redis implementations over `MemoryRedisClient`.
 *
 * A fresh client per structure, so one contract cannot leave a key behind that another
 * reads. This is the run that proves the two sides of every interface agree.
 */
runContracts({
  label: "redis implementations over the in-memory client",
  chat: () => new RedisChatQueue({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  snapshot: () =>
    // Cache off, so a read is a read. The cache is tested on its own in `snapshot.test.ts`
    // — here it would mask exactly the serialisation the contract is checking.
    new RedisSnapshotStore({
      redis: new MemoryRedisClient(),
      logger: SILENT_LOGGER,
      cacheTtlMs: 0,
    }),
  presence: () => new RedisPresenceRegistry({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  cancels: () => new RedisCancelSignals({ redis: new MemoryRedisClient(), logger: SILENT_LOGGER }),
  threads: () =>
    new RedisThreadBindings({
      redis: new MemoryRedisClient(),
      logger: SILENT_LOGGER,
      cacheTtlMs: 0,
    }),
});

/**
 * And against a real server, when one is named.
 *
 * `REDIS_TEST_URL=redis://localhost:6379 npm test` exercises the ioredis path end to end
 * — MULTI, sorted sets, pub/sub on a duplicated connection, expiry. Absent, this whole
 * block does not register, which is what keeps the suite runnable anywhere.
 *
 * The key prefix carries a random suffix so a run cannot collide with a previous one that
 * died before its teardown, or with a developer's own data on a shared server.
 */
const liveUrl = process.env["REDIS_TEST_URL"];

describe("a live redis server", { skip: liveUrl === undefined ? "REDIS_TEST_URL is not set" : false }, () => {
  const clients: RedisClient[] = [];

  const live = (): RedisClient => {
    const connection: RedisConnection = {
      url: liveUrl ?? "",
      commandTimeoutMs: 2000,
      keyPrefix: `caterpillar-test:${crypto.randomUUID()}:`,
    };
    // The SAME construction the supervisor uses, not a copy of it. The reason this block
    // exists is to catch what an in-memory client cannot, and a test that configured its
    // own driver would have missed the offline-queue defect that `createDriver`'s
    // docstring now records — the first commands of a fresh process failing against a
    // perfectly healthy server. The constructor dials immediately, which is why nothing
    // here runs unless `REDIS_TEST_URL` named one.
    const client = new IoRedisClient(createDriver(connection), connection, SILENT_LOGGER);
    clients.push(client);
    return client;
  };

  const teardown = async (): Promise<void> => {
    for (const client of clients.splice(0)) await client.close();
  };

  test("chat inbox round trips", async () => {
    await chatContract(new RedisChatQueue({ redis: live(), logger: SILENT_LOGGER }));
    await teardown();
  });

  test("task snapshot round trips", async () => {
    await snapshotContract(
      new RedisSnapshotStore({ redis: live(), logger: SILENT_LOGGER, cacheTtlMs: 0 }),
    );
    await teardown();
  });

  test("presence round trips", async () => {
    await presenceContract(new RedisPresenceRegistry({ redis: live(), logger: SILENT_LOGGER }));
    await teardown();
  });

  test("cancel signals round trip", async () => {
    await cancelContract(new RedisCancelSignals({ redis: live(), logger: SILENT_LOGGER }));
    await teardown();
  });

  test("thread bindings round trip", async () => {
    await threadsContract(
      new RedisThreadBindings({ redis: live(), logger: SILENT_LOGGER, cacheTtlMs: 0 }),
    );
    await teardown();
  });
});
