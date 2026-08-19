/**
 * A human's message, delivered to a session that is already running. See DESIGN.md §7.3.
 *
 * The same problem `cancel.ts` solves and very nearly the same shape, for the same reason:
 * the bot may be a different pod from the supervisor (§21), so a message typed in a thread
 * has a process boundary to cross before it can reach a live pi session. Two halves again:
 *
 *   chan `steer:<task id>` — the fast path. A subscribed session learns within a round
 *                            trip rather than within a poll interval, which is the whole
 *                            point: steering that arrives after the turn it was about is
 *                            advice on work already done.
 *   list `steer:<task id>` — the durable path. Redis pub/sub is fire-and-forget, so a
 *                            session that subscribes a millisecond after the publish, or
 *                            that is reconnecting, would never see the message. Draining
 *                            the list on subscribe catches those.
 *
 * A LIST rather than a key, and that is the one real difference from a cancel. A cancel is
 * idempotent — the second one says nothing the first did not — so a single key with a
 * timestamp is a complete record of it. Guidance is not: "use the existing migration path"
 * and "and skip the second wave" are two different sentences and losing either is losing
 * half of what a human said. Refining an idea is many short replies (§14.3), so this is the
 * ordinary case rather than the edge one.
 *
 * The list is drained by the SESSION and by nobody else. A steer that is read is gone, which
 * is what stops a task that hands off five times being told the same thing five times; a
 * steer that is never read expires, which is what stops one written today ambushing the
 * session that claims the task next week.
 */
import type { TaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { RedisClient, RedisSubscription } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

export const STEER_PREFIX = "steer:";

/**
 * How long unread guidance waits.
 *
 * Longer than a cancel's ten minutes, because the two are answers to different questions. A
 * cancel is about a session that is running NOW and is meaningless once it has ended. A
 * steer is about the TASK: a session that hands off, parks for a question, or is cut off by
 * the wall clock leaves guidance that its successor should still act on, and that successor
 * may be an hour away. Short of a working day, so nothing survives an overnight gap and
 * arrives as a surprise.
 */
export const STEER_TTL_SECONDS = 4 * 60 * 60;

/**
 * How many unread messages one task holds.
 *
 * A ceiling on a human typing, so it is generous. It exists at all for the reason every
 * other list here has one: an unattended process that pushes in a loop must not be able to
 * grow a key until the server's `maxmemory` policy starts evicting structures that other
 * things depend on. The OLDEST are dropped, because the newest sentence is the one that
 * reflects what the human currently wants.
 */
export const STEER_CAP = 50;

export interface SteeringInbox {
  /**
   * Whether this implementation can reach a session in ANOTHER process.
   *
   * Declared rather than inferred, for `ChatDrainer.selective`'s reason (§21): a structure that
   * answers "recorded" to a question it cannot actually serve is indistinguishable from one
   * that served it, and the caller is the only place that can decide what to do about the
   * difference. `applyGuidance` reads it to tell a human "I could not reach the runner working
   * it" instead of "sent to the session" for a task running on a machine this heap cannot
   * touch — which two runners sharing a state repo with no Redis is a real arrangement of
   * (README, *passing work between machines*).
   *
   * The in-memory implementation is not weaker for saying false. It is the whole mechanism for
   * a session in THIS process, which is where `applyGuidance` reaches it directly.
   */
  readonly crossesProcesses: boolean;
  /** Send `text` to whoever is working `task`. Returns whether it was recorded anywhere. */
  push(task: TaskId, text: string): Promise<boolean>;
  /** Take everything queued for `task`. Consuming: a steer read once is not read again. */
  drain(task: TaskId): Promise<readonly string[]>;
  /**
   * Be told the moment a steer arrives for `task`, with everything already queued.
   *
   * `onSteer` is called once per message. The handle must be closed when the slot closes,
   * or a long-lived process accumulates one subscriber connection per task it has worked.
   */
  watch(task: TaskId, onSteer: (text: string) => void): Promise<SteerWatch>;
}

export interface SteerWatch {
  close(): Promise<void>;
}

/**
 * The fallback when Redis is unconfigured.
 *
 * Not weaker than the Redis one, for `cancel.ts`'s reason: with no Redis there is one
 * process, so the human's message and the session it steers are already in the same heap.
 */
export class InMemorySteeringInbox implements SteeringInbox {
  readonly crossesProcesses = false;

  private readonly pending = new Map<TaskId, string[]>();
  private readonly watchers = new Map<TaskId, Set<(text: string) => void>>();

  push(task: TaskId, text: string): Promise<boolean> {
    const watchers = [...(this.watchers.get(task) ?? [])];
    if (watchers.length === 0) {
      const queue = this.pending.get(task) ?? [];
      queue.push(text);
      if (queue.length > STEER_CAP) queue.splice(0, queue.length - STEER_CAP);
      this.pending.set(task, queue);
      return Promise.resolve(true);
    }
    // Over a copy: a watcher that closes itself in the callback would otherwise mutate the
    // set being iterated.
    for (const watcher of watchers) watcher(text);
    return Promise.resolve(true);
  }

  drain(task: TaskId): Promise<readonly string[]> {
    const queue = this.pending.get(task) ?? [];
    this.pending.delete(task);
    return Promise.resolve(queue);
  }

  watch(task: TaskId, onSteer: (text: string) => void): Promise<SteerWatch> {
    const watchers = this.watchers.get(task) ?? new Set<(text: string) => void>();
    watchers.add(onSteer);
    this.watchers.set(task, watchers);

    // Everything already queued, immediately — matching the Redis implementation's
    // post-subscribe drain. Without it the two sides disagree about a session that starts
    // just after a human typed, and the in-memory one is the side that ignores them.
    for (const text of this.pending.get(task) ?? []) onSteer(text);
    this.pending.delete(task);

    return Promise.resolve({
      close: (): Promise<void> => {
        watchers.delete(onSteer);
        if (watchers.size === 0) this.watchers.delete(task);
        return Promise.resolve();
      },
    });
  }
}

export interface RedisSteeringInboxOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
}

