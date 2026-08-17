/**
 * Verifies supervisor-mediated cluster reads from inside the pod — the seventh of these
 * (DESIGN.md §20, and `docs/remediation-runbook.md` for the order of operations).
 *
 *   npm run verify:cluster-read
 *   npm run verify:cluster-read -- /etc/caterpillar/config/config.json --namespace caterpillar
 *   npm run verify:cluster-read -- --skip-loki --json
 *
 * Enabling remediation needs four changes in a SEPARATE deployment repo: an RBAC grant, a
 * Service port, an Alertmanager route and a ConfigMap block. When one of them is wrong the
 * symptom is a confusing tool error inside an agent session, hours later, in the middle of
 * an incident. This command is what makes that a one-line answer instead.
 *
 * Read-only, and provably so — it asserts the token CANNOT write, and that assertion failing
 * fails the run. It performs no mutation of its own beyond `SelfSubjectAccessReview`, which
 * is a POST because the API's own design makes asking "may I?" a review object; nothing is
 * persisted and it answers only about the token doing the asking.
 *
 * The checks live in `../cluster/preflight.ts` as pure functions over an injected HTTP
 * function. This file is argv, credentials, the real transport and printing — same split as
 * `verify-manifests.ts`, and for the same reason: the interesting cases (a 403, an allowed
 * write verb, a leaked Secret value) cannot be provoked against a healthy cluster on demand.
 *
 * There is no `--insecure` and no code path that sets `rejectUnauthorized: false`. A
 * certificate this does not trust means the mounted CA is not the cluster's, and the fix is
 * the right CA rather than a client that stops looking.
 */
import { readFile } from "node:fs/promises";
import { CA_PATH, TOKEN_PATH, httpsGet } from "../cluster/client.ts";
import {
  checkAccess,
  checkConfig,
  checkCredentials,
  checkKubeVersion,
  checkLoki,
  checkNamespaces,
  checkRedaction,
  skipRedaction,
  summarize,
  type CheckResult,
  type KubeContext,
  type PreflightConfig,
} from "../cluster/preflight.ts";
import { loadConfig } from "../config/load.ts";

/** Same env var the supervisor and the credential holder read. One config, one name. */
const CONFIG_ENV = "CONFIG_PATH";
const DEFAULT_CONFIG = "/etc/caterpillar/config/config.json";

const USAGE = `usage: node src/cli/verify-cluster-read.ts [config.json] [options]

  config.json          path to the supervisor config; defaults to $${CONFIG_ENV}
                       or ${DEFAULT_CONFIG}

  --namespace <ns>     check only this namespace (must be in cluster.namespaces)
  --skip-loki          skip the Loki checks, for a cluster that has no Loki
  --token-file <file>  ServiceAccount token from here instead of the projected volume
  --ca-file <file>     cluster CA from here instead of the projected volume
  --json               machine-readable output on stdout, nothing else
  --help               this text

Exit code is 0 only when every non-skipped check passed.`;

interface Args {
  readonly configPath: string;
  readonly namespace?: string;
  readonly skipLoki: boolean;
  readonly tokenFile: string;
  readonly caFile: string;
  readonly json: boolean;
  readonly help: boolean;
}

export const parseArgs = (argv: readonly string[]): Args => {
  let configPath: string | undefined;
  let namespace: string | undefined;
  let tokenFile: string | undefined;
  let caFile: string | undefined;
  let skipLoki = false;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--skip-loki") {
      skipLoki = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--namespace" || arg === "--token-file" || arg === "--ca-file") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}\n\n${USAGE}`);
      i += 1;
      if (arg === "--namespace") namespace = value;
      else if (arg === "--token-file") tokenFile = value;
      else caFile = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    if (configPath !== undefined) throw new Error(`more than one config path given\n\n${USAGE}`);
    configPath = arg;
  }

  return {
    configPath: configPath ?? process.env[CONFIG_ENV] ?? DEFAULT_CONFIG,
    ...(namespace === undefined ? {} : { namespace }),
    skipLoki,
    tokenFile: tokenFile ?? TOKEN_PATH,
    caFile: caFile ?? CA_PATH,
    json,
    help,
  };
};

