/**
 * Tests for the `verify:cluster-read` checks (DESIGN.md §20).
 *
 * NOTHING here touches the network or a cluster. Every kube API call arrives through an
 * injected `HttpsGet` and Loki through an injected fetch, exactly as `client.test.ts` does
 * it — and for a stronger reason than hygiene: the states worth asserting are the ones a
 * healthy cluster will never produce on demand. A 403 on the one grant that matters, a
 * ServiceAccount that can `delete pods`, a Secret value surviving into the rendered output.
 * A preflight that could only be tested against a working cluster would be tested exactly
 * once, on the day it was written, against the one configuration it was written from.
 *
 * The most valuable test in this file is `an allowed write verb fails the run`. The safety
 * argument for alert-driven remediation is that the supervisor's token cannot change the
 * cluster; a preflight that checks only the reads it wants would pass against a
 * `cluster-admin` binding and certify the opposite of the property being relied on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpResponse, HttpsGet } from "./client.ts";
import {
  accessQueries,
  checkAccess,
  checkConfig,
  checkCredentials,
  checkKubeVersion,
  checkLoki,
  checkNamespaces,
  checkRedaction,
  describeQuery,
  resourceFromRoute,
  summarize,
  type KubeContext,
  type PreflightConfig,
} from "./preflight.ts";

const CONFIG: PreflightConfig = {
  enabled: true,
  namespaces: ["caterpillar"],
  lokiUrl: "http://loki.monitoring.svc.cluster.local:3100",
  kubeApiUrl: "https://kubernetes.default.svc",
};

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** A review answer for the API server's `SelfSubjectAccessReview` route. */
const review = (allowed: boolean, reason?: string): HttpResponse =>
  json(201, { status: { allowed, ...(reason === undefined ? {} : { reason }) } });

/**
 * A kube context whose transport is a function of the request.
 *
 * Deliberately not a queue of canned responses: `checkAccess` performs twenty-odd reviews
 * and the assertions are about WHICH grant answered how, so a positional list would make
 * every test depend on the order `accessQueries` happens to emit.
 */
const kubeWith = (
  respond: (url: string, body: string | undefined) => HttpResponse,
): { readonly kube: KubeContext; readonly calls: string[] } => {
  const calls: string[] = [];
  const http: HttpsGet = (options) => {
    calls.push(`${options.method ?? "GET"} ${options.url}`);
    assert.ok(options.ca.length > 0, "a request went out with no CA pinned");
    assert.ok(options.token.length > 0, "a request went out with no bearer token");
    return Promise.resolve(respond(options.url, options.body));
  };
  return {
    calls,
    kube: { kubeApiUrl: "https://kubernetes.default.svc", token: "t", ca: "ca", http },
  };
};

/** Reviews answered from a predicate over the requested `(verb, resource)`. */
const reviewsBy = (
  allow: (attributes: { verb: string; resource: string; subresource?: string }) => boolean,
): { readonly kube: KubeContext; readonly calls: string[] } =>
  kubeWith((url, body) => {
    assert.ok(url.endsWith("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"));
    const parsed = JSON.parse(body ?? "{}") as {
      spec?: { resourceAttributes?: { verb?: string; resource?: string; subresource?: string } };
    };
    const attributes = parsed.spec?.resourceAttributes ?? {};
    return review(
      allow({
        verb: attributes.verb ?? "",
        resource: attributes.resource ?? "",
        ...(attributes.subresource === undefined ? {} : { subresource: attributes.subresource }),
      }),
    );
  });

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

// ---------------------------------------------------------------- check 1: config

test("an empty namespace allowlist is a failure, not a warning", () => {
  const result = checkConfig({ ...CONFIG, namespaces: [] });
  assert.equal(result.status, "fail");
  // The whole point of the failure: an operator reading it must learn that empty is 'none'
  // rather than 'all', because the runtime symptom is a feature that looks enabled and
  // refuses every call.
  assert.match(result.remedy ?? "", /empty list is not 'all'/);
});

test("cluster.enabled false fails and says which switch to flip", () => {
  const result = checkConfig({ ...CONFIG, enabled: false });
  assert.equal(result.status, "fail");
  assert.match(result.remedy ?? "", /cluster\.enabled/);
});

test("a valid config passes and prints the resolved values", () => {
  const result = checkConfig(CONFIG);
  assert.equal(result.status, "pass");
  const printed = (result.lines ?? []).join("\n");
  assert.match(printed, /caterpillar/);
  assert.match(printed, /loki\.monitoring\.svc\.cluster\.local:3100/);
  assert.match(printed, /kubernetes\.default\.svc/);
});

