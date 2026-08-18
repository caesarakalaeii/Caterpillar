/**
 * Failure containment for the ephemeral plane.
 *
 * The rule this file exists to make structural: **a Redis failure degrades, it never
 * throws.** Every one of the four structures reaches its client through `guard`, so
 * there is exactly one place where the decision is made and exactly one place to read to
 * know what happens when the server goes away.
 *
 * The reasoning is `supervisor/loop.ts:~287`'s, applied one layer down. A rejected
 * promise from a socket that happens to be down would unwind out of `pollOnce`, and the
 * failure mode that produces is the one the loop's own try/catch was added to prevent: a
 * live process that answers `/healthz`, holds its lease, and does no work. It is also
 * `notify/leadership.ts`'s `refresh()`: "I could not reach the remote" is read honestly
 * as "I do not have it", never as an exception for someone else to handle.
 *
 * So a read that fails returns the fallback — an empty list, `undefined`, today's
 * in-memory answer — and a write that fails is dropped with a warn line. That is not
 * data loss in any sense that matters, because nothing in Redis is authoritative: a
 * dropped presence heartbeat means one runner missing from a display, a dropped snapshot
 * write means a bot autocomplete one poll stale, and a dropped inbox push means a Discord
 * command that reports failure to the human who typed it rather than vanishing.
 *
 * Log volume is bounded on purpose. A Redis that is down is down for minutes, and the
 * poll loop touches this several times a second; one warn per operation per
 * `LOG_INTERVAL_MS` is enough to see it in Loki and few enough that it does not bury
 * everything else.
 */
import type { Logger } from "../obs/log.ts";

/** Shortest gap between two warn lines about the same operation. */
const LOG_INTERVAL_MS = 30_000;

export interface RedisGuardOptions {
  readonly logger: Logger;
  /** Injectable for tests that assert the throttle without waiting 30 seconds. */
  readonly now?: () => number;
}

/**
 * Runs Redis work and converts every failure into a value.
 *
 * One instance per structure, so the throttle is per structure too: an inbox that cannot
 * push and a presence that cannot heartbeat are two different symptoms and both deserve
 * to be visible.
 */
export class RedisGuard {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly lastLoggedAt = new Map<string, number>();
  /** Consecutive failures, reset by the first success. Reported when it recovers. */
  private failures = 0;

  constructor(options: RedisGuardOptions) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** True while the last attempted operation failed. Advisory; for the web view only. */
  get degraded(): boolean {
    return this.failures > 0;
  }

  /**
   * Await `work`; on any rejection log (throttled) and return `fallback`.
   *
   * `fallback` is a value rather than a thunk because every caller's fallback is already
   * computed — `undefined`, `[]`, the in-process answer — and a thunk would invite
   * putting IO in it.
   */
  async run<T>(operation: string, work: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const result = await work();
      if (this.failures > 0) {
        this.logger.info("redis.recovered", { operation, failures: this.failures });
        this.failures = 0;
        this.lastLoggedAt.clear();
      }
      return result;
    } catch (error) {
      this.failures += 1;
      this.note(operation, error);
      return fallback;
    }
  }

  /** `run` for a write, where the fallback is simply "it did not happen". */
  async attempt(operation: string, work: () => Promise<unknown>): Promise<boolean> {
    return this.run(
      operation,
      async () => {
        await work();
        return true;
      },
      false,
    );
  }

  private note(operation: string, error: unknown): void {
    const at = this.now();
    const last = this.lastLoggedAt.get(operation);
    if (last !== undefined && at - last < LOG_INTERVAL_MS) return;
    this.lastLoggedAt.set(operation, at);

    this.logger.warn("redis.degraded", {
      operation,
      failures: this.failures,
      // The message only. A Redis error can carry the command's arguments, and an inbox
      // push's argument is a human's Discord message.
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
