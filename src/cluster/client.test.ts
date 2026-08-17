/**
 * Tests for the cluster read client (DESIGN.md §20).
 *
 * No test here touches the network: the kube API arrives through an injected `httpsGet`
 * and Loki through an injected `fetch`, the way `notify/http.ts` and `tracker/vikunja.ts`
 * already do it. That is not only hygiene — the central assertions of this file are
 * NEGATIVE ("the request was never made"), and those are only expressible against an
 * injected transport that can fail the test by being called.
 *
 * Three properties are worth more than the rest:
 *
 *   - a denied namespace never reaches the network, proved separately for all three
 *     methods, because "the guard runs first" is a claim about each method and not about
 *     the module;
 *   - nothing a model can say reaches a URL path or a LogQL selector unvalidated;
 *   - a missing token or CA fails loudly instead of downgrading TLS.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClusterClient,
  ClusterRequestError,
  ClusterUnavailableError,
  escapeForLogQL,
  type ClusterClientOptions,
  type HttpResponse,
  type HttpsGet,
} from "./client.ts";
import { NamespaceNotAllowedError } from "./guard.ts";
import { InvalidNameError } from "./names.ts";
import { UnsupportedKindError } from "./redact.ts";

const CREDENTIALS = { token: "sa-token", ca: "-----BEGIN CERTIFICATE-----" };

/** An `httpsGet` that must never be called. Any call fails the test that installed it. */
const forbiddenGet: HttpsGet = (options) => {
  assert.fail(`the kube API was reached at ${options.url} after the guard should have refused`);
};

/** A `fetch` that must never be called. */
const forbiddenFetch = (input: string): Promise<Response> => {
  assert.fail(`Loki was reached at ${input} after the guard should have refused`);
};

interface Recorder {
  readonly urls: string[];
  readonly get: HttpsGet;
}

const recordingGet = (responses: readonly HttpResponse[]): Recorder => {
  const urls: string[] = [];
  let index = 0;
  return {
    urls,
    get: (options) => {
      urls.push(options.url);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      assert.ok(response !== undefined, "no canned response left");
      return Promise.resolve(response);
    },
  };
};

const json = (body: unknown, status = 200): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});

interface LokiRecorder {
  readonly urls: string[];
  readonly headers: (Record<string, string> | undefined)[];
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const recordingFetch = (payload: unknown, status = 200): LokiRecorder => {
  const urls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  return {
    urls,
    headers,
    fetch: (input, init) => {
      urls.push(input);
      headers.push(init?.headers as Record<string, string> | undefined);
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
};

const client = (overrides: Partial<ClusterClientOptions> = {}): ClusterClient =>
  new ClusterClient({
    namespaces: ["caterpillar", "monitoring"],
    readCredentials: () => Promise.resolve(CREDENTIALS),
    httpsGet: forbiddenGet,
    fetch: forbiddenFetch,
    ...overrides,
  });

const nanos = (iso: string): string => `${new Date(iso).getTime()}000000`;

test("a denied namespace never reaches Loki", async () => {
  await assert.rejects(
    () => client().logs({ namespace: "kube-system" }),
    NamespaceNotAllowedError,
  );
});

test("a denied namespace never reaches the kube events API", async () => {
  await assert.rejects(
    () => client().events({ namespace: "kube-system" }),
    NamespaceNotAllowedError,
  );
});

test("a denied namespace never reaches the kube object API", async () => {
  await assert.rejects(
    () => client().describe({ kind: "Pod", name: "p", namespace: "kube-system" }),
    NamespaceNotAllowedError,
  );
});

test("an empty allowlist denies all three methods", async () => {
  const denied = client({ namespaces: [] });
  await assert.rejects(() => denied.logs({ namespace: "caterpillar" }), NamespaceNotAllowedError);
  await assert.rejects(() => denied.events({ namespace: "caterpillar" }), NamespaceNotAllowedError);
  await assert.rejects(
    () => denied.describe({ kind: "Pod", name: "p", namespace: "caterpillar" }),
    NamespaceNotAllowedError,
  );
});

test("the guard runs before credentials are even read", async () => {
  // Otherwise a runner outside the cluster would report "the token is missing" for a
  // request that was never permitted, which sends the operator to the wrong problem.
  const denied = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: forbiddenGet,
    fetch: forbiddenFetch,
    readCredentials: () => assert.fail("credentials were read for a denied namespace"),
  });

  await assert.rejects(
    () => denied.describe({ kind: "Pod", name: "p", namespace: "kube-system" }),
    NamespaceNotAllowedError,
  );
});

test("the LogQL selector is built from validated parts", async () => {
  const loki = recordingFetch({ data: { result: [] } });
  await client({ fetch: loki.fetch }).logs({ namespace: "caterpillar", pod: "caterpillar-0" });

  const url = new URL(loki.urls[0] ?? "");
  assert.equal(url.searchParams.get("query"), '{namespace="caterpillar", pod="caterpillar-0"}');
  assert.equal(url.pathname, "/loki/api/v1/query_range");
});

test("a trailing `.*` becomes a regex matcher and nothing else does", async () => {
  const loki = recordingFetch({ data: { result: [] } });
  await client({ fetch: loki.fetch }).logs({ namespace: "caterpillar", pod: "caterpillar-abc-.*" });

  const url = new URL(loki.urls[0] ?? "");
  assert.equal(
    url.searchParams.get("query"),
    '{namespace="caterpillar", pod=~"caterpillar-abc-.*"}',
  );
});

test("a pod name that could rewrite the query is refused, not escaped into working", async () => {
  const attacker = client({ fetch: forbiddenFetch });
  for (const pod of [
    'x"} | {namespace="kube-system',
    "x{y}",
    "pod|other",
    ".*",
    "caterpillar-.*-extra",
    "UPPER",
    "-leading",
    "trailing-",
    "a".repeat(254),
  ]) {
    await assert.rejects(
      () => attacker.logs({ namespace: "caterpillar", pod }),
      InvalidNameError,
      `pod '${pod}' was accepted`,
    );
  }
});

test("the refusal for a bad pod says what shape is accepted", async () => {
  await assert.rejects(
    () => client().logs({ namespace: "caterpillar", pod: 'x"' }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidNameError);
      assert.match(error.message, /lowercase letters, digits and dashes/);
      assert.match(error.message, /caterpillar-\.\*/);
      return true;
    },
  );
});