// ---------------------------------------------------- check 2: token and CA

test("a missing token file fails with the in-cluster remedy and no credentials", async () => {
  const { result, credentials } = await checkCredentials({
    tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    caPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    read: () => Promise.reject(new Error("ENOENT")),
  });

  assert.equal(result.status, "fail");
  assert.equal(credentials, undefined);
  assert.match(result.remedy ?? "", /INSIDE a pod/);
  assert.match(result.remedy ?? "", /automountServiceAccountToken/);
  // There is no mode that skips TLS verification, and the remedy must never imply one.
  assert.match(result.remedy ?? "", /no mode that skips TLS verification/);
});

test("an empty token file is treated as missing rather than as a credential", async () => {
  const { result } = await checkCredentials({
    tokenPath: "/token",
    caPath: "/ca",
    read: (path) => Promise.resolve(path === "/token" ? "   \n" : "ca-bundle"),
  });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /\/token/);
});

test("both files present yields the credentials", async () => {
  const { result, credentials } = await checkCredentials({
    tokenPath: "/token",
    caPath: "/ca",
    read: (path) => Promise.resolve(path === "/token" ? "sa-token\n" : "ca-bundle"),
  });
  assert.equal(result.status, "pass");
  assert.equal(credentials?.token, "sa-token");
});

// ------------------------------------------------------- check 3: kube API

test("the server version is printed on a healthy /version", async () => {
  const { kube } = kubeWith(() => json(200, { gitVersion: "v1.33.5+k3s1", platform: "linux/amd64" }));
  const result = await checkKubeVersion(kube);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /v1\.33\.5\+k3s1/);
});

test("a TLS failure never suggests turning verification off", async () => {
  const http: HttpsGet = () => Promise.reject(new Error("unable to verify the first certificate"));
  const result = await checkKubeVersion({
    kubeApiUrl: "https://kubernetes.default.svc",
    token: "t",
    ca: "ca",
    http,
  });
  assert.equal(result.status, "fail");
  assert.match(result.remedy ?? "", /supply the right CA/);
  assert.doesNotMatch(result.remedy ?? "", /insecure|rejectUnauthorized|skip-tls/i);
});

// ----------------------------------------------------- check 4: namespaces

test("a 404 on a namespace is a failure naming the typo", async () => {
  const { kube } = kubeWith(() => json(404, { message: "namespaces 'catrpillar' not found" }));
  const result = await checkNamespaces(kube, ["catrpillar"]);
  assert.equal(result.status, "fail");
  assert.match(result.remedy ?? "", /typo/);
});

test("a 403 on 'get namespaces' is a skip, because no tool reads a namespace object", async () => {
  const { kube } = kubeWith(() => json(403, { message: "forbidden" }));
  const result = await checkNamespaces(kube, ["caterpillar"]);
  // A failure here would push an operator to grant a cluster-scoped verb the feature does
  // not want, in order to make a preflight go green.
  assert.equal(result.status, "skip");
  assert.match(result.detail, /correct for a namespaced read-only Role/);
});

test("a reachable namespace passes", async () => {
  const { kube } = kubeWith(() => json(200, { metadata: { name: "caterpillar" } }));
  const result = await checkNamespaces(kube, ["caterpillar"]);
  assert.equal(result.status, "pass");
});

// ----------------------------------------------------------- check 5: RBAC

test("the review list is derived from the client's own route table", () => {
  assert.deepEqual(resourceFromRoute("/api/v1/namespaces/{ns}/pods/{name}"), {
    group: "",
    resource: "pods",
  });
  assert.deepEqual(resourceFromRoute("/apis/apps/v1/namespaces/{ns}/deployments/{name}"), {
    group: "apps",
    resource: "deployments",
  });

  const grants = accessQueries("caterpillar").map(describeQuery);
  // The four the tools cannot work without, spelled as a Role's rules spell them.
  for (const grant of ["list events", "get pods", "get apps/deployments", "get secrets"]) {
    assert.ok(grants.includes(grant), `${grant} is not among the reviews`);
  }
  // `pods/log` must arrive as resource+subresource; a review for the literal "pods/log"
  // resource comes back denied and reads exactly like a missing grant.
  const log = accessQueries("caterpillar").find((query) => query.subresource === "log");
  assert.equal(log?.resource, "pods");
});

