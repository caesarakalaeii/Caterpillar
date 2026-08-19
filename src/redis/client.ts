/**
 * The narrow Redis surface the rest of the supervisor is allowed to see.
 *
 * Redis carries the EPHEMERAL cross-process plane and nothing else (DESIGN.md §21). Git
 * remains authoritative for leases, task state, the journal and the audit trail. Nothing
 * in this directory may be made load-bearing for correctness: every consumer has an
 * in-memory implementation that is chosen when Redis is unconfigured, and every
 * consumer's behaviour when a Redis call fails is "carry on as though it were
 * unconfigured".
 *
 * Why a wrapper rather than importing the driver:
 *
 *   The same reason `forge/types.ts` and `tracker/types.ts` are wrappers. The driver is
 *   the one thing in the process with a socket, a reconnect state machine and a command
 *   queue; passing it around means every test in the suite either needs a server or needs
 *   to mock a hundred-method class. `RedisClient` is nine methods, so a fake is twenty
 *   lines and the whole suite runs on a laptop with nothing listening on 6379.
 *
 * Why ioredis and not `redis`:
 *
 *   `redis` (node-redis v6) ships as five packages — client, json, bloom, search,
 *   time-series — of which we want one; ioredis is a single package with six small
 *   transitive dependencies and its own type declarations. It also does the two things
 *   this plane actually needs without extra code: an offline command queue with a
 *   bounded retry strategy, and a `Cluster`/Sentinel constructor for the HA deployment in
 *   `all-chat`. Pinned exactly, like every other dependency here (`.npmrc` sets
 *   `save-exact`).
 *
 * NOTHING here logs a value. Keys are identifiers and safe to log; payloads may quote a
 * human's Discord message, and a password never leaves `RedisConfig`.
 */
import type { Logger } from "../obs/log.ts";

/**
 * A subscription handed back by `subscribe`. Closing it is idempotent.
 *
 * Deliberately not an EventEmitter: a consumer that can only unsubscribe by remembering
 * the exact listener function it passed in is a consumer that leaks listeners on every
 * reconnect.
 */
export interface RedisSubscription {
  close(): Promise<void>;
}

/**
 * Everything the ephemeral plane asks of Redis.
 *
 * Every method is allowed to reject. Callers MUST NOT let that reach the poll loop —
 * see `guarded.ts`, which is how all of them actually reach a client.
 */
export interface RedisClient {
  get(key: string): Promise<string | undefined>;
  /** `ttlSeconds` absent means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /**
   * `SET key value NX EX ttl` — take `key` only if nobody holds it. True if taken.
   *
   * The one primitive here that is a DECISION rather than a store, and the only one whose
   * return value callers branch on. It exists for the standalone bot's leadership lock
   * (`notify/leadership.ts`): two bot processes overlapping during a rolling update must
   * not both act, and the atomicity of NX is what decides which one does.
   *
   * `renew` is the same call for a holder that already believes it holds the key: it must
   * NOT be NX, or a renewal would fail against the holder's own value, and it must check
   * the value still belongs to the caller, or a process that lost the key to an expiry
   * would take it back from whoever won it in the meantime. See `RedisChatLock`.
   */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Extend `key`'s TTL only while it still holds exactly `value`. True if extended.
   *
   * Compare-and-set, expressed as the smallest thing that can be done atomically over a
   * connection that may be shared: a GET followed by a SET would let another process take
   * the key between the two, and the loser would then overwrite the winner.
   */
  renewIfHeld(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Drop `key` only while it still holds exactly `value`. For stepping down cleanly. */
  releaseIfHeld(key: string, value: string): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Append to the right of a list, and bound it: older entries beyond `cap` are dropped. */
  rpush(key: string, value: string, cap?: number): Promise<void>;
  /** Take every element of a list and delete it, atomically. */
  drain(key: string): Promise<readonly string[]>;
  /** Members of a sorted set with a score at or above `min`, with their scores. */
  zrangeByScore(key: string, min: number): Promise<readonly RedisScored[]>;
  /** Add or update one sorted-set member, and drop members scoring below `min`. */
  zaddAndTrim(key: string, member: string, score: number, min: number): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<RedisSubscription>;
  /** Closes the connection. Safe to call twice. */
  close(): Promise<void>;
}

export interface RedisScored {
  readonly member: string;
  readonly score: number;
}

/**
 * Resolved connection details. Built by `config/load.ts` plus `secrets/load.ts`.
 *
 * `password` is present only when the secret supplied one and is never logged, never put
 * in the URL, and never re-exported.
 */
export interface RedisConnection {
  readonly url: string;
  readonly password?: string;
  /** Ceiling on ONE command, milliseconds. */
  readonly commandTimeoutMs: number;
  /** Prefix on every key this deployment writes, so two fleets can share one server. */
  readonly keyPrefix: string;
}

/** Raised when a command exceeds `commandTimeoutMs`. Carries no payload. */
export class RedisTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`redis ${operation} exceeded ${ms}ms`);
    this.name = "RedisTimeoutError";
  }
}