test("escapeForLogQL neutralises quotes and backslashes", () => {
  // Unreachable through the validators today, and kept because the query is assembled by
  // concatenation and a third caller is a matter of time.
  assert.equal(escapeForLogQL('a"b'), 'a\\"b');
  assert.equal(escapeForLogQL("a\\b"), "a\\\\b");
});

test("logs come back oldest-last, interleaved across pods, with the timestamp", async () => {
  const loki = recordingFetch({
    data: {
      result: [
        {
          stream: { pod: "caterpillar-0" },
          values: [
            [nanos("2026-01-01T10:00:02Z"), "second"],
            [nanos("2026-01-01T10:00:00Z"), "first"],
          ],
        },
        {
          stream: { pod: "caterpillar-1" },
          values: [[nanos("2026-01-01T10:00:01Z"), "middle"]],
        },
      ],
    },
  });

  const text = await client({ fetch: loki.fetch }).logs({ namespace: "caterpillar" });
  const order = ["first", "middle", "second"].map((line) => text.indexOf(line));
  assert.ok(order.every((at) => at >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(text, /2026-01-01T10:00:00\.000Z {2}caterpillar-0 {2}first/);
});

test("sinceMinutes and limit are clamped rather than trusted", async () => {
  const loki = recordingFetch({ data: { result: [] } });
  await client({ fetch: loki.fetch }).logs({
    namespace: "caterpillar",
    sinceMinutes: 60 * 24 * 30,
    limit: 1_000_000,
  });

  const url = new URL(loki.urls[0] ?? "");
  assert.equal(url.searchParams.get("limit"), "2000");
  const start = BigInt(url.searchParams.get("start") ?? "0");
  const end = BigInt(url.searchParams.get("end") ?? "0");
  assert.equal((end - start) / 1_000_000_000n, BigInt(24 * 60 * 60));
});

test("maxLogLines from config lowers the cap but cannot raise it", async () => {
  const tight = recordingFetch({ data: { result: [] } });
  await client({ fetch: tight.fetch, maxLogLines: 10 }).logs({
    namespace: "caterpillar",
    limit: 500,
  });
  assert.equal(new URL(tight.urls[0] ?? "").searchParams.get("limit"), "10");

  const loose = recordingFetch({ data: { result: [] } });
  await client({ fetch: loose.fetch, maxLogLines: 999_999 }).logs({
    namespace: "caterpillar",
    limit: 500_000,
  });
  assert.equal(new URL(loose.urls[0] ?? "").searchParams.get("limit"), "2000");
});

test("no Loki bearer token is sent unless one is configured", async () => {
  const bare = recordingFetch({ data: { result: [] } });
  await client({ fetch: bare.fetch }).logs({ namespace: "caterpillar" });
  assert.ok(!("authorization" in (bare.headers[0] ?? {})));

  const proxied = recordingFetch({ data: { result: [] } });
  await client({ fetch: proxied.fetch, lokiToken: "grafana-token" }).logs({
    namespace: "caterpillar",
  });
  assert.equal((proxied.headers[0] ?? {})["authorization"], "Bearer grafana-token");
});

test("an empty log result explains itself rather than looking like a failure", async () => {
  const loki = recordingFetch({ data: { result: [] } });
  const text = await client({ fetch: loki.fetch }).logs({ namespace: "caterpillar" });
  assert.match(text, /No log lines/);
  assert.match(text, /namespace="caterpillar"/);
});

test("a Loki failure is a typed error carrying the status", async () => {
  const loki = recordingFetch({ message: "parse error" }, 400);
  await assert.rejects(() => client({ fetch: loki.fetch }).logs({ namespace: "caterpillar" }), (error: unknown) => {
    assert.ok(error instanceof ClusterRequestError);
    assert.equal(error.status, 400);
    return true;
  });
});

test("the Loki base URL is configurable, for a datasource proxy later", async () => {
  const loki = recordingFetch({ data: { result: [] } });
  await client({ fetch: loki.fetch, lokiUrl: "http://grafana.monitoring.svc/api/datasources/proxy/1/" }).logs({
    namespace: "caterpillar",
  });
  assert.match(loki.urls[0] ?? "", /^http:\/\/grafana\.monitoring\.svc\/api\/datasources\/proxy\/1\/loki\/api\/v1\/query_range\?/);
});

test("events are newest-first and one line each", async () => {
  const kube = recordingGet([
    json({
      items: [
        {
          type: "Warning",
          reason: "BackOff",
          lastTimestamp: "2026-01-01T10:00:00Z",
          involvedObject: { kind: "Pod", name: "caterpillar-0" },
          message: "Back-off restarting failed container",
        },
        {
          type: "Normal",
          reason: "Pulled",
          lastTimestamp: "2026-01-01T11:00:00Z",
          involvedObject: { kind: "Pod", name: "caterpillar-0" },
          message: "Container image already present\non the machine",
        },
      ],
    }),
  ]);

  const text = await client({ httpsGet: kube.get }).events({ namespace: "caterpillar" });
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^2026-01-01T11:00:00Z {2}Normal {2}Pulled {2}Pod\/caterpillar-0/);
  // A multi-line message is folded, so one event stays one line and the table stays a table.
  assert.match(lines[0] ?? "", /already present on the machine$/);
  assert.match(lines[1] ?? "", /Warning {2}BackOff/);
  assert.equal(kube.urls[0], "https://kubernetes.default.svc/api/v1/namespaces/caterpillar/events");
});

test("an involvedObject becomes a fieldSelector, kind included when given", async () => {
  const bare = recordingGet([json({ items: [] })]);
  await client({ httpsGet: bare.get }).events({
    namespace: "caterpillar",
    involvedObject: "caterpillar-0",
  });
  assert.match(bare.urls[0] ?? "", /fieldSelector=involvedObject\.name%3Dcaterpillar-0$/);

  const qualified = recordingGet([json({ items: [] })]);
  await client({ httpsGet: qualified.get }).events({
    namespace: "caterpillar",
    involvedObject: "ReplicaSet/caterpillar-abc",
  });
  const selector = new URL(qualified.urls[0] ?? "").searchParams.get("fieldSelector");
  assert.equal(selector, "involvedObject.name=caterpillar-abc,involvedObject.kind=ReplicaSet");
});

test("an involvedObject that could add its own selector is refused", async () => {
  const attacker = client({ httpsGet: forbiddenGet });
  for (const involvedObject of [
    "caterpillar-0,involvedObject.namespace=kube-system",
    "../../nodes/node-1",
    "Pod/../secrets",
    "pod/UPPER",
    "",
  ]) {
    await assert.rejects(
      () => attacker.events({ namespace: "caterpillar", involvedObject }),
      InvalidNameError,
      `involvedObject '${involvedObject}' was accepted`,
    );
  }
});

test("the events limit is applied and the drop is announced", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "Normal",
    reason: `R${index}`,
    lastTimestamp: `2026-01-0${index + 1}T10:00:00Z`,
    involvedObject: { kind: "Pod", name: "p" },
    message: "m",
  }));
  const kube = recordingGet([json({ items })]);

  const text = await client({ httpsGet: kube.get }).events({ namespace: "caterpillar", limit: 2 });
  assert.match(text, /3 older event\(s\) dropped by limit=2/);
  assert.equal(text.trimEnd().split("\n").length, 3);
});

