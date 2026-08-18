/**
 * The viewer over the wire, with real runner processes behind it.
 *
 * §18's rules are re-asserted here rather than assumed from `web/server.test.ts`: this is a
 * SECOND front door to agent-authored bytes, and "the shared module is fine" is exactly the
 * assumption that turns one hardened surface into two, one of which is not.
 *
 * The runners are real `http.Server`s serving canned `/api/*` bodies, so the fan-out uses
 * real sockets and the forwarded identity is observed as a header on the wire.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Aggregator } from "./aggregate.ts";
import { StaticDiscovery, type RunnerEndpoint } from "./discovery.ts";
import { Fanout } from "./fanout.ts";
import { createViewServer } from "./server.ts";

const closers: (() => Promise<void>)[] = [];

after(async () => {
  await Promise.all(closers.map((close) => close()));
});

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
};

interface FakeRunner {
  readonly endpoint: RunnerEndpoint;
  /** Every request the runner saw: path and the forwarded identity, if any. */
  readonly seen: { path: string; user?: string }[];
}

/** A runner that answers a table of paths, and 404s anything else. */
const fakeRunner = async (
  name: string,
  routes: Readonly<Record<string, unknown>>,
  options: { readonly requireForwardedUser?: boolean } = {},
): Promise<FakeRunner> => {
  const seen: { path: string; user?: string }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const header = request.headers["remote-user"];
    const user = Array.isArray(header) ? header[0] : header;
    seen.push({ path, ...(user === undefined ? {} : { user }) });

    if (options.requireForwardedUser === true && user === undefined) {
      response.writeHead(401).end("no identity\n");
      return;
    }

    const body = routes[path];
    if (body === undefined) {
      response.writeHead(404).end("nope\n");
      return;
    }
    if (typeof body === "string") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });

  const port = await listen(server);
  return { endpoint: { name, base: `http://127.0.0.1:${port}` }, seen };
};

const FLEET = {
  tasks: [
    {
      id: "TASK-1",
      title: "Fix the widget",
      kind: "implement",
      status: "running",
      phase: "implementing",
      sessions: 1,
      maxSessions: 20,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
      requires: [],
      noProgressStreak: 0,
      blockedBy: [],
      held: true,
      updatedAt: "2026-08-18T09:00:00.000Z",
    },
  ],
  counts: { running: 1 },
  runners: [],
  live: [
    {
      runner: "self-reported",
      task: "TASK-1",
      session: 2,
      model: "claude-opus-5",
      startedAt: "2026-08-18T08:00:00.000Z",
      messages: 7,
    },
  ],
};

