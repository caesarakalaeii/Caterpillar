/**
 * Supervisor entrypoint. See DESIGN.md §10.
 *
 * Runs as pid 1 in a Deployment. A session crash must never kill this process, and a
 * pod restart must be safe at any instant — all durable state lives in the state
 * repo, so recovery is "fetch and reclaim".
 */
import { createServer } from "node:http";
import { AgentSessionRunner, type WorkspaceBindings } from "./agent/runner.ts";
import { loadConfig } from "./config/load.ts";
import { CredentialService } from "./credential/service.ts";
import { asRunnerId, type WorkspaceName } from "./domain/task.ts";
import type { ForgeFactory } from "./forge/types.ts";
import { Ingester } from "./intake/ingest.ts";
import { FileCredentialStore } from "./llm/credentials.ts";
import { createLlmRuntime } from "./llm/models.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { BotNotifier, DiscordBot } from "./notify/bot.ts";
import { DiscordBridge } from "./notify/bridge.ts";
import { DiscordNotifier, NullNotifier, type Notifier } from "./notify/discord.ts";
import { DiscordGateway } from "./notify/gateway.ts";
import { ChatInbox } from "./supervisor/inbox.ts";
import { TaskSnapshot } from "./supervisor/snapshot.ts";
import { errorFields, JsonLogger, type Logger } from "./obs/log.ts";
import { ReviewCouncil } from "./review/council.ts";
import {
  loadForgeFactory,
  loadReviewerFactory,
  loadStateCredentials,
  loadTracker,
  SecretBundle,
} from "./secrets/load.ts";
import { ensureStateCheckout } from "./state/bootstrap.ts";
import { LeaseManager } from "./state/lease.ts";
import { StateStore } from "./state/store.ts";
import { Supervisor } from "./supervisor/loop.ts";
import { GitProgressProbe } from "./supervisor/probe.ts";
import { AcceptanceVerifier } from "./supervisor/verifier.ts";
import type { Tracker } from "./tracker/types.ts";
import { WorktreeManager } from "./workspace/worktree.ts";

const CONFIG_PATH = process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config.json";
/** Where state-repo installation tokens are minted. Not a workspace forge. */
const GITHUB_API_BASE = process.env["GITHUB_API_BASE"] ?? "https://api.github.com";
/** Authors both the state repo's commits and the agent's. */
const BOT_IDENTITY = {
  name: "caterpillar",
  email: "caterpillar@users.noreply.github.com",
} as const;
const METRICS_PORT = Number.parseInt(process.env["METRICS_PORT"] ?? "9090", 10);
const CRED_SOCKET = process.env["CRED_SOCKET"] ?? "/run/caterpillar/cred.sock";
const CRED_HELPER = process.env["CRED_HELPER"] ?? "/usr/local/bin/caterpillar-cred";

