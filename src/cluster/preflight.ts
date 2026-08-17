/**
 * The checks behind `npm run verify:cluster-read`. See DESIGN.md §20.
 *
 * Every credential-shaped integration in this repo has a preflight CLI for one reason: the
 * four things this feature needs — an RBAC grant, a Service port, an Alertmanager route and
 * a ConfigMap key — live in a SEPARATE deployment repo, and when one of them is wrong the
 * symptom is a confusing tool error inside an agent session hours later. A preflight turns
 * "remediation is broken" into "the ClusterRole is missing `get pods` in namespace X".
 *
 * Pure functions over an injected HTTP function, with `verify-cluster-read.ts` supplying
 * argv, the real transport and the printing. That split is not tidiness:
 *
 *   - the interesting cases are a 403, an allowed write verb and a leaked Secret value,
 *     none of which can be provoked against a healthy cluster on demand;
 *   - no test may touch the network, and a check that needs a cluster to test is a check
 *     nobody tests — the same argument `redact.ts` records for itself.
 *
 * The one thing this file must never do is reimplement a boundary in order to check it. The
 * redaction check calls `redactObject`/`renderObject` from `redact.ts`; a copy that agrees
 * with itself proves nothing about the code the agent actually reads through.
 */
import { ROUTES, type HttpResponse, type HttpsGet } from "./client.ts";
import { DESCRIBABLE_KINDS, redactObject, renderObject } from "./redact.ts";

/**
 * How one check ended.
 *
 * A string union rather than an enum: node's type stripping runs no transform, so an enum
 * emits runtime code and fails to load (§16).
 */
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  /** Short, stable name — the left column of the summary table. */
  readonly name: string;
  readonly status: CheckStatus;
  /** One line of what was observed. Printed on pass as well as on failure. */
  readonly detail: string;
  /** What to do about it. Present on every failure and on a skip worth acting on. */
  readonly remedy?: string;
  /** Extra lines printed under the check — an RBAC table, a resolved config. */
  readonly lines?: readonly string[];
}

const pass = (name: string, detail: string, lines?: readonly string[]): CheckResult => ({
  name,
  status: "pass",
  detail,
  ...(lines === undefined ? {} : { lines }),
});

const fail = (
  name: string,
  detail: string,
  remedy: string,
  lines?: readonly string[],
): CheckResult => ({
  name,
  status: "fail",
  detail,
  remedy,
  ...(lines === undefined ? {} : { lines }),
});

const skip = (name: string, detail: string, remedy?: string): CheckResult => ({
  name,
  status: "skip",
  detail,
  ...(remedy === undefined ? {} : { remedy }),
});

/** The subset of `ClusterConfig` the preflight reads. Kept structural so a test needs no loader. */
export interface PreflightConfig {
  readonly enabled: boolean;
  readonly namespaces: readonly string[];
  readonly lokiUrl: string;
  readonly kubeApiUrl: string;
}

/** What every kube-API check needs: where, with what, and how to speak. */
export interface KubeContext {
  readonly kubeApiUrl: string;
  readonly token: string;
  readonly ca: string;
  readonly http: HttpsGet;
}

/** Loki is plain HTTP in-cluster, so it goes through fetch rather than the CA-pinned helper. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One `(verb, resource, namespace)` the tools need, or must NOT have.
 *
 * `subresource` is separate from `resource` because that is how the API server models it:
 * `pods/log` is `resource: "pods", subresource: "log"`, and a review that sends the slashed
 * string as the resource is answered about a resource that does not exist — which comes
 * back `allowed: false` and reads exactly like a missing grant.
 */
export interface AccessQuery {
  readonly verb: string;
  readonly group: string;
  readonly resource: string;
  readonly subresource?: string;
  readonly namespace: string;
  /** True when the grant is required; false when it must be DENIED. */
  readonly want: boolean;
  /** Why this line is in the list, printed beside a surprising result. */
  readonly why: string;
}

/**
 * `/api/v1/namespaces/{ns}/pods/{name}` → `{ group: "", resource: "pods" }`.
 *
 * Parsed from the route table rather than written out a second time: a kind the client can
 * reach and this file has never heard of is exactly the 403 the preflight exists to catch
 * before a session does. `/api/v1` is the legacy core group, whose group name is the empty
 * string; everything under `/apis/<group>/<version>` names its group.
 */
