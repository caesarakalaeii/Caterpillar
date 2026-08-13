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
import { parseCommand } from "./notify/commands.ts";
import { DiscordNotifier, NullNotifier, type Notifier } from "./notify/discord.ts";
import { DiscordGateway, postMessage } from "./notify/gateway.ts";
import { AnswerInbox, type AnswerOutcome } from "./supervisor/inbox.ts";
import { errorFields, JsonLogger, type Logger } from "./obs/log.ts";
import { loadForgeFactory, loadStateCredentials, loadTracker, SecretBundle } from "./secrets/load.ts";
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
  for (const [name, profile] of config.workspaces) {
    forges.set(name, await loadForgeFactory(profile, config.secretsDir));

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

  const inbox = new AnswerInbox();

  const supervisor = new Supervisor({
    config,
    store,
    leases,
    runner: new AgentSessionRunner({
      config,
      store,
      worktrees,
      credentials,
      llm: createLlmRuntime({
        config: config.llm,
        // Only subscription mode has a rotating credential to persist. Proxy mode
        // authenticates from the environment and has nothing to store.
        ...(config.llm.credentialsPath !== undefined
          ? { credentials: new FileCredentialStore(config.llm.credentialsPath) }
          : {}),
      }),
      bindings,
      metrics,
    }),
    verifier: new AcceptanceVerifier({ worktrees, bindings }),
    progress: new GitProgressProbe({ worktrees }),
    notifier: await createNotifier(config.secretsDir),
    inbox,
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

  // The bridge runs ALONGSIDE the loop, not inside it: a websocket that waits on a
  // session would deliver nothing for hours. It hands work to the supervisor through
  // the inbox, which is the only thing that touches the state repo.
  //
  // Deliberately NOT awaited here — it resolves only at shutdown, so awaiting it would
  // mean the supervisor never starts polling and the pod idles while looking healthy.
  const bridge = startBridge(config.secretsDir, inbox, logger, controller.signal).catch(
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
 * The inbound bridge (DESIGN.md §7). Optional, and independent of the webhook: a bot
 * token alone gives commands AND replies, because the bot answers as itself.
 *
 * Needs `bot-token` and `channel-id` in the mounted secret. Without both, a question
 * still parks and waits — it is answered by committing the file by hand.
 */
const startBridge = async (
  secretsDir: string,
  inbox: AnswerInbox,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> => {
  const bundle = new SecretBundle(secretsDir, "caterpillar-discord");
  const token = await bundle.readOptional("bot-token").catch(() => undefined);
  const channelId = await bundle.readOptional("channel-id").catch(() => undefined);

  if (token === undefined || channelId === undefined) {
    logger.info("bridge.disabled", { reason: "no bot-token and channel-id" });
    return;
  }

  const reply = async (content: string): Promise<void> => {
    await postMessage({ token, channelId, content }).catch((error: unknown) => {
      logger.warn("bridge.reply-failed", errorFields(error));
    });
  };

  const gateway = new DiscordGateway({
    token,
    channelId,
    logger,
    onMessage: async (content, author) => {
      const command = parseCommand(content);
      if (command === undefined) return;

      if (command.kind === "malformed") {
        await reply(command.reason);
        return;
      }

      logger.info("bridge.answer", { task: command.task, author });
      await reply(describe(command.task, await inbox.submit(command.task, command.text)));
    },
  });

  return gateway.run(signal);
};

/** What to tell the human. Silence would leave them unable to tell a typo from an outage. */
const describe = (task: string, outcome: AnswerOutcome): string => {
  switch (outcome.kind) {
    case "applied":
      return `Answered **${task}** (question ${outcome.index}). It is \`ready\` and will be claimed on the next poll.`;
    case "unknown-task":
      return `No task **${task}** in the state repo. Check the id from its notification.`;
    case "not-waiting":
      return `**${task}** is \`${outcome.status}\`, not waiting on an answer — nothing was written.`;
    case "failed":
      return `Could not answer **${task}**: ${outcome.error}`;
  }
};

/** Discord is optional: without a webhook the supervisor runs silently. */
const createNotifier = async (secretsDir: string): Promise<Notifier> => {
  const webhookUrl = await new SecretBundle(secretsDir, "caterpillar-discord")
    .readOptional("webhook-url")
    .catch(() => undefined);

  return webhookUrl === undefined ? new NullNotifier() : new DiscordNotifier({ webhookUrl });
};

main().catch((error: unknown) => {
  // A failure here can predate `loadConfig`, so this logger takes the default level
  // rather than the configured one — a boot failure must never be the thing that gets
  // filtered out.
  new JsonLogger().error("supervisor.boot-failed", errorFields(error));
  process.exitCode = 1;
});