const serve = async (
  runners: readonly RunnerEndpoint[],
  over: { readonly requireForwardedUser?: boolean } = {},
): Promise<string> => {
  const server = createViewServer({
    aggregator: new Aggregator({
      discovery: new StaticDiscovery(runners),
      fanout: new Fanout({ timeoutMs: 500, forwardedUserHeader: "remote-user" }),
    }),
    logger: SILENT_LOGGER,
    requireForwardedUser: over.requireForwardedUser ?? false,
    forwardedUserHeader: "remote-user",
    refreshSeconds: 10,
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
};

/** One request, byte for byte — `fetch` normalises a path and this server may not rely on it. */
const rawRequest = (base: string, requestLine: string): Promise<string> => {
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

test("nothing on the viewer accepts a write, and the refusal precedes routing", async () => {
  // Refused BEFORE routing, so there is no handler a write could reach even if one were
  // added by accident — and the path in the request is one that does not exist, to prove
  // the 405 does not depend on having found a route first.
  const url = await serve([]);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/", "/api/fleet", "/no/such/page"]) {
      const response = await fetch(`${url}${path}`, { method });
      assert.equal(response.status, 405, `${method} ${path} must be refused`);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
  }
});

test("the viewer forwards the identity the proxy vouched for, and fails closed without one", async () => {
  // The runners' `requireForwardedUser` stays exactly as strong: a runner's port is still
  // useless to anything in the cluster that cannot present an identity Authelia signed for.
  const runner = await fakeRunner("caterpillar-0", { "/api/fleet": FLEET }, {
    requireForwardedUser: true,
  });
  const url = await serve([runner.endpoint], { requireForwardedUser: true });

  const anonymous = await fetch(`${url}/`);
  assert.equal(anonymous.status, 401);
  assert.equal(runner.seen.length, 0, "an unauthenticated request never reaches a runner");

  const vouched = await fetch(`${url}/`, { headers: { "remote-user": "caesar" } });
  assert.equal(vouched.status, 200);
  assert.deepEqual(runner.seen, [{ path: "/api/fleet", user: "caesar" }]);
  assert.match(await vouched.text(), /Fix the widget/);
});

test("the fleet page names the replica that did not answer", async () => {
  // A dashboard that silently drops a replica is worse than one that has none: a missing
  // runner renders as an idle runner, and "three of the four are idle" gets acted on.
  const up = await fakeRunner("caterpillar-0", { "/api/fleet": FLEET });
  const url = await serve([
    up.endpoint,
    // Nothing is listening on this one. A closed port fails fast, which is the honest
    // version of a replica that has gone away between DNS answers.
    { name: "caterpillar-1", base: "http://127.0.0.1:1" },
  ]);

  const body = await (await fetch(`${url}/`)).text();
  assert.match(body, /unreachable/);
  assert.match(body, /caterpillar-1/);
  // And the runner that DID answer is still rendered, with its live session named by pod.
  assert.match(body, /caterpillar-0/);
  assert.match(body, /is running on caterpillar-0/);
});

test("/api/fleet carries the merged view plus who could not be reached", async () => {
  const up = await fakeRunner("caterpillar-0", { "/api/fleet": FLEET });
  const url = await serve([up.endpoint, { name: "caterpillar-1", base: "http://127.0.0.1:1" }]);

  const response = await fetch(`${url}/api/fleet`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    live: { runner: string }[];
    unreachable: { runner: string }[];
    source: string;
  };

  assert.deepEqual(body.live.map((entry) => entry.runner), ["caterpillar-0"]);
  assert.deepEqual(body.unreachable.map((entry) => entry.runner), ["caterpillar-1"]);
  assert.equal(body.source, "caterpillar-0");
});

test("an artifact is an attachment nothing renders, on the viewer too", async () => {
  // Agent-authored bytes on the origin that serves every transcript. The runner already
  // serves it this way; the viewer re-asserts the headers rather than proxying them,
  // because a header taken from upstream is a header an upstream bug can choose.
  const runner = await fakeRunner("caterpillar-0", {
    "/api/tasks/TASK-1/artifacts/report.html": "<script>alert(1)</script>",
  });
  const url = await serve([runner.endpoint]);

  const response = await fetch(`${url}/tasks/TASK-1/artifacts/report.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="report\.html"/);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("a task id or artifact name that could climb out of a path is refused here as well", async () => {
  // `isTaskId` and `isArtifactName` are applied again in this process, because it BUILDS a
  // URL from the segment and a `..` would climb out of `/api/tasks/` on the runner it is
  // sent to. Writing this view is what found that `isTaskId` accepted `..` in the first
  // place (§18).
  const runner = await fakeRunner("caterpillar-0", { "/api/fleet": FLEET });
  const url = await serve([runner.endpoint]);

  const traversal = await rawRequest(url, "GET /tasks/../../etc/passwd HTTP/1.1");
  assert.match(traversal, /^HTTP\/1\.1 404/);

  const artifact = await fetch(`${url}/tasks/TASK-1/artifacts/..%2f..%2fspec.md`);
  assert.equal(artifact.status, 404);

  // None of it reached a runner: the guard is here, not downstream.
  assert.deepEqual(runner.seen.filter((entry) => entry.path.includes("..")), []);
});

test("the security headers and the read-only CSP are the runners', byte for byte", async () => {
  const url = await serve([]);
  const response = await fetch(`${url}/`);

  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("/healthz answers before the auth gate, or the kubelet restarts a healthy pod forever", async () => {
  const url = await serve([], { requireForwardedUser: true });

  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("a page with no runner behind it is 503 with the reason, not 404", async () => {
  // "The fleet is unreachable" and "there is no such page" are different problems with
  // different fixes, and conflating them sends an operator looking for a typo mid-outage.
  const url = await serve([{ name: "caterpillar-0", base: "http://127.0.0.1:1" }]);

  const response = await fetch(`${url}/intake`);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /No runner answered/);
});

test("the log page merges the rings and tags each line with its process", async () => {
  const first = await fakeRunner("caterpillar-0", {
    "/api/logs": {
      records: [{ ts: "2026-08-18T09:00:02.000Z", level: "info", event: "poll.tick", fields: {} }],
    },
  });
  const second = await fakeRunner("caterpillar-1", {
    "/api/logs": {
      records: [
        { ts: "2026-08-18T09:00:01.000Z", level: "warn", event: "intake.rejected", fields: {} },
      ],
    },
  });
  const url = await serve([first.endpoint, second.endpoint]);

  const body = await (await fetch(`${url}/logs`)).text();
  assert.match(body, /2 runner\(s\) answered/);
  assert.match(body, /poll\.tick/);
  assert.match(body, /intake\.rejected/);
  assert.ok(
    body.indexOf("poll.tick") < body.indexOf("intake.rejected"),
    "newest first, across rings rather than one ring after another",
  );
});

test("a task, its session and a digest are proxied from the runner that has them", async () => {
  // The state repo is identical on every replica, so these come from the first healthy
  // responder. What the viewer must not do is invent any of it: every one of these pages is
  // the runner's own template rendering the runner's own view model.
  const runner = await fakeRunner("caterpillar-0", {
    "/api/fleet": FLEET,
    "/api/tasks/TASK-1": {
      id: "TASK-1",
      title: "Fix the widget",
      state: {
        id: "TASK-1",
        status: "running",
        phase: "implementing",
        requires: [],
        sessions: 2,
        limits: { maxSessions: 20 },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
        progress: { lastProgressSession: 1, noProgressStreak: 0 },
        createdAt: "2026-08-18T08:00:00.000Z",
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
      questions: [],
      verdicts: [],
      artifacts: [],
      sessions: [1],
    },
    "/api/tasks/TASK-1/sessions/1": {
      task: "TASK-1",
      session: 1,
      entries: [{ index: 0, role: "assistant", text: "hello from the transcript", calls: [] }],
    },
    "/api/tasks/TASK-1/sessions/1/raw": '{"role":"assistant"}\n',
    "/api/digests": { dates: ["2026-08-17"] },
    "/api/digests/2026-08-17": { date: "2026-08-17", body: "# Digest\n\nSomething happened." },
    "/api/runner": {
      runnerId: "caterpillar-0",
      capabilities: ["linux"],
      pollSeconds: 30,
      lease: { heartbeatSeconds: 60, staleAfterSeconds: 300 },
      handoff: { thresholdFraction: 0.7 },
      limits: { maxSessionsPerTask: 20, noProgressLimit: 3, maxReviewRounds: 3, maxSessionSeconds: 3600 },
      llm: {
        auth: "proxy",
        modelId: "claude-opus-5",
        providerId: "anthropic",
        contextWindow: 200000,
        maxTokens: 32000,
        cooldown: { initialSeconds: 60, maxSeconds: 3600 },
      },
      toolchain: { nixpkgs: "pin", timeoutSeconds: 900, gcIntervalHours: 24, gcKeepDays: 7 },
      stateRepo: { url: "https://example.invalid/state.git", branch: "main", path: "/work/state" },
      paths: { mirrors: "/work/mirrors", tasks: "/work/tasks", root: "/work" },
      usage: { intervalHours: 1, deadlineSeconds: 120 },
      intake: { intervalSeconds: 300 },
      remediation: { enabled: true, port: 8081 },
      cluster: { enabled: true, namespaces: ["caterpillar"], maxLogLines: 500 },
      log: { level: "info" },
      workspaces: [],
    },
  });
  const url = await serve([runner.endpoint]);

  const task = await (await fetch(`${url}/tasks/TASK-1`)).text();
  assert.match(task, /Fix the widget/);

  const session = await (await fetch(`${url}/tasks/TASK-1/sessions/1`)).text();
  assert.match(session, /hello from the transcript/);

  // The raw transcript keeps its bytes and its type: re-encoding it would change what an
  // operator downloaded.
  const rawTranscript = await fetch(`${url}/tasks/TASK-1/sessions/1/raw`);
  assert.match(rawTranscript.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(await rawTranscript.text(), '{"role":"assistant"}\n');

  const digest = await (await fetch(`${url}/digests/2026-08-17`)).text();
  assert.match(digest, /Something happened\./);

  const runnerPageBody = await (await fetch(`${url}/runner`)).text();
  assert.match(runnerPageBody, /Read from caterpillar-0/);
  // The alert half of the page, which said nothing until `/intake` needed it.
  assert.match(runnerPageBody, /listening<\/span> on port 8081/);
});
