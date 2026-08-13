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
import { loadForgeFactory, loadTracker, SecretBundle } from "./secrets/load.ts";
import { Git } from "./state/git.ts";
import { LeaseManager } from "./state/lease.ts";
import { StateStore } from "./state/store.ts";
import { Supervisor } from "./supervisor/loop.ts";
import { GitProgressProbe } from "./supervisor/probe.ts";
import { AcceptanceVerifier } from "./supervisor/verifier.ts";
import type { Tracker } from "./tracker/types.ts";
import { WorktreeManager } from "./workspace/worktree.ts";

const CONFIG_PATH = process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config.json";
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

  const git = new Git(config.stateRepo.path);
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
    identity: {
      name: "caterpillar",
      email: "caterpillar@users.noreply.github.com",
    },
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