export const resourceFromRoute = (
  route: string,
): { readonly group: string; readonly resource: string } | undefined => {
  const parts = route.split("/").filter((part) => part.length > 0);
  const resourceIndex = parts.indexOf("{name}") - 1;
  const resource = resourceIndex < 0 ? undefined : parts[resourceIndex];
  if (resource === undefined) return undefined;
  const group = parts[0] === "api" ? "" : (parts[1] ?? "");
  return { group, resource };
};

/** Verbs a remediation session's reads genuinely perform. Nothing else is asked for. */
const READ_VERBS = ["get", "list"] as const;

/**
 * Write verbs that must be DENIED, on the two kinds an agent would reach for first.
 *
 * THIS IS THE CHECK THAT MATTERS MOST, and it is the one a preflight written from the happy
 * path would not contain. The entire safety argument for alert-driven remediation is that
 * the token cannot change the cluster (§20: "It never writes to the cluster") — so a
 * preflight that only confirms the reads it wants would pass just as cheerfully against a
 * `cluster-admin` binding, and would then have certified the opposite of the property the
 * operator is relying on. An allowed write verb is therefore a hard failure, not a warning.
 */
const WRITE_VERBS = ["create", "update", "patch", "delete"] as const;
const WRITE_RESOURCES = [
  { group: "", resource: "pods" },
  { group: "apps", resource: "deployments" },
] as const;

/**
 * Every access review the preflight performs for one namespace.
 *
 * Derived from `ROUTES` and `DESCRIBABLE_KINDS` in `src/cluster/`, plus the two things the
 * route table does not describe: `events`, which `cluster_events` lists, and `pods/log`,
 * which is the fallback the day `cluster_logs` reads the kube API instead of Loki. `pods/log`
 * is reported like any other line rather than being silently optional — an operator granting
 * RBAC by hand wants one list, not a list with a footnote.
 */
export const accessQueries = (namespace: string): readonly AccessQuery[] => {
  const wanted: AccessQuery[] = [];
  const seen = new Set<string>();

  const add = (query: AccessQuery): void => {
    const key = `${query.verb} ${query.group}/${query.resource}${query.subresource === undefined ? "" : `/${query.subresource}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    wanted.push(query);
  };

  // `events` first: an image-pull failure or an OOM kill is answered here and nowhere else,
  // so this is the grant whose absence hurts most.
  for (const verb of READ_VERBS) {
    add({ verb, group: "", resource: "events", namespace, want: true, why: "cluster_events" });
  }

  for (const kind of DESCRIBABLE_KINDS) {
    const route = ROUTES[kind];
    if (route === undefined) continue;
    const parsed = resourceFromRoute(route);
    if (parsed === undefined) continue;
    add({
      verb: "get",
      group: parsed.group,
      resource: parsed.resource,
      namespace,
      want: true,
      why: `cluster_describe ${kind}`,
    });
  }

  add({
    verb: "get",
    group: "",
    resource: "pods",
    subresource: "log",
    namespace,
    want: true,
    why: "container logs read straight from the kube API when Loki is unavailable",
  });

  for (const verb of WRITE_VERBS) {
    for (const target of WRITE_RESOURCES) {
      add({
        verb,
        group: target.group,
        resource: target.resource,
        namespace,
        want: false,
        why: "the token must not be able to change the cluster (§20)",
      });
    }
  }

  return wanted;
};

/** How one review came back. `undefined` allowed means the API server did not say. */
export interface AccessOutcome {
  readonly query: AccessQuery;
  readonly allowed: boolean;
  /** The API server's own explanation, when it gave one. */
  readonly reason?: string;
  /** Set when the review itself failed — a 403 on the review route, say. */
  readonly error?: string;
}

/** `get apps/deployments` — the shape both the table and a remedy name a grant by. */
export const describeQuery = (query: AccessQuery): string => {
  const resource =
    query.subresource === undefined ? query.resource : `${query.resource}/${query.subresource}`;
  return `${query.verb} ${query.group === "" ? "" : `${query.group}/`}${resource}`;
};

interface ReviewResponse {
  readonly status?: {
    readonly allowed?: boolean;
    readonly reason?: string;
    readonly evaluationError?: string;
  };
}