export class RedisSteeringInbox implements SteeringInbox {
  readonly crossesProcesses = true;

  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly ttlSeconds: number;

  constructor(options: RedisSteeringInboxOptions) {
    this.redis = options.redis;
    this.guard = new RedisGuard({ logger: options.logger });
    this.ttlSeconds = options.ttlSeconds ?? STEER_TTL_SECONDS;
  }

  /**
   * List first, then publish — the inbox's ordering and the same argument: a subscriber
   * racing the write must not be woken, drain an empty list, and conclude nothing was said.
   */
  async push(task: TaskId, text: string): Promise<boolean> {
    const stored = await this.guard.attempt("steer.write", () =>
      this.redis.rpush(key(task), text, STEER_CAP, this.ttlSeconds),
    );
    // Only the wake-up. The message itself travels in the list, so a publish that is
    // delivered twice — a reconnect, two subscribers — costs a wasted drain rather than a
    // duplicated sentence in the agent's context.
    const published = await this.guard.attempt("steer.publish", () =>
      this.redis.publish(key(task), "steer"),
    );
    return stored || published;
  }

  /** Empty on failure. "I could not reach Redis" is not "the human said nothing". */
  drain(task: TaskId): Promise<readonly string[]> {
    return this.guard.run<readonly string[]>("steer.drain", () => this.redis.drain(key(task)), []);
  }

  async watch(task: TaskId, onSteer: (text: string) => void): Promise<SteerWatch> {
    // The drain is inside the subscription callback rather than the publish carrying the
    // text, so the two paths cannot disagree about what was said: the list is the record and
    // the channel only says "look at it".
    const deliver = (): void => {
      void this.drain(task)
        .then((messages) => {
          for (const text of messages) onSteer(text);
        })
        .catch(() => undefined);
    };

    const subscription = await this.guard.run<RedisSubscription | undefined>(
      "steer.subscribe",
      () => this.redis.subscribe(key(task), () => deliver()),
      undefined,
    );

    // Once immediately afterwards, for anything published in the gap between this session
    // starting and the subscription being established.
    deliver();

    return {
      close: async (): Promise<void> => {
        await subscription?.close().catch(() => undefined);
      },
    };
  }
}

const key = (task: TaskId): string => `${STEER_PREFIX}${task}`;
