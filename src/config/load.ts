/**
 * Config loading. See DESIGN.md §3.1, §10.
 *
 * Config comes from a ConfigMap-mounted JSON file plus a few env vars for
 * pod identity. Secrets are NOT here — only `secretRef` names pointing into the
 * mounted secret directory, so a config dump can never leak a credential.
 */
import { readFile } from "node:fs/promises";
import { identityFault } from "./identity.ts";
import { isTimeZone } from "../digest/day.ts";
import {
  asWorkspaceName,
  KNOWN_CAPABILITIES,
  type Capability,
  type WorkspaceName,
} from "../domain/task.ts";
import type { LogLevel } from "../obs/log.ts";
import { DEFAULT_TOOLCHAIN_CONFIG as DEFAULTS } from "../workspace/toolchain.ts";
import { DEFAULT_REAP_CONFIG as REAP_DEFAULTS } from "../workspace/worktree.ts";
import { DEFAULT_USAGE_CONFIG as USAGE_DEFAULTS, defaultWorkRoot } from "../workspace/usage.ts";
import { DEFAULT_KUBE_API_URL, DEFAULT_LOKI_URL, MAX_LOG_LINES } from "../cluster/client.ts";
import type {
  ClusterConfig,
  CommitIdentity,
  DigestConfig,
  LlmConfig,
  RedisConfig,
  BotConfig,
  RemediationConfig,
  RunnerConfig,
  ScheduleConfig,
  WebConfig,
  WorkspaceProfile,
} from "./types.ts";

export class ConfigError extends Error {
  constructor(detail: string) {
    super(`invalid configuration: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Shape of the on-disk config file. Validated into RunnerConfig. */
interface RawConfig {
  readonly capabilities?: unknown;
  readonly identity?: unknown;
  readonly stateRepo?: {
    readonly url?: unknown;
    readonly branch?: unknown;
    readonly path?: unknown;
    readonly secretRef?: unknown;
  };
  readonly paths?: {
    readonly mirrors?: unknown;
    readonly tasks?: unknown;
    readonly root?: unknown;
  };
  readonly usage?: { readonly intervalHours?: unknown; readonly deadlineSeconds?: unknown };
  readonly lease?: { readonly heartbeatSeconds?: unknown; readonly staleAfterSeconds?: unknown };
  readonly handoff?: { readonly thresholdFraction?: unknown };
  readonly limits?: {
    readonly maxSessionsPerTask?: unknown;
    readonly noProgressLimit?: unknown;
    readonly maxReviewRounds?: unknown;
    readonly maxSessionSeconds?: unknown;
    readonly commandTimeoutSeconds?: unknown;
    readonly sabotageMaxCommands?: unknown;
    readonly sabotageMinFreeGb?: unknown;
    readonly ciSettleSeconds?: unknown;
    readonly ciPollSeconds?: unknown;
  };
  readonly toolchain?: {
    readonly nixpkgs?: unknown;
    readonly timeoutSeconds?: unknown;
    readonly gcIntervalHours?: unknown;
    readonly gcKeepDays?: unknown;
    readonly substituters?: unknown;
    readonly trustedPublicKeys?: unknown;
    readonly minFreeGb?: unknown;
    readonly maxFreeGb?: unknown;
  };
  readonly workspace?: {
    readonly reap?: {
      readonly intervalHours?: unknown;
      readonly keepHours?: unknown;
    };
  };
  readonly llm?: Record<string, unknown>;
  readonly workspaces?: Record<string, unknown>;
  readonly pollSeconds?: unknown;
  readonly housekeepingSeconds?: unknown;
  readonly concurrency?: unknown;
  readonly secretsDir?: unknown;
  readonly log?: { readonly level?: unknown };
  readonly intake?: { readonly intervalSeconds?: unknown };
  readonly web?: Record<string, unknown>;
  readonly digest?: Record<string, unknown>;
  readonly schedule?: Record<string, unknown>;
  readonly cluster?: Record<string, unknown>;
  readonly remediation?: Record<string, unknown>;
  readonly redis?: Record<string, unknown>;
  readonly bot?: Record<string, unknown>;
}

const str = (value: unknown, field: string, fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value;
};

const num = (value: unknown, field: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${field} must be a finite number`);
  }
  return value;
};