/**
 * Reject after `ms` rather than waiting on a socket that may never answer.
 *
 * ioredis has its own `commandTimeout`, and this is not a duplicate of it: that option
 * covers a command that has been WRITTEN, and the failure mode this plane has to survive
 * is a client stuck in reconnect with the command still in the offline queue, which that
 * timer never starts for. The two together are what makes "Redis is unreachable" a
 * bounded wait instead of a hang in the poll loop.
 */
export const withTimeout = async <T>(
  operation: string,
  ms: number,
  work: Promise<T>,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      // NOT unref'd. This timer is the only thing that will reject a command the driver
      // never settles, and an unref'd one lets the process exit with the caller's promise
      // still pending — a hang, which is the exact failure the timeout exists to prevent.
      // The `finally` below clears it, so it can never hold a finished process open.
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RedisTimeoutError(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Shortest gap between two socket-error lines about the same connection. */
const ERROR_INTERVAL_MS = 30_000;

/** Seconds, floored at 1: Redis rejects a zero or negative EX. */
const ttlTo = (ttlSeconds: number): number => Math.max(1, Math.ceil(ttlSeconds));

/**
 * Extend the TTL only if the value is still ours. 1 when extended, 0 when not.
 *
 * The check and the write have to be one operation. A holder that read "still mine" and
 * then wrote would, if the key expired in between, overwrite whichever process had taken
 * it in that gap — producing exactly the two-holders state the lock exists to prevent.
 */
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

/** Delete only if the value is still ours, so stepping down cannot evict a successor. */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface RedisClientOptions {
  readonly connection: RedisConnection;
  readonly logger: Logger;
}

/**
 * Minimal shape of the ioredis instance this module drives.
 *
 * Declared structurally rather than imported as a type so `IoRedisClient` can be
 * unit-tested against a hand-written stub, and so the driver's type surface — which is
 * enormous and full of overloads — never leaks into the rest of the codebase.
 */
export interface RedisDriver {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  /** `SET key value EX ttl NX`. Resolves to null when the key already existed. */
  set(key: string, value: string, mode: "EX", ttl: number, nx: "NX"): Promise<string | null>;
  /**
   * A Lua script, for the two compare-and-set operations a lock needs.
   *
   * `eval` rather than `defineCommand`: a script used twice at startup does not justify
   * teaching the driver a new method name, and EVAL keeps the script visible at the call
   * site instead of behind a registration that happens somewhere else.
   */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  rpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    withScores: "WITHSCORES",
  ): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  multi(): RedisDriverPipeline;
  /**
   * Only the two events this plane listens for, declared as overloads.
   *
   * A single `(...args: unknown[])` signature would not accept ioredis's own typed
   * emitter, and widening to `any` to make it fit would put the first `any` in this
   * codebase at the exact boundary that exists to keep the driver's types out.
   */
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  duplicate(): RedisDriver;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface RedisDriverPipeline {
  lrange(key: string, start: number, stop: number): RedisDriverPipeline;
  del(key: string): RedisDriverPipeline;
  exec(): Promise<readonly (readonly [Error | null, unknown])[] | null>;
}

/**
 * `RedisClient` over an ioredis connection.
 *
 * Every method wraps the driver call in `withTimeout`. Errors propagate — containment is
 * `guarded.ts`'s job, one layer up, so that the decision "degrade rather than throw" is
 * made in ONE place and is visible in the metrics of every structure at once.
 */
export class IoRedisClient implements RedisClient {
  private readonly driver: RedisDriver;
  private readonly timeoutMs: number;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly subscribers = new Set<RedisDriver>();
  private closed = false;
  /** Last time a socket error was logged, per channel. See `noteConnectionError`. */
  private readonly lastErrorAt = new Map<string, number>();

  constructor(driver: RedisDriver, connection: RedisConnection, logger: Logger) {
    this.driver = driver;
    this.timeoutMs = connection.commandTimeoutMs;
    this.prefix = connection.keyPrefix;
    this.logger = logger;

    // The driver reconnects on its own; this only makes the transition visible. Logged at
    // warn and not error: an unreachable Redis degrades the plane, it does not fail the
    // runner, and paging on it would be paging on a thing that has no correctness effect.
    driver.on("error", (error: unknown) => this.noteConnectionError("redis.connection-error", error));
  }

  /**
   * One line per `ERROR_INTERVAL_MS`, per event.
   *
   * The retry strategy backs off to five seconds, so a Redis that is down for an hour is
   * seven hundred identical lines otherwise — in the same stream an operator is reading
   * to find out what the fleet did. `RedisGuard` throttles the operation side for the
   * same reason; this is the socket side of it.
   */
  private noteConnectionError(event: string, error: unknown, channel?: string): void {
    if (this.closed) return;

    const at = Date.now();
    const last = this.lastErrorAt.get(channel ?? event);
    if (last !== undefined && at - last < ERROR_INTERVAL_MS) return;
    this.lastErrorAt.set(channel ?? event, at);

    this.logger.warn(event, {
      ...(channel === undefined ? {} : { channel }),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  private run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return withTimeout(operation, this.timeoutMs, work());
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.run("get", () => this.driver.get(this.key(key)));
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.run("set", () =>
      ttlSeconds === undefined
        ? this.driver.set(this.key(key), value)
        : // Seconds, not milliseconds: every TTL in this plane is a heartbeat or a reply
          // window, and second granularity keeps the value readable in `redis-cli ttl`.
          this.driver.set(this.key(key), value, "EX", Math.max(1, Math.ceil(ttlSeconds))),
    );
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const reply = await this.run("setnx", () =>
      this.driver.set(this.key(key), value, "EX", ttlTo(ttlSeconds), "NX"),
    );
    // Redis answers OK or nil, never an error, when NX loses. Nil IS the answer "somebody
    // else holds it", so it must not be treated as a failed command.
    return reply !== null && reply !== undefined;
  }

  async renewIfHeld(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const reply = await this.run("renew", () =>
      this.driver.eval(RENEW_SCRIPT, 1, this.key(key), value, String(ttlTo(ttlSeconds))),
    );
    return reply === 1;
  }

  async releaseIfHeld(key: string, value: string): Promise<boolean> {
    const reply = await this.run("release", () =>
      this.driver.eval(RELEASE_SCRIPT, 1, this.key(key), value),
    );
    return reply === 1;
  }

  async del(key: string): Promise<void> {
    await this.run("del", () => this.driver.del(this.key(key)));
  }

  async rpush(key: string, value: string, cap?: number): Promise<void> {
    const full = this.key(key);
    await this.run("rpush", async () => {
      await this.driver.rpush(full, value);
      // Bounded on purpose. A submitter that crashes between pushing an intent and
      // reading its reply leaves the intent behind; without a cap a bridge in a crash
      // loop grows this list until the server's maxmemory policy starts evicting keys
      // that other structures depend on.
      if (cap !== undefined) await this.driver.ltrim(full, -cap, -1);
    });
  }

  async drain(key: string): Promise<readonly string[]> {
    const full = this.key(key);
    // MULTI, so a second drainer cannot read the same entries between the range and the
    // delete. Two supervisors draining one inbox is not the arrangement we intend, but a
    // rollout has two pods alive at once and the overlap is exactly when it would happen.
    const replies = await this.run("drain", () =>
      this.driver.multi().lrange(full, 0, -1).del(full).exec(),
    );
    if (replies === null) return [];

    const first = replies[0];
    if (first === undefined) return [];
    const [error, value] = first;
    if (error !== null) throw error;
    return Array.isArray(value) ? (value as string[]) : [];
  }

  async zrangeByScore(key: string, min: number): Promise<readonly RedisScored[]> {
    // `-Infinity` would reach the server as the literal "-Infinity", which it rejects.
    // Callers legitimately ask for "everything" — presence sweeps do — so it is
    // translated here rather than made every caller's problem.
    const floor = Number.isFinite(min) ? min : min < 0 ? "-inf" : "+inf";
    const flat = await this.run("zrangebyscore", () =>
      this.driver.zrangebyscore(this.key(key), floor, "+inf", "WITHSCORES"),
    );
    const scored: RedisScored[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      const member = flat[index];
      const score = Number(flat[index + 1]);
      if (member === undefined || !Number.isFinite(score)) continue;
      scored.push({ member, score });
    }
    return scored;
  }

  async zaddAndTrim(key: string, member: string, score: number, min: number): Promise<void> {
    const full = this.key(key);
    await this.run("zadd", async () => {
      await this.driver.zadd(full, score, member);
      if (!Number.isFinite(min)) return;
      // Expiry is swept here rather than left to a TTL: a sorted set has one TTL for the
      // whole key, and each member needs its own. Sweeping on write costs nothing and
      // means a runner that died never lingers past one heartbeat window.
      await this.driver.zremrangebyscore(full, "-inf", `(${min}`);
    });
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.run("zrem", () => this.driver.zrem(this.key(key), member));
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.run("publish", () => this.driver.publish(this.key(channel), message));
  }

  /**
   * Subscribe on a DEDICATED connection.
   *
   * Redis puts a connection in subscriber mode: once subscribed it will refuse ordinary
   * commands on that socket. Sharing one would mean the first `/cancel` subscription
   * silently broke every `get` the snapshot cache makes.
   */
  async subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<RedisSubscription> {
    const full = this.key(channel);
    const sub = this.driver.duplicate();
    this.subscribers.add(sub);

    sub.on("error", (error: unknown) =>
      this.noteConnectionError("redis.subscriber-error", error, full),
    );
    sub.on("message", (received: string, message: string) => {
      if (received === full) onMessage(message);
    });

    try {
      await withTimeout("subscribe", this.timeoutMs, sub.subscribe(full) as Promise<unknown>);
    } catch (error) {
      this.subscribers.delete(sub);
      sub.disconnect();
      throw error;
    }

    let closed = false;
    return {
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        this.subscribers.delete(sub);
        // `disconnect` unconditionally after the polite path: an unsubscribe that hangs
        // because the socket is already gone must not keep the process alive at shutdown.
        await withTimeout("unsubscribe", this.timeoutMs, sub.unsubscribe(full) as Promise<unknown>)
          .catch(() => undefined)
          .finally(() => sub.disconnect());
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers) sub.disconnect();
    this.subscribers.clear();
    // `quit` waits for the server to acknowledge, which it cannot do when the server is
    // the thing that is down — so the wait is bounded and the socket is torn down either
    // way. Shutdown must not be the path that hangs.
    await withTimeout("quit", this.timeoutMs, this.driver.quit() as Promise<unknown>)
      .catch(() => undefined)
      .finally(() => this.driver.disconnect());
  }
}
