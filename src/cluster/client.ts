/**
 * The HTTP layer behind the three supervisor-mediated cluster reads. See DESIGN.md §20.
 *
 * The arrangement, and why it is this one:
 *
 *   The alternative was `kubectl` in the agent's shell, using the pod's ambient
 *   ServiceAccount token. It was rejected (§9.2, §20): the credential would then belong to
 *   the POD, so every task that ever ran on the runner — an ordinary `implement` task, a
 *   brainstorm, anything — would inherit cluster read access, and the boundary would be
 *   "what the model chose to type" rather than a checked list of namespaces. Here the
 *   supervisor holds the token, performs the request, and hands back text. The agent never
 *   sees a credential, exactly as it never sees a forge token (§9.2).
 *
 * Three rules this file exists to enforce, all of them structural rather than advisory:
 *
 *   1. `assertNamespaceAllowed` runs before ANY IO in all three methods. `client.test.ts`
 *      proves it per method with an injected request function that fails if reached.
 *   2. No model-supplied string reaches a URL path or a LogQL query un-validated.
 *      `names.ts` is the allowlist; `escapeForLogQL` is the belt to its braces.
 *   3. TLS verification is never disabled. There is no `rejectUnauthorized: false` here
 *      and no code path that adds one — see `readCredentials`.
 *
 * Why `node:https` and not global `fetch`: the kube API is served with the cluster's own
 * CA, and Node's global fetch has no supported way to supply a per-request CA bundle. The
 * documented escape hatches are process-wide (`NODE_EXTRA_CA_CERTS`,
 * `NODE_TLS_REJECT_UNAUTHORIZED`) and both are worse than a twelve-line request helper:
 * one needs an env var set before the process starts, the other switches verification off
 * for every TLS client in the supervisor, including the forge. `node:https` takes `ca` per
 * request, which is the narrow thing we actually want. Loki is plain HTTP in-cluster, so
 * global fetch is fine there.
 */
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { outputCeiling } from "../agent/budget.ts";
import { assertNamespaceAllowed } from "./guard.ts";
import { isPodPattern, validateKind, validateName, validatePodPattern } from "./names.ts";
import { assertKindDescribable, redactObject, renderObject } from "./redact.ts";

/**
 * Where the projected ServiceAccount volume lands in every pod.
 *
 * Exported because `verify:cluster-read` reports on these two files by name: "the token is
 * missing" is only actionable when the operator is told which path was looked at.
 */
export const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

/** Defaults for the two endpoints. Both overridable through config (§5). */
export const DEFAULT_KUBE_API_URL = "https://kubernetes.default.svc";
export const DEFAULT_LOKI_URL = "http://loki.monitoring.svc.cluster.local:3100";

/**
 * Ceilings the tool layer also advertises, kept here so the client cannot be talked past them.
 *
 * There is deliberately no `MAX_LOG_LINES` beside them. Lines from `cluster_logs` are
 * bounded by `MAX_OUTPUT_LINES` — the general one (§6.4) — because this used to be the only
 * output bound in the codebase and had a private copy of every rule. Two constants for one
 * quantity is how they come to disagree, and the disagreement would be invisible: a
 * remediation session getting a different ceiling from Loki than from its own shell, with
 * nothing anywhere to say why.
 */
export const MAX_SINCE_MINUTES = 24 * 60;
export const MAX_EVENTS = 200;

export interface LogsRequest {
  readonly namespace: string;
  /** A pod name, or a name with a single trailing `.*`. Absent means the whole namespace. */
  readonly pod?: string;
  readonly sinceMinutes?: number;
  readonly limit?: number;
}

export interface EventsRequest {
  readonly namespace: string;
  /** `name` or `Kind/name` of the object the events must involve. */
  readonly involvedObject?: string;
  readonly limit?: number;
}

export interface DescribeRequest {
  readonly kind: string;
  readonly name: string;
  readonly namespace: string;
}