/**
 * Check 1 — the config block, with its values printed.
 *
 * An EMPTY `namespaces` list is a failure rather than a warning, and that is a deliberate
 * disagreement with `config/load.ts`, which accepts it. The loader is right to: a
 * supervisor must not refuse to boot over a feature nothing may be using. But an operator
 * who ran this command with `enabled: true` has said the feature is meant to work, and an
 * empty allowlist denies every namespace (`guard.ts`), so the feature is inert. Passing
 * would be certifying a runner that refuses every read.
 */
export const checkConfig = (config: PreflightConfig): CheckResult => {
  const lines = [
    `cluster.enabled    = ${String(config.enabled)}`,
    `cluster.namespaces = ${config.namespaces.length === 0 ? "(empty)" : config.namespaces.join(", ")}`,
    `cluster.lokiUrl    = ${config.lokiUrl}`,
    `cluster.kubeApiUrl = ${config.kubeApiUrl}`,
  ];

  if (!config.enabled) {
    return fail(
      "config",
      "cluster.enabled is false, so this runner performs no cluster reads at all",
      "set cluster.enabled to true in the supervisor ConfigMap and roll the pod",
      lines,
    );
  }
  if (config.namespaces.length === 0) {
    return fail(
      "config",
      "cluster.namespaces is empty, which denies every namespace",
      "list the namespaces a remediation session may read in cluster.namespaces — an " +
        "empty list is not 'all', it is 'none' (see cluster/guard.ts), so the tools would " +
        "refuse every call while looking enabled",
      lines,
    );
  }
  if (config.lokiUrl.length === 0 || config.kubeApiUrl.length === 0) {
    return fail(
      "config",
      "cluster.lokiUrl and cluster.kubeApiUrl must both be non-empty",
      "remove the key to take the in-cluster default rather than setting it to an empty string",
      lines,
    );
  }

  return pass("config", `enabled for ${config.namespaces.length} namespace(s)`, lines);
};

/** What the credential check was handed. Injected so no test needs a mounted volume. */
export interface CredentialProbe {
  readonly tokenPath: string;
  readonly caPath: string;
  /** Resolves to the file's contents, or rejects. `readFile` in production. */
  readonly read: (path: string) => Promise<string>;
}

/**
 * Check 2 — the projected ServiceAccount token and the cluster CA.
 *
 * Both files or neither: a token with no CA cannot be used, because the only honest way to
 * talk to the kube API is with its own CA pinned. There is deliberately no branch here that
 * proceeds without one.
 */
export const checkCredentials = async (
  probe: CredentialProbe,
): Promise<{ readonly result: CheckResult; readonly credentials?: { token: string; ca: string } }> => {
  const load = async (path: string): Promise<string | undefined> => {
    try {
      const value = await probe.read(path);
      return value.trim().length === 0 ? undefined : value;
    } catch {
      return undefined;
    }
  };

  const [token, ca] = await Promise.all([load(probe.tokenPath), load(probe.caPath)]);
  const missing = [
    ...(token === undefined ? [probe.tokenPath] : []),
    ...(ca === undefined ? [probe.caPath] : []),
  ];

  if (token === undefined || ca === undefined) {
    return {
      result: fail(
        "token and CA",
        `missing or empty: ${missing.join(", ")}`,
        "this check only works from INSIDE a pod, where the projected ServiceAccount " +
          "volume supplies both files. If you are in a pod, the ServiceAccount may have " +
          "automountServiceAccountToken: false, or the Pod spec may set it — remove that " +
          "and roll. Outside a pod, pass --token-file <file> with a token obtained from a " +
          "kubeconfig and --ca-file <file> with the cluster CA. There is no mode that " +
          "skips TLS verification.",
      ),
    };
  }

  return {
    result: pass(
      "token and CA",
      `token (${token.trim().length} chars) and CA (${ca.length} bytes) read`,
      [`token: ${probe.tokenPath}`, `CA:    ${probe.caPath}`],
    ),
    credentials: { token: token.trim(), ca },
  };
};

/** Body → JSON, or `undefined`. A non-JSON body from the kube API is itself the finding. */
const asJson = <T>(body: string): T | undefined => {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
};

/** First line of an HTTP body, clipped — enough to identify an HTML error page. */
const oneLine = (body: string): string =>
  body.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Check 3 — `GET /version`, TLS verified against the mounted CA.
 *
 * There is no `--insecure` and no remedy that suggests one. A certificate this does not
 * trust means the CA is not the cluster's, and the fix is the right CA, never a client that
 * stops checking.
 */
