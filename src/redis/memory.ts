/**
 * `RedisClient` with nothing behind it but this process's heap.
 *
 * Two jobs, and they are the same job:
 *
 *   1. It is what the contract tests run against, so the shared contract in
 *      `contract.test.ts` can be executed with no server listening anywhere. That is what
 *      keeps `npm test` green on a laptop.
 *   2. It is NOT the fallback path. When Redis is unconfigured the four structures use
 *      their own in-process implementations (`InMemoryChatInbox` and friends), which are
 *      the classes that were there before Redis existed. Going through this client
 *      instead would mean serialising every intent to JSON and back for no reason, and it
 *      would quietly change the identity semantics the inbox relies on.
 *
 * Expiry is evaluated LAZILY, on read. A timer per key would keep the event loop alive,
 * and `presence entries expire` is a test that wants to advance a clock rather than sleep.
 */
import type { RedisClient, RedisScored, RedisSubscription } from "./client.ts";

interface Entry {
  readonly value: string;
  /** Epoch millis, or undefined for no expiry. */
  readonly expiresAt?: number;
}

export interface MemoryRedisOptions {
  /** Injectable so a test can expire a key without sleeping. */
  readonly now?: () => number;
}

export class MemoryRedisClient implements RedisClient {
  private readonly strings = new Map<string, Entry>();
  private readonly lists = new Map<string, string[]>();
  private readonly sorted = new Map<string, Map<string, number>>();
  private readonly channels = new Map<string, Set<(message: string) => void>>();
  private readonly now: () => number;

  constructor(options: MemoryRedisOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private live(key: string): Entry | undefined {
    const entry = this.strings.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.live(key)?.value);
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.strings.set(key, {
      value,
      ...(ttlSeconds === undefined
        ? {}
        : { expiresAt: this.now() + Math.max(1, Math.ceil(ttlSeconds)) * 1000 }),
    });
    return Promise.resolve();
  }

  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    // Through `live`, so a key whose TTL has passed is takeable. Expiry here is lazy (see
    // the module docstring), and a lock that could not be taken after its holder's TTL
    // elapsed would be a lock that jams the first time a bot pod is killed.
    if (this.live(key) !== undefined) return Promise.resolve(false);
    void this.set(key, value, ttlSeconds);
    return Promise.resolve(true);
  }

  renewIfHeld(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)?.value !== value) return Promise.resolve(false);
    void this.set(key, value, ttlSeconds);
    return Promise.resolve(true);
  }

  releaseIfHeld(key: string, value: string): Promise<boolean> {
    if (this.live(key)?.value !== value) return Promise.resolve(false);
    this.strings.delete(key);
    return Promise.resolve(true);
  }

  del(key: string): Promise<void> {
    this.strings.delete(key);
    this.lists.delete(key);
    this.sorted.delete(key);
    return Promise.resolve();
  }

  rpush(key: string, value: string, cap?: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    if (cap !== undefined && list.length > cap) list.splice(0, list.length - cap);
    this.lists.set(key, list);
    return Promise.resolve();
  }

  drain(key: string): Promise<readonly string[]> {
    const list = this.lists.get(key) ?? [];
    this.lists.delete(key);
    return Promise.resolve(list);
  }

  zrangeByScore(key: string, min: number): Promise<readonly RedisScored[]> {
    const set = this.sorted.get(key);
    if (set === undefined) return Promise.resolve([]);
    const scored: RedisScored[] = [];
    for (const [member, score] of set) if (score >= min) scored.push({ member, score });
    scored.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    return Promise.resolve(scored);
  }

  zaddAndTrim(key: string, member: string, score: number, min: number): Promise<void> {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    set.set(member, score);
    for (const [existing, existingScore] of set) if (existingScore < min) set.delete(existing);
    this.sorted.set(key, set);
    return Promise.resolve();
  }

  zrem(key: string, member: string): Promise<void> {
    this.sorted.get(key)?.delete(member);
    return Promise.resolve();
  }

  publish(channel: string, message: string): Promise<void> {
    // Synchronously, and over a COPY of the listener set: a listener that unsubscribes
    // itself on the message it just received would otherwise mutate the set being walked.
    for (const listener of [...(this.channels.get(channel) ?? [])]) listener(message);
    return Promise.resolve();
  }

  subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<RedisSubscription> {
    const listeners = this.channels.get(channel) ?? new Set<(message: string) => void>();
    listeners.add(onMessage);
    this.channels.set(channel, listeners);

    return Promise.resolve({
      close: (): Promise<void> => {
        listeners.delete(onMessage);
        if (listeners.size === 0) this.channels.delete(channel);
        return Promise.resolve();
      },
    });
  }

  close(): Promise<void> {
    this.strings.clear();
    this.lists.clear();
    this.sorted.clear();
    this.channels.clear();
    return Promise.resolve();
  }
}

/**
 * A client whose every call rejects. For proving that a consumer degrades.
 *
 * Its own class rather than a `sinon`-style stub because the property being tested — "a
 * Redis error must not reach the poll loop" — is worth asserting against something that
 * cannot accidentally succeed.
 */
export class FailingRedisClient implements RedisClient {
  private readonly error: () => Error;

  constructor(message = "redis is unreachable") {
    this.error = (): Error => new Error(message);
  }

  get(): Promise<string | undefined> {
    return Promise.reject(this.error());
  }

  set(): Promise<void> {
    return Promise.reject(this.error());
  }

  setIfAbsent(): Promise<boolean> {
    return Promise.reject(this.error());
  }

  renewIfHeld(): Promise<boolean> {
    return Promise.reject(this.error());
  }

  releaseIfHeld(): Promise<boolean> {
    return Promise.reject(this.error());
  }

  del(): Promise<void> {
    return Promise.reject(this.error());
  }

  rpush(): Promise<void> {
    return Promise.reject(this.error());
  }

  drain(): Promise<readonly string[]> {
    return Promise.reject(this.error());
  }

  zrangeByScore(): Promise<readonly RedisScored[]> {
    return Promise.reject(this.error());
  }

  zaddAndTrim(): Promise<void> {
    return Promise.reject(this.error());
  }

  zrem(): Promise<void> {
    return Promise.reject(this.error());
  }

  publish(): Promise<void> {
    return Promise.reject(this.error());
  }

  subscribe(): Promise<RedisSubscription> {
    return Promise.reject(this.error());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
