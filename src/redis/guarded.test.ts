/**
 * Containment: a Redis failure must degrade, never throw.
 *
 * This is the one property in the whole directory that is load-bearing for the SUPERVISOR
 * rather than for the plane. `supervisor/loop.ts:~287` catches per-poll failures precisely
 * because a live process that answers /healthz and does no work is worse than a crash;
 * `RedisGuard` is what stops an optional cache from ever reaching that catch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLogger, SILENT_LOGGER, type LogFields, type Logger } from "../obs/log.ts";
import { RedisGuard } from "./guarded.ts";

/** Collects records so a test can assert on events without touching stdout. */
const recorder = (): { readonly logger: Logger; readonly lines: string[] } => {
  const lines: string[] = [];
  return {
    logger: new JsonLogger({ level: "debug", write: (line) => lines.push(line) }),
    lines,
  };
};

const eventsIn = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => (JSON.parse(line) as { readonly event: string }).event);

test("a failing read returns the fallback instead of throwing", async () => {
  const guard = new RedisGuard({ logger: SILENT_LOGGER });

  const value = await guard.run<readonly string[]>(
    "drain",
    () => Promise.reject(new Error("ECONNREFUSED")),
    [],
  );

  assert.deepEqual(value, []);
});

test("a failing write reports that it did not happen, rather than raising", async () => {
  const guard = new RedisGuard({ logger: SILENT_LOGGER });

  assert.equal(await guard.attempt("push", () => Promise.reject(new Error("down"))), false);
  assert.equal(await guard.attempt("push", () => Promise.resolve()), true);
});

test("a rejection that is not an Error is still contained", async () => {
  const guard = new RedisGuard({ logger: SILENT_LOGGER });

  // ioredis rejects with its own error types and a broken pipe can surface as a string.
  // Anything that reaches `catch` has to be survivable, including a thrown undefined.
  assert.equal(await guard.run("get", () => Promise.reject(undefined), "fallback"), "fallback");
  assert.equal(await guard.run("get", () => Promise.reject("a string"), "fallback"), "fallback");
});

test("the failure is logged, but the value is not", async () => {
  const { logger, lines } = recorder();
  const guard = new RedisGuard({ logger });

  // A real inbox push carries a human's Discord message. If a driver error ever quoted
  // the arguments, logging `error` wholesale would put that message in Loki.
  await guard.attempt("inbox.push", () =>
    Promise.reject(new Error("ECONNREFUSED 10.0.0.5:6379")),
  );

  assert.deepEqual(eventsIn(lines), ["redis.degraded"]);
  const record = JSON.parse(lines[0] ?? "{}") as LogFields;
  assert.equal(record["operation"], "inbox.push");
  assert.equal(record["error"], "ECONNREFUSED 10.0.0.5:6379");
});

test("repeated failures of one operation are logged once per interval", async () => {
  const { logger, lines } = recorder();
  let now = 1_000_000;
  const guard = new RedisGuard({ logger, now: () => now });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await guard.attempt("presence.heartbeat", () => Promise.reject(new Error("down")));
    now += 1000;
  }

  // Twenty seconds of a dead Redis is one line, not twenty. At the poll rates this plane
  // sees, the unthrottled version buries every other record in Loki.
  assert.equal(lines.length, 1);

  now += 60_000;
  await guard.attempt("presence.heartbeat", () => Promise.reject(new Error("down")));
  assert.equal(lines.length, 2, "a failure past the interval is worth saying again");
});

test("different operations are throttled independently", async () => {
  const { logger, lines } = recorder();
  const guard = new RedisGuard({ logger });

  await guard.attempt("inbox.push", () => Promise.reject(new Error("down")));
  await guard.attempt("presence.heartbeat", () => Promise.reject(new Error("down")));

  // An inbox that cannot push and a presence that cannot heartbeat are two symptoms, and
  // an operator diagnosing one must not have it hidden by the other's throttle.
  assert.equal(lines.length, 2);
});

test("recovery is announced once, and resets the throttle", async () => {
  const { logger, lines } = recorder();
  const guard = new RedisGuard({ logger });

  await guard.attempt("snapshot.write", () => Promise.reject(new Error("down")));
  assert.equal(guard.degraded, true);

  await guard.attempt("snapshot.write", () => Promise.resolve());
  assert.equal(guard.degraded, false);
  assert.deepEqual(eventsIn(lines), ["redis.degraded", "redis.recovered"]);

  // The throttle was cleared with it: the next outage says so immediately rather than
  // staying silent for the remainder of the previous one's window.
  await guard.attempt("snapshot.write", () => Promise.reject(new Error("down again")));
  assert.deepEqual(eventsIn(lines), ["redis.degraded", "redis.recovered", "redis.degraded"]);
});

test("a success on a healthy guard says nothing at all", async () => {
  const { logger, lines } = recorder();
  const guard = new RedisGuard({ logger });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    await guard.run("snapshot.read", () => Promise.resolve("{}"), undefined);
  }

  // The happy path runs several times a second forever. One line per call would be the
  // noisiest thing the supervisor emits.
  assert.deepEqual(lines, []);
});
