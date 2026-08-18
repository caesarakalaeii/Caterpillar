/**
 * Supervisor entrypoint. See DESIGN.md §10.
 *
 * Runs as pid 1 in a Deployment. A session crash must never kill this process, and a
 * pod restart must be safe at any instant — all durable state lives in the state
 * repo, so recovery is "fetch and reclaim".
 */
import { createServer } from "node:http";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { AgentSessionRunner, type WorkspaceBindings } from "./agent/runner.ts";
import { ClusterClient, type ClusterReader } from "./cluster/client.ts";
import { loadConfig } from "./config/load.ts";
import { stateRepoRef, workspaceScopeOf } from "./config/scope.ts";
import type { RunnerConfig } from "./config/types.ts";
import { CredentialService } from "./credential/service.ts";
import { MirrorChangeReader } from "./digest/changes.ts";
import { DailyDigest } from "./digest/publish.ts";
import { LlmSummariser } from "./digest/summarise.ts";
import { asRunnerId, type WorkspaceName } from "./domain/task.ts";
import type { ForgeFactory, WorkspaceScope } from "./forge/types.ts";
import { Ingester } from "./intake/ingest.ts";
import { FileCredentialStore } from "./llm/credentials.ts";
import { HOLDER_TOKEN_ENV, HttpCredentialStore } from "./llm/credential-client.ts";
import { createLlmRuntime, type LlmRuntime } from "./llm/models.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { BotNotifier, BotPresence, BotThreadCloser, DiscordBot } from "./notify/bot.ts";
import { DiscordBridge } from "./notify/bridge.ts";
import { threadBindings, ThreadIndex, type ThreadOwner } from "./notify/threads.ts";
import { ChatLeadership } from "./notify/leadership.ts";
import { DiscordNotifier, NullNotifier, type Notifier } from "./notify/discord.ts";
import { DiscordGateway } from "./notify/gateway.ts";
import { AlertProcessor, AlertQueue } from "./remediation/queue.ts";
import { startRemediationReceiver, type AlertObserver } from "./remediation/receiver.ts";
import { ChatInbox } from "./supervisor/inbox.ts";
import { TaskSnapshot } from "./supervisor/snapshot.ts";
import { errorFields, JsonLogger, type Logger } from "./obs/log.ts";
import { LiveSession } from "./obs/live.ts";
import { LogRing } from "./obs/ring.ts";
import { createWebServer } from "./web/server.ts";
import { PlanMaintainer } from "./plan/maintain.ts";
import { ReviewCouncil } from "./review/council.ts";
import {
  loadForgeFactory,
  loadReviewerFactory,
  loadStateCredentials,
  loadTracker,
  SecretBundle,
} from "./secrets/load.ts";
import { ensureStateCheckout } from "./state/bootstrap.ts";
import type { Git } from "./state/git.ts";
import { LeaseManager } from "./state/lease.ts";
import { StateStore } from "./state/store.ts";
import { Supervisor } from "./supervisor/loop.ts";
import { GitProgressProbe } from "./supervisor/probe.ts";
import { AcceptanceVerifier } from "./supervisor/verifier.ts";
import type { Tracker } from "./tracker/types.ts";
import { WorktreeManager } from "./workspace/worktree.ts";
import { ToolchainResolver } from "./workspace/toolchain.ts";

const CONFIG_PATH = process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config.json";
/** Where state-repo installation tokens are minted. Not a workspace forge. */
const GITHUB_API_BASE = process.env["GITHUB_API_BASE"] ?? "https://api.github.com";
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

/**
 * Where this runner's rotating credential comes from (DESIGN.md §9.6).
 *
 * Three cases, and the ORDER is the whole decision:
 *
 *   `credentialsUrl` — a fleet. The credential holder owns the only copy and this runner
 *   reads it over HTTP. Checked FIRST, and it wins over a path, because a fleet's
 *   ConfigMap necessarily carries both: one object configures the runners and the holder,
 *   and `credentialsPath` there is the HOLDER's field. A runner that preferred the path
 *   would open its own copy on its own volume and start rotating a token three other
 *   replicas are using — the exact failure the holder exists to prevent, arriving through
 *   a config that looks correct.
 *
 *   `credentialsPath` — one replica, the original shape. A file on the PVC, locked across
 *   processes. Still supported and still right for a machine runner or a `docker run`,
 *   neither of which has a holder to talk to.
 *
 *   neither — proxy mode, which authenticates from the environment and stores nothing.
 */
