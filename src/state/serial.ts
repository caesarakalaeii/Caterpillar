/**
 * A serialising async mutex — one shared git checkout, more than one caller.
 *
 * The supervisor runs two independent loops (DESIGN.md §6.4): a housekeeping loop that
 * pulls, drains chat, ingests and publishes, and a work loop that runs one session at a
 * time. Both write the state repo, and `StateStore` is ONE working copy. Two concurrent
 * writers interleave `git add` / `git commit` in it: `index.lock` at best, and at worst a
 * commit carrying half of somebody else's state — which is exactly the reasoning
 * `src/supervisor/inbox.ts` already gives for why the Discord bridge does not touch git
 * at all.
 *
 * A promise chain is all this needs. `run` appends to a tail promise and returns the
 * caller's own result, so acquisitions are served strictly in the order they were made
 * and nothing ever runs while another holder is between its first and last git call.
 *
 * Two properties are load-bearing and both are pinned by `serial.test.ts`:
 *
 *   - **A throw releases the lock.** The chain is advanced in a `finally`, and the tail
 *     that later callers await never rejects — a rejected tail would make one failed
 *     `commitAndPush` poison every subsequent acquisition, which is a wedged runner
 *     rather than a failed write.
 *   - **It is re-entrant-HOSTILE, deliberately.** Calling `run` from inside `run` on the
 *     same mutex deadlocks. There is no ownership token to check against, and inventing
 *     one would hide the real bug: a public `StateStore` method calling another public
 *     one. `StateStore` therefore keeps its git work in private unlocked helpers and
 *     takes the lock exactly once, at the public boundary.
 */

/** Serialises async critical sections. Fair: callers run in acquisition order. */
export class Serial {
  /**
   * The tail of the chain. Never rejects — see the class docstring: a rejected tail is
   * a permanently wedged mutex.
   */
  private tail: Promise<void> = Promise.resolve();

  /** How many callers are queued behind the one running, for tests and metrics. */
  private queued = 0;

  /**
   * Run `body` once every earlier acquisition has settled.
   *
   * The returned promise settles with `body`'s own result — success or failure — so a
   * caller cannot tell the mutex is there except by how long it waited.
   */
  async run<T>(body: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const predecessor = this.tail;

    let release: () => void = () => {};
    // Assigned synchronously by the Promise constructor, so `tail` is advanced before
    // any `await` yields — two callers entering `run` in the same tick still queue.
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await body();
    } finally {
      this.queued -= 1;
      release();
    }
  }

  /** True while someone holds the lock or is waiting for it. Diagnostics only. */
  get busy(): boolean {
    return this.queued > 0;
  }
}