/** ✓ / ✗ / – , matching the other six verifiers' vocabulary. */
const MARK: Readonly<Record<CheckResult["status"], string>> = {
  pass: "✓",
  fail: "✗",
  skip: "–",
};

/**
 * Print one check, numbered.
 *
 * Numbered because these run in a fixed order and each one presupposes the last: a reader
 * who sees "4 of 7 failed" knows the token and the API server were already fine, which is
 * half of the diagnosis before reading a word of the remedy.
 */
const report = (index: number, total: number, result: CheckResult, json: boolean): void => {
  if (json) return;
  console.log(`\n[${index}/${total}] ${result.name}`);
  console.log(`  ${MARK[result.status]} ${result.detail}`);
  for (const line of result.lines ?? []) console.log(`  ${line}`);
  if (result.remedy !== undefined) {
    console.log(`  → ${result.remedy}`);
  }
};

/** A `Secret` name in the namespace, or a reason there is none to read. */
const findSecret = async (
  kube: KubeContext,
  namespace: string,
): Promise<{ readonly name: string } | { readonly why: string; readonly remedy: string }> => {
  const response = await kube.http({
    url: `${kube.kubeApiUrl}/api/v1/namespaces/${namespace}/secrets?limit=50`,
    token: kube.token,
    ca: kube.ca,
  });

  if (response.status === 403) {
    return {
      why: `listing Secrets in ${namespace} is forbidden, so no live Secret could be read`,
      remedy:
        `grant 'list secrets' in ${namespace} to exercise this check. It is not needed by ` +
        `the tools themselves — cluster_describe only ever GETs a Secret by name — so a ` +
        `403 here is a preflight limitation rather than a broken feature. Until then, the ` +
        `redaction guarantee rests on src/cluster/redact.test.ts alone.`,
    };
  }
  if (response.status !== 200) {
    return {
      why: `could not list Secrets in ${namespace} (HTTP ${response.status})`,
      remedy: "re-run once the kube API answers this route, or pass --namespace elsewhere",
    };
  }

  const payload = JSON.parse(response.body) as {
    readonly items?: readonly {
      readonly metadata?: { readonly name?: string };
      readonly data?: Record<string, unknown>;
    }[];
  };
  // The first Secret with at least one key: an empty one would render nothing and prove
  // nothing, and reporting a vacuous pass is worse than reporting a skip.
  for (const item of payload.items ?? []) {
    const name = item.metadata?.name;
    if (name === undefined) continue;
    if (Object.keys(item.data ?? {}).length === 0) continue;
    return { name };
  }

  return {
    why: `no Secret with any data keys exists in ${namespace}`,
    remedy:
      "nothing was proved either way — re-run with --namespace pointing at a namespace " +
      "that holds a Secret, so the redactor is exercised on real bytes",
  };
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const results: CheckResult[] = [];
  // Fixed, so the numbering is stable between runs and between clusters. The redaction
  // check is always the seventh even when Loki is skipped.
  const TOTAL = 7;

  if (!args.json) {
    console.log(`verify:cluster-read — config ${args.configPath}`);
  }

  // Loaded before anything else, and a failure here is terminal: with no config there is no
  // namespace allowlist, and every check below is about namespaces. The message names the
  // path, because the usual cause is running this outside the pod where the ConfigMap is
  // not mounted at the default location.
  let config: PreflightConfig;
  try {
    const loaded = await loadConfig(args.configPath);
    config = loaded.cluster;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not read the supervisor config at ${args.configPath}: ${detail}\n` +
        `  → pass the path as the first argument, or set ${CONFIG_ENV}. In the pod it is ` +
        `${DEFAULT_CONFIG}; outside the pod, get a copy with ` +
        `\`kubectl -n caterpillar get configmap caterpillar -o jsonpath='{.data.config\\.json}'\`. ` +
        `RUNNER_ID must also be set, exactly as the supervisor requires it.`,
    );
  }

  // 1: config.
  const configResult = checkConfig(config);
  results.push(configResult);
  report(1, TOTAL, configResult, args.json);

  const namespaces =
    args.namespace === undefined ? config.namespaces : [args.namespace];
  if (args.namespace !== undefined && !config.namespaces.includes(args.namespace)) {
    // Refused rather than checked anyway. A namespace the allowlist does not contain is one
    // the guard denies at runtime, so checking it would answer a question about a
    // namespace no session can read — and passing would be actively misleading.
    throw new Error(
      `--namespace ${args.namespace} is not in cluster.namespaces (${config.namespaces.join(", ") || "empty"}) — ` +
        `the guard denies it at runtime, so verifying it would prove nothing`,
    );
  }

  // 2: token and CA.
  const credentials = await checkCredentials({
    tokenPath: args.tokenFile,
    caPath: args.caFile,
    read: (path) => readFile(path, "utf8"),
  });
  results.push(credentials.result);
  report(2, TOTAL, credentials.result, args.json);

  const first = namespaces[0];

  if (credentials.credentials === undefined) {
    // Every kube check needs a credential; LOKI DOES NOT. It is plain HTTP with no bearer
    // in this deployment, so it is still run here — an operator debugging from a
    // workstation with a port-forward gets the one answer that is available to them
    // instead of a screen of skips.
    for (const [index, name] of [
      [3, "kube API"],
      [4, "namespaces"],
      [5, "RBAC"],
    ] as const) {
      const skipped: CheckResult = {
        name,
        status: "skip",
        detail: "not attempted: no ServiceAccount token — see check 2",
      };
      results.push(skipped);
      report(index, TOTAL, skipped, args.json);
    }

    const loki = await lokiCheck(config.lokiUrl, first, args.skipLoki);
    results.push(loki);
    report(6, TOTAL, loki, args.json);

    const redaction: CheckResult = {
      name: "redaction",
      status: "skip",
      detail: "not attempted: no ServiceAccount token, so no Secret could be read — see check 2",
    };
    results.push(redaction);
    report(7, TOTAL, redaction, args.json);
    return finish(results, args.json);
  }

  const kube: KubeContext = {
    kubeApiUrl: config.kubeApiUrl.replace(/\/+$/, ""),
    token: credentials.credentials.token,
    ca: credentials.credentials.ca,
    // The real transport, with the cluster CA pinned per request. `client.ts`'s own helper,
    // not a second one — the `ca`-without-`rejectUnauthorized` arrangement is the property
    // being reused, and a copy of it here would be a second place to get that wrong.
    http: httpsGet,
  };

  // 3: the API server answers, over verified TLS.
  const version = await checkKubeVersion(kube);
  results.push(version);
  report(3, TOTAL, version, args.json);

  // 4, 5 and 7 all speak to the API server, so an unreachable one makes them thirty
  // identical connection errors rather than thirty findings. Reported as skips pointing at
  // check 3, which is the only one an operator can act on.
  const reachable = version.status === "pass";
  const blocked = (name: string): CheckResult => ({
    name,
    status: "skip",
    detail: "not attempted: the kube API did not answer — see check 3",
  });

  // 4: each allowlisted namespace exists.
  const nsResult = reachable ? await checkNamespaces(kube, namespaces) : blocked("namespaces");
  results.push(nsResult);
  report(4, TOTAL, nsResult, args.json);

  // 5: RBAC, reads and — the load-bearing half — writes.
  const rbac = reachable ? (await checkAccess(kube, namespaces)).result : blocked("RBAC");
  results.push(rbac);
  report(5, TOTAL, rbac, args.json);

  // 6: Loki, which is a different address and a different process — so it is attempted
  // whatever the kube API did.
  const loki = await lokiCheck(config.lokiUrl, first, args.skipLoki);
  results.push(loki);
  report(6, TOTAL, loki, args.json);

  // 7: redaction, against a real Secret, through `redact.ts` itself.
  const redaction = reachable ? await redactionCheck(kube, first) : blocked("redaction");
  results.push(redaction);
  report(7, TOTAL, redaction, args.json);

  return finish(results, args.json);
};