const credentialStore = (
  llm: RunnerConfig["llm"],
  logger: Logger,
): { credentials: CredentialStore } | undefined => {
  if (llm.credentialsUrl !== undefined) {
    logger.info("llm.credential-source", { source: "holder", url: llm.credentialsUrl });
    return {
      credentials: new HttpCredentialStore({
        baseUrl: llm.credentialsUrl,
        // Absent is legal and the holder decides whether that is acceptable — it warns
        // at boot when it is running without one. Failing here instead would mean a
        // runner refusing to start over a policy its peer is responsible for.
        ...(process.env[HOLDER_TOKEN_ENV] === undefined
          ? {}
          : { token: process.env[HOLDER_TOKEN_ENV] }),
      }),
    };
  }

  if (llm.credentialsPath !== undefined) {
    logger.info("llm.credential-source", { source: "file", path: llm.credentialsPath });
    return { credentials: new FileCredentialStore(llm.credentialsPath) };
  }

  return undefined;
};

const main = async (): Promise<void> => {
  const loaded = await loadConfig(CONFIG_PATH);

  // The ring is the logger's SINK, not a second Logger: it therefore holds exactly the
  // records that reached stdout, and there is no threshold implemented twice (obs/ring.ts).
  const ring = new LogRing(loaded.web.enabled ? loaded.web.logCapacity : 0);
  const logger = new JsonLogger({
    level: loaded.log.level,
    write: (line) => {
      process.stdout.write(line);
      ring.push(line);
    },
  });

  // What this runner is executing right now. Written by the session runner, read by the
  // web view, and empty at every other moment (DESIGN.md §18).
  const live = new LiveSession();

  // ONE resolver for the whole process. The agent's shell, the council's, the plan
  // maintainer's and the acceptance gate's must be the same environment or the gate grades
  // work against a shell the agent never saw (see workspace/toolchain.ts).
  const toolchain = new ToolchainResolver({
    logger,
    config: loaded.toolchain,
    tasksDir: loaded.paths.tasks,
    // So a fallback to `inherited` can say whether the repo HAS a nix expression this
    // worktree simply predates, rather than leaving the agent to infer it from missing
    // tools (DESIGN.md §8.1).
    repo: () => worktrees,
  });

  // `nix` is derived from the machine rather than taken from the ConfigMap (DESIGN.md
  // §8.1). A runner that has nix and does not advertise it leaves every task declaring a
  // toolchain `ready` forever, claimable by nobody, and says nothing about why.
  const config: RunnerConfig = {
    ...loaded,
    capabilities: await toolchain.capabilities(loaded.capabilities),
  };

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
    identity: config.identity,
    ...(stateCredentials !== undefined ? { envProvider: stateCredentials.gitEnv } : {}),
  });
  // The salvage hook is how a runner says it had to set its own commits aside. At `error`
  // deliberately: it means two runners recorded the same task and one of them lost, which
  // is never routine — but the runner keeps working, so nothing else would raise it.
  // The runner id goes in because it names every journal shard this runner writes; that
  // is what makes two runners' journal commits commute instead of colliding (§4.3).
  const store = new StateStore(
    config.stateRepo.path,
    git,
    (salvaged) => {
      logger.error("state.salvaged", {
        ref: salvaged.ref,
        commit: salvaged.commit,
        detail: salvaged.detail,
      });
    },
    config.runnerId,
  );
  const metrics = new AgentMetrics();

  // Parsed once: every workspace's scope excludes the same state repo, and a task
  // credential that could reach it would make the audit trail agent-writable (§9.3).
  const stateRepo = stateRepoRef(config.stateRepo);

  const forges = new Map<WorkspaceName, ForgeFactory>();
  const trackers = new Map<WorkspaceName, Tracker>();
  const reviewers = new Map<WorkspaceName, ForgeFactory>();
  const scopes = new Map<WorkspaceName, WorkspaceScope>();
  for (const [name, profile] of config.workspaces) {
    scopes.set(name, workspaceScopeOf(profile, stateRepo));
    forges.set(name, await loadForgeFactory(profile, config.secretsDir, stateRepo));

    // The second identity (§12.1). Absent is normal and supported: the council still
    // reviews, and merging stays a human act.
    const reviewer = await loadReviewerFactory(profile, config.secretsDir, stateRepo);
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
    identity: config.identity,
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
  // Filled by the webhook receiver when one is running, drained by the loop (§20). Built
  // unconditionally and cheap: an empty queue costs one array swap a poll, and building it
  // here keeps the receiver's own startup a single decision about the port and the secret.
  const alertQueue = new AlertQueue();
  const snapshot = new TaskSnapshot();
  const threads = new ThreadIndex();
  const discord = await loadDiscord(config.secretsDir, logger);

  // Shared by the implementation sessions and the review council — one provider, one
  // credential store, one place the model id is decided.
  const llm = createLlmRuntime({
    config: config.llm,
    ...(credentialStore(config.llm, logger) ?? {}),
  });

  const digester = createDigest({
    config,
    git,
    store,
    leases,
    worktrees,
    llm,
    notifier: discord.notifier,
    metrics,
    logger,
  });

  // Read-only cluster access for remediation sessions (DESIGN.md §20). Built here so the
  // ServiceAccount token stays with the supervisor and is never handed to a session.
  const cluster = createClusterReader(config, logger);

  // Built before both users: the supervisor refreshes it on every poll, the bridge reads
  // it on every inbound event (DESIGN.md §7). One replica of a fleet acts on Discord.
  const chat = new ChatLeadership({
    claims: leases,
    runner: asRunnerId(config.runnerId),
    logger,
  });

  const supervisor = new Supervisor({
    config,
    store,
    leases,
    ...(digester === undefined ? {} : { digest: digester }),
    chat,
    runner: new AgentSessionRunner({
      config,
      store,
      logger,
      worktrees,
      credentials,
      llm,
      bindings,
      metrics,
      toolchain,
      live,
      ...(cluster === undefined ? {} : { cluster }),
    }),
    toolchain,
    verifier: new AcceptanceVerifier({ worktrees, bindings, toolchain }),
    progress: new GitProgressProbe({ worktrees }),
    // The third gate (§12.1) — runs only after the §12 pair has already passed.
    council: new ReviewCouncil({ config, worktrees, llm, logger, toolchain }),
    maintainer: new PlanMaintainer({ config, worktrees, llm, logger, toolchain }),
    reviewers,
    threads,
    ...(discord.bot === undefined
      ? {}
      : {
          presence: new BotPresence(discord.bot),
          closer: new BotThreadCloser(discord.bot, threads),
        }),
    notifier: discord.notifier,
    credentials,
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
      scopes,
      logger,
      maxSessionsPerTask: config.limits.maxSessionsPerTask,
    }),
    // The fifth intake path (§20). Present whether or not the receiver is listening: the
    // drain is a no-op on an empty queue, and wiring it conditionally would mean an alert
    // accepted by a receiver started later had nowhere to go.
    alerts: {
      queue: alertQueue,
      ingester: new AlertProcessor({
        store,
        notifier: discord.notifier,
        logger,
        metrics: alertObserver(metrics),
        maxSessionsPerTask: config.limits.maxSessionsPerTask,
      }),
    },
  });

  const stopMetrics = startMetricsServer(metrics, METRICS_PORT);
  const stopWeb = startWebView({ config, store, live, ring, logger });
  const stopReceiver = await startAlertReceiver({
    config,
    sink: alertQueue,
    metrics,
    logger,
  });

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info("supervisor.shutdown", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // BEFORE the bridge connects, not on the first poll. The index is what tells a message
  // in a thread which task it belongs to, and the loop only rebuilds it once per cycle —
  // so a reply arriving in the seconds after a restart hit an empty index, fell through
  // to channel parsing, and `!answer we want B` was read as an answer to a task called
  // `we`. Keel rolls this pod on every push to main, which makes that window routine.
  await hydrateThreads(store, threads, logger);

  // Deliberately NOT awaited here — it resolves only at shutdown, so awaiting it would
  // mean the supervisor never starts polling and the pod idles while looking healthy.
  const bridge =
    discord.bot === undefined
      ? Promise.resolve()
      : runBridge(discord.bot, inbox, snapshot, threads, logger, controller.signal, chat).catch(
          (error: unknown) => {
            logger.error("bridge.failed", errorFields(error));
          },
        );

  try {
    await supervisor.run(controller.signal);
  } finally {
    // FIRST, and unconditionally. `runBridge`'s loop only exits when this signal aborts,
    // and only the SIGTERM/SIGINT handlers used to abort it — so a throw out of
    // `supervisor.run` reached `await bridge` and blocked there forever, having already
    // closed /healthz and the credential socket. The Discord websocket kept the event
    // loop alive, so the process never exited, and `Restart=always` never fired.
    controller.abort();
    stopMetrics();
    stopWeb();
    stopReceiver();
    await credentials.stop();
    await bridge;
  }
};

