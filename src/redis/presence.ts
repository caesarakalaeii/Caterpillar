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

  /**
   * The exact member string this process last wrote, per runner id.
   *
   * The note is part of the member, so a runner whose note changes writes a DIFFERENT
   * member and the old one would linger for a whole TTL — one runner appearing twice in
   * the display, once per note it has had. Remembering what we wrote makes removing it
   * one `ZREM` on a known string; the alternative is reading the whole set on every
   * heartbeat to find our own entries, which is a poll-rate scan for a display.
   */
  private readonly written = new Map<RunnerId, string>();

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

    // Written FIRST, so a crash between the two leaves the runner present twice for one
    // TTL rather than absent. Both are wrong and only one of them is alarming: a display
    // that briefly double-counts a runner is a cosmetic bug, and one that loses a runner
    // that is demonstrably working invites someone to go looking for a pod that is fine.
    const wrote = await this.guard.attempt("presence.heartbeat", () =>
      this.redis.zaddAndTrim(PRESENCE_KEY, member, at, at - this.ttlMs),
    );
    if (!wrote) return;

    const previous = this.written.get(runner);
    this.written.set(runner, member);
    if (previous === undefined || previous === member) return;

    await this.guard.attempt("presence.replace", () => this.redis.zrem(PRESENCE_KEY, previous));
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

  /**
   * Leave the display on a clean shutdown.
   *
   * Only what THIS process wrote. A runner that has never heartbeated here has nothing to
   * remove, and scanning for one would be a process removing another process's entry — a
   * decision about liveness, which is exactly what this structure is forbidden from
   * making. A runner that dies without departing ages out on its score instead.
   */
  async depart(runner: RunnerId): Promise<void> {
    const member = this.written.get(runner);
    if (member === undefined) return;
    this.written.delete(runner);
    await this.guard.attempt("presence.depart", () => this.redis.zrem(PRESENCE_KEY, member));
  }
}