/**
 * The nix store's disk quota (DESIGN.md §8.1).
 *
 * Validated together rather than as two independent numbers, because the ORDER between
 * them is the setting. `max-free` at or below `min-free` means nix has already met its
 * target the moment it starts collecting, so it collects on every single build and frees
 * almost nothing each time — a store that thrashes its garbage collector while still
 * filling the disk, which reads from outside as "the quota is on and not working".
 *
 * Refused at boot rather than corrected, because either number could be the typo and
 * picking one would be guessing which.
 */
const nixFreeSpace = (
  toolchain: RawConfig["toolchain"],
): { minFreeGb: number; maxFreeGb: number } => {
  const minFreeGb = num(toolchain?.minFreeGb, "toolchain.minFreeGb", DEFAULTS.minFreeGb);
  const maxFreeGb = num(toolchain?.maxFreeGb, "toolchain.maxFreeGb", DEFAULTS.maxFreeGb);

  if (minFreeGb < 0) throw new ConfigError("toolchain.minFreeGb cannot be negative");
  // 0 is the documented off switch, and off means neither number applies.
  if (minFreeGb > 0 && maxFreeGb <= minFreeGb) {
    throw new ConfigError(
      `toolchain.maxFreeGb (${maxFreeGb}) must exceed toolchain.minFreeGb (${minFreeGb}) — ` +
        `the gap between them is the hysteresis, and without one nix collects on every ` +
        `build and frees almost nothing`,
    );
  }

  return { minFreeGb, maxFreeGb };
};

/**
 * A list of non-empty strings, defaulting to empty.
 *
 * Every entry is checked rather than the array as a whole: a substituter list with one
 * `null` in it would otherwise reach nix as the string "null" and be reported as an
 * unreachable cache, which sends the operator looking at the network.
 */
const strings = (value: unknown, field: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array of strings`);
  return value.map((entry, index) => str(entry, `${field}[${index}]`));
};

/**
 * A boolean is never coerced.
 *
 * `"false"` is truthy in JavaScript and false in intent, and the field this most matters
 * for decides whether unauthenticated requests are answered. Refusing the string is the
 * only reading that cannot silently mean the opposite of what was written.
 */
const bool = (value: unknown, field: string, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${field} must be true or false`);
  return value;
};

