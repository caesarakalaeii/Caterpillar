/**
 * Building the ephemeral plane, with or without a server. See DESIGN.md §21.
 *
 * One decision, made once, at boot: is `redis.enabled` set? If it is, the five structures
 * are the Redis ones; if it is not, they are the in-process classes that were there
 * before this directory existed. Everything downstream takes the interfaces and cannot
 * tell which it got — which is the property that keeps the whole test suite runnable with
 * nothing listening on 6379, and keeps a single-replica runner byte-for-byte what it was.
 *
 * Note what this factory does NOT do: it never fails the boot. A Redis that is
 * unreachable at startup produces a client that keeps retrying and a plane whose every
 * operation degrades through `RedisGuard` — the same state a Redis that dies at 3am
 * produces. Refusing to start would make the ephemeral plane a startup dependency of the
 * authoritative one, and the authoritative one is git.
 */
// Named import, not default: ioredis is CommonJS and its type declarations expose `Redis`
// as a named export, so a default import fails under NodeNext without esModuleInterop.
import { Redis } from "ioredis";
import type { Logger } from "../obs/log.ts";
import type { RedisConfig } from "../config/types.ts";
import { SecretBundle } from "../secrets/load.ts";
import { ChatInbox } from "../supervisor/inbox.ts";
import { TaskSnapshot } from "../supervisor/snapshot.ts";
import {
  IoRedisClient,
  type RedisClient,
  type RedisConnection,
  type RedisDriver,
} from "./client.ts";
import { InMemoryCancelSignals, RedisCancelSignals, type CancelSignals } from "./cancel.ts";
import {
  InMemorySteeringInbox,
  RedisSteeringInbox,
  type SteeringInbox,
} from "./steering.ts";
import { InMemoryChatQueue, RedisChatQueue, type ChatQueue } from "./inbox.ts";
import {
  InMemoryPresenceRegistry,
  RedisPresenceRegistry,
  type PresenceRegistry,
} from "./presence.ts";
import {
  InMemorySnapshotStore,
  RedisSnapshotStore,
  type SnapshotStore,
} from "./snapshot.ts";
import {
  InMemoryThreadBindings,
  RedisThreadBindings,
  type ThreadBindingStore,
} from "./threads.ts";

/**
 * The five ephemeral structures, plus the raw in-process objects behind them.
 *
 * `inbox` and `snapshot` are the concrete `ChatInbox`/`TaskSnapshot` and are present ONLY
 * in the unconfigured case. The supervisor still wants them there: `takeWhere` and `some`
 * have no Redis equivalent (see `inbox.ts`), and keeping the concrete object reachable is
 * what makes the no-Redis path identical to the one that predates this directory rather
 * than a re-implementation of it.
 */
export interface EphemeralPlane {
  readonly chat: ChatQueue;
  readonly snapshot: SnapshotStore;
  /**
   * Named `runners` and not `presence`: the supervisor already has a `presence`, and it is
   * the Discord typing indicator. Two fields with one name in the same deps object is how
   * one silently shadows the other.
   */
  readonly runners: PresenceRegistry;
  readonly cancels: CancelSignals;
  /**
   * A human's guidance, reaching a session that is already running (DESIGN.md §7.3).
   *
   * `cancels`' counterpart and the sixth structure, here for the same reason: a message typed
   * at the standalone bot has a process boundary to cross before it can reach a live session,
   * and its loss is a degraded conversation rather than a lost task — which is the line §21
   * draws for what may live here at all.
   */
  readonly steering: SteeringInbox;
  /**
   * Thread ↔ task, published by the supervisor and consumed by the standalone bot (§14.3).
   *
   * The fifth structure, and the only one that exists solely because the bot was split
   * out: in one process the `ThreadIndex` is rebuilt from the state repo at boot, and a
   * process with no state repo has nothing to rebuild it from.
   */
  readonly threads: ThreadBindingStore;
  /** True when a Redis client is behind the structures above. For logs and the web view. */
  readonly backed: boolean;
  /**
   * The client itself, present only when `backed`.
   *
   * Deliberately the LAST resort and not a general escape hatch. It exists for the
   * standalone bot's chat lock (`notify/leadership.ts`), which needs the compare-and-swap
   * trio — those are properties of the connection rather than of any structure, so there
   * is no structure to put them behind. Anything that fits one of the five above must use
   * that instead: reaching for a raw client is how the narrow interface stops being
   * narrow, and with it goes the property that the whole suite runs with nothing on 6379.
   */
  readonly client?: RedisClient;
  /** Present only when NOT `backed` — there is no Redis equivalent to hand back. */
  readonly inbox?: ChatInbox;
  readonly tasks?: TaskSnapshot;
  close(): Promise<void>;
}

export interface EphemeralPlaneOptions {
  readonly config: RedisConfig;
  readonly secretsDir: string;
  readonly logger: Logger;
  /**
   * Injected client, for tests and for the standalone bot, which builds its own.
   *
   * When present the config's `enabled` is still honoured — a test proving the
   * unconfigured fallback must be able to pass a client and watch it go unused.
   */
  readonly client?: RedisClient;
}

/** The plane every runner had before Redis: in-process objects, no IO. */
export const inMemoryPlane = (): EphemeralPlane => {
  const inbox = new ChatInbox();
  const tasks = new TaskSnapshot();
  return {
    chat: new InMemoryChatQueue(inbox),
    snapshot: new InMemorySnapshotStore(tasks),
    runners: new InMemoryPresenceRegistry(),
    cancels: new InMemoryCancelSignals(),
    steering: new InMemorySteeringInbox(),
    threads: new InMemoryThreadBindings(),
    backed: false,
    inbox,
    tasks,
    close: (): Promise<void> => Promise.resolve(),
  };
};