test("an empty event list says why empty is normal", async () => {
  const kube = recordingGet([json({ items: [] })]);
  const text = await client({ httpsGet: kube.get }).events({ namespace: "monitoring" });
  assert.match(text, /No events in namespace monitoring/);
  assert.match(text, /expires events/);
});

test("describe routes each kind to its own API path", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["Pod", "/api/v1/namespaces/caterpillar/pods/x"],
    ["Service", "/api/v1/namespaces/caterpillar/services/x"],
    ["ConfigMap", "/api/v1/namespaces/caterpillar/configmaps/x"],
    ["Secret", "/api/v1/namespaces/caterpillar/secrets/x"],
    ["PersistentVolumeClaim", "/api/v1/namespaces/caterpillar/persistentvolumeclaims/x"],
    ["Deployment", "/apis/apps/v1/namespaces/caterpillar/deployments/x"],
    ["StatefulSet", "/apis/apps/v1/namespaces/caterpillar/statefulsets/x"],
    ["DaemonSet", "/apis/apps/v1/namespaces/caterpillar/daemonsets/x"],
    ["Job", "/apis/batch/v1/namespaces/caterpillar/jobs/x"],
    ["CronJob", "/apis/batch/v1/namespaces/caterpillar/cronjobs/x"],
    ["Ingress", "/apis/networking.k8s.io/v1/namespaces/caterpillar/ingresses/x"],
  ];

  for (const [kind, path] of cases) {
    const kube = recordingGet([json({ kind, metadata: { name: "x" } })]);
    await client({ httpsGet: kube.get }).describe({ kind, name: "x", namespace: "caterpillar" });
    assert.equal(kube.urls[0], `https://kubernetes.default.svc${path}`);
  }
});

