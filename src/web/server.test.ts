/**
 * End-to-end tests for the web view (DESIGN.md §18).
 *
 * A real `http.Server` on a real port, driven with real `fetch`. Everything worth
 * asserting here is a property of the WIRE — the status code a write attempt gets, the
 * headers that stop a transcript becoming script, the body a path-traversal attempt is
 * answered with — and none of it is visible to a test that calls a handler function.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import { asTaskId, asWorkspaceName, type TaskSpec, type TaskState } from "../domain/task.ts";
import { LiveSession } from "../obs/live.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { LogRing } from "../obs/ring.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";
import { createWebServer } from "./server.ts";

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

after(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const config = (over: Partial<RunnerConfig["web"]> = {}): RunnerConfig => ({
  runnerId: "pod-test",
  capabilities: ["linux"],
  identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  toolchain: {
    nixpkgs: "github:NixOS/nixpkgs/pin",
    timeoutSeconds: 900,
    gcIntervalHours: 24,
    gcKeepDays: 7,
    substituters: [],
    trustedPublicKeys: [],
  },
  stateRepo: {
    url: "https://example.invalid/state.git",
    branch: "main",
    path: "/work/state",
    secretRef: "caterpillar-github-app",
  },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks", root: "/work" },
  usage: { intervalHours: 1, deadlineSeconds: 120 },
  lease: { heartbeatSeconds: 60, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: { maxSessionsPerTask: 20, noProgressLimit: 3, maxReviewRounds: 3, maxSessionSeconds: 14_400, commandTimeoutSeconds: 900 },
  log: { level: "info" },
  intake: { intervalSeconds: 300 },
  llm: {
    auth: "subscription",
    baseUrl: "http://llm-proxy",
    modelId: "claude-opus-5",
    providerId: "anthropic",
    contextWindow: 200_000,
    maxTokens: 32_000,
    cooldown: { initialSeconds: 60, maxSeconds: 3600 },
    credentialsPath: "/work/llm/credentials.json",
  },
  workspaces: new Map([
    [
      asWorkspaceName("caesar"),
      {
        name: asWorkspaceName("caesar"),
        forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
        secretRef: "caterpillar-github-app",
      },
    ],
  ]),
  pollSeconds: 30,
  secretsDir: "/etc/caterpillar/secrets",
  digest: { enabled: true, hour: 18, timeZone: "Europe/Berlin", summarise: true },
  cluster: {
    enabled: false,
    namespaces: [],
    lokiUrl: "http://loki.invalid",
    kubeApiUrl: "https://kube.invalid",
    maxLogLines: 2000,
  },
  remediation: { enabled: false, port: 8081 },
  redis: {
    enabled: false,
    url: "redis://localhost:6379",
    commandTimeoutMs: 1000,
    keyPrefix: "caterpillar:",
  },
  web: {
    enabled: true,
    port: 0,
    logCapacity: 500,
    refreshSeconds: 10,
    requireForwardedUser: false,
    forwardedUserHeader: "remote-user",
    ...over,
  },
});

const state = (id: string, over: Partial<TaskState> = {}): TaskState => ({
  id: asTaskId(id),
  status: "running",
  phase: "implementing",
  requires: ["linux"],
  sessions: 1,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.25 },
  progress: { lastProgressSession: 1, noProgressStreak: 0 },
  createdAt: "2026-08-16T08:00:00.000Z",
  updatedAt: "2026-08-16T09:00:00.000Z",
  ...over,
});

const spec = (id: string, goal: string): TaskSpec => ({
  id: asTaskId(id),
  workspace: asWorkspaceName("caesar"),
  kind: "implement",
  goal,
  repos: [{ host: "github.com", owner: "acme", name: "widget" }],
  requires: ["linux"],
  acceptance: ["npm test"],
});

/**
 * One request, byte for byte, with nothing between the test and the server.
 *
 * `fetch` normalises a path before sending it. That is a client courtesy this server may
 * not depend on, so the traversal test writes the request line itself.
 */
