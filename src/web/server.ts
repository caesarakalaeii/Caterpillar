/**
 * The read-only web view. See DESIGN.md §18.
 *
 * It runs INSIDE the supervisor rather than as its own Deployment, and that is the
 * decision everything else follows from. A separate process would need its own clone of
 * the state repo and its own credential to keep it fresh, and it still could not show the
 * two things this exists for — the log the process is writing and the session it is
 * running — because both live in this process's memory.
 *
 * Its own port, not the metrics port. The Ingress publishes exactly one, and the
 * ServiceMonitor scrapes the other; keeping them apart is what makes "what is exposed"
 * answerable by reading a Service.
 *
 * READ ONLY, three times over, because one guarantee that rests on a single mechanism is
 * a guarantee that ends the day someone adds a route:
 *   1. anything that is not GET or HEAD is refused before routing (405),
 *   2. every handler reads through `view.ts`, which touches nothing that writes,
 *   3. the process holds no forge token while serving — the credential service refuses
 *      to answer outside a session by design (§9.2).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RunnerConfig } from "../config/types.ts";
import { asTaskId, isTaskId, type TaskId } from "../domain/task.ts";
import type { LiveSession } from "../obs/live.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { LogRing } from "../obs/ring.ts";
import { isArtifactName, type StateStore } from "../state/store.ts";
import { SCRIPT, STYLESHEET } from "./assets.ts";
import type { Html } from "./html.ts";
import {
  digestPage,
  digestsPage,
  errorPage,
  fleetPage,
  layout,
  logsPage,
  runnerPage,
  sessionPage,
  taskPage,
  type Chrome,
  type Page,
} from "./pages.ts";
import { parseTranscript } from "./transcript.ts";
import { digests, digestView, diskView, fleet, runnerExport, taskDetail } from "./view.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";

/**
 * The last work-volume measurement, if one has been taken. Implemented by `UsageMonitor`.
 *
 * A reader rather than the monitor itself, so the server depends on "something that can
 * tell me the last snapshot" and cannot reach the method that STARTS a walk. A web request
 * must never be able to trigger the expensive thing: it is idle-only for a reason, and a
 * route that could kick it off would be a way for anyone with the page open to take the
 * poll loop away from the fleet.
 */
export interface UsageSnapshotReader {
  current(): WorkspaceUsage | undefined;
}

export interface WebServerOptions {
  readonly config: RunnerConfig;
  readonly store: StateStore;
  readonly live: LiveSession;
  readonly ring: LogRing;
  readonly logger: Logger;
  /** Absent on a runner with the measurement disabled; the page then says so. */
  readonly usage?: UsageSnapshotReader;
}

interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The second line of defence behind `html.ts`.
 *
 * `default-src 'none'` means a page that somehow contained agent-authored markup still
 * cannot fetch, connect or frame anything. No `unsafe-inline`, which is why the
 * stylesheet and the script are routes rather than inline blocks. `data:` is allowed for
 * images only, for the empty favicon.
 */
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
  // Nothing here is cacheable: it is live state, and it is private.
  "cache-control": "no-store",
};

export const createWebServer = (options: WebServerOptions): Server =>
  createServer((request, response) => {
    void respond(options, request, response);
  });

const respond = async (
  options: WebServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let reply: Reply;
  try {
    reply = await route(options, request);
  } catch (error: unknown) {
    // A page must never take the supervisor down, and the operator must still be told.
    options.logger.error("web.failed", { path: request.url ?? "", ...errorFields(error) });
    reply = page(options, "fleet", "error", errorPage(500, "Something failed while rendering this."), 500);
  }

  response.writeHead(reply.status, {
    "content-type": reply.type,
    ...SECURITY_HEADERS,
    ...reply.headers,
  });
  // HEAD must produce the same headers and no body — a probe or a link checker uses it.
  response.end(request.method === "HEAD" ? undefined : reply.body);
};

const route = async (options: WebServerOptions, request: IncomingMessage): Promise<Reply> => {
  const method = request.method ?? "GET";
  const path = decodePath(request.url ?? "/");

  // Answered before anything else, including the auth gate: the kubelet probes this pod
  // directly and never goes through the Ingress, so a probe that gets 401 restarts a
  // healthy container forever.
  if (path === "/healthz") return { status: 200, type: "text/plain; charset=utf-8", body: "ok" };

  if (method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      type: "text/plain; charset=utf-8",
      body: "this view is read-only\n",
      headers: { allow: "GET, HEAD" },
    };
  }

  const user = forwardedUser(options.config, request);
  if (options.config.web.requireForwardedUser && user === undefined) {
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

  const { config, store, live, ring } = options;

  if (path === "/") {
    return page(options, "fleet", "fleet", fleetPage(await fleet({ store, live, runnerId: config.runnerId })), 200, user);
  }
  if (path === "/logs") {
    return page(options, "logs", "logs", logsPage(ring.records(), config.web.logCapacity), 200, user);
  }
  if (path === "/runner") {
    const disk = options.usage?.current();
    return page(
      options,
      "runner",
      config.runnerId,
      runnerPage(runnerExport(config), disk === undefined ? undefined : diskView(disk)),
      200,
      user,
    );
  }

  // `/digests` and `/digests/<date>`. The date is validated by the store before it ever
  // becomes a path (`isDigestDate`), so anything else simply has no digest and 404s.
  if (path === "/digests") {
    return page(options, "digests", "digests", digestsPage(await digests(store)), 200, user);
  }
  if (path.startsWith("/digests/")) {
    const view = await digestView(store, path.slice("/digests/".length));
    if (view === undefined) return notFound(options, user);
    return page(options, "digests", `digest ${view.date}`, digestPage(view), 200, user);
  }

  if (path === "/api/fleet") return json(200, await fleet({ store, live, runnerId: config.runnerId }));
  if (path === "/api/digests") return json(200, { dates: await digests(store) });
  if (path.startsWith("/api/digests/")) {
    const view = await digestView(store, path.slice("/api/digests/".length));
    return view === undefined
      ? notFound(options, user)
      : json(200, { date: view.date, body: view.body });
  }
  if (path === "/api/runner") {
    // The disk is a sibling key rather than folded into the export: `runnerExport` is a
    // pure function of the ConfigMap and stays that way, while this is a measurement that
    // may simply not exist yet.
    const disk = options.usage?.current();
    return json(200, {
      ...runnerExport(config),
      ...(disk === undefined ? {} : { disk: diskView(disk) }),
    });
  }
  if (path === "/api/logs") return json(200, { records: ring.records() });

  const task = taskRoute(path);
  if (task !== undefined) return handleTask(options, task, user);

  return notFound(options, user);
};