test("describe redacts a Secret before returning it", async () => {
  const kube = recordingGet([
    json({
      kind: "Secret",
      metadata: { name: "creds", namespace: "caterpillar", managedFields: [{ manager: "m" }] },
      data: { token: Buffer.from("super-secret-token").toString("base64") },
    }),
  ]);

  const text = await client({ httpsGet: kube.get }).describe({
    kind: "Secret",
    name: "creds",
    namespace: "caterpillar",
  });
  assert.ok(!text.includes("super-secret-token"));
  assert.ok(!text.includes(Buffer.from("super-secret-token").toString("base64")));
  assert.match(text, /token: 18 bytes/);
  assert.ok(!text.includes("managedFields"));
});

test("describe refuses a kind outside the allowlist without any request", async () => {
  await assert.rejects(
    () => client({ httpsGet: forbiddenGet }).describe({ kind: "Node", name: "n", namespace: "caterpillar" }),
    UnsupportedKindError,
  );
});

test("a name that could traverse the API path is refused without any request", async () => {
  const attacker = client({ httpsGet: forbiddenGet });
  for (const name of ["../../../nodes/n", "x/y", "x?watch=true", "UPPER", ""]) {
    await assert.rejects(
      () => attacker.describe({ kind: "Pod", name, namespace: "caterpillar" }),
      InvalidNameError,
      `name '${name}' was accepted`,
    );
  }
});

test("a namespace that passes the allowlist is still checked against the grammar", async () => {
  // Belt and braces: an operator could put anything in `cluster.namespaces`, and a path
  // segment assembled from it should not depend on the ConfigMap being well formed.
  const odd = new ClusterClient({
    namespaces: ["../kube-system"],
    readCredentials: () => Promise.resolve(CREDENTIALS),
    httpsGet: forbiddenGet,
  });
  await assert.rejects(
    () => odd.describe({ kind: "Pod", name: "p", namespace: "../kube-system" }),
    InvalidNameError,
  );
});

