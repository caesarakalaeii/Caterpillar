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
    await this.git.tryRun(
      "push",
      this.remote,
      "--delete",
      leaseRef(lease.task),
      `--force-with-lease=${leaseRef(lease.task)}:${lease.oid}`,
    );
  }

  /**
   * Write a lease commit and CAS it onto the ref.
   *
   * The commit is created with `commit-tree` against the empty tree so a lease
   * carries no working-tree content and cannot conflict with repo history.
   */
  private async push(task: TaskId, expectedOid: string): Promise<Lease | undefined> {
    const emptyTree = await this.git.run("hash-object", "-t", "tree", "/dev/null");
    const message = `lease ${task} runner=${this.runner}`;
    const oid = await this.git.run("commit-tree", emptyTree, "-m", message);

    const ref = leaseRef(task);
    const result = await this.git.tryRun(
      "push",
      this.remote,
      `${oid}:${ref}`,
      `--force-with-lease=${ref}:${expectedOid}`,
    );

    if (result.code !== 0) return undefined;
    return { task, runner: this.runner, oid };
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
  manager: LeaseManager,
  lease: Lease,
  intervalSeconds: number,
  onLost: (error: LeaseLostError) => void,
): { readonly stop: () => void; readonly current: () => Lease } => {
  let held = lease;
  const timer = setInterval(() => {
    void manager.renew(held).then(
      (renewed) => {
        held = renewed;
      },
      (error: unknown) => {
        clearInterval(timer);
        onLost(
          error instanceof LeaseLostError ? error : new LeaseLostError(held.task),
        );
      },
    );
  }, intervalSeconds * 1000);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    current: () => held,
  };
};