const raw = (base: string, requestLine: string): Promise<string> => {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(`${requestLine}\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
};

interface Harness {
  readonly url: string;
  readonly store: StateStore;
  readonly live: LiveSession;
  readonly ring: LogRing;
}

const serve = async (
  over: Partial<RunnerConfig["web"]> = {},
  usage?: WorkspaceUsage,
): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-web-"));
  roots.push(root);

  const store = new StateStore(root, new Git(root));
  const live = new LiveSession();
  const ring = new LogRing(500);
  const server = createWebServer({
    config: config(over),
    store,
    live,
    ring,
    logger: SILENT_LOGGER,
    // Only `current()`: the server is given a reader, never the monitor, so no request can
    // start a walk. The measurement is idle-only for a reason.
    usage: { current: () => usage },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, store, live, ring };
};

test("the fleet page renders the tasks in the state repo", async () => {
  const harness = await serve();
  await harness.store.writeSpec(spec("TASK-1", "# Fix the widget"));
  await harness.store.writeState(state("TASK-1"));

  const response = await fetch(`${harness.url}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);

  const body = await response.text();
  assert.match(body, /Fix the widget/);
  assert.match(body, /TASK-1/);
});

test("nothing on this server accepts a write", async () => {
  // The read-only guarantee is a property of the routing as well as of the code behind
  // it: there is no handler a POST could reach even if one were added by accident.
  const harness = await serve();

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${harness.url}/`, { method });
    assert.equal(response.status, 405, `${method} must be refused`);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

test("every response carries the headers that stop agent prose becoming script", async () => {
  const harness = await serve();
  const response = await fetch(`${harness.url}/`);

  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("unsafe-inline"), "inline script and style must stay forbidden");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("a goal containing markup is escaped, not executed", async () => {
  const harness = await serve();
  await harness.store.writeSpec(spec("TASK-XSS", "# <script>alert(1)</script>\n\nbody"));
  await harness.store.writeState(state("TASK-XSS"));

  const body = await (await fetch(`${harness.url}/tasks/TASK-XSS`)).text();
  assert.ok(!body.includes("<script>alert(1)</script>"), "the tag must not survive");
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("an unknown path and an unknown task are both a plain 404", async () => {
  const harness = await serve();

  assert.equal((await fetch(`${harness.url}/nope`)).status, 404);
  assert.equal((await fetch(`${harness.url}/tasks/TASK-MISSING`)).status, 404);
});

test("a task id that is not a task id never reaches the file system", async () => {
  // Task ids are directory names. `isTaskId` is the same guard the chat commands use.
  //
  // Sent over a raw socket, not with `fetch`. A standards-compliant URL parser collapses
  // `..` AND `%2e%2e` before the request leaves, so a fetch-based test would be asserting
  // on the client's normaliser and would pass with the guard removed. The server may not
  // rely on a client having done that.
  const harness = await serve();

  // The targets are the ones that matter HERE: `tasks/<id>` is one level below the state
  // repo root, so `..` reaches the task tree and `../..` reaches the checkout itself —
  // its `.git/config`, its intake records, every other task. Nothing needs to reach out
  // of the repo for this to be worth refusing.
  for (const attempt of ["..", ".", "%2e%2e", "..%2f..%2f.git%2fconfig", "a%2fb", "TASK%201"]) {
    const response = await raw(harness.url, `GET /tasks/${attempt} HTTP/1.1`);
    assert.match(response, /^HTTP\/1\.1 404 /, `${attempt} must be refused`);
  }
});

test("an artifact is served as a download, never as a page on this origin", async () => {
  // An artifact is agent-authored bytes. Served as text/html on the same origin as the
  // transcripts it would be script; served as an attachment it is a file.
  const harness = await serve();
  const id = asTaskId("TASK-ART");
  await harness.store.writeSpec(spec("TASK-ART", "# Artifacts"));
  await harness.store.writeState(state("TASK-ART"));
  await harness.store.writeArtifact(id, "probe.json", Buffer.from(`{"ok":true}`));

  const response = await fetch(`${harness.url}/tasks/TASK-ART/artifacts/probe.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(await response.text(), `{"ok":true}`);

  assert.equal((await fetch(`${harness.url}/tasks/TASK-ART/artifacts/..%2f..%2fstate.json`)).status, 404);
  assert.equal((await fetch(`${harness.url}/tasks/TASK-ART/artifacts/missing.txt`)).status, 404);
});

