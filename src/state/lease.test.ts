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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "./git.ts";
import { LeaseLostError, LeaseManager, heldLease, startHeartbeat, type Lease } from "./lease.ts";

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

/**
 * A real remote, because the thing under test IS the compare-and-swap. A stub that always
 * agrees would pass while two runners both believed they had won.
 */
const remoteFixture = async (): Promise<{
  manager: LeaseManager;
  other: LeaseManager;
  /** Builds a further manager over the same remote — used to vary the stale threshold. */
  join: (runner: string, staleAfterSeconds: number) => LeaseManager;
}> => {
  const hermetic: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const root = await mkdtemp(join(tmpdir(), "caterpillar-lease-"));
  const origin = join(root, "origin.git");
  const a = join(root, "a");
  const b = join(root, "b");

  const setup = new Git(root, hermetic);
  await setup.run("init", "--quiet", "--bare", "--initial-branch=main", origin);
  await setup.run("clone", "--quiet", origin, a);
  await setup.run("clone", "--quiet", origin, b);

  // `casRef` builds a commit, and the global config is nulled out for hermeticity, so
  // without this every claim fails with "Author identity unknown".
  for (const dir of [a, b]) {
    const git = new Git(dir, hermetic);
    await git.run("config", "user.email", "runner@example.invalid");
    await git.run("config", "user.name", "runner");
  }

  const of = (dir: string, runner: string, staleAfterSeconds: number): LeaseManager =>
    new LeaseManager({
      git: new Git(dir, hermetic),
      remote: "origin",
      runner: asRunnerId(runner),
      staleAfterSeconds,
    });

  return {
    manager: of(a, "runner-a", 300),
    other: of(b, "runner-b", 300),
    join: (runner, staleAfterSeconds) => of(b, runner, staleAfterSeconds),
  };
};

test("a stealable ref is won by exactly one runner, and refused to the other", async () => {
  // The fleet needs one holder for things that must not happen four times — the Discord
  // gateway most of all. Four replicas each ran the bridge, so a single `/brainstorm`
  // would have opened four threads and minted four tasks, and one `!answer` would have
  // been four writes to the same state repo.
  const { manager, other } = await remoteFixture();

  const won = await manager.claimStealable("refs/chat/holder", "held by runner-a");
  assert.notEqual(won, undefined, "the first runner must win");

  const lost = await other.claimStealable("refs/chat/holder", "held by runner-b");
  assert.equal(lost, undefined, "and the second must be refused, not queued");
});

test("the holder renews its own claim rather than losing it to itself", async () => {
  // Renewal is what makes the claim stealable-but-not-stolen: the ref moves, so its
  // commit time advances, so nobody else ever sees it as stale while the holder lives.
  const { manager, other } = await remoteFixture();

  const first = await manager.claimStealable("refs/chat/holder", "held");
  assert.ok(first !== undefined);
  const renewed = await manager.claimStealable("refs/chat/holder", "held", first);
  assert.notEqual(renewed, undefined, "the holder must be able to renew its own ref");

  // Deliberately NOT asserting the oid changed. `casRef` commits an empty tree with a
  // fixed message, so within one second the commit is byte-identical and git accepts the
  // push as a no-op. That is harmless — renewals are a poll interval apart, so the
  // timestamp differs, the oid differs and the commit time advances — but a reader
  // expecting a new oid here would be looking at a bug that is not one.
  // What actually matters after a renewal: this runner is still the holder.
  //
  // Asserted as "defined" and not as "equal to `renewed`" for the reason the paragraph
  // above gives — and this line used to get it wrong, which made the test fail roughly one
  // run in ten. Whether the oid moves depends on whether the two pushes land in the same
  // whole second: same second, byte-identical commit, same oid; a second boundary between
  // them, a new commit time and a new oid. Both are successful renewals, so the assertion
  // has to be about success rather than about which side of a clock tick the test ran on.
  assert.notEqual(
    await manager.claimStealable("refs/chat/holder", "held", renewed),
    undefined,
    "renewing again from the oid it was just given must still succeed",
  );

  assert.equal(
    await other.claimStealable("refs/chat/holder", "held by runner-b"),
    undefined,
    "a renewed claim is still refused to everyone else",
  );
});

test("a claim whose holder went away is taken over", async () => {
  // Without this the fleet loses the bridge for good the first time a pod is deleted: the
  // ref outlives the process that made it, so a claim nobody can steal is a claim nobody
  // can ever hold again.
  const { manager, join: over } = await remoteFixture();
  assert.ok((await manager.claimStealable("refs/chat/holder", "held by runner-a")) !== undefined);

  // A threshold of zero plus a real second of age, rather than a negative threshold:
  // `isStale` compares whole seconds, so a claim made in this same second is age 0 and
  // `0 > 0` is false. Waiting exercises the arithmetic production actually uses.
  const stealer = over("runner-b", 0);
  await sleep(1100);

  assert.notEqual(
    await stealer.claimStealable("refs/chat/holder", "held by runner-b"),
    undefined,
    "a stale claim must be takeable",
  );
});
