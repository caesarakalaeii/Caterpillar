/**
 * The heartbeat's fencing token, which ROTATES.
 *
 * `assertHeld` compares the lease oid exactly — that exactness is the whole fence — so
 * anything holding a `Lease` VALUE across a renewal is holding a token the ref no longer
 * has. The supervisor did exactly that: it read one out of the heartbeat before a
 * multi-minute council review and pushed with it afterwards, so a plan that had already
 * been reviewed and cut into five tasks was thrown away as "someone else owns this now".
 *
 * These tests drive `startHeartbeat` directly with a renewal whose completion the test
 * controls, because the timing IS the behaviour and nothing observable from the supervisor
 * distinguishes a rotated token from a stolen one.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { asRunnerId, asTaskId } from "../domain/task.ts";
import { LeaseLostError, heldLease, startHeartbeat, type Lease } from "./lease.ts";

const TASK = asTaskId("LEASE-1");
const RUNNER = asRunnerId("test-runner");

const lease = (oid: string): Lease => ({ task: TASK, runner: RUNNER, oid });

/** Fires the interval fast enough that a test does not wait on wall-clock seconds. */
const FAST = 0.02;

test("current() returns the token the last renewal produced, not the original", async () => {
  const renewals: string[] = [];
  const manager = {
    renew: (held: Lease): Promise<Lease> => {
      renewals.push(held.oid);
      return Promise.resolve(lease(`oid-${renewals.length}`));
    },
  };

  const heartbeat = startHeartbeat(manager, lease("oid-0"), FAST, () => {
    assert.fail("the lease was not lost");
  });

  try {
    while (renewals.length < 2) await sleep(5);
    const current = await heartbeat.current();

    assert.notEqual(
      current.oid,
      "oid-0",
      "a token captured before a renewal is exactly what assertHeld rejects",
    );
    assert.match(current.oid, /^oid-\d+$/);
    // Each renewal must CAS from the previous token, not from the original: `renew` passes
    // `lease.oid` as the expected value, so chaining wrong makes every renewal after the
    // first fail against the ref.
    assert.deepEqual(renewals.slice(0, 2), ["oid-0", "oid-1"]);
  } finally {
    heartbeat.stop();
  }
});

test("current() waits out a renewal that is already airborne", async () => {
  // The narrow race the async signature exists for. A renewal's push may already have
  // moved the ref while this side still names the old oid, so answering from `held`
  // immediately reports a loss that never happened.
  let finish: ((renewed: Lease) => void) | undefined;
  let started = 0;
  const manager = {
    renew: (): Promise<Lease> => {
      started += 1;
      return new Promise<Lease>((resolve) => {
        finish = resolve;
      });
    },
  };

  const heartbeat = startHeartbeat(manager, lease("before"), FAST, () => {
    assert.fail("the lease was not lost");
  });

  try {
    while (started === 0) await sleep(5);
    // Stop the interval so exactly ONE renewal is airborne for the rest of the test.
    // `stop` deliberately does not settle it — that is the state under test, and it is
    // also what the supervisor's error path does before it parks.
    heartbeat.stop();

    let answered: string | undefined;
    const pending = heartbeat.current().then((held) => {
      answered = held.oid;
    });

    await sleep(60);
    assert.equal(
      answered,
      undefined,
      "current() must not answer while a renewal is in flight — the ref is mid-move",
    );

    assert.ok(finish !== undefined);
    finish(lease("after"));
    await pending;

    assert.equal(answered, "after", "the settled token is the one the remote now holds");
  } finally {
    heartbeat.stop();
  }
});

test("a failed renewal reports the loss once and stops renewing", async () => {
  let started = 0;
  const manager = {
    renew: (): Promise<Lease> => {
      started += 1;
      return Promise.reject(new LeaseLostError(TASK));
    },
  };

  const losses: LeaseLostError[] = [];
  const heartbeat = startHeartbeat(manager, lease("only"), FAST, (error) => {
    losses.push(error);
  });

  try {
    while (losses.length === 0) await sleep(5);
    const afterFirstLoss = started;
    await sleep(80);

    assert.equal(losses.length, 1, "a lost lease is reported once, not once per interval");
    assert.equal(
      started,
      afterFirstLoss,
      "renewing must stop after a loss — the ref belongs to another runner now",
    );
    assert.equal(losses[0]?.task, TASK);

    // `current()` must still answer, and must not hang on the rejected renewal: the caller
    // parks the task, and parking writes.
    assert.equal((await heartbeat.current()).oid, "only");
  } finally {
    heartbeat.stop();
  }
});

test("heldLease resolves to exactly the lease it was given", async () => {
  const held = lease("fixed");
  assert.deepEqual(await heldLease(held).current(), held);
});