test("a 401 re-reads the credentials once and retries", async () => {
  // A projected ServiceAccount token is rotated on disk without the process being told, so
  // the first 401 after a rotation is a stale cache rather than a denial.
  let reads = 0;
  const tokens = ["stale", "fresh"];
  const seen: string[] = [];
  const kube: HttpsGet = (options) => {
    seen.push(options.token);
    return Promise.resolve(seen.length === 1 ? { status: 401, body: "Unauthorized" } : json({ kind: "Pod" }));
  };

  const rotating = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: kube,
    readCredentials: () => {
      const token = tokens[Math.min(reads, tokens.length - 1)] ?? "";
      reads += 1;
      return Promise.resolve({ token, ca: CREDENTIALS.ca });
    },
  });

  await rotating.describe({ kind: "Pod", name: "p", namespace: "caterpillar" });
  assert.deepEqual(seen, ["stale", "fresh"]);
  assert.equal(reads, 2);
});

test("a second 401 is reported, not retried forever", async () => {
  let reads = 0;
  const always401: HttpsGet = () => Promise.resolve({ status: 401, body: "Unauthorized" });
  const denied = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: always401,
    readCredentials: () => {
      reads += 1;
      return Promise.resolve(CREDENTIALS);
    },
  });

  await assert.rejects(
    () => denied.describe({ kind: "Pod", name: "p", namespace: "caterpillar" }),
    (error: unknown) => {
      assert.ok(error instanceof ClusterRequestError);
      assert.equal(error.status, 401);
      return true;
    },
  );
  assert.equal(reads, 2, "the credentials were re-read more than once");
});

test("credentials are read once for a session, not once per request", async () => {
  let reads = 0;
  const kube = recordingGet([json({ items: [] }), json({ kind: "Pod" })]);
  const shared = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: kube.get,
    readCredentials: () => {
      reads += 1;
      return Promise.resolve(CREDENTIALS);
    },
  });

  await shared.events({ namespace: "caterpillar" });
  await shared.describe({ kind: "Pod", name: "p", namespace: "caterpillar" });
  assert.equal(reads, 1);
});

test("a missing token or CA is a typed failure that names the file, never a TLS downgrade", async () => {
  const broken = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: forbiddenGet,
    readCredentials: () =>
      Promise.reject(
        new ClusterUnavailableError(
          "the cluster CA bundle is missing or unreadable at /var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        ),
      ),
  });

  await assert.rejects(
    () => broken.describe({ kind: "Pod", name: "p", namespace: "caterpillar" }),
    (error: unknown) => {
      assert.ok(error instanceof ClusterUnavailableError);
      assert.match(error.message, /ca\.crt/);
      assert.match(error.message, /only work in-cluster/);
      return true;
    },
  );
});

test("a failed credential read is not cached", async () => {
  // The token volume can be projected slightly after the process starts, and a client that
  // remembered the first failure would stay broken for the pod's life.
  let attempt = 0;
  const kube = recordingGet([json({ kind: "Pod" })]);
  const late = new ClusterClient({
    namespaces: ["caterpillar"],
    httpsGet: kube.get,
    readCredentials: () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new ClusterUnavailableError("the ServiceAccount token is missing"))
        : Promise.resolve(CREDENTIALS);
    },
  });

  await assert.rejects(
    () => late.describe({ kind: "Pod", name: "p", namespace: "caterpillar" }),
    ClusterUnavailableError,
  );
  await late.describe({ kind: "Pod", name: "p", namespace: "caterpillar" });
  assert.equal(attempt, 2);
});

test("this module contains no way to disable TLS verification", async () => {
  // A grep, deliberately. Every other assertion here is about behaviour with an injected
  // transport, which by construction cannot see what the real one would have sent — and
  // the property that matters most is about the real one. `rejectUnauthorized: false` is a
  // single line anyone could add in a hurry to make a local run work, and this is the test
  // that would go red when they did.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./client.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.ok(!/rejectUnauthorized/.test(code), "client.ts mentions rejectUnauthorized in code");
  assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(code), "client.ts touches NODE_TLS_REJECT_UNAUTHORIZED");
  // The CA has to be passed per request, which is the entire reason this module uses
  // node:https instead of global fetch.
  assert.match(code, /ca: options\.ca/);
});
