/**
 * Which runners are alive right now. **Advisory. For display only.**
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 *  NOTHING MAY MAKE A CORRECTNESS DECISION FROM THIS.
 *
 *  Not routing, not claiming, not stealing, not "is that lease really dead". Those
 *  answers come from the lease refs in git and only from there (DESIGN.md §5). A runner
 *  missing here is a runner whose last heartbeat did not land — a Redis blip, a pod
 *  paused for three seconds by a node under memory pressure, a clock — and treating that
 *  as "it is gone" is how two runners end up working one task.
 *
 *  DESIGN.md §18 says "There is no runner registry", and that stays true in the sense it
 *  was written in: there is no registry anything DEPENDS on. This is a display, in the
 *  same category as the web view's log ring — informative, disposable, and safe to be
 *  wrong.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Stored as a sorted set scored by heartbeat time rather than a key per runner with a
 * TTL, for one reason: listing has to be a single cheap read (the bot's `/fleet` is
 * inside the same 3-second budget the snapshot is), and a key-per-runner layout means a
 * `SCAN` or a `KEYS`, one of which is slow and the other of which is banned. Expiry is
 * therefore by score — `zaddAndTrim` sweeps members older than the window on every
 * heartbeat, and readers filter by score anyway, so a stale member is invisible even
 * between sweeps.
 */
import type { RunnerId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { RedisClient } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

/** `fleet:presence`, one sorted set for the whole fleet. */
export const PRESENCE_KEY = "fleet:presence";

/**
 * How long after its last heartbeat a runner is still shown.
 *
 * Several poll intervals. Deliberately far longer than a heartbeat period, because the
 * cost of showing a runner that died forty seconds ago is a slightly wrong display and
 * the cost of hiding one that is merely busy is an operator concluding the fleet has
 * shrunk. Nothing depends on it, so the generous reading is the right one.
 */
export const PRESENCE_TTL_SECONDS = 120;

export interface RunnerPresence {
  readonly runner: RunnerId;
  /** Epoch millis of the last heartbeat. */
  readonly seenAt: number;
  /** What the runner said it was doing. Free text, truncated, never parsed. */
  readonly note?: string;
}

export interface PresenceRegistry {
  /** Record that this runner is alive. Call once per poll. */
  heartbeat(runner: RunnerId, note?: string): Promise<void>;
  /** Everyone seen inside the window, most recently seen first. */
  alive(): Promise<readonly RunnerPresence[]>;
  /** Remove this runner — a clean shutdown, so the display is right immediately. */
  depart(runner: RunnerId): Promise<void>;
}

/** Longest note kept. A note is a label, not a log line. */
const MAX_NOTE = 120;

/**
 * The fallback when Redis is unconfigured.
 *
 * A single-process fleet is a fleet of one, and it knows about itself. This is not a
 * degraded version of the Redis registry, it is the complete truth for that deployment.
 */
export class InMemoryPresenceRegistry implements PresenceRegistry {
  private readonly seen = new Map<RunnerId, RunnerPresence>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { readonly now?: () => number; readonly ttlSeconds?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = (options.ttlSeconds ?? PRESENCE_TTL_SECONDS) * 1000;
  }

  heartbeat(runner: RunnerId, note?: string): Promise<void> {
    this.seen.set(runner, {
      runner,
      seenAt: this.now(),
      ...(note === undefined ? {} : { note: note.slice(0, MAX_NOTE) }),
    });
    return Promise.resolve();
  }

  alive(): Promise<readonly RunnerPresence[]> {
    const floor = this.now() - this.ttlMs;
    const live = [...this.seen.values()].filter((entry) => entry.seenAt >= floor);
    return Promise.resolve(live.sort((a, b) => b.seenAt - a.seenAt));
  }

  depart(runner: RunnerId): Promise<void> {
    this.seen.delete(runner);
    return Promise.resolve();
  }
}

export interface RedisPresenceRegistryOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

export class RedisPresenceRegistry implements PresenceRegistry {
  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: RedisPresenceRegistryOptions) {
    this.redis = options.redis;
    this.guard = new RedisGuard({ logger: options.logger });
    this.ttlMs = (options.ttlSeconds ?? PRESENCE_TTL_SECONDS) * 1000;
    this.now = options.now ?? Date.now;
  }

  async heartbeat(runner: RunnerId, note?: string): Promise<void> {
    const at = this.now();
    // The member carries the note, so one read answers "who, and doing what" without a
    // second key per runner. The runner id is first and delimited so a note containing a
    // newline cannot forge one.
    const member = note === undefined ? runner : `${runner}\n${note.slice(0, MAX_NOTE)}`;

    // Old members for the SAME runner would otherwise accumulate, one per distinct note.
    // Removed before the add rather than after, so a crash between the two leaves the
    // runner absent for one heartbeat rather than present twice.
    await this.guard.attempt("presence.sweep", () => this.sweep(runner));
    await this.guard.attempt("presence.heartbeat", () =>
      this.redis.zaddAndTrim(PRESENCE_KEY, member, at, at - this.ttlMs),
    );
  }

  async alive(): Promise<readonly RunnerPresence[]> {
    const floor = this.now() - this.ttlMs;
    const scored = await this.guard.run("presence.read", () => this.redis.zrangeByScore(PRESENCE_KEY, floor), []);

    return scored
      .map(({ member, score }) => {
        const split = member.indexOf("\n");
        const runner = (split === -1 ? member : member.slice(0, split)) as RunnerId;
        const note = split === -1 ? undefined : member.slice(split + 1);
        return { runner, seenAt: score, ...(note === undefined ? {} : { note }) };
      })
      .sort((a, b) => b.seenAt - a.seenAt);
  }

  async depart(runner: RunnerId): Promise<void> {
    await this.guard.attempt("presence.depart", () => this.sweep(runner));
  }

  /** Remove every member belonging to `runner`, whatever note it carries. */
  private async sweep(runner: RunnerId): Promise<void> {
    const scored = await this.redis.zrangeByScore(PRESENCE_KEY, Number.NEGATIVE_INFINITY);
    for (const { member } of scored) {
      const split = member.indexOf("\n");
      if ((split === -1 ? member : member.slice(0, split)) === runner) {
        await this.redis.zrem(PRESENCE_KEY, member);
      }
    }
  }
}
