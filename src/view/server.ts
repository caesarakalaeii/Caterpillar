/**
 * The aggregating viewer. A second read-only front door, in its own process.
 * See DESIGN.md §18.
 *
 * §18 argued that the view had to run INSIDE the supervisor, and for one replica it was
 * right: a separate process would have needed its own state-repo credential and its own
 * clone, and it still could not have shown the log this process writes or the session it
 * runs. Both objections dissolve when the second process AGGREGATES instead of cloning \u2014
 * it reads nothing from git, it asks each runner for its own log and its own live session,
 * and it therefore shows N of each instead of one at random.
 *
 * What it holds: nothing. No state-repo credential, no forge token, no provider credential,
 * no PVC, no ServiceAccount token. Strictly less privilege than the process serving that
 * page today.
 *
 * Every rule \u00a718 states is re-implemented here rather than inherited by assumption, and
 * asserted again in this module's tests:
 *   - anything that is not GET or HEAD is refused BEFORE routing,
 *   - the same CSP, with no `unsafe-inline`,
 *   - `html.ts` escapes by default and `raw` is used on literals only,
 *   - an artifact is an `application/octet-stream` attachment,
 *   - `isTaskId` and `isArtifactName` guard every path segment,
 *   - `requireForwardedUser` fails closed, and the identity is FORWARDED to the runners
 *     rather than the runners relaxing their own check.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { asTaskId, isTaskId, type TaskId } from "../domain/task.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import { isArtifactName } from "../state/store.ts";
import { SCRIPT, STYLESHEET } from "../web/assets.ts";
import type { Html } from "../web/html.ts";
import {
  digestPage,
  digestsPage,
  errorPage,
  intakePage,
  layout,
  runnerPage,
  sessionPage,
  taskPage,
  type Chrome,
  type Page,
} from "../web/pages.ts";
import { parseTranscript } from "../web/transcript.ts";
import type { DigestView, IntakeView, RunnerExport, TaskDetail } from "../web/view.ts";
import type { Aggregator } from "./aggregate.ts";
import { fleetWithRunners, viewerLogsPage } from "./pages.ts";

export interface ViewServerOptions {
  readonly aggregator: Aggregator;
  readonly logger: Logger;
  /** Fail-closed check on the Ingress losing its forward-auth annotations (\u00a718). */
  readonly requireForwardedUser: boolean;
  readonly forwardedUserHeader: string;
  readonly refreshSeconds: number;
}

interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Byte for byte the runners' policy. A second front door with a weaker CSP is a hole. */
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export const createViewServer = (options: ViewServerOptions): Server =>
  createServer((request, response) => {
    void respond(options, request, response);
  });

const respond = async (
  options: ViewServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let reply: Reply;
  try {
    reply = await route(options, request);
  } catch (error: unknown) {
    options.logger.error("view.failed", { path: request.url ?? "", ...errorFields(error) });
    reply = page(options, "fleet", "error", errorPage(500, "Something failed while rendering this."), 500);
  }

  response.writeHead(reply.status, {
    "content-type": reply.type,
    ...SECURITY_HEADERS,
    ...reply.headers,
  });
  response.end(request.method === "HEAD" ? undefined : reply.body);
};

