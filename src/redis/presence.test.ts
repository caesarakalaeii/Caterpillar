/**
 * Presence expires, and nothing may depend on it.
 *
 * The second half of that sentence is not testable directly — there is no assertion for
 * "no caller reads this" — so what is tested here is the property that makes the first
 * half safe: a runner that stops heartbeating disappears from the DISPLAY, on a clock
 * that has nothing to do with the lease it holds in git.
 *
 * The generous window is deliberate. Showing a runner that died forty seconds ago costs a
 * slightly wrong display; hiding one that is merely busy inside a long session costs an
 * operator concluding the fleet has shrunk. Since nothing routes from it, the generous
 * reading is the correct one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunnerId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { MemoryRedisClient } from "./memory.ts";
import {
  InMemoryPresenceRegistry,
  PRESENCE_KEY,
  RedisPresenceRegistry,
  type PresenceRegistry,
} from "./presence.ts";

const ALPHA = asRunnerId("caterpillar-0");
const BETA = asRunnerId("caterpillar-1");

/** Both implementations, each with an injected clock. */
const registries = (
  clock: () => number,
): readonly { readonly label: string; readonly registry: PresenceRegistry }[] => [
  {
    label: "in-memory",
    registry: new InMemoryPresenceRegistry({ now: clock, ttlSeconds: 60 }),
  },
  {
    label: "redis",
    registry: new RedisPresenceRegistry({
      redis: new MemoryRedisClient({ now: clock }),
      logger: SILENT_LOGGER,
      now: clock,
      ttlSeconds: 60,
    }),
  },
];

test("an entry expires once its heartbeat stops, in both implementations", async () => {
  let now = 1_000_000;
  for (const { label, registry } of registries(() => now)) {
    await registry.heartbeat(ALPHA);
    await registry.heartbeat(BETA);
    assert.equal((await registry.alive()).length, 2, label);

    // Beta keeps beating; alpha does not.
    now += 30_000;
    await registry.heartbeat(BETA);
    assert.equal((await registry.alive()).length, 2, `${label}: 30s is inside the window`);

    now += 40_000;
    await registry.heartbeat(BETA);
    const alive = await registry.alive();
    assert.deepEqual(
      alive.map((entry) => entry.runner),
      [BETA],
      `${label}: alpha should have aged out at 70s with a 60s window`,
    );
  }
});

test("the most recently seen runner sorts first", async () => {
  let now = 1_000_000;
  for (const { label, registry } of registries(() => now)) {
    await registry.heartbeat(ALPHA);
    now += 1000;
    await registry.heartbeat(BETA);

    assert.deepEqual(
      (await registry.alive()).map((entry) => entry.runner),
      [BETA, ALPHA],
      label,
    );
  }
});

test("a note survives, is truncated, and cannot forge a second runner", async () => {
  const now = (): number => 1_000_000;
  for (const { label, registry } of registries(now)) {
    // The Redis member packs runner and note into one string with a newline between them.
    // A note containing a newline must not be readable as another runner's entry.
    await registry.heartbeat(ALPHA, `working\ncaterpillar-9\nmore`);
    const alive = await registry.alive();

    assert.equal(alive.length, 1, label);
    assert.equal(alive[0]?.runner, ALPHA, label);
    assert.match(alive[0]?.note ?? "", /^working/, label);

    await registry.heartbeat(BETA, "x".repeat(500));
    const long = (await registry.alive()).find((entry) => entry.runner === BETA);
    assert.ok((long?.note?.length ?? 0) <= 120, `${label}: a note is a label, not a log line`);
  }
});

test("a runner changing its note leaves exactly one entry behind", async () => {
  const redis = new MemoryRedisClient();
  const registry = new RedisPresenceRegistry({ redis, logger: SILENT_LOGGER });

  await registry.heartbeat(ALPHA, "polling");
  await registry.heartbeat(ALPHA, "working GH-acme-widget-1");
  await registry.heartbeat(ALPHA, "polling");

  // The note is part of the sorted-set member, so without the sweep each distinct note
  // would be its own member and one runner would appear three times in the display.
  const members = await redis.zrangeByScore(PRESENCE_KEY, 0);
  assert.equal(members.length, 1);
  assert.equal((await registry.alive()).length, 1);
});

test("departing removes the runner immediately", async () => {
  for (const { label, registry } of registries(() => 1_000_000)) {
    await registry.heartbeat(ALPHA);
    await registry.heartbeat(BETA);
    await registry.depart(ALPHA);

    // A clean shutdown should not leave a ghost in the display for the whole TTL.
    assert.deepEqual((await registry.alive()).map((entry) => entry.runner), [BETA], label);
  }
});

test("an empty fleet reads as empty, not as an error", async () => {
  for (const { label, registry } of registries(() => 1_000_000)) {
    assert.deepEqual(await registry.alive(), [], label);
    await registry.depart(ALPHA);
    assert.deepEqual(await registry.alive(), [], label);
  }
});