test("all reads allowed and all writes denied is a pass", async () => {
  const { kube } = reviewsBy((attributes) => ["get", "list"].includes(attributes.verb));
  const { result, outcomes } = await checkAccess(kube, ["caterpillar"]);

  assert.equal(result.status, "pass");
  assert.match(result.detail, /every read allowed, every write denied/);
  assert.ok(outcomes.length > 10, "far too few reviews were performed");
  assert.ok(
    outcomes.some((outcome) => !outcome.query.want),
    "no negative assertion was made at all",
  );
});

test("an allowed write verb fails the run, loudly", async () => {
  // The `cluster-admin` case: everything is allowed, including `delete pods`.
  const { kube } = reviewsBy(() => true);
  const { result } = await checkAccess(kube, ["caterpillar"]);

  assert.equal(result.status, "fail");
  assert.match(result.detail, /THE TOKEN CAN WRITE TO THE CLUSTER/);
  assert.match(result.detail, /delete pods|create pods|patch pods|update pods/);
  // The remedy has to name the actual cause, which is a broad binding rather than a
  // missing one — RBAC has no deny rules, so "remove a grant" is the only fix.
  assert.match(result.remedy ?? "", /cluster-admin/);
});

test("an allowed write outranks a missing read: the write is what gets reported", async () => {
  // Nothing is granted except `delete pods`. Both findings are real; the write is the one
  // that must be on screen, because it is the safety property rather than a broken feature.
  const { kube } = reviewsBy((attributes) => attributes.verb === "delete");
  const { result } = await checkAccess(kube, ["caterpillar"]);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /THE TOKEN CAN WRITE/);
});

test("a missing read grant fails with a remedy naming the verb, resource and namespace", async () => {
  const { kube } = reviewsBy(
    (attributes) => ["get", "list"].includes(attributes.verb) && attributes.resource !== "secrets",
  );
  const { result } = await checkAccess(kube, ["caterpillar"]);

  assert.equal(result.status, "fail");
  assert.match(result.detail, /get secrets/);
  assert.match(result.remedy ?? "", /get secrets in namespace caterpillar/);
  assert.match(result.remedy ?? "", /Role/);
});

test("a 403 on the review route itself is reported as a failed review, not as a denial", async () => {
  const { kube } = kubeWith(() => json(403, { message: "forbidden" }));
  const { result } = await checkAccess(kube, ["caterpillar"]);

  assert.equal(result.status, "fail");
  // Every authenticated principal may POST a SelfSubjectAccessReview, so a 403 there is a
  // different fact from "this grant is missing" and the remedy says which one it is.
  assert.match(result.remedy ?? "", /HTTP 403/);
  assert.match(result.remedy ?? "", /add these verbs and resources|about the request rather than about permission/);
});

test("the RBAC table shows expectation and verdict as separate columns", async () => {
  const { kube } = reviewsBy((attributes) => ["get", "list"].includes(attributes.verb));
  const { result } = await checkAccess(kube, ["caterpillar"]);
  const table = (result.lines ?? []).join("\n");
  assert.match(table, /get pods\s+ALLOWED\s+ok/);
  assert.match(table, /delete pods\s+denied\s+ok/);
});

// ----------------------------------------------------------- check 6: Loki

const lokiFetch = (
  responses: Readonly<Record<string, { status: number; body: unknown }>>,
): ((input: string) => Promise<Response>) =>
  (input: string) => {
    const key = input.includes("/loki/api/v1/query_range") ? "query" : "ready";
    const canned = responses[key] ?? { status: 404, body: "not found" };
    return Promise.resolve(
      new Response(typeof canned.body === "string" ? canned.body : JSON.stringify(canned.body), {
        status: canned.status,
      }),
    );
  };

test("Loki reachable with streams passes and prints the count", async () => {
  const result = await checkLoki({
    lokiUrl: CONFIG.lokiUrl,
    namespace: "caterpillar",
    fetch: lokiFetch({
      ready: { status: 200, body: "ready\n" },
      query: {
        status: 200,
        body: { data: { result: [{ stream: { namespace: "caterpillar", pod: "caterpillar-1" } }] } },
      },
    }),
  });
  assert.equal(result.status, "pass");
  assert.match(result.detail, /1 stream/);
});

