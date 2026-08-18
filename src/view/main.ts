/**
 * The viewer's entrypoint: `caterpillar-view`. See DESIGN.md §18.
 *
 * A second `command` on the same image, not a second image \u2014 `dist/` already ships
 * everything this needs. It runs as a Deployment rather than a StatefulSet because it has
 * nothing to keep: no volumes, no clone, no credential of any kind.
 *
 * What it does at boot is the whole of it: resolve the headless Service, serve HTTP, and
 * refuse anything that is not a GET.
 */
import { JsonLogger, type LogLevel } from "../obs/log.ts";
import { Aggregator } from "./aggregate.ts";
import { loadViewConfig } from "./config.ts";
import { parseRunnerList, SrvDiscovery, StaticDiscovery, type Discovery } from "./discovery.ts";
import { Fanout } from "./fanout.ts";
import { createViewServer } from "./server.ts";

const LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

export const run = async (): Promise<void> => {
  const config = loadViewConfig();
  const logger = new JsonLogger({
    level: (LEVELS.includes(config.logLevel) ? config.logLevel : "info") as LogLevel,
  });

  const discovery: Discovery =
    config.runners === undefined
      ? new SrvDiscovery({
          service: config.service,
          // Logged rather than thrown: a DNS blip must render as "no runners visible",
          // which an operator can act on, not as a 500 from the process whose entire job
          // is to be readable when things are wrong.
          onError: (error) =>
            logger.warn("view.discovery-failed", {
              service: config.service,
              error: error instanceof Error ? error.message : String(error),
            }),
        })
      : new StaticDiscovery(parseRunnerList(config.runners));

  const aggregator = new Aggregator({
    discovery,
    fanout: new Fanout({
      timeoutMs: config.timeoutMs,
      forwardedUserHeader: config.forwardedUserHeader,
    }),
  });

  const server = createViewServer({
    aggregator,
    logger,
    requireForwardedUser: config.requireForwardedUser,
    forwardedUserHeader: config.forwardedUserHeader,
    refreshSeconds: config.refreshSeconds,
  });

  server.listen(config.port);
  logger.info("view.listening", {
    port: config.port,
    discovery: config.runners === undefined ? config.service : "static",
    requireForwardedUser: config.requireForwardedUser,
    timeoutMs: config.timeoutMs,
  });

  // Resolved once at boot purely so a misconfigured Service is an error line at start
  // rather than an empty page nobody attributes to DNS.
  const runners = await discovery.runners();
  logger.info("view.runners", { count: runners.length, names: runners.map((r) => r.name).join(",") });

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      logger.info("view.shutdown", { signal });
      server.close(() => resolve());
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  });
};

