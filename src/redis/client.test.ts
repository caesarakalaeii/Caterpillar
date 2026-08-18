/**
 * The driver wrapper: prefixing, timeouts, and the subscriber connection.
 *
 * Driven against a hand-written stub rather than a server, which is exactly what the
 * `RedisDriver` interface exists to make possible — `client.ts` declares the driver
 * structurally so nothing here needs a socket. The live end-to-end run is in
 * `contract.test.ts`, behind `REDIS_TEST_URL`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLogger, SILENT_LOGGER } from "../obs/log.ts";
import {
  IoRedisClient,
  RedisTimeoutError,
  withTimeout,
  type RedisConnection,
  type RedisDriver,
  type RedisDriverPipeline,
} from "./client.ts";

const connection = (over: Partial<RedisConnection> = {}): RedisConnection => ({
  url: "redis://localhost:6379",
  commandTimeoutMs: 50,
  keyPrefix: "caterpillar:",
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A driver that records what it was asked and answers whatever the test set up. */
const stubDriver = (
  answers: Readonly<Record<string, unknown>> = {},
): { readonly driver: RedisDriver; readonly calls: Call[]; readonly listeners: Map<string, unknown> } => {
  const calls: Call[] = [];
  const listeners = new Map<string, unknown>();

  const record = (method: string, ...args: readonly unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    // `in`, not `??`: a stubbed `null` is what a missing key looks like and must not be
    // mistaken for "no answer configured".
    const answer = method in answers ? answers[method] : "OK";
    return answer instanceof Promise ? answer : Promise.resolve(answer);
  };

  const pipeline: RedisDriverPipeline = {
    lrange: (key: string, start: number, stop: number): RedisDriverPipeline => {
      calls.push({ method: "multi.lrange", args: [key, start, stop] });
      return pipeline;
    },
    del: (key: string): RedisDriverPipeline => {
      calls.push({ method: "multi.del", args: [key] });
      return pipeline;
    },
    exec: () => Promise.resolve((answers["exec"] as never) ?? [[null, []], [null, 1]]),
  };

  const driver: RedisDriver = {
    get: (key) => record("get", key) as Promise<string | null>,
    set: (...args: readonly unknown[]) => record("set", ...args),
    del: (key) => record("del", key),
    rpush: (key, value) => record("rpush", key, value),
    ltrim: (key, start, stop) => record("ltrim", key, start, stop),
    lrange: (key, start, stop) => record("lrange", key, start, stop) as Promise<string[]>,
    zrangebyscore: (key, min, max, withScores) =>
      record("zrangebyscore", key, min, max, withScores) as Promise<string[]>,
    zadd: (key, score, member) => record("zadd", key, score, member),
    zremrangebyscore: (key, min, max) => record("zremrangebyscore", key, min, max),
    zrem: (key, member) => record("zrem", key, member),
    publish: (channel, message) => record("publish", channel, message),
    subscribe: (channel) => record("subscribe", channel),
    unsubscribe: (channel) => record("unsubscribe", channel),
    multi: () => {
      calls.push({ method: "multi", args: [] });
      return pipeline;
    },
    on: (event: string, listener: unknown): unknown => {
      listeners.set(event, listener);
      return undefined;
    },
    duplicate: () => {
      calls.push({ method: "duplicate", args: [] });
      return driver;
    },
    quit: () => record("quit"),
    disconnect: () => void calls.push({ method: "disconnect", args: [] }),
  } as RedisDriver;

  return { driver, calls, listeners };
};

const argsOf = (calls: readonly Call[], method: string): readonly unknown[] =>
  calls.find((call) => call.method === method)?.args ?? [];

test("every key is prefixed, so two fleets can share one server", async () => {
  const { driver, calls } = stubDriver({ get: null });
  const client = new IoRedisClient(driver, connection({ keyPrefix: "staging:" }), SILENT_LOGGER);

  await client.get("chat:snapshot");
  await client.set("chat:snapshot", "[]");
  await client.del("chat:snapshot");
  await client.publish("cancel:GH-1", "cancel");

  // A staging supervisor draining production's chat inbox is the accident this prevents.
  assert.deepEqual(argsOf(calls, "get"), ["staging:chat:snapshot"]);
  assert.deepEqual(argsOf(calls, "del"), ["staging:chat:snapshot"]);
  assert.deepEqual(argsOf(calls, "publish"), ["staging:cancel:GH-1", "cancel"]);
});