test("zero streams fails with the label-mismatch remedy and how to list the real labels", async () => {
  const result = await checkLoki({
    lokiUrl: CONFIG.lokiUrl,
    namespace: "caterpillar",
    fetch: lokiFetch({
      ready: { status: 200, body: "ready\n" },
      query: { status: 200, body: { data: { result: [] } } },
    }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.remedy ?? "", /k8s_namespace_name/);
  assert.match(result.remedy ?? "", /loki\/api\/v1\/labels/);
});

test("an unreachable Loki names the gateway trap", async () => {
  const result = await checkLoki({
    lokiUrl: "http://loki-gateway.monitoring.svc.cluster.local",
    namespace: "caterpillar",
    fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND loki-gateway.monitoring.svc.cluster.local")),
  });
  assert.equal(result.status, "fail");
  assert.match(result.remedy ?? "", /gateway\.enabled: false/);
  assert.match(result.remedy ?? "", /loki\.monitoring\.svc\.cluster\.local:3100/);
});

test("a 503 from /ready does not stop the real query from deciding", async () => {
  const result = await checkLoki({
    lokiUrl: CONFIG.lokiUrl,
    namespace: "caterpillar",
    fetch: lokiFetch({
      ready: { status: 503, body: "replaying WAL" },
      query: { status: 200, body: { data: { result: [{ stream: { namespace: "caterpillar" } }] } } },
    }),
  });
  assert.equal(result.status, "pass");
  assert.match((result.lines ?? []).join("\n"), /HTTP 503/);
});

test("the query window is five minutes, in nanoseconds", async () => {
  const seen: string[] = [];
  await checkLoki({
    lokiUrl: CONFIG.lokiUrl,
    namespace: "caterpillar",
    now: 1_700_000_000_000,
    fetch: (input) => {
      seen.push(input);
      return Promise.resolve(new Response(JSON.stringify({ data: { result: [] } }), { status: 200 }));
    },
  });

  const query = seen.find((url) => url.includes("query_range")) ?? "";
  const params = new URL(query).searchParams;
  // Milliseconds here would be read by Loki as 1970 and return nothing, which looks
  // identical to a label mismatch — see client.ts.
  assert.equal(params.get("end"), String(1_700_000_000_000 * 1_000_000));
  assert.equal(
    Number(params.get("end")) - Number(params.get("start")),
    5 * 60_000 * 1_000_000,
  );
});

// ------------------------------------------------------ check 7: redaction

test("a real Secret renders key names and byte lengths with no value", () => {
  const result = checkRedaction(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "caterpillar-discord", namespace: "caterpillar" },
      data: { "webhook-url": b64("https://discord.com/api/webhooks/1/supersecret") },
    },
    "caterpillar/caterpillar-discord",
  );

  assert.equal(result.status, "pass");
  assert.match((result.lines ?? []).join("\n"), /webhook-url: 46 bytes/);
});

test("a value that survives into the output fails the check, in either encoding", () => {
  const value = "supersecret-token-value";
  // A leak the redactor really does not catch: `last-applied-configuration` is stripped by
  // name, and any OTHER annotation carrying the same bytes is not. This is the shape of the
  // failure this check exists to notice against a live cluster.
  const result = checkRedaction(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "leaky",
        annotations: { "example.com/copy-of-the-value": value },
      },
      data: { token: b64(value) },
    },
    "caterpillar/leaky",
  );

  assert.equal(result.status, "fail");
  assert.match(result.detail, /token \(decoded\)/);
  assert.match(result.remedy ?? "", /redact\.ts is the entire boundary/);
});

test("the base64 form is caught even when the plaintext is not present", () => {
  const encoded = b64("another-secret");
  const result = checkRedaction(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "leaky-b64", annotations: { "example.com/encoded": encoded } },
      data: { token: encoded },
    },
    "caterpillar/leaky-b64",
  );
  assert.equal(result.status, "fail");
  assert.match(result.detail, /token \(base64\)/);
});

test("a Secret with no data keys is a skip, never a silent pass", () => {
  const result = checkRedaction(
    { apiVersion: "v1", kind: "Secret", metadata: { name: "empty" } },
    "caterpillar/empty",
  );
  assert.equal(result.status, "skip");
  assert.match(result.detail, /nothing could leak and nothing was proved/);
});

// ------------------------------------------------------------ check 8: verdict

test("the verdict is ok only when nothing failed, and a skip does not fail it", () => {
  const results = [
    { name: "a", status: "pass" as const, detail: "" },
    { name: "b", status: "skip" as const, detail: "" },
  ];
  const verdict = summarize(results);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.passed, 1);
  assert.equal(verdict.skipped, 1);

  const failed = summarize([...results, { name: "c", status: "fail" as const, detail: "" }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, 1);
});