export const checkKubeVersion = async (kube: KubeContext): Promise<CheckResult> => {
  let response: HttpResponse;
  try {
    response = await kube.http({
      url: `${kube.kubeApiUrl}/version`,
      token: kube.token,
      ca: kube.ca,
    });
  } catch (error) {
    return fail(
      "kube API",
      `GET ${kube.kubeApiUrl}/version failed: ${error instanceof Error ? error.message : String(error)}`,
      "in-cluster the only address that works is https://kubernetes.default.svc — check " +
        "cluster.kubeApiUrl. A certificate error here means the CA that was mounted is not " +
        "the one this API server presents; supply the right CA, never a client that skips " +
        "verification.",
    );
  }

  if (response.status !== 200) {
    return fail(
      "kube API",
      `GET /version answered HTTP ${response.status}: ${oneLine(response.body)}`,
      response.status === 401
        ? "a 401 on /version is an unauthenticated token — it may have expired, or the " +
            "file read is not the one this API server issued. Roll the pod to get a fresh " +
            "projected token."
        : "the address answered but not as a kube API server. Check cluster.kubeApiUrl " +
            "points at the API server and not at an Ingress or a proxy in front of it.",
    );
  }

  const payload = asJson<{ readonly gitVersion?: string; readonly platform?: string }>(
    response.body,
  );
  if (payload?.gitVersion === undefined) {
    return fail(
      "kube API",
      `GET /version returned no gitVersion: ${oneLine(response.body)}`,
      "something answered on this address that is not a Kubernetes API server",
    );
  }

  return pass(
    "kube API",
    `reachable, server ${payload.gitVersion}${payload.platform === undefined ? "" : ` (${payload.platform})`}`,
  );
};

/**
 * Check 4 — each allowlisted namespace exists and is readable.
 *
 * Separate from the access reviews on purpose. A review answers "would I be allowed", which
 * is `allowed: true` for a namespace that does not exist — so an allowlist with a typo in it
 * passes every RBAC check and then returns nothing from every read. This check is the one
 * that catches the typo.
 */