/** Check 6, or the reason it was not run. Needs no credential: Loki is plain HTTP here. */
const lokiCheck = async (
  lokiUrl: string,
  namespace: string | undefined,
  skipLoki: boolean,
): Promise<CheckResult> => {
  if (skipLoki) {
    return {
      name: "Loki",
      status: "skip",
      detail: "--skip-loki: cluster_logs will fail at runtime unless Loki exists",
    };
  }
  if (namespace === undefined) {
    return { name: "Loki", status: "skip", detail: "no namespace to query — see check 1" };
  }
  return checkLoki({ lokiUrl, namespace, fetch: (input, init) => fetch(input, init) });
};

/** Find a Secret, read it, and hand the RAW object to the redactor the tools use. */
const redactionCheck = async (
  kube: KubeContext,
  namespace: string | undefined,
): Promise<CheckResult> => {
  if (namespace === undefined) {
    return skipRedaction("no namespace to read a Secret from — see check 1", "fix check 1 first");
  }

  let found: Awaited<ReturnType<typeof findSecret>>;
  try {
    found = await findSecret(kube, namespace);
  } catch (error) {
    return skipRedaction(
      `could not look for a Secret in ${namespace}: ${error instanceof Error ? error.message : String(error)}`,
      "the kube API did not answer the Secret list route; check 3 and check 4 say more",
    );
  }
  if ("why" in found) return skipRedaction(found.why, found.remedy);

  const response = await kube.http({
    url: `${kube.kubeApiUrl}/api/v1/namespaces/${namespace}/secrets/${found.name}`,
    token: kube.token,
    ca: kube.ca,
  });
  if (response.status !== 200) {
    return skipRedaction(
      `GET Secret ${namespace}/${found.name} answered HTTP ${response.status}`,
      "check 5's table says whether 'get secrets' is granted in this namespace",
    );
  }

  // The RAW response, deliberately. The check decodes `data` from this object and asserts
  // each decoded and each base64 substring is absent from the rendered output — so it is
  // comparing against the bytes the API server really sent, not against an expectation.
  return checkRedaction(
    JSON.parse(response.body) as Record<string, unknown>,
    `${namespace}/${found.name}`,
  );
};

