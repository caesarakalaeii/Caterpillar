/**
 * The runner's back-off after the model provider stops answering. See DESIGN.md §6.3.
 *
 * This is the piece that turns a provider outage into a pause instead of a stampede.
 * Without it the supervisor's reaction to "the provider refused" is to release the task
 * and claim the next one, which fails identically, and the one after that — an account
 * limit reached at 10:00 takes the whole queue with it in under a minute.
 *
 * Deliberately at RUNNER scope, not task scope. The provider is shared by every task on
 * this runner, so what one task learned about it is true for all of them, and a per-task
 * retry schedule would multiply the request rate by the number of tasks waiting.
 *
 * Pure and clock-injected: `now` is a parameter, never read here. The supervisor owns
 * the clock, and a back-off schedule that can only be tested by sleeping is one nobody
 * tests.
 */
import type { ProviderOutage } from "../domain/task.ts";

export interface CooldownOptions {
  /** Wait after the first outage. Doubles per consecutive outage. */
  readonly initialSeconds: number;
  /**
   * Ceiling on one wait.
   *
   * Also the price of learning the outage is over: a monthly spend limit lasts days,
   * and the runner discovers it has cleared by spending one rejected request per cap
   * interval. Long enough to be free, short enough that a topped-up account is picked
   * up without anyone restarting the pod.
   */
  readonly maxSeconds: number;
}

export interface CooldownEntry {
  readonly waitMs: number;
  /** True when this began a new incident — the moment worth telling a human about. */
  readonly first: boolean;
}

export class ProviderCooldown {
  private readonly options: CooldownOptions;
  private streak = 0;
  private until = 0;

  constructor(options: CooldownOptions) {
    this.options = options;
  }

  /** Record an outage and return how long the runner should now wait. */
  record(now: number, outage: ProviderOutage): CooldownEntry {
    const first = this.streak === 0;
    this.streak += 1;

    const waitMs = Math.min(this.maxMs, this.wantedMs(outage));
    this.until = now + waitMs;
    return { waitMs, first };
  }

  /**
   * Note that the provider answered. Returns true if this ended an incident, which is
   * what makes "it is back" a single message rather than one per session.
   */
  clear(): boolean {
    const recovered = this.streak > 0;
    this.streak = 0;
    this.until = 0;
    return recovered;
  }

  /** How much longer the runner must not start a session. Zero when healthy. */
  remainingMs(now: number): number {
    return Math.max(0, this.until - now);
  }

  private get maxMs(): number {
    return this.options.maxSeconds * 1000;
  }

  private wantedMs(outage: ProviderOutage): number {
    // A rejected credential is not a queue to wait out — it needs a human, and the
    // access token pi refreshes has an hour on it either way. Waiting the short
    // intervals first would just be a quieter way of hammering the same 401.
    if (outage.kind === "unauthorised") return this.maxMs;

    const backoff = this.options.initialSeconds * 1000 * 2 ** (this.streak - 1);
    // The provider's own number wins when it is larger: it knows when the window rolls
    // over and we are guessing.
    return Math.max(backoff, outage.retryAfterMs ?? 0);
  }
}
