/**
 * The Discord bot, as its own process. See DESIGN.md §7 and §10.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 *  THIS PROCESS TOUCHES NO STATE REPO AND HOLDS NO FORGE OR LLM CREDENTIAL.
 *
 *  That separation is most of the value of splitting it out. Nothing in this file
 *  constructs a `StateStore`, a `LeaseManager`, a `Git`, a `WorktreeManager`, a forge or
 *  tracker factory, or the credential service — and `bot.test.ts` asserts it, because a
 *  property nobody checks is a property that lasts until the next refactor.
 *
 *  It is enforced by two things rather than one, and the second is what actually holds:
 *  this file never calls them, AND the bot's Deployment mounts neither the forge secret
 *  nor the LLM credential nor the work PVC. A few of those modules are still REACHABLE in
 *  the import graph, because `config/load.ts` reads default constants out of them and
 *  `SecretBundle` shares a module with the forge loaders — reachable is not the same as
 *  used, and the credential they would want is not on the filesystem to be read.
 *
 *  Anything that must touch the state repo goes to the supervisor as an intent on the
 *  Redis inbox and comes back as a `ChatOutcome`; anything that only needs to be READ is
 *  answered from the Redis snapshot. If a future change needs one of those constructors
 *  here, that is the signal that it belongs on the other side of the inbox instead.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * WHY IT IS SPLIT. Not for duplicate claims — those were already solved by the CAS in
 * `notify/leadership.ts`, which is why four supervisors produced one acting bot. The
 * broken thing was LIVENESS. Leadership was refreshed from the supervisor's loop and
 * `applyChatRequests` only drained between tasks, so a replica in the middle of a
 * four-hour session could neither renew nor step down, and the inbox went undrained for
 * the length of the session. The bot was online and answered nothing. Here that cannot
 * happen structurally: this process has no sessions to block on, so its liveness stops
 * depending on any runner's.
 *
 * WHAT IT OWNS. The gateway (`notify/gateway.ts`), the bot's REST half
 * (`notify/bot.ts`), the bridge (`notify/bridge.ts`) and the thread index
 * (`notify/threads.ts`). Slash commands are NOT registered here, and the reason is now
 * the split itself rather than the old "registration is a deploy-time step": §7.1 makes
 * the supervisor publish the set once per change across the fleet, claimed on a git ref
 * keyed by the commands' digest (`notify/register.ts`). That claim is a push to the state
 * repo with the forge credential — exactly what this process is defined not to hold. So
 * registration stays on the supervisor side, which still runs it when `bot.mode` is
 * external because it is an OUTBOUND write like the notification and the typing
 * indicator; only READING the channel moved here. `npm run discord:register` remains the
 * manual escape hatch.
 *
 * WHAT IT NEEDS. Redis, and the Discord secret. Redis is not optional for this process
 * the way it is for a supervisor: it IS the connection to the supervisor, so a bot with
 * no Redis configured has nowhere to send a `/resume` and nothing to answer `/tasks`
 * from. That is a misconfiguration and this refuses to start on it, rather than coming
 * up and failing every command individually.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { botModeMismatched } from "./config/bot.ts";
import { loadConfig } from "./config/load.ts";
import type { RunnerConfig } from "./config/types.ts";
import { asRunnerId } from "./domain/task.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { DiscordBot } from "./notify/bot.ts";
import { DiscordBridge } from "./notify/bridge.ts";
import { DiscordGateway } from "./notify/gateway.ts";
import { RedisChatLock } from "./notify/leadership.ts";
import { ThreadIndex, ThreadRouter } from "./notify/threads.ts";
import { errorFields, JsonLogger, type Logger } from "./obs/log.ts";
import type { RedisClient } from "./redis/client.ts";
import { createEphemeralPlane, type EphemeralPlane } from "./redis/plane.ts";
import { THREADS_KEY, type ThreadBindingReader } from "./redis/threads.ts";
import { SecretBundle } from "./secrets/load.ts";

const CONFIG_PATH = process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config.json";

/**
 * How often the published thread↔task bindings are pulled in.
 *
 * Faster than the supervisor's housekeeping publishes them, so the index is at most one
 * publish behind, and cheap: one Redis GET against a key the store also caches. A human
 * typing in a brand-new brainstorm thread is the case this interval is chosen for — the
 * bot binds that thread locally the moment it creates it, so this only has to catch
 * threads created by some OTHER process.
 */
const THREAD_REFRESH_MS = 5_000;

