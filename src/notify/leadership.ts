/**
 * Which replica of the fleet acts on Discord. See DESIGN.md §7.
 *
 * Every replica connects to the gateway — that is what keeps the bot online across a
 * rollout, and a connection costs nothing — but exactly one may act on what arrives over
 * it. Four that all acted opened four threads for one `/brainstorm`, because a
 * brainstorm's id is derived from the thread Discord has just created for it, and turned
 * one `!answer` into four runners writing the same state repo.
 *
 * The claim is a git ref won by the same compare-and-swap that claims a task (§5), for
 * the same reason the daily digest's is (§19): the state repo is the only thing the fleet
 * shares, so it is the only place a fleet-wide decision can be made. No new coordination
 * mechanism, and nothing to run when there is one replica.
 *
 * Refreshed from the supervisor's HOUSEKEEPING loop (DESIGN.md §6.4), on that loop's
 * interval.
 *
 * It used to be refreshed from the single poll loop, and the reason given was that a timer
 * of its own "would keep renewing the claim while a session blocked the loop — advertising
 * a holder that cannot currently answer anything". That objection was correct and is now
 * void, because the thing on the other side of the claim moved with it: the housekeeping
 * loop IS what drains the inbox, applies `/resume` and `/answer`, and ingests. It runs
 * whether or not a session is in flight, so a replica that renews here is by construction
 * a replica that can answer.
 *
 * The arrangement it replaces had the worse failure in practice, because renewing and
 * STEPPING DOWN are both this method. A replica that took the claim and then started a
 * four-hour session did neither for four hours: it went on believing it was the holder
 * while its claim went stale, and another replica eventually stole it. In the meantime
 * the bot was online, `held()` said yes, and nothing was answered.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHEN THE BOT RUNS AS ITS OWN PROCESS (DESIGN.md §7, §10)
 *
 * Splitting the bot out (`src/bot.ts`) changes what leadership is FOR, and the change is
 * worth stating plainly because the obvious answer is wrong.
 *
 * The duplicate-claim problem this file was written for is not the bot's problem. It was
 * the SUPERVISOR's: four supervisors each held a gateway connection because each one also
 * polled, so each one saw every message. A dedicated bot Deployment is scaled on its own,
 * and the fleet wants exactly one of it — supervisors scale freely and connect to Discord
 * not at all. So the default is (a): **one bot replica, no leadership object.**
 * `DiscordBridge.acts()` already treats absent leadership as "yes", which is why that
 * costs no code.
 *
 * One replica is not one PROCESS, though, and that gap is what `RedisChatLock` below is
 * for. A rolling update runs the new pod before the old one has gone, and for those
 * seconds two bots are connected and both would act — duplicate replies, and a duplicate
 * `/brainstorm` mints two threads and two tasks, which is the exact failure the git CAS
 * was added to stop. Option (c): a **Redis lock with a TTL**, taken by whichever process
 * gets there first and renewed on its own timer.
 *
 * Why not (b) — keeping this class and refreshing it on a timer. The brief preferred it,
 * and the docstring's old objection really is void: nothing blocks a bot process, so a
 * timer here would be honest. It is unbuildable for a different reason. `refresh()` calls
 * `claims.claimStealable()`, which is `LeaseManager`'s `lsRemote` + `casRef` — a push to
 * the state repo. That needs the forge credential the split exists to take AWAY from the
 * bot (§7: the bot touches no state repo and holds no forge or LLM credential). A bot
 * holding a state-repo credential to decide which bot may speak gives back most of the
 * value of splitting it out, so the credential constraint wins and the mechanism moves.
 *
 * Redis is acceptable here where it is NOT acceptable for leases (§21, "why the leases are
 * not moving"), and the difference is what a lost lock costs. A lost task lease means two
 * runners writing one task's state and a commit that can never rebase. A lost chat lock
 * means one duplicated Discord message during a rollout. That asymmetry is the whole
 * argument: the ephemeral plane may decide things whose failure is cosmetic, and nothing
 * more.
 *
 * The rule when Redis is unreachable is therefore **do not act**, and it is the same rule
 * `refresh()` already follows for an unreachable remote: a claim that cannot be proved is
 * not held. It also composes with the health check (`bot.ts`), which reports unready when
 * Redis is unreachable — a bot that cannot prove it may speak is a bot that should be
 * taken out of service, not one that answers probes while saying nothing.
 */