/** The plane over a client that is already built. Used by `createEphemeralPlane`. */
export const redisPlane = (redis: RedisClient, logger: Logger): EphemeralPlane => ({
  chat: new RedisChatQueue({ redis, logger }),
  snapshot: new RedisSnapshotStore({ redis, logger }),
  runners: new RedisPresenceRegistry({ redis, logger }),
  cancels: new RedisCancelSignals({ redis, logger }),
  steering: new RedisSteeringInbox({ redis, logger }),
  threads: new RedisThreadBindings({ redis, logger }),
  backed: true,
  client: redis,
  close: (): Promise<void> => redis.close(),
});

/**
 * Build the plane this runner's configuration asks for.
 *
 * Async only because reading the password is: the connection itself is established lazily
 * by the driver, so this returns before anything has been dialled and a Redis that is
 * down costs the boot nothing.
 */
export const createEphemeralPlane = async (
  options: EphemeralPlaneOptions,
): Promise<EphemeralPlane> => {
  const { config, logger } = options;

  if (!config.enabled) {
    logger.info("redis.disabled", { reason: "redis.enabled is false" });
    return inMemoryPlane();
  }

  if (options.client !== undefined) {
    logger.info("redis.enabled", { transport: "injected" });
    return redisPlane(options.client, logger);
  }

  const password = await readPassword(config, options.secretsDir, logger);
  const connection: RedisConnection = {
    url: config.url,
    ...(password === undefined ? {} : { password }),
    commandTimeoutMs: config.commandTimeoutMs,
    keyPrefix: config.keyPrefix,
  };

  // The URL and the prefix are identifiers and safe to log; the password is not mentioned
  // at all, not even as present-or-absent-with-a-length.
  logger.info("redis.enabled", { url: config.url, keyPrefix: config.keyPrefix });

  return redisPlane(new IoRedisClient(createDriver(connection), connection, logger), logger);
};

/**
 * Read `password` from the mounted secret, or nothing.
 *
 * `readOptional`, so a Redis with no AUTH is a supported deployment rather than a boot
 * failure — and the read is guarded, because a `secretRef` naming a directory that has
 * not been mounted yet must degrade to "no password" and let the connection fail
 * honestly, not take the supervisor down before it has claimed anything.
 */
const readPassword = async (
  config: RedisConfig,
  secretsDir: string,
  logger: Logger,
): Promise<string | undefined> => {
  if (config.secretRef === undefined) return undefined;

  const bundle = new SecretBundle(secretsDir, config.secretRef);
  const password = await bundle.readOptional("password").catch(() => undefined);
  // The KEY is named, never the value — `secrets/load.ts`'s rule.
  if (password === undefined) {
    logger.warn("redis.no-password", { secretRef: config.secretRef, key: "password" });
  }
  return password;
};

/**
 * The ioredis instance, configured for a plane that must degrade rather than block.
 *
 * The offline queue is left ON, and that is a deliberate reversal of the obvious choice.
 * Turning it off makes a command issued while disconnected reject immediately, which
 * sounds exactly like the containment this plane wants — but "disconnected" includes the
 * first few milliseconds of the process's life, before the initial handshake completes.
 * With it off, every command the supervisor's FIRST poll issues fails with "Stream isn't
 * writeable", so a perfectly healthy Redis looks unreachable until something happens to
 * retry. Observed, not theorised: it is what the live contract run against a real server
 * caught, and nothing in the in-memory suite could have.
 *
 * Leaving it on would ordinarily reintroduce the failure `supervisor/loop.ts:~287` is
 * written against — a hanging call in the poll loop — except that `withTimeout` in
 * `client.ts` bounds EVERY operation independently of the driver. So a command queued
 * against a Redis that is genuinely down waits `commandTimeoutMs` and then degrades
 * through `RedisGuard`, which is the behaviour we wanted from the flag and did not get.
 */
export const createDriver = (connection: RedisConnection): RedisDriver => {
  // The return type is the assertion. ioredis's own instance satisfies `RedisDriver`
  // structurally, so there is NO cast here on purpose: a driver upgrade that renames or
  // re-signs one of the nine methods fails `npm run check` rather than at 3am in the
  // cluster, which is the whole reason the interface is declared structurally.
  const client = new Redis(connection.url, {
    ...(connection.password === undefined ? {} : { password: connection.password }),
    enableOfflineQueue: true,
    // A second timer inside the driver, covering a command that HAS been written and is
    // waiting on a server that accepted the socket and then stopped answering.
    // `withTimeout` in `client.ts` covers the rest; see its docstring for why both.
    commandTimeout: connection.commandTimeoutMs,
    connectTimeout: connection.commandTimeoutMs,
    // Capped backoff. Unbounded retries with a growing delay would eventually mean a
    // Redis that came back an hour ago is still not being talked to.
    retryStrategy: (attempt: number): number => Math.min(attempt * 200, 5000),
    // The driver reconnects forever at that interval rather than giving up: this plane is
    // optional, so there is no state in which "stop trying" is better than "keep trying
    // cheaply while everything degrades".
    //
    // `maxRetriesPerRequest` bounds how long ONE command sits in the offline queue before
    // the driver gives up on it. 1 rather than 0: zero means "do not queue at all", which
    // is the flag above under another name and brings back the cold-start failure.
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  return client;
};