test("a stored session renders, and its raw transcript is served as plain text", async () => {
  const harness = await serve();
  const id = asTaskId("TASK-SESS");
  await harness.store.writeSpec(spec("TASK-SESS", "# Sessions"));
  await harness.store.writeState(state("TASK-SESS"));
  await harness.store.writeSessionTranscript(
    id,
    1,
    JSON.stringify({ role: "user", content: "run the tests", timestamp: 1_760_000_000_000 }),
  );

  const page = await fetch(`${harness.url}/tasks/TASK-SESS/sessions/1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /run the tests/);

  const raw = await fetch(`${harness.url}/tasks/TASK-SESS/sessions/1/raw`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await raw.text(), /run the tests/);

  assert.equal((await fetch(`${harness.url}/tasks/TASK-SESS/sessions/9`)).status, 404);
  assert.equal((await fetch(`${harness.url}/tasks/TASK-SESS/sessions/abc`)).status, 404);
});

test("the session running right now is visible before its transcript exists", async () => {
  // This is the whole reason the live tap exists: a session runs for tens of minutes and
  // writes its file only at the end.
  const harness = await serve();
  await harness.store.writeSpec(spec("TASK-LIVE", "# Live"));
  await harness.store.writeState(state("TASK-LIVE"));

  harness.live.begin({
    task: asTaskId("TASK-LIVE"),
    session: 2,
    model: "claude-opus-5",
    startedAt: "2026-08-16T10:00:00.000Z",
  });
  harness.live.record({ role: "user", content: "the in-flight message", timestamp: 0 });

  const body = await (await fetch(`${harness.url}/tasks/TASK-LIVE`)).text();
  assert.match(body, /the in-flight message/);
  assert.match(body, /Live session 2/);
});

test("the log view shows what this process wrote", async () => {
  const harness = await serve();
  harness.ring.push(`{"task":"TASK-1","ts":"2026-08-16T09:00:00.000Z","level":"warn","event":"task.parked"}\n`);

  const body = await (await fetch(`${harness.url}/logs`)).text();
  assert.match(body, /task\.parked/);
  assert.match(body, /TASK-1/);
});

test("the runner page and its json never carry a path to a credential", async () => {
  const harness = await serve();

  for (const path of ["/runner", "/api/runner"]) {
    const body = await (await fetch(`${harness.url}${path}`)).text();
    assert.ok(!body.includes("/etc/caterpillar/secrets"), `${path} leaked the secrets dir`);
    assert.ok(!body.includes("credentials.json"), `${path} leaked the credential path`);
  }
});

test("the json endpoints answer with json", async () => {
  const harness = await serve();
  await harness.store.writeSpec(spec("TASK-J", "# Json"));
  await harness.store.writeState(state("TASK-J"));

  const fleet = await fetch(`${harness.url}/api/fleet`);
  assert.match(fleet.headers.get("content-type") ?? "", /application\/json/);
  const parsed = (await fleet.json()) as { tasks: { id: string }[] };
  assert.equal(parsed.tasks[0]?.id, "TASK-J");

  const task = await fetch(`${harness.url}/api/tasks/TASK-J`);
  assert.equal(task.status, 200);
  assert.equal((await fetch(`${harness.url}/api/tasks/TASK-NOPE`)).status, 404);
});

test("the assets are served from this origin with their own content types", async () => {
  const harness = await serve();

  const css = await fetch(`${harness.url}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  const js = await fetch(`${harness.url}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
});

test("healthz answers without touching the state repo", async () => {
  const harness = await serve();
  const response = await fetch(`${harness.url}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("with requireForwardedUser, a request that did not come through the proxy is refused", async () => {
  // The realistic failure is an Ingress whose forward-auth annotations are dropped, which
  // publishes every transcript and looks like a working deployment.
  const harness = await serve({ requireForwardedUser: true });

  const bare = await fetch(`${harness.url}/`);
  assert.equal(bare.status, 401);

  const proxied = await fetch(`${harness.url}/`, { headers: { "remote-user": "caesar" } });
  assert.equal(proxied.status, 200);
  assert.match(await proxied.text(), /caesar/, "the page names who it thinks you are");
});

test("healthz answers even when a forwarded user is required, or the probe fails", async () => {
  // The kubelet does not go through the Ingress. A liveness probe that gets 401 restarts
  // a healthy pod forever.
  const harness = await serve({ requireForwardedUser: true });
  assert.equal((await fetch(`${harness.url}/healthz`)).status, 200);
});

test("a forwarded user is clipped before it is rendered", async () => {
  // The header is attacker-controllable in length. It is escaped like every other string
  // on the page, so the risk is not markup — it is a header-sized name in the rail.
  const harness = await serve();
  const response = await fetch(`${harness.url}/`, { headers: { "remote-user": "a".repeat(5000) } });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes("a".repeat(100)), "the name must not be rendered at full length");
});

test("a published digest is served as it was published", async () => {
  // The page serves the stored document rather than re-deriving the day. It is the record
  // of what Discord was sent, and a page that recomputed it would disagree with the
  // message the moment either renderer changed.
  const harness = await serve();
  await harness.store.writeDigest("2026-08-16", "# Daily digest — 2026-08-16\n\n2 done · $7.40\n");
  await harness.store.writeDigest("2026-08-15", "# Daily digest — 2026-08-15\n\nNothing moved.\n");

  const list = await (await fetch(`${harness.url}/digests`)).text();
  assert.match(list, /2026-08-16/);
  assert.match(list, /2026-08-15/);

  const page = await (await fetch(`${harness.url}/digests/2026-08-16`)).text();
  assert.match(page, /2 done · \$7\.40/);

  const api = (await (await fetch(`${harness.url}/api/digests`)).json()) as {
    readonly dates: readonly string[];
  };
  assert.deepEqual(api.dates, ["2026-08-16", "2026-08-15"], "newest first");
});

test("a date that is not a date never reaches the file system", async () => {
  // Same rule as a task id, same reason: `digests/<date>.md` is a path built from a URL
  // segment, and `..` is a legal directory name that resolves to the state repo root.
  const harness = await serve();

  for (const attempt of ["..", "%2e%2e", "..%2f..%2f.git%2fconfig", "2026-8-1", "2026-08-16x"]) {
    const response = await raw(harness.url, `GET /digests/${attempt} HTTP/1.1`);
    assert.match(response, /^HTTP\/1\.1 404 /, `${attempt} must be refused`);
  }
});

test("the digests page is there before any digest is", async () => {
  const harness = await serve();
  const list = await (await fetch(`${harness.url}/digests`)).text();

  assert.match(list, /No digest has been published yet/);
});

test("the runner page shows the work volume once it has been measured", async () => {
  const harness = await serve(
    {},
    {
      measuredAt: "2026-08-18T09:00:00.000Z",
      durationMs: 4200,
      partial: false,
      fs: { totalBytes: 100 * 1024 ** 3, freeBytes: 40 * 1024 ** 3 },
      mirrorBytes: 5 * 1024 ** 3,
      taskBytes: 30 * 1024 ** 3,
      nixBytes: 20 * 1024 ** 3,
      otherBytes: 0,
      mirrors: [{ name: "acme/widget", bytes: 5 * 1024 ** 3 }],
      tasks: [{ name: "TASK-BIG", bytes: 30 * 1024 ** 3 }],
    },
  );

  const page = await (await fetch(`${harness.url}/runner`)).text();
  assert.match(page, /<h2>Disk<\/h2>/);
  assert.match(page, /TASK-BIG/);
  assert.match(page, /40\.0 GiB/);

  const json = (await (await fetch(`${harness.url}/api/runner`)).json()) as {
    disk?: { usedBytes: number; tasks: { name: string }[] };
  };
  assert.equal(json.disk?.usedBytes, 60 * 1024 ** 3);
  assert.equal(json.disk?.tasks[0]?.name, "TASK-BIG");
});

test("before the first measurement the runner json simply has no disk key", async () => {
  // Absent rather than zeroed: "nobody has walked the volume yet" and "the volume is
  // empty" are different facts, and only one of them is ever true here.
  const harness = await serve();

  const json = (await (await fetch(`${harness.url}/api/runner`)).json()) as { disk?: unknown };
  assert.equal(json.disk, undefined);
  assert.match(await (await fetch(`${harness.url}/runner`)).text(), /Not measured yet/);
});
