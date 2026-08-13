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
import { createLlmRuntime } from "./llm/models.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { DiscordNotifier, NullNotifier, type Notifier } from "./notify/discord.ts";
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
      process.stderr.write(
        `workspace '${name}': tracker '${profile.tracker.kind}' is not implemented; ` +
          `running without tracker mirroring\n`,
      );
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

  const supervisor = new Supervisor({
    config,
    store,
    leases,
    runner: new AgentSessionRunner({
      config,
      store,
      worktrees,
      credentials,
      llm: createLlmRuntime(config.llm),
      bindings,
      metrics,
    }),
    verifier: new AcceptanceVerifier({ worktrees, bindings }),
    progress: new GitProgressProbe({ worktrees }),
    notifier: await createNotifier(config.secretsDir),
    metrics,
    trackers,
  });

  const stopMetrics = startMetricsServer(metrics, METRICS_PORT);

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}, finishing current session\n`);
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await supervisor.run(controller.signal);
  } finally {
    stopMetrics();
    await credentials.stop();
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
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
