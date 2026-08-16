/**
 * Distributed lease over git refs. See DESIGN.md §5.
 *
 * Mutual exclusion relies on git's atomic ref update: `--force-with-lease=<ref>:<oid>`
 * makes the push a compare-and-swap. An empty expected oid means "must not exist",
 * which is how a first claim is won.
 *
 * The heartbeat IS the fence. A runner whose lease was stolen discovers it when its
 * next CAS fails against an oid it no longer owns, and must abort immediately —
 * mutual exclusion at claim time is not sufficient, because a partitioned runner
 * keeps working. `assertHeld` is the guard every push must pass through.
 */
import type { Git } from "./git.ts";
import type { RunnerId, TaskId } from "../domain/task.ts";

export const leaseRef = (task: TaskId): string => `refs/leases/${task}`;

export class LeaseLostError extends Error {
  readonly task: TaskId;

  constructor(task: TaskId) {
    super(`lease for ${task} is no longer held by this runner — aborting`);
    this.task = task;
    this.name = "LeaseLostError";
  }
}

/** A held lease. Possession of this object is the right to write for `task`. */
export interface Lease {
  readonly task: TaskId;
  readonly runner: RunnerId;
  /** Fencing token: the lease commit oid this runner most recently pushed. */
  readonly oid: string;
}

/**
 * A live claim, resolved at the moment of use.
 *
 * A `Lease` VALUE is a snapshot of a token the heartbeat ROTATES, so it stops matching the
 * ref the moment a renewal lands — and `assertHeld` compares the oid exactly, because that
 * exactness is the fence. Anything that writes after an await of unbounded length must
 * therefore carry one of these instead of a `Lease` and resolve it immediately before the
 * write. A council review takes minutes and a 60s heartbeat rotates the token several times
 * inside one; passing the pre-review snapshot to `assertHeld` reported a stolen lease that
 * nobody had stolen, and the caller discarded work it had already done.
 *
 * `current()` is async so it can wait out a renewal ALREADY IN FLIGHT: a read that races a
 * renewal's push would otherwise see the ref's new oid while this side still names the old
 * one — the same false loss, in a much narrower window.
 */
export interface LeaseHandle {
  readonly current: () => Promise<Lease>;
}

/**
 * A claim nothing renews.
 *
 * For the short paths that claim, write and release with no await worth rotating a token
 * across. They still take a `LeaseHandle` so that no signature offers the choice.
 */
export const heldLease = (lease: Lease): LeaseHandle => ({
  current: () => Promise.resolve(lease),
});

export interface LeaseManagerOptions {
  readonly git: Git;
  readonly remote: string;
  readonly runner: RunnerId;
  readonly staleAfterSeconds: number;
}

export class LeaseManager {
  private readonly git: Git;
  private readonly remote: string;
  private readonly runner: RunnerId;
  private readonly staleAfterSeconds: number;

  constructor(options: LeaseManagerOptions) {
    this.git = options.git;
    this.remote = options.remote;
    this.runner = options.runner;
    this.staleAfterSeconds = options.staleAfterSeconds;
  }

  /**
   * Attempt to claim `task`. Returns undefined when another runner holds a live
   * lease, or when we lost the race — both are normal, the caller tries the next task.
   */
  async claim(task: TaskId): Promise<Lease | undefined> {
    const ref = leaseRef(task);
    const existing = await this.git.lsRemote(this.remote, ref);

    if (existing !== undefined && !(await this.isStale(existing))) return undefined;

    // Empty expected value = "must not exist". Otherwise we are stealing a stale
    // lease and must CAS from exactly the oid we observed as stale.
    const expected = existing ?? "";
    return this.push(task, expected);
  }

  /**
   * Renew an existing lease. Throws LeaseLostError if the CAS fails, which means
   * another runner stole it — the caller must stop all work immediately.
   */
  async renew(lease: Lease): Promise<Lease> {
    const renewed = await this.push(lease.task, lease.oid);
    if (renewed === undefined) throw new LeaseLostError(lease.task);
    return renewed;
  }

  /**
   * Verify we still hold the lease before any write. Cheap remote read; call this
   * before pushing task branches or state (DESIGN.md §5.1).
   */
  async assertHeld(lease: Lease): Promise<void> {
    const current = await this.git.lsRemote(this.remote, leaseRef(lease.task));
    if (current !== lease.oid) throw new LeaseLostError(lease.task);
  }

  /** Release voluntarily. Best-effort: a failure just means it will expire instead. */
  async release(lease: Lease): Promise<void> {
    await this.releaseRef(leaseRef(lease.task), lease.oid);
  }