/**
 * Build the daily digest, if this runner was told to publish one (DESIGN.md §19).
 *
 * Off by default, like the web view and for a related reason: publishing writes to the
 * shared state repo and posts to the shared Discord channel, and a runner someone starts
 * on a workstation must not begin doing either because it was upgraded. The claim protocol
 * makes a second publisher harmless, not welcome.
 *
 * The summariser is a separate switch. Everything else in a digest is measured from git
 * and costs nothing; the prose is the only part that spends tokens, so a runner minding
 * its spend can drop the paragraph without losing the report.
 */
const createDigest = (options: {
  readonly config: RunnerConfig;
  readonly git: Git;
  readonly store: StateStore;
  readonly leases: LeaseManager;
  readonly worktrees: WorktreeManager;
  readonly llm: LlmRuntime;
  readonly notifier: Notifier;
  readonly metrics: AgentMetrics;
  readonly logger: Logger;
}): DailyDigest | undefined => {
  const { config, logger } = options;
  const { digest } = config;

  if (!digest.enabled) {
    logger.info("digest.disabled", { reason: "digest.enabled is false" });
    return undefined;
  }

  logger.info("digest.configured", {
    hour: digest.hour,
    timeZone: digest.timeZone,
    summarise: digest.summarise,
  });

  return new DailyDigest({
    git: options.git,
    store: options.store,
    leases: options.leases,
    notifier: options.notifier,
    logger,
    boundary: { hour: digest.hour, timeZone: digest.timeZone },
    runner: config.runnerId,
    branch: config.stateRepo.branch,
    // Read-only, and strictly local: the digest reports on mirrors this runner already
    // has and never fetches one to do it.
    changes: new MirrorChangeReader(options.worktrees),
    ...(digest.summarise
      ? {
          summariser: new LlmSummariser({
            llm: options.llm,
            timeZone: digest.timeZone,
            thresholdFraction: config.handoff.thresholdFraction,
            maxSessionSeconds: config.limits.maxSessionSeconds,
          }),
        }
      : {}),
    onPublished: (_date, quiet) =>
      options.metrics.digests.inc({ runner: config.runnerId, quiet: String(quiet) }),
  });
};