const port = (value: unknown, field: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${field} must be an integer port between 1 and 65535`);
  }
  return value;
};

const KNOWN_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const logLevel = (value: unknown): LogLevel => {
  if (value === undefined) return "info";
  if (typeof value !== "string" || !KNOWN_LOG_LEVELS.includes(value as LogLevel)) {
    throw new ConfigError(
      `log.level must be one of ${KNOWN_LOG_LEVELS.join(", ")} (got '${String(value)}')`,
    );
  }
  return value as LogLevel;
};

const capabilities = (value: unknown): readonly Capability[] => {
  if (!Array.isArray(value)) throw new ConfigError("capabilities must be an array");
  return value.map((entry) => {
    if (typeof entry !== "string" || !KNOWN_CAPABILITIES.includes(entry as Capability)) {
      throw new ConfigError(
        `unknown capability '${String(entry)}' (known: ${KNOWN_CAPABILITIES.join(", ")})`,
      );
    }
    return entry as Capability;
  });
};

/**
 * Validate who this runner authors as (DESIGN.md §9.7).
 *
 * Required, with no default. Every default would be a claim about who wrote an audit
 * trail, and after the fact a wrong claim is indistinguishable from a right one — so a
 * runner that has not been told refuses to start rather than guess.
 *
 * Which addresses are refused, and why, lives in `identity.ts`: the same rule guards the
 * environment every task shell is handed, and it must be one rule rather than two copies
 * that agree today.
 */
const identity = (value: unknown): CommitIdentity => {
  const raw = (value === null || typeof value !== "object" ? {} : value) as Record<string, unknown>;
  const name = str(raw["name"], "identity.name");
  const email = str(raw["email"], "identity.email");

  const fault = identityFault(email);
  if (fault !== undefined) throw new ConfigError(`identity.email ${fault}`);

  // `identityFault` is deliberately NOT asked of the retired addresses. Nothing commits as
  // one — they exist so the digest can recognise its own past work (§19) — and refusing a
  // bare noreply address here would leave a deployment that already made that mistake
  // unable to describe the history it has.
  return { name, email, pastEmails: strings(raw["pastEmails"], "identity.pastEmails") };
};

const workspace = (name: string, value: unknown): WorkspaceProfile => {
  if (value === null || typeof value !== "object") {
    throw new ConfigError(`workspace '${name}' must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const forge = raw["forge"];
  if (forge === null || typeof forge !== "object") {
    throw new ConfigError(`workspace '${name}' is missing 'forge'`);
  }
  const f = forge as Record<string, unknown>;
  const kind = str(f["kind"], `workspaces.${name}.forge.kind`);
  if (kind !== "github" && kind !== "forgejo") {
    throw new ConfigError(`workspaces.${name}.forge.kind must be 'github' or 'forgejo'`);
  }

  const tracker = raw["tracker"];
  const profile: WorkspaceProfile = {
    name: asWorkspaceName(name),
    forge: {
      kind,
      host: str(f["host"], `workspaces.${name}.forge.host`),
      owner: str(f["owner"], `workspaces.${name}.forge.owner`),
      apiBase: str(f["apiBase"], `workspaces.${name}.forge.apiBase`),
    },
    secretRef: str(raw["secretRef"], `workspaces.${name}.secretRef`),
  };

  if (tracker === null || tracker === undefined) return profile;

  const t = tracker as Record<string, unknown>;
  const trackerKind = str(t["kind"], `workspaces.${name}.tracker.kind`);
  if (trackerKind !== "github-issues" && trackerKind !== "vikunja") {
    throw new ConfigError(
      `workspaces.${name}.tracker.kind must be 'github-issues' or 'vikunja'`,
    );
  }

  const optionalLabel = (field: string): string | undefined => {
    const value = t[field];
    return value === undefined ? undefined : str(value, `workspaces.${name}.tracker.${field}`);
  };
  const wipLabel = optionalLabel("wipLabel");
  const needsHumanLabel = optionalLabel("needsHumanLabel");

  return {
    ...profile,
    tracker: {
      kind: trackerKind,
      apiBase: str(t["apiBase"], `workspaces.${name}.tracker.apiBase`),
      ingestLabel: str(t["ingestLabel"], `workspaces.${name}.tracker.ingestLabel`),
      ...(wipLabel !== undefined ? { wipLabel } : {}),
      ...(needsHumanLabel !== undefined ? { needsHumanLabel } : {}),
    },
  };
};

/**
 * Validate the LLM block.
 *
 * `auth` defaults to `proxy` so an existing config keeps working. Subscription mode
 * demands `credentialsPath` up front rather than failing at the first session: the
 * OAuth login needs a browser, so discovering it is missing inside a pod is
 * discovering it too late.
 */
const llmConfig = (llm: Record<string, unknown>): LlmConfig => {
  const auth = llm["auth"] ?? "proxy";
  if (auth !== "proxy" && auth !== "subscription") {
    throw new ConfigError("llm.auth must be 'proxy' or 'subscription'");
  }

  const credentialsPath = llm["credentialsPath"];
  const credentialsUrl = llm["credentialsUrl"];
  // Either is a complete answer to "where does this runner get its credential", and a
  // fleet's ConfigMap carries BOTH because the same object configures the runners and
  // the holder they read from. Only their joint absence is a misconfiguration.
  if (auth === "subscription" && credentialsPath === undefined && credentialsUrl === undefined) {
    throw new ConfigError(
      "llm.auth is 'subscription' but neither llm.credentialsPath nor llm.credentialsUrl " +
        "is set — a single runner needs a path on writable, durable storage (the PVC), " +
        "because refreshing the token rotates it; a fleet needs the URL of the credential " +
        "holder that owns the only copy",
    );
  }

  return {
    auth,
    // Unused by subscription mode, but still required: a config that silently
    // stops pointing anywhere when auth flips is worse than one that repeats itself.
    baseUrl: str(llm["baseUrl"], "llm.baseUrl"),
    modelId: str(llm["modelId"], "llm.modelId"),
    providerId: str(llm["providerId"], "llm.providerId"),
    contextWindow: num(llm["contextWindow"], "llm.contextWindow"),
    maxTokens: num(llm["maxTokens"], "llm.maxTokens"),
    // Defaulted, never required: this exists to survive an incident, and an incident
    // must not be the moment a runner discovers its ConfigMap is a field short.
    cooldown: {
      initialSeconds: num(llm["cooldownSeconds"], "llm.cooldownSeconds", 60),
      maxSeconds: num(llm["maxCooldownSeconds"], "llm.maxCooldownSeconds", 1800),
    },
    ...(credentialsPath === undefined
      ? {}
      : { credentialsPath: str(credentialsPath, "llm.credentialsPath") }),
    ...(credentialsUrl === undefined
      ? {}
      : { credentialsUrl: str(credentialsUrl, "llm.credentialsUrl") }),
  };
};

