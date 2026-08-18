/**
 * The viewer's configuration, which is deliberately tiny. See DESIGN.md §18.
 *
 * Environment variables rather than the runners' ConfigMap file: this process has no state
 * repo, no workspaces, no toolchain, no limits and no credentials, so reusing `RunnerConfig`
 * would mean shipping a document that is 95% fields this process must never act on. The
 * whole surface is "where are the runners, how long do I wait for one, and is the proxy in
 * front of me required".
 */

export interface ViewConfig {
  readonly port: number;
  /**
   * SRV name enumerating ready runner pods, e.g.
   * `_web._tcp.caterpillar-headless.caterpillar.svc.cluster.local`.
   */
  readonly service: string;
  /**
   * An explicit `name=url,name=url` list, which wins over the SRV name when set.
   * The escape hatch for running the viewer outside a cluster.
   */
  readonly runners?: string;
  readonly timeoutMs: number;
  readonly refreshSeconds: number;
  /** Fail-closed check on the Ingress losing its forward-auth annotations. */
  readonly requireForwardedUser: boolean;
  readonly forwardedUserHeader: string;
  readonly logLevel: string;
}

export const DEFAULT_VIEW_PORT = 8080;

/**
 * A per-runner timeout, not a per-page one.
 *
 * Four seconds is long enough for a busy single-threaded supervisor to answer between tool
 * calls and short enough that one wedged replica does not hold the page. The fan-out is
 * parallel, so the page's worst case is this, not four times it.
 */
export const DEFAULT_TIMEOUT_MS = 4000;

const number = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Read the environment. Never throws: a viewer that refuses to boot over a malformed
 * number is a dashboard that is missing exactly when someone is trying to read it, and
 * every field here has a defensible default.
 *
 * `requireForwardedUser` defaults to TRUE, which is the opposite of the runners' `web`
 * default and deliberate: a runner may be started on a workstation and must not begin
 * serving transcripts because it was upgraded, whereas this process exists only to be put
 * behind an authenticating proxy. The unsafe direction should need a word typed on purpose.
 */
export const loadViewConfig = (env: NodeJS.ProcessEnv = process.env): ViewConfig => ({
  port: number(env["VIEW_PORT"], DEFAULT_VIEW_PORT),
  service:
    env["VIEW_SERVICE"] ?? "_web._tcp.caterpillar-headless.caterpillar.svc.cluster.local",
  ...(env["VIEW_RUNNERS"] === undefined || env["VIEW_RUNNERS"].trim() === ""
    ? {}
    : { runners: env["VIEW_RUNNERS"] }),
  timeoutMs: number(env["VIEW_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS),
  refreshSeconds: number(env["VIEW_REFRESH_SECONDS"], 10),
  requireForwardedUser: env["VIEW_REQUIRE_FORWARDED_USER"] !== "false",
  forwardedUserHeader: (env["VIEW_FORWARDED_USER_HEADER"] ?? "remote-user").toLowerCase(),
  logLevel: env["LOG_LEVEL"] ?? "info",
});