const route = async (options: ViewServerOptions, request: IncomingMessage): Promise<Reply> => {
  const method = request.method ?? "GET";
  const path = decodePath(request.url ?? "/");

  // Before the auth gate, like the runners': the kubelet probes this pod directly and
  // never goes through the Ingress, so a probe that gets 401 restarts a healthy container
  // forever. It answers for the VIEWER only \u2014 a runner being down is a thing to render,
  // not a reason to have this pod killed.
  if (path === "/healthz") return { status: 200, type: "text/plain; charset=utf-8", body: "ok" };

  if (method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      type: "text/plain; charset=utf-8",
      body: "this view is read-only\n",
      headers: { allow: "GET, HEAD" },
    };
  }

  const user = forwardedUser(options, request);
  if (options.requireForwardedUser && user === undefined) {
    return {
      status: 401,
      type: "text/plain; charset=utf-8",
      body: "this view is served behind an authenticating proxy, and this request did not come through one\n",
    };
  }

  if (path === undefined) return notFound(options, user);

  if (path === "/assets/app.css") return { status: 200, type: "text/css; charset=utf-8", body: STYLESHEET };
  if (path === "/assets/app.js") {
    return { status: 200, type: "text/javascript; charset=utf-8", body: SCRIPT };
  }

  const { aggregator } = options;
  const forward = user === undefined ? {} : { user };

  if (path === "/" || path === "/api/fleet") {
    const merged = await aggregator.fleet({ ...forward, path: "/api/fleet" });
    return path === "/api/fleet"
      ? json(200, { ...merged.view, unreachable: merged.unreachable, source: merged.source })
      : page(options, "fleet", "fleet", fleetWithRunners(merged), 200, user);
  }

  if (path === "/logs" || path === "/api/logs") {
    const merged = await aggregator.logs({ ...forward, path: "/api/logs" });
    return path === "/api/logs"
      ? json(200, merged)
      : page(options, "logs", "logs", viewerLogsPage(merged), 200, user);
  }

  if (path === "/intake" || path === "/api/intake") {
    const { value, unreachable } = await aggregator.fromAny<IntakeView>({
      ...forward,
      path: "/api/intake",
    });
    if (value === undefined) return unreachablePage(options, user, unreachable);
    return path === "/api/intake"
      ? json(200, value)
      : page(options, "intake", "intake", intakePage(value), 200, user);
  }

  if (path === "/runner" || path === "/api/runner") {
    const { value, unreachable } = await aggregator.fromAny<RunnerExport & { disk?: never }>({
      ...forward,
      path: "/api/runner",
    });
    if (value === undefined) return unreachablePage(options, user, unreachable);
    return path === "/api/runner"
      ? json(200, value)
      : page(options, "runner", value.runnerId, runnerPage(value, value.disk), 200, user);
  }

  if (path === "/digests" || path === "/api/digests") {
    const { value, unreachable } = await aggregator.fromAny<{ readonly dates: readonly string[] }>({
      ...forward,
      path: "/api/digests",
    });
    if (value === undefined) return unreachablePage(options, user, unreachable);
    return path === "/api/digests"
      ? json(200, value)
      : page(options, "digests", "digests", digestsPage(value.dates), 200, user);
  }

  if (path.startsWith("/digests/") || path.startsWith("/api/digests/")) {
    const api = path.startsWith("/api/");
    const date = path.slice((api ? "/api/digests/" : "/digests/").length);
    // Not validated here: `isDigestDate` lives in the store, the runner applies it before
    // a path segment is built, and a date this rejects simply has no digest and 404s.
    const { value } = await aggregator.fromAny<DigestView | { readonly date: string; readonly body: string }>({
      ...forward,
      path: `/api/digests/${encodeURIComponent(date)}`,
    });
    if (value === undefined) return notFound(options, user);
    const dates = await datesFor(options, forward);
    return api
      ? json(200, value)
      : page(options, "digests", `digest ${value.date}`, digestPage({ ...value, dates }), 200, user);
  }

  const task = taskRoute(path);
  if (task !== undefined) return handleTask(options, task, user);

  return notFound(options, user);
};

const datesFor = async (
  options: ViewServerOptions,
  forward: { readonly user?: string },
): Promise<readonly string[]> => {
  const { value } = await options.aggregator.fromAny<{ readonly dates: readonly string[] }>({
    ...forward,
    path: "/api/digests",
  });
  return value?.dates ?? [];
};

interface TaskRoute {
  readonly id: TaskId;
  readonly rest: readonly string[];
  readonly api: boolean;
}

/**
 * The same guard the runners use, applied again here rather than trusted to have happened
 * downstream. This process builds a URL out of the segment, and an id containing `..`
 * would climb out of `/api/tasks/` on the runner it is sent to.
 */
const taskRoute = (path: string): TaskRoute | undefined => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const api = segments[0] === "api";
  const offset = api ? 1 : 0;
  if (segments[offset] !== "tasks") return undefined;

  const id = segments[offset + 1];
  if (id === undefined || !isTaskId(id)) return undefined;

  return { id: asTaskId(id), rest: segments.slice(offset + 2), api };
};