/** Serves /metrics for the ServiceMonitor. */
const startMetricsServer = (metrics: AgentMetrics, port: number): (() => void) => {
  const server = createServer((request, response) => {
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(metrics.render());
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port);
  return () => server.close();
};

const main = async (): Promise<void> => {
  const config = await loadConfig(CONFIG_PATH);
  const logger = new JsonLogger({ level: config.log.level });

  // The state repo's own credential: minted from the App, never served over the
  // credential socket, and never inherited by task worktrees (DESIGN.md §9.3).
  const stateCredentials = await loadStateCredentials(
    config.stateRepo,
    config.secretsDir,
    GITHUB_API_BASE,
  );
  const git = await ensureStateCheckout({
    path: config.stateRepo.path,
    url: config.stateRepo.url,
    branch: config.stateRepo.branch,
    identity: BOT_IDENTITY,
    ...(stateCredentials !== undefined ? { envProvider: stateCredentials.gitEnv } : {}),
  });
  const store = new StateStore(config.stateRepo.path, git);
  const metrics = new AgentMetrics();

  const forges = new Map<WorkspaceName, ForgeFactory>();
  const trackers = new Map<WorkspaceName, Tracker>();
  const reviewers = new Map<WorkspaceName, ForgeFactory>();
  for (const [name, profile] of config.workspaces) {
    forges.set(name, await loadForgeFactory(profile, config.secretsDir));

    // The second identity (§12.1). Absent is normal and supported: the council still
    // reviews, and merging stays a human act.
    const reviewer = await loadReviewerFactory(profile, config.secretsDir);
    if (reviewer !== undefined) reviewers.set(name, reviewer);
    logger.info("reviewer.identity", { workspace: name, configured: reviewer !== undefined });

    const tracker = await loadTracker(profile, config.secretsDir);
    if (tracker !== undefined) {
      trackers.set(name, tracker);
    } else if (profile.tracker !== undefined) {
      // Configured but unavailable — say so, or a silently unmirrored workspace
      // looks like a broken tracker rather than an unimplemented adapter.
      logger.warn("tracker.unavailable", {
        workspace: name,
        tracker: profile.tracker.kind,
      });
    }
  }
  const bindings: WorkspaceBindings = { forges, trackers };

  const worktrees = new WorktreeManager({
    git,
    mirrorsDir: config.paths.mirrors,
    tasksDir: config.paths.tasks,
    helperPath: CRED_HELPER,
    socketPath: CRED_SOCKET,
    identity: BOT_IDENTITY,
  });

  const credentials = new CredentialService();
  await credentials.start(CRED_SOCKET);

  const leases = new LeaseManager({
    git,
    remote: "origin",
    runner: asRunnerId(config.runnerId),
    staleAfterSeconds: config.lease.staleAfterSeconds,
  });

  const inbox = new ChatInbox();
  const snapshot = new TaskSnapshot();
  const discord = await loadDiscord(config.secretsDir, logger);

  // Shared by the implementation sessions and the review council — one provider, one
  // credential store, one place the model id is decided.
  const llm = createLlmRuntime({
    config: config.llm,
    // Only subscription mode has a rotating credential to persist. Proxy mode
    // authenticates from the environment and has nothing to store.
    ...(config.llm.credentialsPath !== undefined
      ? { credentials: new FileCredentialStore(config.llm.credentialsPath) }
      : {}),
  });

  const supervisor = new Supervisor({
    config,
    store,
    leases,
    runner: new AgentSessionRunner({
      config,
      store,
      worktrees,
      credentials,
      llm,
      bindings,
      metrics,
    }),
    verifier: new AcceptanceVerifier({ worktrees, bindings }),
    progress: new GitProgressProbe({ worktrees }),
    // The third gate (§12.1) — runs only after the §12 pair has already passed.
    council: new ReviewCouncil({ config, worktrees, llm, logger }),
    reviewers,
    notifier: discord.notifier,
    inbox,
    snapshot,
    metrics,
    logger,
    trackers,
    // Without this the supervisor polls an empty `tasks/` directory forever and
    // labelling an issue `agent` does nothing (DESIGN.md §14).
    intake: new Ingester({
      store,
      trackers,
      logger,
      maxSessionsPerTask: config.limits.maxSessionsPerTask,
    }),
  });

  const stopMetrics = startMetricsServer(metrics, METRICS_PORT);

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info("supervisor.shutdown", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Deliberately NOT awaited here — it resolves only at shutdown, so awaiting it would
  // mean the supervisor never starts polling and the pod idles while looking healthy.
  const bridge =
    discord.bot === undefined
      ? Promise.resolve()
      : runBridge(discord.bot, inbox, snapshot, logger, controller.signal).catch(
          (error: unknown) => {
            logger.error("bridge.failed", errorFields(error));
          },
        );

  try {
    await supervisor.run(controller.signal);
  } finally {
    stopMetrics();
    await credentials.stop();
    await bridge;
  }
};

/**
 * Resolve the Discord transports from the mounted secret. Every key is optional and a
 * missing one costs a capability, never a boot.
 *
 * The notifier PREFERS the bot over the webhook wherever both exist, which reverses the
 * order §11.2 shipped with. The reason is not aesthetic: Discord refuses interactive
 * components from a webhook the application does not own, and `webhook-url` is a webhook
 * created in the channel's settings. A question notification with an Answer button on it
 * can therefore only be sent by the bot. The webhook remains the fallback for a runner
 * with no bot token, and there it still renders the typed `!answer` instruction instead.
 *
 * That the bot now posts the notifications it also reads is safe for the same reason it
 * always was: the gateway drops `author.bot` messages (`gateway.ts`), a guard that was
 * written for the webhook's `!answer` hint and now carries the bot's own output too.
 */
const loadDiscord = async (
  secretsDir: string,
  logger: Logger,
): Promise<{ readonly bot?: DiscordBot; readonly notifier: Notifier }> => {
  const bundle = new SecretBundle(secretsDir, "caterpillar-discord");
  const token = await bundle.readOptional("bot-token").catch(() => undefined);
  const channelId = await bundle.readOptional("channel-id").catch(() => undefined);
  const webhookUrl = await bundle.readOptional("webhook-url").catch(() => undefined);

  if (token === undefined || channelId === undefined) {
    logger.info("bridge.disabled", { reason: "no bot-token and channel-id" });
    return {
      notifier: webhookUrl === undefined ? new NullNotifier() : new DiscordNotifier({ webhookUrl }),
    };
  }

  const bot = new DiscordBot({ token, channelId });
  return { bot, notifier: new BotNotifier(bot) };
};

/**
 * The inbound bridge (DESIGN.md §7).
 *
 * Runs alongside the loop, never inside it: a websocket that waits on a session would
 * deliver nothing for hours. It hands work to the supervisor through the inbox, which is
 * the only thing that touches the state repo, and answers reads from the snapshot, which
 * touches nothing at all.
 */
const runBridge = (
  bot: DiscordBot,
  inbox: ChatInbox,
  snapshot: TaskSnapshot,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> => {
  const bridge = new DiscordBridge({ bot, inbox, snapshot, logger });

  return new DiscordGateway({
    token: bot.token,
    channelId: bot.channelId,
    logger,
    onMessage: (content, author) => bridge.handleMessage(content, author),
    onInteraction: (interaction) => bridge.handleInteraction(interaction),
  }).run(signal);
};

main().catch((error: unknown) => {
  // A failure here can predate `loadConfig`, so this logger takes the default level
  // rather than the configured one — a boot failure must never be the thing that gets
  // filtered out.
  new JsonLogger().error("supervisor.boot-failed", errorFields(error));
  process.exitCode = 1;
});
