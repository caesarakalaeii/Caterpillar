/**
 * The buffer between a human typing and a session reading.
 *
 * Every test here is about a message that must not disappear. The two windows it can
 * disappear in are the gap BETWEEN two sessions of the same task — `workTask` runs as many
 * as it needs and neither one is subscribed during the changeover — and the turn where pi
 * stops before polling its steering queue, which is why what the journal records is what
 * ARRIVED rather than what was consumed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotSteering } from "./steering.ts";

test("a message that arrives with no session waiting is held for the next one", () => {
  const steering = new SlotSteering();
  steering.push("use the existing migration path");

  assert.deepEqual(steering.take(), ["use the existing migration path"]);
});

test("the backlog is taken exactly once", () => {
  const steering = new SlotSteering();
  steering.push("one");

  assert.deepEqual(steering.take(), ["one"]);
  assert.deepEqual(steering.take(), [], "a second session must not replay the first's steer");
});

test("a subscribed session gets messages as they arrive", () => {
  const steering = new SlotSteering();
  const seen: string[] = [];
  steering.subscribe((text) => seen.push(text));

  steering.push("drop the third task");
  steering.push("and the criteria are unmeasurable");

  assert.deepEqual(seen, ["drop the third task", "and the criteria are unmeasurable"]);
  assert.deepEqual(steering.take(), [], "a delivered message is not also buffered");
});

test("unsubscribing sends later messages back to the buffer", () => {
  // The session boundary. The old session unsubscribes in its `finally`; anything typed
  // before the next one subscribes has to survive the gap.
  const steering = new SlotSteering();
  const seen: string[] = [];
  const stop = steering.subscribe((text) => seen.push(text));

  steering.push("during");
  stop();
  steering.push("between sessions");

  assert.deepEqual(seen, ["during"]);
  assert.deepEqual(steering.take(), ["between sessions"]);
});

test("unsubscribing is scoped to the subscriber that did it", () => {
  // A stale `finally` from the previous session must not silence the current one.
  const steering = new SlotSteering();
  const seen: string[] = [];
  const stale = steering.subscribe(() => assert.fail("the old session must not be called"));
  stale();
  steering.subscribe((text) => seen.push(text));
  stale();

  steering.push("still listening");
  assert.deepEqual(seen, ["still listening"]);
});

test("a listener that throws does not lose the message", () => {
  // pi's queue refusing a steer is not a reason for a human's sentence to vanish. It goes
  // back to the buffer, where the next session's `take` finds it.
  const steering = new SlotSteering();
  steering.subscribe(() => {
    throw new Error("queue refused");
  });

  steering.push("keep me");
  assert.deepEqual(steering.take(), ["keep me"]);
});

test("what arrived is recorded even when a session consumed it", () => {
  // The journal is written from this, and the journal is what the NEXT session reads. A
  // steer pi never polled — `shouldStopAfterTurn` exits before it does — has to still be
  // in front of the agent afterwards.
  const steering = new SlotSteering();
  steering.subscribe(() => undefined);
  steering.push("delivered");
  steering.push("also delivered");

  assert.deepEqual(steering.arrived(), ["delivered", "also delivered"]);
});

test("recorded guidance is cleared once a session has journalled it", () => {
  // A task that hands off five times must not append the same guidance five times.
  const steering = new SlotSteering();
  steering.push("said once");
  steering.clearArrived();

  assert.deepEqual(steering.arrived(), []);
  assert.deepEqual(steering.take(), ["said once"], "clearing the record does not consume it");
});