/** Print the summary (or the JSON document) and return the process's exit code. */
const finish = (results: readonly CheckResult[], json: boolean): number => {
  const verdict = summarize(results);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: verdict.ok,
          passed: verdict.passed,
          failed: verdict.failed,
          skipped: verdict.skipped,
          checks: verdict.results.map((result) => ({
            name: result.name,
            status: result.status,
            detail: result.detail,
            ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
            ...(result.lines === undefined ? {} : { lines: result.lines }),
          })),
        },
        null,
        2,
      ),
    );
    return verdict.ok ? 0 : 1;
  }

  console.log("\n--- summary ---");
  const width = Math.max(...verdict.results.map((result) => result.name.length));
  for (const result of verdict.results) {
    console.log(`  ${MARK[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
  }
  console.log(
    `\n${verdict.passed} passed, ${verdict.failed} failed, ${verdict.skipped} skipped`,
  );

  if (verdict.ok) {
    console.log(
      verdict.skipped === 0
        ? "\nVERDICT: PASS — supervisor-mediated cluster reads work from this pod, and the " +
            "token cannot write."
        : "\nVERDICT: PASS with skips — nothing failed, but the skipped checks above proved " +
            "nothing. Read them before calling this verified.",
    );
    return 0;
  }

  console.log(
    "\nVERDICT: FAIL — remediation sessions will not be able to diagnose anything until " +
      "the failures above are fixed. Each one names its remedy; " +
      "docs/remediation-runbook.md has the order of operations.",
  );
  return 1;
};

/**
 * One exit path, and no unhandled rejection on any of them.
 *
 * The failure this handler exists for is running the command OUTSIDE a cluster, which is
 * how most people will first meet it: no config at that path, no token file, no API server.
 * That must be one legible line and a non-zero exit, never a stack trace — an operator
 * reading a Node stack for "you are not in a pod" learns nothing from it.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