/**
 * Validate the `digest` block (DESIGN.md §19).
 *
 * The hour and the zone are checked even when the digest is disabled. A runner that has a
 * typo in a zone it is not currently using finds out the day someone enables it — in the
 * cluster, at 18:00, when the thing that was supposed to report the day instead throws
 * inside the poll loop.
 */
const digestConfig = (digest: Record<string, unknown>): DigestConfig => {
  const hour = num(digest["hour"], "digest.hour", 18);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ConfigError("digest.hour must be an integer hour between 0 and 23");
  }

  const timeZone = str(digest["timezone"], "digest.timezone", "Europe/Berlin");
  if (!isTimeZone(timeZone)) {
    throw new ConfigError(
      `digest.timezone '${timeZone}' is not an IANA zone name — it must be something like ` +
        `'Europe/Berlin' or 'UTC'. An unrecognised zone would otherwise fall back to UTC ` +
        `and publish at the wrong hour forever without saying so`,
    );
  }

  return {
    enabled: bool(digest["enabled"], "digest.enabled", false),
    hour,
    timeZone,
    summarise: bool(digest["summarise"], "digest.summarise", true),
  };
};

/** See `WebConfig` for why `enabled` and `requireForwardedUser` default the way they do. */
const webConfig = (web: Record<string, unknown>): WebConfig => ({
  enabled: bool(web["enabled"], "web.enabled", false),
  port: port(web["port"], "web.port", 8080),
  logCapacity: num(web["logCapacity"], "web.logCapacity", 500),
  refreshSeconds: num(web["refreshSeconds"], "web.refreshSeconds", 10),
  requireForwardedUser: bool(web["requireForwardedUser"], "web.requireForwardedUser", false),
  forwardedUserHeader: str(
    web["forwardedUserHeader"],
    "web.forwardedUserHeader",
    "remote-user",
  ).toLowerCase(),
});

/**
 * Validate the `schedule` block (DESIGN.md §22).
 *
 * One field, and nothing to validate but its type — everything else about a schedule is in
 * the state repo, where a malformed one is refused on the intake pass and shown on
 * `/intake` rather than discovered at 09:00 by a runner with nothing useful to do.
 */
const scheduleConfig = (schedule: Record<string, unknown>): ScheduleConfig => ({
  enabled: bool(schedule["enabled"], "schedule.enabled", false),
});

/**
 * Validate the `cluster` block (DESIGN.md §20).
 *
 * Everything defaults, and the defaults are the closed ones: disabled, no namespaces. The
 * namespace list is validated per entry by `strings`, so a `null` in it is a config error
 * rather than an allowlist containing the string "null".
 *
 * `enabled: true` with an empty list is NOT an error here. It is a runner that will refuse
 * every read and increment `outcome="denied"` when it does, which is a state an operator can
 * see and fix — whereas throwing at startup would take the whole supervisor down over a
 * feature nothing may even be using yet.
 */
const clusterConfig = (cluster: Record<string, unknown>): ClusterConfig => {
  const maxLogLines = num(cluster["maxLogLines"], "cluster.maxLogLines", MAX_LOG_LINES);
  if (!Number.isInteger(maxLogLines) || maxLogLines < 1) {
    throw new ConfigError("cluster.maxLogLines must be a positive integer");
  }

  return {
    enabled: bool(cluster["enabled"], "cluster.enabled", false),
    namespaces: strings(cluster["namespaces"], "cluster.namespaces"),
    lokiUrl: str(cluster["lokiUrl"], "cluster.lokiUrl", DEFAULT_LOKI_URL),
    kubeApiUrl: str(cluster["kubeApiUrl"], "cluster.kubeApiUrl", DEFAULT_KUBE_API_URL),
    // Clamped rather than refused: the client caps it too, and an operator who wrote a
    // larger number wanted more logs, not a runner that will not start.
    maxLogLines: Math.min(maxLogLines, MAX_LOG_LINES),
  };
};