/**
 * What the tools are given. An interface rather than the class, so `tools.test.ts` can
 * assert on binding without standing up an HTTP layer at all.
 */
export interface ClusterReader {
  logs(request: LogsRequest): Promise<string>;
  events(request: EventsRequest): Promise<string>;
  describe(request: DescribeRequest): Promise<string>;
}

/** One HTTPS response, reduced to the two things this module reacts to. */
export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The injectable seam for the kube API. Matches `httpsGet` below. */
export type HttpsGet = (options: {
  readonly url: string;
  readonly token: string;
  readonly ca: string;
  /**
   * `GET` unless stated. The only non-GET caller is the preflight's
   * `SelfSubjectAccessReview`, which is a POST by the API's own design — asking "may I?"
   * creates a review object. It is still a read in every sense that matters: the review is
   * not persisted and answers only about the presented token.
   */
  readonly method?: "GET" | "POST";
  /** JSON body, for `POST`. Ignored on a GET, where a body has no meaning here. */
  readonly body?: string;
}) => Promise<HttpResponse>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ClusterUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `cluster reads are unavailable: ${detail}. These tools only work in-cluster, where ` +
        `the ServiceAccount token and the cluster CA are projected into the pod. There is ` +
        `deliberately no fallback that skips TLS verification`,
    );
    this.name = "ClusterUnavailableError";
  }
}

export class ClusterRequestError extends Error {
  readonly status: number;

  /** `status` 0 means the request completed and the BODY was the problem. */
  constructor(what: string, status: number, body: string) {
    super(
      status === 0
        ? `${what}: ${body.slice(0, 400)}`
        : `${what} failed with HTTP ${status}: ${body.slice(0, 400)}`,
    );
    this.name = "ClusterRequestError";
    this.status = status;
  }
}

/**
 * One request over HTTPS with an explicit CA. The whole reason this module does not use fetch.
 *
 * Deliberately minimal: no redirects followed, no retry. The kube API is one network hop
 * away inside the same cluster, so a failure here is a real failure and retrying it would
 * only delay the message reaching the session that has to act on it.
 *
 * `POST` exists for exactly one caller — `preflight.ts`'s access reviews — and is NOT a
 * write path into the cluster: a `SelfSubjectAccessReview` is how the API server is asked
 * what the presented token may do, it stores nothing, and the client class above never
 * passes a method at all. Sharing this function rather than growing a second one keeps the
 * `ca`-per-request arrangement, and the absence of `rejectUnauthorized`, in one place.
 */
export const httpsGet: HttpsGet = (options) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const body = options.method === "POST" ? (options.body ?? "") : undefined;
    const request = httpsRequest(
      options.url,
      {
        method: options.method ?? "GET",
        // `ca` REPLACES the default trust store for this request, which is exactly right:
        // the kube API is signed by the cluster CA and by nothing a public root would
        // vouch for. Note what is absent — `rejectUnauthorized` is left at its default of
        // true, and there is no branch anywhere in this file that sets it to false.
        ca: options.ca,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body, "utf8")),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });

type Credentials = ClusterCredentials;

/** The token and CA one process reads once. Exported for the preflight's own load. */
export interface ClusterCredentials {
  readonly token: string;
  readonly ca: string;
}

export interface ClusterClientOptions {
  /** Namespaces this client may read. Empty denies everything (see `guard.ts`). */
  readonly namespaces: readonly string[];
  readonly kubeApiUrl?: string;
  readonly lokiUrl?: string;
  readonly maxLogLines?: number;
  /**
   * Bearer token for Loki. Absent by default and absent in the deployment we have: the
   * SingleBinary Loki has `gateway.enabled: false`, so there is no nginx front door and
   * nothing to authenticate to. It exists for the day the base URL points at a Grafana
   * datasource proxy instead, which does want one.
   */
  readonly lokiToken?: string;
  /** Test seams. Production takes the defaults and touches the real network. */
  readonly httpsGet?: HttpsGet;
  readonly fetch?: FetchLike;
  /** Reads the ServiceAccount token and CA. Injectable so no test needs a mounted volume. */
  readonly readCredentials?: () => Promise<Credentials>;
}