import type { RunnerId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";

/** `refs/chat/holder` — one per fleet, not per task or per day. */
export const CHAT_HOLDER_REF = "refs/chat/holder";

/** What leadership needs from `LeaseManager`, narrowed to what it actually calls. */
export interface StealableClaims {
  claimStealable(ref: string, message: string, held?: string): Promise<string | undefined>;
  /** Delete a ref this runner holds. Never deletes someone else's — see `standDown`. */
  releaseRef(ref: string, oid: string): Promise<void>;
}

export interface ChatLeadershipOptions {
  readonly claims: StealableClaims;
  readonly runner: RunnerId;
  readonly logger: Logger;
}

export class ChatLeadership {
  private readonly options: ChatLeadershipOptions;
  /** The oid this replica believes it wrote, or undefined when it holds nothing. */
  private oid: string | undefined;

  constructor(options: ChatLeadershipOptions) {
    this.options = options;
  }

  /** Read synchronously, on every inbound Discord event. Never does IO. */
  held(): boolean {
    return this.oid !== undefined;
  }

  /**
   * Give the claim up on the way out, so the next replica does not wait for it to go stale.
   *
   * **This is what makes a rollout cost a poll instead of five minutes.** A holder that just
   * dies leaves `refs/chat/holder` behind with the commit time of its last renewal, and
   * `claimStealable` refuses a ref that is not yet stale — `lease.staleAfterSeconds`, 300 by
   * default. So every replica came up, connected its gateway, and then acted on nothing for the
   * remainder of that window, in complete silence: `acts()` is checked at both inbound doors and
   * a non-holder returns without logging, so a slash command in the gap shows Discord's own
   * "This interaction failed" and a message typed in a thread is simply gone.
   *
   * Observed on the 2026-08-19 rollout: pods restarted 20:03–20:05, the ref went stale at
   * 20:09:58 — exactly 300s after the dead holder's last renewal — and the bot was deaf between.
   *
   * The same shape as `PresenceRegistry.depart`, which this shutdown path already calls for the
   * same reason one line further down: leave the display before closing the connection.
   *
   * CAS on the oid WE wrote, so a replica that quietly lost the claim cannot delete the ref its
   * successor is now holding. Never throws: shutdown must not be the path that fails, and the
   * cost of a failed stand-down is exactly the behaviour that existed before this.
   */
  async standDown(): Promise<void> {
    const { claims, runner, logger } = this.options;
    const held = this.oid;
    if (held === undefined) return;

    this.oid = undefined;
    try {
      await claims.releaseRef(CHAT_HOLDER_REF, held);
      logger.info("chat.stood-down", { runner });
    } catch (error) {
      // The next replica waits for staleness, as it always did. Worth a line, never a throw.
      logger.warn("chat.stand-down-failed", {
        runner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Take the claim, or renew it, or discover it has been taken away.
   *
   * Failure is never fatal and never throws: a runner that cannot reach the remote must
   * keep working its task, and the honest reading of "I could not renew" is "I am not the
   * holder" — so it steps down rather than acting on a claim it cannot prove.
   */
  async refresh(): Promise<void> {
    const { claims, runner, logger } = this.options;
    const message = `chat holder: ${runner}`;

    try {
      const next =
        this.oid === undefined
          ? await claims.claimStealable(CHAT_HOLDER_REF, message)
          : await claims.claimStealable(CHAT_HOLDER_REF, message, this.oid);

      if (next === undefined) {
        // Losing it is worth a line; not having it is not. Three replicas out of four are
        // in the second case on every poll, forever.
        if (this.oid !== undefined) logger.warn("chat.stepped-down", { runner });
        this.oid = undefined;
        return;
      }

      if (this.oid === undefined) logger.info("chat.holder", { runner });
      this.oid = next;
    } catch (error) {
      if (this.oid !== undefined) {
        logger.warn("chat.stepped-down", {
          runner,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.oid = undefined;
    }
  }
}

/**
 * `chat:holder` — the Redis key the standalone bot's lock lives under.
 *
 * Deliberately not the same NAME as `CHAT_HOLDER_REF`'s path: they are different
 * mechanisms on different planes, and a shared name would invite the reading that losing
 * one has anything to do with the other.
 */
export const CHAT_LOCK_KEY = "chat:holder";

/**
 * How long a lock survives without a renewal.
 *
 * Long enough that one slow round trip does not hand the bot over, short enough that a
 * pod killed mid-rollout does not silence the fleet for longer than a human notices. The
 * renewal interval is a third of it (`RENEW_FRACTION`), so two consecutive failures are
 * survivable before anything changes hands.
 */
export const CHAT_LOCK_TTL_SECONDS = 30;

/** Renew at a third of the TTL, so losing one renewal is not losing the lock. */
const RENEW_FRACTION = 3;

/** The subset of `RedisClient` a lock needs. Narrow, so a fake is three methods. */
export interface LockableRedis {
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  renewIfHeld(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  releaseIfHeld(key: string, value: string): Promise<boolean>;
}

export interface RedisChatLockOptions {
  readonly redis: LockableRedis;
  /** Identifies THIS process in the key, so a renewal can tell its own lock from a successor's. */
  readonly runner: RunnerId;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
  /** Seam for tests; production waits for real. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

/**
 * One bot process acts, decided by a Redis key rather than a git ref.
 *
 * Same shape as `ChatLeadership` — `held()` is synchronous and does no IO, because it is
 * consulted on every inbound Discord event — and the same honest default: a process that
 * cannot reach Redis reports that it does not hold the lock.
 *
 * The renewal runs on its own timer, which is correct HERE and was not correct in the
 * supervisor: a bot process has no session to block on, so a timer that keeps firing is
 * evidence the process can still answer. See this file's header for the full reasoning.
 */
export class RedisChatLock {
  private readonly options: RedisChatLockOptions;
  private readonly ttlSeconds: number;
  /** The value written into the key: unique per PROCESS, not per runner name. */
  private readonly token: string;
  private holding = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RedisChatLockOptions) {
    this.options = options;
    this.ttlSeconds = options.ttlSeconds ?? CHAT_LOCK_TTL_SECONDS;
    // A restarted pod may reuse its runner id, and a bare id would let the NEW process's
    // renewal succeed against the OLD one's key — two processes each believing they hold
    // it. The uuid is what makes the compare-and-set in `renewIfHeld` mean "mine".
    this.token = `${options.runner}:${crypto.randomUUID()}`;
  }

  /** Read synchronously, on every inbound Discord event. Never does IO. */
  held(): boolean {
    return this.holding;
  }

  /**
   * Take the lock, or renew it, or discover it belongs to someone else.
   *
   * Never throws, for `ChatLeadership.refresh`'s reason: the caller is a timer, and an
   * unreachable Redis must degrade this process to "does not act" rather than unwind
   * through a handler nobody installed.
   */
  async refresh(): Promise<void> {
    const { redis, logger, runner } = this.options;

    try {
      // Renewal first when we believe we hold it. Attempting NX would fail against our
      // OWN key and read as a loss, so the bot would step down every single tick.
      const renewed = this.holding
        ? await redis.renewIfHeld(CHAT_LOCK_KEY, this.token, this.ttlSeconds)
        : false;
      if (renewed) return;

      const taken = await redis.setIfAbsent(CHAT_LOCK_KEY, this.token, this.ttlSeconds);

      if (taken) {
        if (!this.holding) logger.info("chat.holder", { runner });
        this.holding = true;
        return;
      }

      // Losing it is worth a line; never having had it is not — the second bot pod of a
      // rollout is in that state for its whole (short) life.
      if (this.holding) logger.warn("chat.stepped-down", { runner });
      this.holding = false;
    } catch (error) {
      if (this.holding) {
        logger.warn("chat.stepped-down", {
          runner,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.holding = false;
    }
  }

  /**
   * Start renewing on a timer, and take the lock immediately.
   *
   * Awaits the first refresh so a caller can start the gateway knowing whether this
   * process is the one that acts — otherwise the first seconds after boot are a window
   * where the bot is connected and silently declining to answer.
   */
  async start(): Promise<void> {
    await this.refresh();

    const start = this.options.setInterval ?? setInterval;
    this.timer = start(() => void this.refresh(), (this.ttlSeconds / RENEW_FRACTION) * 1000);
    // Never keeps the process alive on its own. A bot whose gateway has closed should
    // exit, not linger because a renewal timer is still pending.
    this.timer.unref?.();
  }

  /**
   * Stop renewing and hand the lock back.
   *
   * Releasing on the way out is what makes a rolling update fast: without it the incoming
   * pod waits out the TTL before it can speak, and for those seconds the bot is online
   * and answers nothing. `releaseIfHeld` compares first, so a process that already lost
   * the lock cannot evict its successor on the way down.
   */
  async stop(): Promise<void> {
    const stop = this.options.clearInterval ?? clearInterval;
    if (this.timer !== undefined) stop(this.timer);
    this.timer = undefined;

    if (!this.holding) return;
    this.holding = false;
    await this.options.redis
      .releaseIfHeld(CHAT_LOCK_KEY, this.token)
      .catch(() => undefined);
  }
}