const main = async (): Promise<void> => {
  const config = await loadConfig(CONFIG_PATH);
  const logger = new JsonLogger({ level: config.log.level });

  logger.info("bot.starting", { runner: config.runnerId, mode: config.bot.mode });

  // The mirror of `externalBot`'s interlock, from this side of the split. That function
  // makes the supervisor keep the gateway unless the config says a separate process owns
  // it; running this binary anyway means BOTH processes hold it. Nothing downstream
  // catches that, because the two arbitrate by different mechanisms — the supervisor by
  // the git CAS in `notify/leadership.ts`, this process by a Redis TTL lock — so each is
  // alone in its own scheme and both act, double-answering every command.
  //
  // A warning rather than a refusal, matching `bot.mode-ignored`: the operator who starts
  // this binary means to run a bot, and the duplicate is visible and recoverable, whereas
  // exiting here during a config rollout would take the bot down entirely. What matters is
  // that the misconfiguration is diagnosable from EITHER half rather than only from the
  // supervisor's log, which is where the asymmetry used to hide it.
  if (botModeMismatched(config)) {
    logger.warn("bot.mode-mismatch", {
      mode: config.bot.mode,
      reason:
        'the standalone bot is running but bot.mode is not "external", so the supervisor ' +
        "keeps the Discord gateway too — both processes will answer every command",
    });
  }

  // Refused rather than degraded. Redis is how this process reaches the supervisor at
  // all: without it `/tasks` has no snapshot to read and `/resume` has no inbox to go to,
  // so every command would fail individually while `/healthz` said 200 — the shape of
  // failure `supervisor/loop.ts:~287` exists to rule out.
  if (!config.redis.enabled) {
    throw new Error(
      "the standalone bot requires redis.enabled: it is the only path to the supervisor, " +
        "and without it no command can be served. Run the bot in-process instead " +
        '(bot.mode: "in-process") if you have no Redis.',
    );
  }

  const bot = await loadBot(config, logger);
  const plane = await createEphemeralPlane({
    config: config.redis,
    secretsDir: config.secretsDir,
    logger,
  });

  const metrics = new AgentMetrics();

  // One process, one lock — see `notify/leadership.ts` for why this is a Redis TTL lock
  // and not the git CAS the supervisor uses. The deployment runs ONE replica; this covers
  // the seconds of a rolling update when two of them overlap.
  const lock = new RedisChatLock({
    redis: redisOf(plane),
    runner: asRunnerId(config.runnerId),
    logger,
  });

  const threads = new ThreadIndex();
  // BEFORE the gateway connects, for `index.ts:~448`'s reason: the index is what tells a
  // message in a thread which task it belongs to. Unlike the supervisor's, this one comes
  // from Redis rather than the state repo, and on a cold start it may legitimately be
  // empty — no supervisor has published yet. That is why the bridge answers an unknown
  // thread with a message rather than silence.
  await refreshThreads(plane.threads, threads, logger);

  const controller = new AbortController();
  // No `repos`, and it cannot be otherwise: the `/brainstorm repo:` catalogue (§9.1.1) is
  // `mergedCatalog` over the configured FORGES, and a forge credential is the thing this
  // process is defined not to hold. `suggestRepos` treats an absent catalogue as an empty
  // suggestion list, which is the same answer a refusing forge gets and is why an
  // autocomplete never hangs. The box is therefore typed by hand here rather than
  // completed — the brainstorm still starts, because the supervisor validates the repo
  // when it drains the intent, where the credential actually lives.
  // The index decides ROUTING; the router decides DELIVERY, and they are not the same
  // question here. The bot's index arrives over Redis and is legitimately behind, so a
  // thread bound seconds ago — or one this process has never heard of — must still reach
  // the bridge to be answered honestly. Without this the gateway filter consulted the same
  // index the bridge would, and dropped precisely the messages the bridge had an answer
  // for. See `ThreadRouter`.
  //
  // Built BEFORE the bridge, because the bridge takes it too now: an interaction from a
  // thread no binding names — `/resume` on a parked task is always one — was refused outright
  // until the gate could ask this instead of asking the index (§7.1).
  const router = new ThreadRouter({
    channelId: bot.channelId,
    index: threads,
    parentOf: (channelId) => bot.parentChannel(channelId),
  });

  const bridge = new DiscordBridge({
    bot,
    inbox: plane.chat,
    snapshot: plane.snapshot,
    threads,
    router,
    logger,
    leadership: lock,
  });

  const gateway = new DiscordGateway({
    token: bot.token,
    channelId: bot.channelId,
    threads: router,
    logger,
    onMessage: (content, author, channelId, messageId, replyTo) =>
      bridge.handleMessage(content, author, channelId, messageId, replyTo),
    onInteraction: (interaction) => bridge.handleInteraction(interaction),
  });

  // Health BEFORE the gateway dials, so a bot that cannot reach Discord is visibly
  // unready rather than absent — an unready pod is a fact an operator can see, and a pod
  // that never bound its port looks like a scheduling problem.
  const stopHealth = startHealthServer({
    config,
    metrics,
    gateway,
    redis: redisOf(plane),
    logger,
  });

  await lock.start();

  const refresh = setInterval(() => {
    void refreshThreads(plane.threads, threads, logger);
  }, THREAD_REFRESH_MS);
  // Never the reason the process stays alive.
  refresh.unref?.();

  const shutdown = (signal: string): void => {
    logger.info("bot.shutdown", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    // Resolves only when the signal aborts. `run` never throws — it reconnects forever.
    await gateway.run(controller.signal);
  } finally {
    clearInterval(refresh);
    stopHealth();
    // Hand the lock back explicitly rather than waiting out its TTL: without this the
    // incoming pod of a rolling update is connected but declining to act for up to
    // CHAT_LOCK_TTL_SECONDS, which is the bot being online and answering nothing — the
    // exact failure this whole split was built to remove.
    await lock.stop();
    await plane
      .close()
      .catch((error: unknown) => logger.warn("redis.close-failed", errorFields(error)));
  }
};

/**
 * The Discord transports, from the mounted secret.
 *
 * Both keys are REQUIRED here, unlike in the supervisor where a missing token costs the
 * bridge and nothing else. This process is the bridge; without a token it has no reason
 * to be running, and starting anyway would produce a pod that passes its probes forever
 * while being unreachable from Discord.
 */
const loadBot = async (config: RunnerConfig, logger: Logger): Promise<DiscordBot> => {
  const bundle = new SecretBundle(config.secretsDir, "caterpillar-discord");
  const token = await bundle.readOptional("bot-token").catch(() => undefined);
  const channelId = await bundle.readOptional("channel-id").catch(() => undefined);

  if (token === undefined || channelId === undefined) {
    throw new Error(
      "the standalone bot needs `bot-token` and `channel-id` in the caterpillar-discord " +
        "secret — it has no other purpose than to hold that connection",
    );
  }

  logger.info("bot.discord", { channel: channelId });
  return new DiscordBot({ token, channelId });
};

/**
 * Pull the supervisor's published bindings into the local index.
 *
 * `replace` rather than merge, because `threadBindings` unbinds a terminal task's thread
 * and a merge would keep listening to a conversation that is over — where every message
 * is read as an answer to a task that has finished. `ThreadIndex.replace` keeps LOCALLY
 * bound threads that the incoming mapping does not mention (see its docstring), which is
 * what protects a brainstorm thread this process created seconds ago from being unbound by
 * a mapping the supervisor has not caught up with yet — without weakening the unbind,
 * since a thread the mapping does mention is authoritative from then on.
 *
 * An empty mapping still has to be told from a silent one, because empty mentions nothing
 * and so pins nothing either: "the fleet has no live threads" must clear the index, while
 * "nobody has published since this process started" must leave it alone. The READER draws
 * that line — `read()` resolves to undefined for both a cold start and an unreachable
 * Redis — so there is no flag here to keep in step with it, and both cases are the same
 * one instruction: change nothing.
 */
export const refreshThreads = async (
  source: ThreadBindingReader,
  threads: ThreadIndex,
  logger: Logger,
): Promise<void> => {
  const bindings = await source.read().catch((error: unknown) => {
    logger.warn("threads.refresh-failed", errorFields(error));
    return undefined;
  });
  if (bindings === undefined) return;

  threads.replace(bindings.map((binding) => [binding.threadId, binding.task] as const));
  logger.debug("threads.refreshed", { count: bindings.length });
};

export interface HealthOptions {
  readonly config: RunnerConfig;
  readonly metrics: AgentMetrics;
  readonly gateway: { connected: () => boolean };
  /**
   * The raw client, NOT one of the plane's structures — see `readiness` for why.
   *
   * Taking the client rather than the plane also stops the next person reaching for
   * `plane.threads.read()` here: the type no longer offers it.
   */
  readonly redis: Pick<RedisClient, "get">;
  readonly logger: Logger;
}

/**
 * `/healthz`, `/readyz` and `/metrics` for the bot.
 *
 * The containment lesson at `supervisor/loop.ts:~287`, applied to a process whose whole
 * job is to be reachable: **a process that answers probes while doing nothing useful is
 * worse than one that exits**, because nothing restarts it and nothing pages. So
 * readiness is not "the HTTP server bound its port" — it is the two facts that decide
 * whether a human typing in Discord gets an answer:
 *
 *   the GATEWAY is connected and identified. An open socket that never identified
 *   delivers nothing, and a reconnect loop looks exactly like an idle channel.
 *
 *   REDIS is reachable. It is the only route to the supervisor and the only source of
 *   the snapshot, so a bot without it can acknowledge and then answer nothing.
 *
 * `/healthz` and `/readyz` are deliberately DIFFERENT. Liveness stays cheap and almost
 * always true — restarting the process does not fix a Redis outage, and a liveness probe
 * that reacted to one would turn a dependency's bad minute into a crash loop. Readiness
 * carries the real answer, which is what takes the pod out of the Service and what an
 * operator reads.
 */
export const startHealthServer = (options: HealthOptions): (() => void) => {
  const { config, metrics, gateway, redis, logger } = options;

  const server = createServer((request, response) => {
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(metrics.render());
      return;
    }

    // Liveness: the process is running and its event loop turns. Deliberately not
    // dependent on Discord or Redis — see the docstring.
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }

    if (request.url === "/readyz") {
      void readiness(gateway, redis).then((ready) => {
        response
          .writeHead(ready.ok ? 200 : 503, { "content-type": "application/json" })
          .end(JSON.stringify(ready));
      });
      return;
    }

    response.writeHead(404).end();
  });

  server.listen(config.bot.port, () => {
    logger.info("bot.health", { port: config.bot.port });
  });

  return () => server.close();
};