/**
 * Load the ServiceAccount token and the cluster CA.
 *
 * A missing file is a typed, terminal failure naming the file. It is emphatically NOT a
 * cue to fall back to unverified TLS: the situation "I could not find the CA" and the
 * situation "I will trust any certificate" differ by the entire security property, and a
 * fallback would make a runner started outside the cluster silently accept anything
 * answering on `kubernetes.default.svc`.
 */
export const readServiceAccount = async (): Promise<Credentials> => {
  const load = async (path: string, what: string): Promise<string> => {
    try {
      return await readFile(path, "utf8");
    } catch {
      throw new ClusterUnavailableError(`${what} is missing or unreadable at ${path}`);
    }
  };

  const [token, ca] = await Promise.all([
    load(TOKEN_PATH, "the ServiceAccount token"),
    load(CA_PATH, "the cluster CA bundle"),
  ]);
  if (token.trim().length === 0) throw new ClusterUnavailableError(`the token at ${TOKEN_PATH} is empty`);
  if (ca.trim().length === 0) throw new ClusterUnavailableError(`the CA bundle at ${CA_PATH} is empty`);
  return { token: token.trim(), ca };
};

/**
 * Escape a validated pod pattern for a LogQL matcher.
 *
 * Belt to `names.ts`'s braces. The pattern has already been checked against the Kubernetes
 * name grammar, so by construction there is nothing here to escape — but the query is
 * assembled by string concatenation, and one day someone will add a third caller. A `"` or
 * a `}` reaching the selector would let a session write its own query, and the cost of
 * being certain twice is one function.
 */
export const escapeForLogQL = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const clamp = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
};

/**
 * Kind → the API route that GETs one object of it.
 *
 * Exported so `preflight.ts` derives the RBAC it checks from THIS table rather than from a
 * second hand-written list: a resource the client can reach and the preflight does not know
 * about is precisely the 403 that would surface hours later inside a session.
 *
 * A literal table rather than a discovery call. Discovery would be one more request, one
 * more failure mode, and — the part that matters — it would let the kind decide its own
 * path. Here the path for a kind is a line in this file, which is the same reasoning as
 * `DESCRIBABLE_KINDS` being a literal in `redact.ts`.
 */
export const ROUTES: Readonly<Record<string, string>> = {
  Pod: "/api/v1/namespaces/{ns}/pods/{name}",
  Service: "/api/v1/namespaces/{ns}/services/{name}",
  ConfigMap: "/api/v1/namespaces/{ns}/configmaps/{name}",
  Secret: "/api/v1/namespaces/{ns}/secrets/{name}",
  PersistentVolumeClaim: "/api/v1/namespaces/{ns}/persistentvolumeclaims/{name}",
  Deployment: "/apis/apps/v1/namespaces/{ns}/deployments/{name}",
  StatefulSet: "/apis/apps/v1/namespaces/{ns}/statefulsets/{name}",
  DaemonSet: "/apis/apps/v1/namespaces/{ns}/daemonsets/{name}",
  Job: "/apis/batch/v1/namespaces/{ns}/jobs/{name}",
  CronJob: "/apis/batch/v1/namespaces/{ns}/cronjobs/{name}",
  Ingress: "/apis/networking.k8s.io/v1/namespaces/{ns}/ingresses/{name}",
};

interface KubeEvent {
  readonly type?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTimestamp?: string;
  readonly eventTime?: string;
  readonly firstTimestamp?: string;
  readonly involvedObject?: { readonly kind?: string; readonly name?: string };
}

interface LokiStream {
  readonly stream?: Readonly<Record<string, string>>;
  readonly values?: readonly (readonly [string, string])[];
}