const handleTask = async (
  options: ViewServerOptions,
  route: TaskRoute,
  user: string | undefined,
): Promise<Reply> => {
  const forward = user === undefined ? {} : { user };

  if (route.rest.length === 0) {
    const { value } = await options.aggregator.fromAny<TaskDetail>({
      ...forward,
      path: `/api/tasks/${route.id}`,
    });
    if (value === undefined) return notFound(options, user);
    return route.api ? json(200, value) : page(options, "fleet", value.id, taskPage(value), 200, user);
  }

  if (route.rest[0] === "artifacts" && route.rest.length === 2) {
    const name = route.rest[1] ?? "";
    if (!isArtifactName(name)) return notFound(options, user);

    const { body } = await options.aggregator.bytes({
      ...forward,
      path: `/api/tasks/${route.id}/artifacts/${name}`,
    });
    if (body === undefined) return notFound(options, user);

    // Agent-authored bytes, on the origin that also serves every transcript. The runner
    // already serves it this way; the content type is re-asserted rather than proxied,
    // because a header taken from upstream is a header an upstream bug can choose.
    return {
      status: 200,
      type: "application/octet-stream",
      body,
      headers: { "content-disposition": `attachment; filename="${name}"` },
    };
  }

  if (route.rest[0] === "sessions" && (route.rest.length === 2 || route.rest.length === 3)) {
    const ordinal = Number(route.rest[1]);
    if (!Number.isInteger(ordinal) || ordinal < 0) return notFound(options, user);

    if (route.rest[2] === "raw") {
      const { body } = await options.aggregator.bytes({
        ...forward,
        path: `/api/tasks/${route.id}/sessions/${ordinal}/raw`,
      });
      if (body === undefined) return notFound(options, user);
      return { status: 200, type: "text/plain; charset=utf-8", body };
    }
    if (route.rest.length === 3) return notFound(options, user);

    const { value } = await options.aggregator.fromAny<{
      readonly task: TaskId;
      readonly session: number;
      readonly entries: unknown[];
    }>({ ...forward, path: `/api/tasks/${route.id}/sessions/${ordinal}` });
    if (value === undefined) return notFound(options, user);

    if (route.api) return json(200, value);

    // The runner's `/api/tasks/<id>/sessions/<n>` already returns parsed entries, so this
    // renders them; `parseTranscript` stays imported for the raw path's tests to lean on
    // the same parser the runner used.
    const detail = await options.aggregator.fromAny<TaskDetail>({
      ...forward,
      path: `/api/tasks/${route.id}`,
    });
    return page(
      options,
      "fleet",
      `${route.id} · session ${ordinal}`,
      sessionPage({
        task: route.id,
        session: ordinal,
        sessions: detail.value?.sessions ?? [],
        entries: value.entries as ReturnType<typeof parseTranscript>,
      }),
      200,
      user,
    );
  }

  return notFound(options, user);
};

const forwardedUser = (
  options: ViewServerOptions,
  request: IncomingMessage,
): string | undefined => {
  const value = request.headers[options.forwardedUserHeader];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first.trim() === "") return undefined;
  return first.trim().slice(0, MAX_USER_CHARS);
};

const MAX_USER_CHARS = 64;

const decodePath = (url: string): string | undefined => {
  const withoutQuery = url.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return undefined;
  }
};

const page = (
  options: ViewServerOptions,
  current: Page,
  title: string,
  body: Html,
  status = 200,
  user?: string,
): Reply => {
  const chrome: Chrome = {
    // The viewer is not a runner and does not pretend to be one. What the rail names is
    // the thing an operator is actually looking at: an aggregate of every replica.
    runnerId: user === undefined ? "viewer · all runners" : `viewer · ${user}`,
    capabilities: [],
    current,
    title,
    ...(status === 200 ? { refresh: options.refreshSeconds } : {}),
  };

  return { status, type: "text/html; charset=utf-8", body: layout(chrome, body) };
};

const notFound = (options: ViewServerOptions, user: string | undefined): Reply =>
  page(options, "fleet", "not found", errorPage(404, "No such page."), 404, user);

/**
 * Nobody answered.
 *
 * 503 rather than 404, and it says which runners were tried and what each of them said.
 * "The fleet is unreachable" and "there is no such page" are different problems with
 * different fixes, and a viewer that conflated them would send an operator looking for a
 * typo during an outage.
 */
const unreachablePage = (
  options: ViewServerOptions,
  user: string | undefined,
  unreachable: readonly { readonly runner: string; readonly error: string }[],
): Reply =>
  page(
    options,
    "fleet",
    "no runner answered",
    errorPage(
      503,
      unreachable.length === 0
        ? "No runners were discovered. The headless Service should list one record per ready pod."
        : `No runner answered: ${unreachable.map((entry) => `${entry.runner} (${entry.error})`).join(", ")}`,
    ),
    503,
    user,
  );

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json; charset=utf-8",
  body: `${JSON.stringify(value, null, 2)}\n`,
});