/**
 * The two facts that decide whether a human gets an answer. Never throws.
 *
 * The Redis term goes through the RAW CLIENT and not through `plane.threads`, and that is
 * the whole subtlety of this function. Every plane structure reaches Redis through
 * `RedisGuard`, whose stated contract is that it converts every failure into a value and
 * never rejects — so `plane.threads.read().catch(() => false)` is dead code: it reports
 * `true` against a client whose every call rejects (proved in `bot.test.ts` with
 * `FailingRedisClient`). It is also served from a 2s cache, so most probes would make no
 * round trip at all. The result was the precise containment failure this probe exists to
 * rule out: during a Redis outage the gateway is still connected, `/readyz` returns 200,
 * the pod stays in the Service — while `RedisChatLock.refresh()` has honestly stepped
 * down and the bot answers nothing.
 *
 * `client.get` does propagate: it is bounded by `commandTimeoutMs` and rejects on a dead
 * socket, which is exactly the signal wanted here. Guarding is right for the hot path and
 * wrong for the probe, because the probe's entire job is to notice.
 */
const readiness = async (
  gateway: { connected: () => boolean },
  redisClient: Pick<RedisClient, "get">,
): Promise<{ readonly ok: boolean; readonly gateway: boolean; readonly redis: boolean }> => {
  const connected = gateway.connected();

  const redis = await redisClient
    .get(THREADS_KEY)
    .then(() => true)
    .catch(() => false);

  return { ok: connected && redis, gateway: connected, redis };
};