/**
 * Read-only access to logs, events and single objects, bounded by a namespace allowlist.
 *
 * Constructed once per process, in `index.ts`, and handed to a remediation session's tool
 * bundle. Credentials are read ONCE per session rather than per request — a token file
 * read on every call would be three syscalls per diagnosis for a file that changes hourly
 * — and re-read exactly once on a 401, which is what a rotation looks like from here.
 */
export class ClusterClient implements ClusterReader {
  private readonly options: ClusterClientOptions;
  private readonly get: HttpsGet;
  private readonly http: FetchLike;
  private readonly readCredentials: () => Promise<Credentials>;
  private readonly kubeApiUrl: string;
  private readonly lokiUrl: string;
  private readonly maxLogLines: number;

  /** Cached for the process. `undefined` means "not read yet", never "unavailable". */
  private credentials: Promise<Credentials> | undefined;

  constructor(options: ClusterClientOptions) {
    this.options = options;
    this.get = options.httpsGet ?? httpsGet;
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
    this.readCredentials = options.readCredentials ?? readServiceAccount;
    this.kubeApiUrl = (options.kubeApiUrl ?? DEFAULT_KUBE_API_URL).replace(/\/+$/, "");
    this.lokiUrl = (options.lokiUrl ?? DEFAULT_LOKI_URL).replace(/\/+$/, "");
    // Through `outputCeiling` rather than a `Math.min` of its own: the default-and-clamp
    // rule is one rule (§6.4), and this used to be the only place that had it.
    //
    // One behaviour change to know about: the two layers treat nonsense differently. A
    // programmatic `maxLogLines: 0` used to yield 0 and now yields the 2,000 default, so
    // out-of-range input RAISES the effective bound here instead of lowering it. Nothing
    // reaches this through config — `load.ts`'s `outputBound` refuses anything below 1 by
    // name — and no caller passes a non-positive value, so it is left as the shared rule's
    // answer rather than special-cased back.
    this.maxLogLines = outputCeiling({
      ...(options.maxLogLines === undefined ? {} : { maxLines: options.maxLogLines }),
    }).maxLines;
  }

  /** The allowlist, for the startup log line an operator debugging a denial goes looking for. */
  get namespaces(): readonly string[] {
    return this.options.namespaces;
  }

