/**
 * `/cancel`, delivered to a session that is already running.
 *
 * The problem, from `supervisor/loop.ts`: the poll loop is BLOCKED for the whole duration
 * of a session — hours, in the limit — and the inbox drain runs in that loop. A `/cancel`
 * typed while the agent is working therefore sat in the queue until the session it was
 * meant to stop had already finished, and the operator's Discord reply hung until then.
 * The existing fix is `CANCEL_POLL_MS`: a 2-second `setInterval` inside the session that
 * filters the in-process queue for a matching park. That works, and it works only because
 * the submitter and the session are the same process.
 *
 * With a standalone bot they are not, so the signal needs somewhere to cross. Two halves,
 * for the same reason the inbox has two:
 *
 *   chan `cancel:<task id>` — the fast path. A session subscribed to it learns within a
 *                             round trip, not within a poll interval.
 *   key  `cancel:<task id>` — the durable path, with a TTL. Pub/sub in Redis is
 *                             fire-and-forget: a session that subscribes a millisecond
 *                             after the publish, or that is reconnecting, would never see
 *                             it. `requested()` at a turn boundary catches those.
 *
 * The key is what makes this correct rather than merely fast, and it is also why a
 * session still checks at turn boundaries: a cancel that is only a message is a cancel
 * that a network hiccup silently discards, and the human is told `cancelling` either way.
 *
 * Clearing is the CANCELLER's job only in the sense that the key expires; the session
 * clears it when it acts on it, so a task cancelled, parked and resumed inside the TTL
 * does not immediately cancel itself again.
 */
import type { TaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { RedisClient, RedisSubscription } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

export const CANCEL_PREFIX = "cancel:";

/**
 * How long a cancel stays pending if nothing consumes it.
 *
 * Generous enough to survive a session that is mid-turn on a long tool call, short enough
 * that a cancel for a task nobody ever picked up does not ambush the session that claims
 * it tomorrow.
 */
export const CANCEL_TTL_SECONDS = 10 * 60;

export interface CancelSignals {
  /** Ask that `task` stop. Returns whether the signal was recorded anywhere. */
  request(task: TaskId): Promise<boolean>;
  /** Is a cancel pending for `task`? Consumes nothing. */
  requested(task: TaskId): Promise<boolean>;
  /** Acknowledge and clear. Called by the session that is stopping. */
  clear(task: TaskId): Promise<void>;
  /**
   * Be told the moment a cancel arrives for `task`.
   *
   * The returned handle must be closed when the session ends, or a long-lived process
   * accumulates one subscriber connection per task it has ever run.
   */
  watch(task: TaskId, onCancel: () => void): Promise<CancelWatch>;
}

export interface CancelWatch {
  close(): Promise<void>;
}

/**
 * The fallback when Redis is unconfigured.
 *
 * A set and a listener map. This is the whole mechanism for a single-replica runner, and
 * it is not weaker than the Redis one: the submitter and the session are in the same
 * process, which is precisely the situation the pre-Redis code was written for.
 */
export class InMemoryCancelSignals implements CancelSignals {
  private readonly pending = new Set<TaskId>();
  private readonly watchers = new Map<TaskId, Set<() => void>>();

  request(task: TaskId): Promise<boolean> {
    this.pending.add(task);
    // Over a copy: a watcher that closes itself on the callback would otherwise mutate
    // the set being iterated.
    for (const watcher of [...(this.watchers.get(task) ?? [])]) watcher();
    return Promise.resolve(true);
  }

  requested(task: TaskId): Promise<boolean> {
    return Promise.resolve(this.pending.has(task));
  }

  clear(task: TaskId): Promise<void> {
    this.pending.delete(task);
    return Promise.resolve();
  }

  watch(task: TaskId, onCancel: () => void): Promise<CancelWatch> {
    const watchers = this.watchers.get(task) ?? new Set<() => void>();
    watchers.add(onCancel);
    this.watchers.set(task, watchers);

    // Fire immediately for a cancel that is ALREADY pending, matching the Redis
    // implementation's post-subscribe key check. Without it the two sides of the
    // interface disagree about a session that starts just after a `/cancel` was
    // submitted, and the in-memory one is the side that runs to completion.
    if (this.pending.has(task)) onCancel();

    return Promise.resolve({
      close: (): Promise<void> => {
        watchers.delete(onCancel);
        if (watchers.size === 0) this.watchers.delete(task);
        return Promise.resolve();
      },
    });
  }
}

export interface RedisCancelSignalsOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
}

export class RedisCancelSignals implements CancelSignals {
  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly ttlSeconds: number;

  constructor(options: RedisCancelSignalsOptions) {
    this.redis = options.redis;
    this.guard = new RedisGuard({ logger: options.logger });
    this.ttlSeconds = options.ttlSeconds ?? CANCEL_TTL_SECONDS;
  }

  async request(task: TaskId): Promise<boolean> {
    // Key first, then publish — the inbox's ordering and the same argument: a subscriber
    // racing the write must not read an absent key and conclude nothing was asked.
    const stored = await this.guard.attempt("cancel.write", () =>
      this.redis.set(key(task), String(Date.now()), this.ttlSeconds),
    );
    const published = await this.guard.attempt("cancel.publish", () =>
      this.redis.publish(key(task), "cancel"),
    );
    return stored || published;
  }

  /** False on failure. "I could not reach Redis" is not "the human asked me to stop". */
  requested(task: TaskId): Promise<boolean> {
    return this.guard.run(
      "cancel.read",
      async () => (await this.redis.get(key(task))) !== undefined,
      false,
    );
  }

  async clear(task: TaskId): Promise<void> {
    await this.guard.attempt("cancel.clear", () => this.redis.del(key(task)));
  }

  /**
   * Subscribe, and check the key once immediately afterwards.
   *
   * The check is not redundant: a cancel published between the session starting and the
   * subscription being established would otherwise be delivered to nobody, and the
   * session would run to completion with a human waiting on it.
   */
  async watch(task: TaskId, onCancel: () => void): Promise<CancelWatch> {
    const subscription = await this.guard.run<RedisSubscription | undefined>(
      "cancel.subscribe",
      () => this.redis.subscribe(key(task), () => onCancel()),
      undefined,
    );

    if (await this.requested(task)) onCancel();

    return {
      close: async (): Promise<void> => {
        await subscription?.close().catch(() => undefined);
      },
    };
  }
}

const key = (task: TaskId): string => `${CANCEL_PREFIX}${task}`;