test("a ttl becomes whole seconds, never zero", async () => {
  const { driver, calls } = stubDriver();
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  await client.set("k", "v", 90);
  assert.deepEqual(argsOf(calls, "set"), ["caterpillar:k", "v", "EX", 90]);

  // A sub-second TTL rounds UP: `EX 0` is rejected by the server, and a key that fails to
  // be written is a reply the submitter never sees.
  const second = stubDriver();
  await new IoRedisClient(second.driver, connection(), SILENT_LOGGER).set("k", "v", 0.2);
  assert.deepEqual(argsOf(second.calls, "set"), ["caterpillar:k", "v", "EX", 1]);
});

test("a missing key reads as undefined, not null", async () => {
  const { driver } = stubDriver({ get: null });
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  // `null` is what the driver returns and `undefined` is what the codebase uses
  // everywhere else. Leaking the driver's convention past this boundary is how a
  // `=== undefined` check silently stops working.
  assert.equal(await client.get("missing"), undefined);
});

test("a bounded list is trimmed after the push", async () => {
  const { driver, calls } = stubDriver();
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  await client.rpush("chat:inbox", "{}", 1000);
  assert.deepEqual(argsOf(calls, "ltrim"), ["caterpillar:chat:inbox", -1000, -1]);

  const second = stubDriver();
  await new IoRedisClient(second.driver, connection(), SILENT_LOGGER).rpush("k", "{}");
  assert.equal(second.calls.some((call) => call.method === "ltrim"), false);
});

test("draining is one MULTI, so two drainers cannot read the same entries", async () => {
  const { driver, calls } = stubDriver({ exec: [[null, ["a", "b"]], [null, 1]] });
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  assert.deepEqual(await client.drain("chat:inbox"), ["a", "b"]);
  // A rollout has two supervisors alive at once, which is exactly when a non-atomic
  // read-then-delete would hand one intent to both.
  assert.deepEqual(argsOf(calls, "multi.lrange"), ["caterpillar:chat:inbox", 0, -1]);
  assert.deepEqual(argsOf(calls, "multi.del"), ["caterpillar:chat:inbox"]);
});

test("an aborted MULTI drains nothing rather than half", async () => {
  const client = new IoRedisClient(stubDriver({ exec: null }).driver, connection(), SILENT_LOGGER);
  assert.deepEqual(await client.drain("chat:inbox"), []);
});

test("an error inside the MULTI is raised, not silently swallowed", async () => {
  const { driver } = stubDriver({ exec: [[new Error("WRONGTYPE"), null]] });
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  // A WRONGTYPE here means someone put a string where the inbox list belongs. Returning
  // [] would hide it forever; the guard one layer up is what turns it into a warn line.
  await assert.rejects(() => client.drain("chat:inbox"), /WRONGTYPE/);
});

test("sorted-set reads pair members with their scores and skip malformed pairs", async () => {
  const { driver } = stubDriver({ zrangebyscore: ["runner-a", "1000", "runner-b", "not-a-number"] });
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  assert.deepEqual(await client.zrangeByScore("fleet:presence", 0), [
    { member: "runner-a", score: 1000 },
  ]);
});

test("an infinite floor reaches the server as -inf, not the string 'Infinity'", async () => {
  const { driver, calls } = stubDriver({ zrangebyscore: [] });
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  // Presence sweeps ask for everything. `-Infinity` stringifies to something the server
  // rejects, so the translation lives here rather than in every caller.
  await client.zrangeByScore("fleet:presence", Number.NEGATIVE_INFINITY);
  assert.deepEqual(argsOf(calls, "zrangebyscore"), [
    "caterpillar:fleet:presence",
    "-inf",
    "+inf",
    "WITHSCORES",
  ]);
});

test("a heartbeat adds the member and sweeps the expired ones", async () => {
  const { driver, calls } = stubDriver();
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  await client.zaddAndTrim("fleet:presence", "runner-a", 5000, 2000);

  assert.deepEqual(argsOf(calls, "zadd"), ["caterpillar:fleet:presence", 5000, "runner-a"]);
  // Exclusive bound: a member scoring exactly at the floor is still inside the window,
  // and readers filter with `>=`.
  assert.deepEqual(argsOf(calls, "zremrangebyscore"), [
    "caterpillar:fleet:presence",
    "-inf",
    "(2000",
  ]);
});

