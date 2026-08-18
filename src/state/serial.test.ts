/**
 * The serialising mutex that stands in front of every `StateStore` git call.
 *
 * These assert ORDER, not merely the absence of a crash: a mutex that let two bodies
 * overlap would still pass "nothing threw", and overlapping is the entire failure mode —
 * two loops interleaving `git add`/`git commit` in one working copy.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Serial } from "./serial.ts";

test("two critical sections never overlap, and run in acquisition order", async () => {
  const serial = new Serial();
  const events: string[] = [];

  const section = async (name: string, ms: number): Promise<void> =>
    serial.run(async () => {
      events.push(`${name}:enter`);
      await sleep(ms);
      events.push(`${name}:exit`);
    });

  // `b` is deliberately the FASTER body and acquires second. Without the mutex it would
  // finish inside `a`'s window and the interleaving would be visible below.
  const a = section("a", 40);
  const b = section("b", 1);
  await Promise.all([a, b]);

  assert.deepEqual(events, ["a:enter", "a:exit", "b:enter", "b:exit"]);
});

test("a body that throws releases the lock instead of wedging the mutex", async () => {
  // The whole runner rests on this. `commitAndPush` throws on any non-zero git exit — a
  // rejected push, a hook, a dead network — and if that left the chain rejected, every
  // later acquisition would reject too: one failed write would stop the supervisor
  // pulling, draining chat and ingesting, forever, with no error naming the cause.
  const serial = new Serial();
  const events: string[] = [];

  const failing = serial.run(async () => {
    events.push("first:enter");
    await sleep(1);
    throw new Error("git commit failed");
  });

  const following = serial.run(async () => {
    events.push("second:enter");
    return "ok";
  });

  await assert.rejects(failing, /git commit failed/);
  assert.equal(await following, "ok", "a throw must not poison later acquisitions");
  assert.deepEqual(events, ["first:enter", "second:enter"]);
});

test("a synchronous throw inside the body releases the lock too", async () => {
  const serial = new Serial();

  await assert.rejects(
    serial.run(() => {
      throw new Error("threw before the first await");
    }),
    /threw before the first await/,
  );

  assert.equal(await serial.run(() => Promise.resolve(7)), 7);
});

test("the caller gets its own result back, not the mutex's", async () => {
  const serial = new Serial();
  const results = await Promise.all([
    serial.run(() => Promise.resolve(1)),
    serial.run(() => Promise.resolve(2)),
    serial.run(() => Promise.resolve(3)),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
});

test("callers entering in the same tick still queue", async () => {
  // The tail must be advanced SYNCHRONOUSLY inside `run`, before its first await. If it
  // were not, three acquisitions made in one tick would all see the same predecessor and
  // all run at once — which is the bug the mutex exists to prevent, and it would only
  // show up under exactly the load the two loops produce.
  const serial = new Serial();
  let inside = 0;
  let peak = 0;

  const body = async (): Promise<void> => {
    inside += 1;
    peak = Math.max(peak, inside);
    await sleep(2);
    inside -= 1;
  };

  await Promise.all([serial.run(body), serial.run(body), serial.run(body)]);
  assert.equal(peak, 1, "only one critical section may be in flight at a time");
});

test("busy reports whether anything holds or wants the lock", async () => {
  const serial = new Serial();
  assert.equal(serial.busy, false);

  const held = serial.run(() => sleep(5));
  assert.equal(serial.busy, true, "an acquisition in flight counts as busy");

  await held;
  assert.equal(serial.busy, false);
});