/**
 * Validate the `remediation` block (DESIGN.md §20).
 *
 * Off by default — see `RemediationConfig` for why this one's default matters more than the
 * web view's. The port is validated even when the receiver is disabled, for the reason
 * `digestConfig` validates its zone: a typo in a field nobody is using is discovered the
 * day someone enables it, in the cluster, by a supervisor that throws at boot.
 */
const remediationConfig = (remediation: Record<string, unknown>): RemediationConfig => ({
  enabled: bool(remediation["enabled"], "remediation.enabled", false),
  port: port(remediation["port"], "remediation.port", 8081),
});

/**
 * Validate the `redis` block (DESIGN.md §21).
 *
 * Off by default, and everything is validated whether it is on or not — `digestConfig`'s
 * reason: a typo in a field nobody is using is otherwise discovered the day someone
 * enables it, in the cluster, by a supervisor that throws at boot.
 *
 * The URL's SCHEME is checked rather than the whole thing parsed. `redis://` and
 * `rediss://` are the two the driver understands, and an `http://` here is not a
 * connection that fails once — it is a client that retries a nonsense endpoint forever
 * while every read on the plane quietly times out and degrades, which looks from the logs
 * like a Redis that is merely down.
 */
const redisConfig = (redis: Record<string, unknown>): RedisConfig => {
  const url = str(redis["url"], "redis.url", "redis://localhost:6379");
  if (!/^rediss?:\/\//.test(url)) {
    throw new ConfigError(
      `redis.url must start with redis:// or rediss:// (got '${url.split(":")[0] ?? ""}:...')`,
    );
  }

  const commandTimeoutMs = num(redis["commandTimeoutMs"], "redis.commandTimeoutMs", 1000);
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
    throw new ConfigError("redis.commandTimeoutMs must be a positive integer");
  }

  return {
    enabled: bool(redis["enabled"], "redis.enabled", false),
    url,
    ...(redis["secretRef"] === undefined
      ? {}
      : { secretRef: str(redis["secretRef"], "redis.secretRef") }),
    commandTimeoutMs,
    keyPrefix: str(redis["keyPrefix"], "redis.keyPrefix", "caterpillar:"),
  };
};

/**
 * Validate the `bot` block (DESIGN.md §7).
 *
 * The mode is validated as an enum rather than coerced, because the failure of a typo is
 * invisible: `mode: "extrenal"` silently falling back to in-process gives a fleet where
 * the supervisor AND the standalone bot are both connected to Discord and both acting,
 * which is the duplicate-acting failure the whole arrangement exists to prevent. A boot
 * failure naming the field is the only honest answer.
 */
const botConfig = (bot: Record<string, unknown>): BotConfig => {
  const mode = str(bot["mode"], "bot.mode", "in-process");
  if (mode !== "in-process" && mode !== "external") {
    throw new ConfigError(
      `bot.mode must be "in-process" or "external" (got '${mode}')`,
    );
  }

  return { mode, port: port(bot["port"], "bot.port", 9091) };
};