/**
 * Build the cluster reader, if this runner was told it may read the cluster (DESIGN.md §20).
 *
 * Off by default, like the web view and the digest, and for a sharper reason than either: a
 * runner someone starts on a workstation has no ServiceAccount token, and one running in a
 * cluster it was not deployed to has the wrong one. `enabled` is the operator saying "this
 * replica is in the cluster it is allowed to look at".
 *
 * The allowlist is LOGGED at startup, including when it is empty. An operator debugging a
 * refused read should find the answer in the log rather than inferring it from a denial
 * message inside a session transcript — and an empty list denies everything, which is the
 * one case where that log line is the whole diagnosis.
 */
const createClusterReader = (config: RunnerConfig, logger: Logger): ClusterReader | undefined => {
  const { cluster } = config;
  if (!cluster.enabled) {
    logger.info("cluster.disabled", { reason: "cluster.enabled is false" });
    return undefined;
  }

  logger.info("cluster.configured", {
    // Joined rather than nested: log fields are scalars, and the whole point of this line
    // is that the allowlist can be read out of it.
    namespaces: cluster.namespaces.join(","),
    kubeApiUrl: cluster.kubeApiUrl,
    lokiUrl: cluster.lokiUrl,
    maxLogLines: cluster.maxLogLines,
  });
  if (cluster.namespaces.length === 0) {
    // Not fatal, and not silent either: the feature is on and can read nothing, which is a
    // half-finished ConfigMap rather than a decision anyone would make on purpose.
    logger.warn("cluster.namespaces.empty", {
      detail:
        "cluster.enabled is true but cluster.namespaces is empty, so every cluster read " +
        "will be denied",
    });
  }

  return new ClusterClient({
    namespaces: cluster.namespaces,
    kubeApiUrl: cluster.kubeApiUrl,
    lokiUrl: cluster.lokiUrl,
    maxLogLines: cluster.maxLogLines,
  });
};