  /**
   * Logs for a namespace, optionally narrowed to a pod or a replica-set prefix.
   *
   * The selector is built from VALIDATED PARTS and never from a model-supplied string:
   * `{namespace="…", pod=~"…"}`, both sides through `names.ts` first. A raw string here
   * would let a session append its own matchers and read a namespace the guard just
   * refused, which is the one bypass this whole feature has to be immune to.
   */
  async logs(request: LogsRequest): Promise<string> {
    assertNamespaceAllowed(request.namespace, this.options.namespaces);
    const namespace = validateName("namespace", request.namespace);

    const sinceMinutes = clamp(request.sinceMinutes, 30, MAX_SINCE_MINUTES);
    const limit = clamp(request.limit, 200, this.maxLogLines);

    const matchers = [`namespace="${escapeForLogQL(namespace)}"`];
    if (request.pod !== undefined) {
      const pod = validatePodPattern("pod", request.pod);
      const escaped = escapeForLogQL(pod);
      matchers.push(isPodPattern(pod) ? `pod=~"${escaped}"` : `pod="${escaped}"`);
    }

    const end = Date.now();
    const query = new URLSearchParams({
      query: `{${matchers.join(", ")}}`,
      limit: String(limit),
      // Nanoseconds: Loki's range API takes RFC3339 or a Unix timestamp in ns, and a
      // millisecond value is silently read as 1970, which returns nothing at all.
      start: String((end - sinceMinutes * 60_000) * 1_000_000),
      end: String(end * 1_000_000),
      // Newest first from Loki, so when the limit bites it is the OLDEST lines that are
      // lost rather than the ones nearest the incident. The render below sorts back to
      // oldest-first, because a log is read as a narrative.
      direction: "BACKWARD",
    });

    const url = `${this.lokiUrl}/loki/api/v1/query_range?${query.toString()}`;
    const response = await this.http(url, {
      headers: {
        accept: "application/json",
        ...(this.options.lokiToken === undefined
          ? {}
          : { authorization: `Bearer ${this.options.lokiToken}` }),
      },
    });
    if (!response.ok) {
      throw new ClusterRequestError("Loki query", response.status, await response.text());
    }

    const payload = parseJson<{ readonly data?: { readonly result?: readonly LokiStream[] } }>(
      await response.text(),
      "Loki query",
    );
    const lines: { readonly at: bigint; readonly text: string }[] = [];
    for (const stream of payload.data?.result ?? []) {
      const pod = stream.stream?.["pod"] ?? "";
      for (const [ns, line] of stream.values ?? []) {
        // A timestamp that is not a number would otherwise throw out of `BigInt` and end the
        // tool call with a message about syntax. Sorted to the front instead: an unreadable
        // timestamp is still a log line, and the line is what the session came for.
        const at = nanosOrZero(ns);
        lines.push({ at, text: `${at === 0n ? ns : isoFromNanos(ns)}  ${pod}  ${line.trimEnd()}` });
      }
    }
    if (lines.length === 0) {
      return (
        `No log lines in the last ${sinceMinutes} minutes for {${matchers.join(", ")}}. ` +
        `An empty result is a fact, not an error: the pod may be silent, or Loki may not ` +
        `be ingesting that namespace.`
      );
    }

    // Sorted here rather than trusting per-stream order: the result is a set of streams,
    // one per pod, each ordered within itself and interleaved with none of the others.
    lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const kept = lines.slice(-limit);
    const note =
      lines.length > kept.length ? `# … ${lines.length - kept.length} older line(s) dropped by limit=${limit}\n` : "";
    return `${note}${kept.map((line) => line.text).join("\n")}\n`;
  }

  /**
   * Events in a namespace, newest first, optionally for one involved object.
   *
   * Newest first here and oldest first in `logs` on purpose. An event list is read as "what
   * has just happened", and the answer is at the top; a log is read as a narrative, and a
   * narrative that runs backwards is unreadable.
   */
  async events(request: EventsRequest): Promise<string> {
    assertNamespaceAllowed(request.namespace, this.options.namespaces);
    const namespace = validateName("namespace", request.namespace);
    const limit = clamp(request.limit, 50, MAX_EVENTS);

    const query = new URLSearchParams();
    if (request.involvedObject !== undefined) {
      // `Kind/name` or a bare name. Both halves are validated before they reach the query
      // string — the name against the object-name grammar, the kind against the kind
      // grammar — because the API server parses this parameter and a session must not be
      // able to write half of it.
      const [first, second] = request.involvedObject.split("/");
      const name = second === undefined ? (first ?? "") : second;
      const selectors = [`involvedObject.name=${validateName("involvedObject", name)}`];
      if (second !== undefined && first !== undefined) {
        selectors.push(`involvedObject.kind=${validateKind("involvedObject kind", first)}`);
      }
      query.set("fieldSelector", selectors.join(","));
    }

    const suffix = query.toString();
    const path = `/api/v1/namespaces/${namespace}/events${suffix.length === 0 ? "" : `?${suffix}`}`;
    const payload = await this.kubeGet<{ readonly items?: readonly KubeEvent[] }>(
      path,
      "kube events",
    );

    const items = [...(payload.items ?? [])];
    items.sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
    if (items.length === 0) {
      return (
        `No events in namespace ${namespace}${request.involvedObject === undefined ? "" : ` for ${request.involvedObject}`}. ` +
        `Kubernetes expires events after about an hour, so "none" often means "nothing ` +
        `recently" rather than "nothing ever".`
      );
    }

    const kept = items.slice(0, limit);
    const rows = kept.map((event) => {
      const object = `${event.involvedObject?.kind ?? "?"}/${event.involvedObject?.name ?? "?"}`;
      return [
        eventTime(event) || "-",
        event.type ?? "-",
        event.reason ?? "-",
        object,
        (event.message ?? "").replace(/\s+/g, " ").trim(),
      ].join("  ");
    });
    const note =
      items.length > kept.length ? `# … ${items.length - kept.length} older event(s) dropped by limit=${limit}\n` : "";
    return `${note}${rows.join("\n")}\n`;
  }