  /**
   * Claim a ref that must be won exactly once across the whole fleet, ever.
   *
   * The same compare-and-swap as a task claim, with two differences that matter: the
   * expected value is always empty, so this succeeds only if nobody has ever created the
   * ref; and nothing renews or steals it, so winning is permanent. That is what a marker
   * wants — "the digest for 2026-08-16 has been published" is not a fact that expires
   * (DESIGN.md §19), and a stealable one would let a restarted runner republish a day.
   *
   * Returns the oid this runner wrote, or undefined when it did not win. Undefined is NOT
   * proof that someone else did: a dead network fails the same push. Callers that must
   * tell the two apart ask `hasRef` afterwards.
   */
  async claimOnce(ref: string, message: string): Promise<string | undefined> {
    return this.casRef(ref, message, "");
  }

  /** Whether the remote has `ref` at all. */
  async hasRef(ref: string): Promise<boolean> {
    return (await this.git.lsRemote(this.remote, ref)) !== undefined;
  }

  /** Delete a ref this runner holds. Best-effort, and never deletes someone else's. */
  async releaseRef(ref: string, oid: string): Promise<void> {
    await this.git.tryRun(
      "push",
      this.remote,
      "--delete",
      ref,
      `--force-with-lease=${ref}:${oid}`,
    );
  }

  /**
   * Write a lease commit and CAS it onto the ref.
   *
   * The commit is created with `commit-tree` against the empty tree so a lease
   * carries no working-tree content and cannot conflict with repo history.
   */
  private async push(task: TaskId, expectedOid: string): Promise<Lease | undefined> {
    const oid = await this.casRef(
      leaseRef(task),
      `lease ${task} runner=${this.runner}`,
      expectedOid,
    );
    return oid === undefined ? undefined : { task, runner: this.runner, oid };
  }

  /**
   * The compare-and-swap itself, shared by every ref this manager owns.
   *
   * ONE implementation on purpose: `--force-with-lease` semantics are the whole of the
   * mutual exclusion (DESIGN.md §5), and a second copy written for a second kind of ref
   * is a second chance to get an empty expected value subtly wrong. An empty `expectedOid`
   * means "must not already exist"; anything else means "must be exactly this".
   */
  private async casRef(
    ref: string,
    message: string,
    expectedOid: string,
  ): Promise<string | undefined> {
    const emptyTree = await this.git.run("hash-object", "-t", "tree", "/dev/null");
    const oid = await this.git.run("commit-tree", emptyTree, "-m", message);

    const result = await this.git.tryRun(
      "push",
      this.remote,
      `${oid}:${ref}`,
      `--force-with-lease=${ref}:${expectedOid}`,
    );

    return result.code === 0 ? oid : undefined;
  }

  /**
   * A lease is stale when its commit is older than the threshold.
   *
   * Compares commit timestamps across machines, so runners must run NTP. The
   * threshold is deliberately far larger than plausible skew (DESIGN.md §5.1).
   */
  private async isStale(oid: string): Promise<boolean> {
    await this.git.tryRun("fetch", this.remote, oid);
    try {
      const committed = await this.git.commitTime(oid);
      const ageSeconds = Math.floor(Date.now() / 1000) - committed;
      return ageSeconds > this.staleAfterSeconds;
    } catch {
      // Cannot read the lease commit — treat as live rather than risk two runners.
      return false;
    }
  }
}

/**
 * Renew `lease` on an interval until the returned stop function is called.
 *
 * `onLost` fires when the CAS fails; the caller must abort the session. The
 * heartbeat intentionally does not swallow the error — losing a lease is not a
 * recoverable condition, it means someone else owns the work now.
 */
export const startHeartbeat = (
  /** Only `renew` is needed, and saying so is what lets the timing be tested directly. */
  manager: Pick<LeaseManager, "renew">,
  lease: Lease,
  intervalSeconds: number,
  onLost: (error: LeaseLostError) => void,
): LeaseHandle & { readonly stop: () => void } => {
  let held = lease;
  /** Set while a renewal is airborne, so `current()` can wait for the token to settle. */
  let inFlight: Promise<void> | undefined;

  const timer = setInterval(() => {
    inFlight = manager.renew(held).then(
      (renewed) => {
        held = renewed;
        inFlight = undefined;
      },
      (error: unknown) => {
        clearInterval(timer);
        inFlight = undefined;
        onLost(
          error instanceof LeaseLostError ? error : new LeaseLostError(held.task),
        );
      },
    );
  }, intervalSeconds * 1000);
  timer.unref();

  return {
    // Stopping does not settle an airborne renewal, so `current()` still has to wait for
    // one: the push may already have moved the ref.
    stop: () => clearInterval(timer),
    current: async () => {
      // Exactly the renewal airborne when asked, not "until none is airborne": looping
      // would hand control to whatever the interval starts next and could wait forever if
      // renewals stop completing — the caller wants to write, and a caller that never
      // returns is worse than one racing a rotation.
      //
      // A renewal starting AFTER this point still leaves the pre-existing window between
      // `assertHeld` and the push it guards. That window is a second or two against a
      // 60s interval, and losing it costs an unwound task, not a corrupted one.
      const settling = inFlight;
      if (settling !== undefined) await settling;
      return held;
    },
  };
};