/**
 * Start the read-only web view, if this runner was told to serve one (DESIGN.md §18).
 *
 * Its own port. The metrics port stays exactly what it was — one Service port for the
 * ServiceMonitor and one for the Ingress means "what is published" is answerable by
 * reading a Service rather than by reading this file.
 */
const startWebView = (options: {
  readonly config: RunnerConfig;
  readonly store: StateStore;
  readonly live: LiveSession;
  readonly ring: LogRing;
  readonly logger: Logger;
}): (() => void) => {
  const { web } = options.config;
  if (!web.enabled) {
    options.logger.info("web.disabled", { reason: "web.enabled is false" });
    return () => undefined;
  }
  assertPortsDiffer(options.config);

  const server = createWebServer(options);
  server.listen(web.port);
  options.logger.info("web.listening", {
    port: web.port,
    requireForwardedUser: web.requireForwardedUser,
  });

  return () => server.close();
};

/**
 * Every port this process listens on must be a different port.
 *
 * Checked in one place for all three rather than pairwise as each was added: bind order
 * would otherwise decide which listener exists, and the loser fails with an EADDRINUSE that
 * names neither of the two things that collided.
 */
const assertPortsDiffer = (config: RunnerConfig): void => {
  const ports: readonly (readonly [string, number])[] = [
    ["METRICS_PORT", METRICS_PORT],
    ["web.port", config.web.port],
    ["remediation.port", config.remediation.port],
  ];

  for (const [i, [name, value]] of ports.entries()) {
    for (const [otherName, otherValue] of ports.slice(i + 1)) {
      if (value === otherValue) {
        throw new Error(`${name} (${value}) must differ from ${otherName} (${otherValue})`);
      }
    }
  }
};

/**
 * Start the Alertmanager webhook receiver, if this runner was told to (DESIGN.md §20).
 *
 * Two ways not to start, and they are different events:
 *
 *   `remediation.enabled` is false — the ordinary case, logged at info like the web view's.
 *
 *   the secret is missing — a MISCONFIGURATION, logged at error, and the receiver does not
 *   start. It does not fall back to an open port: this listener is the only one that can
 *   cause a task to exist, and a task is a session with a shell and a forge credential, so
 *   an unauthenticated one is a remote code execution path. Failing closed leaves the alert
 *   path dark and everything else working, which is the failure an operator can see and fix
 *   with one commit.
 */