/** The parts of a `/tasks/...` or `/api/tasks/...` path, once the id has been validated. */
interface TaskRoute {
  readonly id: TaskId;
  readonly rest: readonly string[];
  readonly api: boolean;
}

const taskRoute = (path: string): TaskRoute | undefined => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const api = segments[0] === "api";
  const offset = api ? 1 : 0;
  if (segments[offset] !== "tasks") return undefined;

  const id = segments[offset + 1];
  // The same guard the chat commands use: an id is a directory name under `tasks/`, and
  // this one arrives from a URL.
  if (id === undefined || !isTaskId(id)) return undefined;

  return { id: asTaskId(id), rest: segments.slice(offset + 2), api };
};

const handleTask = async (
  options: WebServerOptions,
  route: TaskRoute,
  user: string | undefined,
): Promise<Reply> => {
  const { store, live } = options;
  const detail = await taskDetail(store, route.id, live);
  if (detail === undefined) return notFound(options, user);

  if (route.rest.length === 0) {
    return route.api
      ? json(200, detail)
      : page(options, "fleet", detail.id, taskPage(detail), 200, user);
  }

  if (route.rest[0] === "artifacts" && route.rest.length === 2) {
    const name = route.rest[1] ?? "";
    if (!isArtifactName(name)) return notFound(options, user);

    const contents = await store.readArtifact(route.id, name);
    if (contents === undefined) return notFound(options, user);

    // An artifact is agent-authored bytes. Served as an attachment with a type that
    // nothing renders, it is a file; served as anything else it would be content on the
    // origin that also serves every transcript.
    return {
      status: 200,
      type: "application/octet-stream",
      body: contents,
      headers: { "content-disposition": `attachment; filename="${name}"` },
    };
  }

  if (route.rest[0] === "sessions" && (route.rest.length === 2 || route.rest.length === 3)) {
    const ordinal = Number(route.rest[1]);
    const jsonl = await store.readSessionTranscript(route.id, ordinal);
    if (jsonl === undefined) return notFound(options, user);

    if (route.rest[2] === "raw") {
      return { status: 200, type: "text/plain; charset=utf-8", body: jsonl };
    }
    if (route.rest.length === 3) return notFound(options, user);

    const entries = parseTranscript(jsonl);
    if (route.api) return json(200, { task: route.id, session: ordinal, entries });

    return page(
      options,
      "fleet",
      `${detail.id} · session ${ordinal}`,
      sessionPage({ task: route.id, session: ordinal, sessions: detail.sessions, entries }),
      200,
      user,
    );
  }

  return notFound(options, user);
};

/**
 * The identity the authenticating proxy vouched for, if it sent one.
 *
 * Shown in the rail, and — when `requireForwardedUser` is on — required. It is not
 * authentication: anything inside the cluster can set a header. See `WebConfig`.
 */
const forwardedUser = (config: RunnerConfig, request: IncomingMessage): string | undefined => {
  const value = request.headers[config.web.forwardedUserHeader];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first.trim() === "") return undefined;

  // Clipped because it is rendered. It is escaped by `html.ts` like everything else, so
  // the risk is not markup — it is a header-sized name in the rail of every page.
  return first.trim().slice(0, MAX_USER_CHARS);
};

/** A username is a username. Anything longer arrived from something that is not Authelia. */
const MAX_USER_CHARS = 64;

/**
 * The path, or nothing when it will not decode.
 *
 * A malformed percent-escape throws in `decodeURIComponent`, and the answer to one is
 * 404 rather than a 500 in the log every scanner can trigger.
 */
const decodePath = (url: string): string | undefined => {
  const withoutQuery = url.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return undefined;
  }
};

const page = (
  options: WebServerOptions,
  current: Page,
  title: string,
  body: Html,
  status = 200,
  user?: string,
): Reply => {
  const live = options.live.current();
  const chrome: Chrome = {
    runnerId: user === undefined ? options.config.runnerId : `${options.config.runnerId} · ${user}`,
    capabilities: options.config.capabilities,
    current,
    title,
    // A static page does not poll. The pages that show moving state do.
    ...(status === 200 ? { refresh: options.config.web.refreshSeconds } : {}),
    ...(live === undefined ? {} : { liveTask: live.task }),
  };

  return { status, type: "text/html; charset=utf-8", body: layout(chrome, body) };
};

const notFound = (options: WebServerOptions, user: string | undefined): Reply =>
  page(options, "fleet", "not found", errorPage(404, "No such page."), 404, user);

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json; charset=utf-8",
  body: `${JSON.stringify(value, null, 2)}\n`,
});