  /** One object, redacted, as YAML. See `redact.ts` for what "redacted" is load-bearing for. */
  async describe(request: DescribeRequest): Promise<string> {
    assertNamespaceAllowed(request.namespace, this.options.namespaces);
    const namespace = validateName("namespace", request.namespace);
    const kind = assertKindDescribable(request.kind);
    const name = validateName("name", request.name);

    const route = ROUTES[kind];
    // Unreachable while ROUTES covers DESCRIBABLE_KINDS, and checked anyway: the two lists
    // live in different files and the failure of a missed entry would otherwise be a
    // request to the string "undefined".
    if (route === undefined) throw new ClusterUnavailableError(`no API route is known for kind ${kind}`);

    const object = await this.kubeGet<Record<string, unknown>>(
      route.replace("{ns}", namespace).replace("{name}", name),
      `kube get ${kind}/${name}`,
    );
    return renderObject(redactObject(kind, object));
  }

  /**
   * One authenticated GET against the kube API, with the 401 re-read.
   *
   * A projected ServiceAccount token is rotated by the kubelet — hourly by default — and
   * the file on disk is replaced rather than the running process being told. So a 401 is
   * most likely a stale cached token, and re-reading once is the whole remedy. Once, not
   * in a loop: a genuine RBAC denial also answers 401/403, and retrying that would turn a
   * clear message into a hang.
   */
  private async kubeGet<T>(path: string, what: string): Promise<T> {
    const url = `${this.kubeApiUrl}${path}`;
    let credentials = await this.load();
    let response = await this.get({ url, token: credentials.token, ca: credentials.ca });

    if (response.status === 401) {
      this.credentials = undefined;
      credentials = await this.load();
      response = await this.get({ url, token: credentials.token, ca: credentials.ca });
    }

    if (response.status < 200 || response.status >= 300) {
      throw new ClusterRequestError(what, response.status, response.body);
    }
    return parseJson<T>(response.body, what);
  }

  /** Read-once-per-session credentials. The promise is cached so concurrent calls share one read. */
  private async load(): Promise<Credentials> {
    // Cached on failure would wedge the client for the process's life, so an error clears
    // the cache: a token that was not projected yet at startup can succeed on a later call.
    const pending = this.credentials ?? this.readCredentials();
    this.credentials = pending;
    try {
      return await pending;
    } catch (error) {
      this.credentials = undefined;
      throw error;
    }
  }
}

/**
 * JSON, or a typed error that says which call produced the unparseable body.
 *
 * A bare `SyntaxError` would reach the session as "Unexpected token < in JSON at position
 * 0", which is the signature of an HTML error page from something that is not the API
 * server at all — and the one detail that would help is which endpoint answered.
 */
const parseJson = <T>(body: string, what: string): T => {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ClusterRequestError(`${what} returned a body that is not JSON`, 0, body);
  }
};

/** Nanoseconds, or 0 for anything Loki sent that is not a number. */
const nanosOrZero = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

/** Best available timestamp on an event. `lastTimestamp` is empty on the events.k8s.io shape. */
const eventTime = (event: KubeEvent): string =>
  event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? "";

/** Nanosecond string → ISO instant. Millisecond precision is enough to read a log by. */
const isoFromNanos = (nanos: string): string => {
  const ms = Number(BigInt(nanos) / 1_000_000n);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : nanos;
};