const startAlertReceiver = async (options: {
  readonly config: RunnerConfig;
  readonly sink: AlertQueue;
  readonly metrics: AgentMetrics;
  readonly logger: Logger;
}): Promise<() => void> => {
  const { config, logger } = options;
  if (!config.remediation.enabled) {
    logger.info("remediation.disabled", { reason: "remediation.enabled is false" });
    return () => undefined;
  }
  assertPortsDiffer(config);

  const bundle = new SecretBundle(config.secretsDir, "caterpillar-remediation");
  const token = await bundle.readOptional("webhook-token").catch(() => undefined);
  if (token === undefined || token.length === 0) {
    logger.error("remediation.no-token", {
      secret: "caterpillar-remediation",
      key: "webhook-token",
      reason:
        "the receiver refuses to start unauthenticated — a webhook that creates tasks is a " +
        "remote code execution path",
    });
    return () => undefined;
  }

  return startRemediationReceiver({
    port: config.remediation.port,
    token,
    sink: options.sink,
    logger,
    metrics: alertObserver(options.metrics),
  });
};

/**
 * The alert counter, as the two halves of the alert path see it.
 *
 * One adapter rather than each of them reaching into `AgentMetrics`, so `outcome` is the
 * label the receiver and the queue agree on and neither has to know how a counter is
 * incremented.
 */
const alertObserver = (metrics: AgentMetrics): AlertObserver => ({
  observe: (alertname, outcome) => metrics.alerts.inc({ alertname, outcome }),
});

/**
 * Rebuild the thread index from the state repo.
 *
 * The durable copy is `state.chat.threadId`; this is a derived lookup, so it is rebuilt
 * rather than persisted — a restart heals it, and there is no second index to fall out
 * of step with the tasks.
 */
const hydrateThreads = async (
  store: StateStore,
  threads: ThreadIndex,
  logger: Logger,
): Promise<void> => {
  const owners: ThreadOwner[] = [];
  for (const id of await store.listTasks()) {
    const state = await store.readState(id).catch(() => undefined);
    if (state === undefined) continue;
    owners.push({
      id,
      status: state.status,
      ...(state.chat === undefined ? {} : { threadId: state.chat.threadId }),
    });
  }
  const entries = threadBindings(owners);
  threads.replace(entries);
  logger.info("threads.hydrated", { count: entries.length });
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
  threads: ThreadIndex,
  logger: Logger,
  signal: AbortSignal,
  leadership: ChatLeadership,
): Promise<void> => {
  // Every replica connects; one acts (§7). The connection is what keeps the bot online
  // through a rollout, and it costs nothing — it is acting four times that broke things.
  const bridge = new DiscordBridge({ bot, inbox, snapshot, threads, logger, leadership });

  return new DiscordGateway({
    token: bot.token,
    channelId: bot.channelId,
    threads,
    logger,
    onMessage: (content, author, channelId) => bridge.handleMessage(content, author, channelId),
    onInteraction: (interaction) => bridge.handleInteraction(interaction),
  }).run(signal);
};

/**
 * Die loudly rather than linger.
 *
 * Every failure path here has the same shape: something the supervisor cannot recover
 * from happens, and the process stays alive because a websocket or a listening socket is
 * still holding the event loop open. A runner that is up but not working is the worst of
 * the three states — Kubernetes will not restart it, systemd will not restart it, and
 * `/healthz` says 200 — so each of these exits on purpose.
 *
 * `process.exit` rather than `exitCode`: setting the code only takes effect once the loop
 * drains, which is exactly what is not going to happen.
 */
const die = (event: string, error: unknown): never => {
  new JsonLogger().error(event, errorFields(error));
  process.exit(1);
};

process.on("uncaughtException", (error) => die("supervisor.uncaught", error));
process.on("unhandledRejection", (reason) => die("supervisor.unhandled-rejection", reason));

main().then(
  () => {
    // A clean return means the signal aborted and shutdown completed.
    process.exit(0);
  },
  (error: unknown) => {
    // A failure here can predate `loadConfig`, so this logger takes the default level
    // rather than the configured one — a boot failure must never be the thing that gets
    // filtered out.
    die("supervisor.boot-failed", error);
  },
);
