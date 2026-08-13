/**
 * Supervisor entrypoint. See DESIGN.md §10.
 *
 * Runs as pid 1 in a Deployment. A session crash must never kill this process, and a
 * pod restart must be safe at any instant — all durable state lives in the state
 * repo, so recovery is "fetch and reclaim".
 */
import { createServer } from "node:http";
import { loadConfig } from "./config/load.ts";
import { asRunnerId } from "./domain/task.ts";
import { AgentMetrics } from "./metrics/registry.ts";
import { NullNotifier } from "./notify/discord.ts";
import { Git } from "./state/git.ts";
import { LeaseManager } from "./state/lease.ts";
import { StateStore } from "./state/store.ts";
import { Supervisor, type ProgressProbe, type SessionRunner, type Verifier } from "./supervisor/loop.ts";

const CONFIG_PATH = process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config.json";
const METRICS_PORT = Number.parseInt(process.env["METRICS_PORT"] ?? "9090", 10);

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

// TODO: replace with the real implementations once the forge/tracker adapters land.
const notImplemented = (name: string) => () => Promise.reject(new Error(`${name} not implemented`));

const pendingRunner: SessionRunner = { run: notImplemented("SessionRunner.run") };
const pendingVerifier: Verifier = { verify: notImplemented("Verifier.verify") };
const pendingProgress: ProgressProbe = { probe: notImplemented("ProgressProbe.probe") };

const main = async (): Promise<void> => {
  const config = await loadConfig(CONFIG_PATH);

  const git = new Git(config.stateRepo.path);
  const store = new StateStore(config.stateRepo.path, git);
  const metrics = new AgentMetrics();

  const leases = new LeaseManager({
    git,
    remote: "origin",
    runner: asRunnerId(config.runnerId),
    staleAfterSeconds: config.lease.staleAfterSeconds,
  });

  const stopMetrics = startMetricsServer(metrics, METRICS_PORT);

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}, finishing current session\n`);
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const supervisor = new Supervisor({
    config,
    store,
    leases,
    runner: pendingRunner,
    verifier: pendingVerifier,
    progress: pendingProgress,
    notifier: new NullNotifier(),
    metrics,
  });

  try {
    await supervisor.run(controller.signal);
  } finally {
    stopMetrics();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