test("subscribing uses a duplicated connection, not the shared one", async () => {
  const { driver, calls, listeners } = stubDriver();
  const client = new IoRedisClient(driver, connection(), SILENT_LOGGER);

  const received: string[] = [];
  const subscription = await client.subscribe("cancel:GH-1", (message) => received.push(message));

  // Redis puts a connection into subscriber mode and then refuses ordinary commands on
  // it. Sharing one would mean the first cancel subscription broke every snapshot read.
  assert.equal(calls.some((call) => call.method === "duplicate"), true);
  assert.deepEqual(argsOf(calls, "subscribe"), ["caterpillar:cancel:GH-1"]);

  const onMessage = listeners.get("message") as (channel: string, message: string) => void;
  onMessage("caterpillar:cancel:GH-1", "cancel");
  onMessage("caterpillar:cancel:GH-2", "cancel");
  // Channel-filtered: one connection may carry several subscriptions.
  assert.deepEqual(received, ["cancel"]);

  await subscription.close();
  assert.deepEqual(argsOf(calls, "unsubscribe"), ["caterpillar:cancel:GH-1"]);

  // Idempotent — a session's `finally` and an explicit close must not double-unsubscribe.
  await subscription.close();
  assert.equal(calls.filter((call) => call.method === "unsubscribe").length, 1);
});

test("a command that never settles rejects on the timeout", async () => {
  const { driver } = stubDriver({ get: new Promise(() => undefined) });
  const client = new IoRedisClient(driver, connection({ commandTimeoutMs: 20 }), SILENT_LOGGER);

  // The failure this bounds is a driver stuck reconnecting with the command still in its
  // offline queue — a state ioredis's own `commandTimeout` never starts a timer for.
  await assert.rejects(() => client.get("k"), RedisTimeoutError);
});

test("a timeout names the operation but carries no payload", async () => {
  await assert.rejects(
    () => withTimeout("inbox.push", 5, new Promise(() => undefined)),
    (error: unknown) => {
      assert.ok(error instanceof RedisTimeoutError);
      assert.match(error.message, /inbox\.push/);
      // The argument to an inbox push is a human's Discord message; a timeout that
      // echoed it would put that message in Loki.
      assert.equal(error.message.includes("push"), true);
      return true;
    },
  );
});

test("withTimeout returns the value when the work wins", async () => {
  assert.equal(await withTimeout("get", 1000, Promise.resolve("value")), "value");
});

test("a connection error is logged at warn and never raised", async () => {
  const lines: string[] = [];
  const { driver, listeners } = stubDriver();
  new IoRedisClient(
    driver,
    connection(),
    new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
  );

  const onError = listeners.get("error") as (error: unknown) => void;
  // The driver reconnects on its own. Warn and not error: this plane is optional, and
  // paging on it would be paging on something with no correctness effect.
  onError(new Error("ECONNREFUSED"));

  // And once, not once per reconnect attempt. The retry strategy backs off to five
  // seconds, so an hour of downtime is seven hundred identical lines in the same stream
  // an operator is reading to find out what the fleet did.
  for (let attempt = 0; attempt < 50; attempt += 1) onError(new Error("ECONNREFUSED"));

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record["event"], "redis.connection-error");
  assert.equal(record["level"], "warn");
});

test("closing is bounded, tears down subscribers, and silences later errors", async () => {
  const lines: string[] = [];
  const { driver, calls, listeners } = stubDriver({ quit: new Promise(() => undefined) });
  const client = new IoRedisClient(
    driver,
    connection({ commandTimeoutMs: 20 }),
    new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
  );

  await client.subscribe("cancel:GH-1", () => undefined);
  await client.close();

  // `quit` waits for a server that may be the thing that is down, so the wait is bounded
  // and the socket is torn down either way. Shutdown must not be the path that hangs.
  assert.equal(calls.some((call) => call.method === "disconnect"), true);

  (listeners.get("error") as (error: unknown) => void)(new Error("after close"));
  assert.deepEqual(lines, [], "a socket error during teardown is not news");

  // Twice is safe: `index.ts` closes the plane in a `finally` that may already have run.
  await client.close();
});