/**
 * The plane's client, for the lock.
 *
 * The lock needs the compare-and-swap trio, which is not on any of the five structures —
 * those are properties of the connection. `redis.enabled` was checked at the top of
 * `main`, so a plane with no client here means the plane failed to build one, and
 * carrying on would give a bot that acts unconditionally: during a rollout both pods
 * would answer, and a duplicate `/brainstorm` mints two threads and two tasks.
 */
const redisOf = (plane: EphemeralPlane): RedisClient => {
  if (plane.client === undefined) {
    throw new Error(
      "the ephemeral plane built no redis client, so the chat lock cannot be taken — " +
        "refusing to start rather than acting unconditionally",
    );
  }
  return plane.client;
};

/**
 * Die loudly rather than linger — `index.ts`'s rule, and it matters more here.
 *
 * This process holds a websocket, which keeps the event loop alive indefinitely. Without
 * these a boot failure leaves a pod that is up, connected to nothing, and answering
 * `/healthz` with 200 forever.
 */
const die = (event: string, error: unknown): never => {
  new JsonLogger().error(event, errorFields(error));
  process.exit(1);
};

/**
 * Only when this file is the program, never when it is imported.
 *
 * Without the guard, `import { startHealthServer } from "./bot.ts"` in a test boots the
 * whole process: it reads `/etc/caterpillar/config.json`, fails, and calls `process.exit`
 * — which kills the test RUNNER mid-suite and reports the remaining files as passing
 * because they never ran. `index.ts` has no such guard because nothing imports it; the
 * moment a wiring test exists, the entrypoint needs one.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("uncaughtException", (error) => die("bot.uncaught", error));
  process.on("unhandledRejection", (reason) => die("bot.unhandled-rejection", reason));

  main().then(
    () => process.exit(0),
    (error: unknown) => die("bot.boot-failed", error),
  );
}