export const loadConfig = async (path: string): Promise<RunnerConfig> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as RawConfig;

  const runnerId = process.env["RUNNER_ID"];
  if (runnerId === undefined || runnerId.length === 0) {
    throw new ConfigError("RUNNER_ID must be set (use the pod name via fieldRef)");
  }

  const workspaces = new Map<WorkspaceName, WorkspaceProfile>();
  for (const [name, value] of Object.entries(raw.workspaces ?? {})) {
    workspaces.set(asWorkspaceName(name), workspace(name, value));
  }
  if (workspaces.size === 0) throw new ConfigError("at least one workspace is required");

  const llm = raw.llm ?? {};

  const mirrors = str(raw.paths?.mirrors, "paths.mirrors");
  const tasks = str(raw.paths?.tasks, "paths.tasks");

  // Hoisted because `housekeepingSeconds` both defaults to it and is clamped by it, and
  // three copies of the same `num(..., 30)` are three places for the default to drift.
  const poll = num(raw.pollSeconds, "pollSeconds", 30);

  // Default 1, so a runner that says nothing behaves exactly as every runner did before
  // slots existed. Refused rather than clamped when it is nonsense: `concurrency: 0` is a
  // runner that claims nothing and looks perfectly healthy doing it, and `concurrency: 2.5`
  // is a typo whose silent correction an operator would never find out about. Both are
  // configuration mistakes with no reading that is more likely than "this was meant to be a
  // count of slots", so they stop the boot rather than the throughput.
  const concurrency = num(raw.concurrency, "concurrency", 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ConfigError("concurrency must be a whole number of at least 1");
  }

  // Hoisted out of the `limits` block below so they can be validated before they are used.
  // Both are refused rather than clamped, for the same reason `concurrency` is: the only
  // reading of either is "a budget", so a number that is not one is a typo, and correcting
  // it silently leaves an operator believing they set something they did not.
  const sabotageMaxCommands = num(
    raw.limits?.sabotageMaxCommands,
    "limits.sabotageMaxCommands",
    40,
  );
  if (!Number.isInteger(sabotageMaxCommands) || sabotageMaxCommands < 1) {
    throw new ConfigError(
      `limits.sabotageMaxCommands (${sabotageMaxCommands}) must be a whole number of at ` +
        `least 1 — a sabotage reviewer that cannot run a command can only abstain, and it ` +
        `would do so once per task with a full session spent on it`,
    );
  }

  // 0 is allowed here, unlike `toolchain.minFreeGb`: it is the honest "copy regardless" for
  // a single-replica machine with no shared volume to fill.
  const sabotageMinFreeGb = num(raw.limits?.sabotageMinFreeGb, "limits.sabotageMinFreeGb", 5);
  if (sabotageMinFreeGb < 0) {
    throw new ConfigError(
      `limits.sabotageMinFreeGb (${sabotageMinFreeGb}) cannot be negative`,
    );
  }

  // Not 0, and not negative: `awaitChecks` sleeps `min(pollMs, remaining)` between polls,
  // so a non-positive interval polls the forge continuously for the whole settle budget.
  // `ciSettleSeconds` needs no companion check — 0 there simply skips the wait.
  const ciPollSeconds = num(raw.limits?.ciPollSeconds, "limits.ciPollSeconds", 30);
  if (ciPollSeconds < 1) {
    throw new ConfigError(
      `limits.ciPollSeconds (${ciPollSeconds}) must be at least 1 second: a shorter ` +
        `interval polls CI continuously for the whole of limits.ciSettleSeconds`,
    );
  }

  return {
    runnerId,
    capabilities: capabilities(raw.capabilities),
    identity: identity(raw.identity),
    toolchain: {
      nixpkgs: str(raw.toolchain?.nixpkgs, "toolchain.nixpkgs", DEFAULTS.nixpkgs),
      timeoutSeconds: num(
        raw.toolchain?.timeoutSeconds,
        "toolchain.timeoutSeconds",
        DEFAULTS.timeoutSeconds,
      ),
      gcIntervalHours: num(
        raw.toolchain?.gcIntervalHours,
        "toolchain.gcIntervalHours",
        DEFAULTS.gcIntervalHours,
      ),
      gcKeepDays: num(raw.toolchain?.gcKeepDays, "toolchain.gcKeepDays", DEFAULTS.gcKeepDays),
      substituters: strings(raw.toolchain?.substituters, "toolchain.substituters"),
      trustedPublicKeys: strings(
        raw.toolchain?.trustedPublicKeys,
        "toolchain.trustedPublicKeys",
      ),
      ...nixFreeSpace(raw.toolchain),
    },
    // The worktree half of the same janitor. Both entirely defaulted, because the numbers
    // that are right for a 20Gi PVC are right for every runner on one and an operator who
    // has to tune a garbage collector before the disk stops filling has not been given a
    // garbage collector.
    workspace: {
      reap: {
        intervalHours: num(
          raw.workspace?.reap?.intervalHours,
          "workspace.reap.intervalHours",
          REAP_DEFAULTS.intervalHours,
        ),
        keepHours: num(
          raw.workspace?.reap?.keepHours,
          "workspace.reap.keepHours",
          REAP_DEFAULTS.keepHours,
        ),
      },
    },
    stateRepo: {
      url: str(raw.stateRepo?.url, "stateRepo.url"),
      branch: str(raw.stateRepo?.branch, "stateRepo.branch"),
      path: str(raw.stateRepo?.path, "stateRepo.path"),
      ...(raw.stateRepo?.secretRef === undefined
        ? {}
        : { secretRef: str(raw.stateRepo.secretRef, "stateRepo.secretRef") }),
    },
    paths: {
      mirrors,
      tasks,
      // Defaulted rather than required: every config written before the usage measurement
      // existed omits it, and a mandatory field would refuse to load all of them.
      root: str(raw.paths?.root, "paths.root", defaultWorkRoot(mirrors, tasks)),
    },
    usage: {
      intervalHours: num(
        raw.usage?.intervalHours,
        "usage.intervalHours",
        USAGE_DEFAULTS.intervalHours,
      ),
      deadlineSeconds: num(
        raw.usage?.deadlineSeconds,
        "usage.deadlineSeconds",
        USAGE_DEFAULTS.deadlineSeconds,
      ),
    },
    lease: {
      heartbeatSeconds: num(raw.lease?.heartbeatSeconds, "lease.heartbeatSeconds", 60),
      staleAfterSeconds: num(raw.lease?.staleAfterSeconds, "lease.staleAfterSeconds", 300),
    },
    handoff: {
      thresholdFraction: num(raw.handoff?.thresholdFraction, "handoff.thresholdFraction", 0.7),
    },
    limits: {
      maxSessionsPerTask: num(raw.limits?.maxSessionsPerTask, "limits.maxSessionsPerTask", 20),
      noProgressLimit: num(raw.limits?.noProgressLimit, "limits.noProgressLimit", 3),
      maxReviewRounds: num(raw.limits?.maxReviewRounds, "limits.maxReviewRounds", 3),
      // Four hours. Long enough that no honest session has ever come close — the longest
      // observed is well under one — and short enough that a hung tool call is caught
      // within a shift rather than discovered by someone wondering why the queue stopped.
      maxSessionSeconds: num(raw.limits?.maxSessionSeconds, "limits.maxSessionSeconds", 4 * 60 * 60),
      // 15 minutes, matching the acceptance gate's own per-command timeout. This is the
      // hang detector that actually catches things; maxSessionSeconds above is what
      // catches whatever this misses.
      commandTimeoutSeconds: num(
        raw.limits?.commandTimeoutSeconds,
        "limits.commandTimeoutSeconds",
        15 * 60,
      ),
      sabotageMaxCommands,
      sabotageMinFreeGb,
      // 20 minutes. Comfortably longer than this repo's own CI (~5 minutes) plus time
      // queueing behind other runs, and short enough that a check which is genuinely
      // stuck reaches an agent within one session slot rather than pinning the runner.
      ciSettleSeconds: num(raw.limits?.ciSettleSeconds, "limits.ciSettleSeconds", 20 * 60),
      ciPollSeconds,
    },
    llm: llmConfig(llm),
    workspaces,
    pollSeconds: poll,
    // Defaulted to `pollSeconds` rather than to a constant, and then clamped to it: the
    // guarantee the split is worth having for is "chat, intake and leadership are never
    // slower than they were before", and a config that set `pollSeconds: 5` and left this
    // alone would silently break it. Faster is allowed — housekeeping costs a fetch and a
    // few array filters, and a human waiting on `/resume` is the thing being optimised.
    housekeepingSeconds: Math.min(num(raw.housekeepingSeconds, "housekeepingSeconds", poll), poll),
    concurrency,
    secretsDir: str(raw.secretsDir, "secretsDir"),
    log: { level: logLevel(raw.log?.level) },
    intake: {
      intervalSeconds: num(raw.intake?.intervalSeconds, "intake.intervalSeconds", 300),
    },
    web: webConfig(raw.web ?? {}),
    digest: digestConfig(raw.digest ?? {}),
    schedule: scheduleConfig(raw.schedule ?? {}),
    cluster: clusterConfig(raw.cluster ?? {}),
    remediation: remediationConfig(raw.remediation ?? {}),
    redis: redisConfig(raw.redis ?? {}),
    bot: botConfig(raw.bot ?? {}),
  };
};