export const checkNamespaces = async (
  kube: KubeContext,
  namespaces: readonly string[],
): Promise<CheckResult> => {
  const lines: string[] = [];
  const problems: string[] = [];

  for (const namespace of namespaces) {
    let response: HttpResponse;
    try {
      response = await kube.http({
        url: `${kube.kubeApiUrl}/api/v1/namespaces/${namespace}`,
        token: kube.token,
        ca: kube.ca,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lines.push(`${namespace}  ERROR  ${detail}`);
      problems.push(`${namespace}: ${detail}`);
      continue;
    }

    if (response.status === 200) {
      lines.push(`${namespace}  ok`);
      continue;
    }
    if (response.status === 403) {
      lines.push(`${namespace}  403 forbidden`);
      problems.push(
        `${namespace}: the ServiceAccount lacks 'get namespaces' for it — grant get on ` +
          `resource 'namespaces' (core group, cluster-scoped) or accept that this one line ` +
          `stays red while the per-namespace reads below work`,
      );
      continue;
    }
    if (response.status === 404) {
      lines.push(`${namespace}  404 not found`);
      problems.push(
        `${namespace}: no such namespace in this cluster — cluster.namespaces has a typo, ` +
          `or the namespace has not been created yet`,
      );
      continue;
    }
    lines.push(`${namespace}  HTTP ${response.status}`);
    problems.push(`${namespace}: HTTP ${response.status} — ${oneLine(response.body)}`);
  }

  if (problems.length > 0) {
    return fail(
      "namespaces",
      `${problems.length} of ${namespaces.length} namespace(s) not readable`,
      problems.join("; "),
      lines,
    );
  }
  return pass("namespaces", `${namespaces.length} namespace(s) reachable`, lines);
};

/**
 * One `SelfSubjectAccessReview`.
 *
 * `SelfSubjectAccessReview` rather than `SubjectAccessReview`: the self- form asks about the
 * token doing the asking, needs no `create subjectaccessreviews` grant beyond its own route,
 * and cannot be pointed at another identity. Every authenticated principal may perform it,
 * which means a 403 on THIS route is itself a finding worth reporting rather than a hole.
 */
export const reviewAccess = async (
  kube: KubeContext,
  query: AccessQuery,
): Promise<AccessOutcome> => {
  const body = JSON.stringify({
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectAccessReview",
    spec: {
      resourceAttributes: {
        namespace: query.namespace,
        verb: query.verb,
        group: query.group,
        resource: query.resource,
        ...(query.subresource === undefined ? {} : { subresource: query.subresource }),
      },
    },
  });

  let response: HttpResponse;
  try {
    response = await kube.http({
      url: `${kube.kubeApiUrl}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
      token: kube.token,
      ca: kube.ca,
      method: "POST",
      body,
    });
  } catch (error) {
    return {
      query,
      allowed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return { query, allowed: false, error: `HTTP ${response.status}: ${oneLine(response.body)}` };
  }

  const payload = asJson<ReviewResponse>(response.body);
  if (payload?.status === undefined) {
    return { query, allowed: false, error: `unparseable review response: ${oneLine(response.body)}` };
  }

  const reason = payload.status.reason ?? payload.status.evaluationError;
  return {
    query,
    allowed: payload.status.allowed === true,
    ...(reason === undefined || reason.length === 0 ? {} : { reason }),
  };
};

/** Fixed-width RBAC table, so a missing grant is found by scanning one column. */
export const renderAccessTable = (outcomes: readonly AccessOutcome[]): readonly string[] => {
  const width = Math.max(...outcomes.map((outcome) => describeQuery(outcome.query).length), 10);
  return outcomes.map((outcome) => {
    const grant = describeQuery(outcome.query).padEnd(width);
    const verdict = outcome.allowed ? "ALLOWED" : "denied ";
    // Two columns rather than one: "allowed" is a pass on a read and a failure on a write,
    // and collapsing them into a single "ok" would hide exactly that distinction.
    const expected = outcome.query.want === outcome.allowed ? "ok  " : "WRONG";
    const note = outcome.error ?? outcome.reason ?? "";
    return `  ${grant}  ${verdict}  ${expected}${note.length === 0 ? "" : `  ${note}`}`;
  });
};

/**
 * Check 5 — RBAC, precisely, including the negative.
 *
 * The reads are the obvious half. The writes are the half that makes this check worth
 * having: see `WRITE_VERBS` above. A write verb that comes back allowed fails the run with a
 * message an operator cannot mistake for a warning, because the alternative is a preflight
 * that blesses a `cluster-admin` binding.
 */
export const checkAccess = async (
  kube: KubeContext,
  namespaces: readonly string[],
): Promise<{ readonly result: CheckResult; readonly outcomes: readonly AccessOutcome[] }> => {
  const outcomes: AccessOutcome[] = [];
  for (const namespace of namespaces) {
    for (const query of accessQueries(namespace)) {
      outcomes.push(await reviewAccess(kube, query));
    }
  }

  const lines: string[] = [];
  for (const namespace of namespaces) {
    lines.push(`namespace ${namespace}:`);
    lines.push(...renderAccessTable(outcomes.filter((o) => o.query.namespace === namespace)));
  }

  const missing = outcomes.filter((outcome) => outcome.query.want && !outcome.allowed);
  const writable = outcomes.filter((outcome) => !outcome.query.want && outcome.allowed);
  const broken = outcomes.filter((outcome) => outcome.error !== undefined);

  if (writable.length > 0) {
    return {
      outcomes,
      result: fail(
        "RBAC",
        `THE TOKEN CAN WRITE TO THE CLUSTER — ${writable.length} write verb(s) allowed: ` +
          writable
            .map((outcome) => `${describeQuery(outcome.query)} in ${outcome.query.namespace}`)
            .join(", "),
        "This is the one failure that is not about a missing grant. Alert-driven " +
          "remediation is safe only because this token cannot change the cluster (§20) — " +
          "with write access, a session's blast radius is a live cluster with no review " +
          "step in front of it. Almost always the ServiceAccount is bound to a broad " +
          "ClusterRole (edit, admin or cluster-admin) rather than to the read-only Role " +
          "this feature needs. Fix the binding before enabling remediation.",
        lines,
      ),
    };
  }

  if (missing.length > 0) {
    const grants = missing
      .map((outcome) => `${describeQuery(outcome.query)} in namespace ${outcome.query.namespace}`)
      .join(", ");
    return {
      outcomes,
      result: fail(
        "RBAC",
        `${missing.length} required grant(s) missing: ${grants}`,
        `add these verbs and resources to the supervisor's Role in each namespace and ` +
          `re-apply, then roll the pod: ${grants}. RBAC is additive — nothing else has to ` +
          `be removed — and each line above names the verb and the resource exactly as a ` +
          `Role's rules spell them.` +
          (broken.length > 0
            ? ` ${broken.length} review(s) could not be performed at all: ${broken
                .map((outcome) => `${describeQuery(outcome.query)} (${outcome.error ?? ""})`)
                .join(", ")}`
            : ""),
        lines,
      ),
    };
  }

  if (broken.length > 0) {
    return {
      outcomes,
      result: fail(
        "RBAC",
        `${broken.length} access review(s) failed to run`,
        `every authenticated principal may POST a SelfSubjectAccessReview, so a failure ` +
          `here is about the request rather than about permission: ${broken
            .map((outcome) => `${describeQuery(outcome.query)} (${outcome.error ?? ""})`)
            .join(", ")}`,
        lines,
      ),
    };
  }

  return {
    outcomes,
    result: pass(
      "RBAC",
      `${outcomes.length} review(s): every read allowed, every write denied`,
      lines,
    ),
  };
};

/**
 * Check 6 — Loki answers, and a real bounded query returns something describable.
 *
 * A readiness probe alone is not enough: `/ready` proves a process is up, and the failure
 * this feature actually has is a Loki that is ready and ingesting under label names nobody
 * queried. So one real `query_range` over five minutes follows, and the stream count is
 * printed — zero streams is reported as a fact with the label mismatch named, because a
 * silent namespace and a wrong label look identical from here.
 */
export const checkLoki = async (
  options: {
    readonly lokiUrl: string;
    readonly namespace: string;
    readonly fetch: FetchLike;
    readonly now?: number;
  },
): Promise<CheckResult> => {
  const base = options.lokiUrl.replace(/\/+$/, "");
  const lines: string[] = [];

  const gatewayRemedy =
    `there is no Loki gateway in this cluster (the chart runs SingleBinary with ` +
    `gateway.enabled: false), so the address is the Loki Service itself — ` +
    `http://loki.monitoring.svc.cluster.local:3100. A URL naming a gateway host ` +
    `(loki-gateway, loki-nginx) simply will not resolve.`;

  let ready: Response;
  try {
    ready = await options.fetch(`${base}/ready`);
  } catch (error) {
    return fail(
      "Loki",
      `GET ${base}/ready failed: ${error instanceof Error ? error.message : String(error)}`,
      gatewayRemedy,
    );
  }

  if (!ready.ok) {
    // Not fatal on its own: `/ready` is 503 while Loki replays its WAL, and some
    // deployments put it behind a route that answers 404. The query below is the real test,
    // so this is recorded and the check continues.
    lines.push(`GET /ready answered HTTP ${ready.status} — continuing to the query`);
  } else {
    lines.push(`GET /ready answered 200`);
  }

  const end = options.now ?? Date.now();
  const start = end - 5 * 60_000;
  const query = new URLSearchParams({
    query: `{namespace="${options.namespace}"}`,
    limit: "5",
    // Nanoseconds. A millisecond value is read as 1970 and returns nothing at all, which
    // would look exactly like a label mismatch — see `client.ts`.
    start: String(start * 1_000_000),
    end: String(end * 1_000_000),
    direction: "BACKWARD",
  });

  let response: Response;
  try {
    response = await options.fetch(`${base}/loki/api/v1/query_range?${query.toString()}`);
  } catch (error) {
    return fail(
      "Loki",
      `query_range failed: ${error instanceof Error ? error.message : String(error)}`,
      gatewayRemedy,
      lines,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    return fail(
      "Loki",
      `query_range answered HTTP ${response.status}: ${oneLine(body)}`,
      response.status === 400
        ? `a 400 is a rejected LogQL query — this one is the same selector cluster_logs ` +
            `builds, so a rejection means the endpoint is not Loki's query API`
        : gatewayRemedy,
      lines,
    );
  }

  const payload = asJson<{
    readonly data?: { readonly result?: readonly { readonly stream?: Record<string, string> }[] };
  }>(body);
  const streams = payload?.data?.result;
  if (streams === undefined) {
    return fail(
      "Loki",
      `query_range returned a body that is not a Loki result: ${oneLine(body)}`,
      `something answered on ${base} that is not Loki's query API — a Grafana instance or ` +
        `an Ingress default backend both do this`,
      lines,
    );
  }

  lines.push(`query {namespace="${options.namespace}"} over 5m → ${streams.length} stream(s)`);
  for (const stream of streams.slice(0, 3)) {
    lines.push(`  labels: ${JSON.stringify(stream.stream ?? {})}`);
  }

  if (streams.length === 0) {
    return fail(
      "Loki",
      `Loki answered but returned 0 streams for {namespace="${options.namespace}"} in the last 5 minutes`,
      `either nothing logged in that namespace for five minutes, or — far more likely — ` +
        `Loki is not labelling by 'namespace'. The labels depend on the collector: ` +
        `Promtail's kubernetes_sd gives 'namespace'/'pod', while some Alloy and OTel ` +
        `pipelines give 'k8s_namespace_name'/'k8s_pod_name'. List what this Loki actually ` +
        `has with: curl -s ${base}/loki/api/v1/labels — and if 'namespace' is absent, ` +
        `cluster_logs will always come back empty until the collector's relabelling is fixed.`,
      lines,
    );
  }

  return pass("Loki", `reachable, ${streams.length} stream(s) in the last 5 minutes`, lines);
};

/**
 * Check 7 — the redaction promise, against a real Secret.
 *
 * The one check that verifies what an operator actually cares about: the supervisor's token
 * can read Secret values (RBAC cannot express "keys but not values", see `redact.ts`) and
 * `redactObject` is the entire boundary between those values and a model's transcript.
 *
 * Two things make this an assertion rather than a gesture. It renders through
 * `redact.ts`'s own functions — a reimplementation here would only prove this file agrees
 * with itself — and it asserts on the DECODED values taken from the raw API response, in
 * both plaintext and base64, because a value that survives redaction survives in whichever
 * encoding it arrived in.
 */
export const checkRedaction = (
  secret: Record<string, unknown>,
  name: string,
): CheckResult => {
  const rendered = renderObject(redactObject("Secret", secret));
  const data = secret["data"];
  const keys =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? Object.entries(data as Record<string, unknown>)
      : [];

  if (keys.length === 0) {
    return skip(
      "redaction",
      `Secret ${name} has no data keys, so nothing could leak and nothing was proved`,
      "re-run against a namespace holding a Secret with at least one key to exercise the " +
        "redactor on real bytes",
    );
  }

  const leaked: string[] = [];
  const lines: string[] = [];
  for (const [key, value] of keys) {
    if (typeof value !== "string") continue;
    const decoded = Buffer.from(value, "base64").toString("utf8");
    // Both encodings, and the base64 first: the API server sends base64, and a redactor
    // that decoded before printing would leak the plaintext while the base64 stayed absent.
    if (value.length > 0 && rendered.includes(value)) leaked.push(`${key} (base64)`);
    if (decoded.length > 0 && rendered.includes(decoded)) leaked.push(`${key} (decoded)`);
    if (!rendered.includes(key)) leaked.push(`${key} (key NAME missing from the output)`);
    lines.push(`  ${key}: ${Buffer.from(value, "base64").byteLength} bytes`);
  }

  if (leaked.length > 0) {
    return fail(
      "redaction",
      `Secret ${name}: ${leaked.join(", ")}`,
      "STOP. A Secret's values reached the rendered output that cluster_describe hands to " +
        "a model, or a key name went missing from it. src/cluster/redact.ts is the entire " +
        "boundary here and it is not holding — do not enable remediation until " +
        "redact.test.ts explains why.",
      lines,
    );
  }

  return pass(
    "redaction",
    `Secret ${name}: ${keys.length} key name(s) and byte length(s) rendered, no value present`,
    lines,
  );
};

/** No Secret to read is a SKIP, never a pass: nothing was proved either way. */
export const skipRedaction = (detail: string, remedy: string): CheckResult =>
  skip("redaction", detail, remedy);

/** Check 8's shape — every result, plus the single bit an exit code is made of. */
export interface Verdict {
  readonly results: readonly CheckResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** True only when nothing failed. A skip does not fail the run; it is reported. */
  readonly ok: boolean;
}

export const summarize = (results: readonly CheckResult[]): Verdict => {
  const count = (status: CheckStatus): number =>
    results.filter((result) => result.status === status).length;
  const failed = count("fail");
  return {
    results,
    passed: count("pass"),
    failed,
    skipped: count("skip"),
    ok: failed === 0,
  };
};
