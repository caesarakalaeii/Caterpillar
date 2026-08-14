/**
 * Runner and workspace configuration. See DESIGN.md §3.1 (workspaces).
 *
 * Config carries NO secrets. Every credential is referenced indirectly via
 * `secretRef` and resolved from the mounted SOPS secret at use time, so a config
 * dump is never a credential leak.
 */
import type { Capability, ForgeKind, TrackerKind, WorkspaceName } from "../domain/task.ts";
import type { LogLevel } from "../obs/log.ts";

export interface ForgeConfig {
  readonly kind: ForgeKind;
  readonly host: string;
  /** Default owner/org for repos in this workspace. */
  readonly owner: string;
  /** API base, e.g. `https://codeberg.org/api/v1`. */
  readonly apiBase: string;
}

export interface TrackerConfig {
  readonly kind: TrackerKind;
  readonly apiBase: string;
  /** Label that marks an item as agent-eligible at intake. */
  readonly ingestLabel: string;
  /**
   * Labels the supervisor applies as a task moves (DESIGN.md §9.5). Optional because
   * the adapters default them (`agent-wip`, `needs-human`) — they exist here so a
   * tracker that already uses different vocabulary needs a config change, not a
   * code change. The label must already exist: no adapter creates one.
   */
  readonly wipLabel?: string;
  readonly needsHumanLabel?: string;
}

/**
 * One ecosystem: forge + tracker + credential bundle. A task in one workspace can
 * never obtain another workspace's credentials.
 */
export interface WorkspaceProfile {
  readonly name: WorkspaceName;
  readonly forge: ForgeConfig;
  readonly tracker?: TrackerConfig;
  /** Key into the mounted secret directory. */
  readonly secretRef: string;
}

export interface LeaseConfig {
  /** Heartbeat interval. Also the fencing granularity (DESIGN.md §5.1). */
  readonly heartbeatSeconds: number;
  /** A lease older than this is stealable. Must exceed plausible clock skew. */
  readonly staleAfterSeconds: number;
}

export interface HandoffConfig {
  /**
   * Fraction of the model's context window at which the session hands off.
   * Must leave pi's compaction trigger unreachable — enforced by
   * `assertHandoffBeforeCompaction` (DESIGN.md §6.1).
   */
  readonly thresholdFraction: number;
}

export interface LimitsConfig {
  readonly maxSessionsPerTask: number;
  /** Consecutive no-progress sessions before parking. */
  readonly noProgressLimit: number;
  /**
   * Times the review council may send one task back before it parks for a human
   * (DESIGN.md §12.1). The council and the implementation agent can otherwise trade a
   * task until the session limit, which looks from outside like a task that is running
   * and getting nowhere.
   */
  readonly maxReviewRounds: number;
}

export interface StateRepoConfig {
  /**
   * Clone URL of the state repo. Written by the supervisor only (DESIGN.md §9.3).
   * HTTPS, so the GitHub App token can authenticate it as a header.
   */
  readonly url: string;
  readonly branch: string;
  /** Checkout path on the PVC. */
  readonly path: string;
  /**
   * Secret holding the GitHub App credentials used for the state repo — same key
   * layout as a github workspace (`app-id`, `installation-id`, `private-key.pem`).
   * The App must be installed on the state repo, which is a different repo from the
   * ones tasks touch.
   *
   * Optional: without it the supervisor assumes the checkout is already authenticated,
   * which is only true for local development.
   */
  readonly secretRef?: string;
}

export interface WorkspacePathsConfig {
  /** Bare mirrors, one per repo. */
  readonly mirrors: string;
  /** Per-task worktrees. */
  readonly tasks: string;
}

/**
 * How the runner authenticates to the model provider (DESIGN.md §9.6).
 *
 * `proxy` — the in-cluster proxy holds the provider credential.
 * `subscription` — pi-ai's Anthropic OAuth mode against a Claude Pro/Max
 *   subscription, talking to api.anthropic.com directly. There is no proxy in this
 *   path: an OAuth bearer credential cannot be forwarded by a proxy that
 *   authenticates with `x-api-key`.
 */
export type LlmAuthMode = "proxy" | "subscription";

export interface LlmConfig {
  readonly auth: LlmAuthMode;
  /** Proxy base URL. Ignored for `subscription`, which uses pi's own provider. */
  readonly baseUrl: string;
  readonly modelId: string;
  /** Provider id registered with pi-ai for the proxy. Ignored for `subscription`. */
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /**
   * Where the rotating OAuth credential lives. Required for `subscription`.
   *
   * Must be on WRITABLE, durable storage — the PVC, never a mounted Secret.
   * Refreshing rotates the refresh token, so a read-only mount locks the
   * supervisor out as soon as the access token expires.
   */
  readonly credentialsPath?: string;
}

export interface RunnerConfig {
  readonly runnerId: string;
  readonly capabilities: readonly Capability[];
  readonly stateRepo: StateRepoConfig;
  readonly paths: WorkspacePathsConfig;
  readonly lease: LeaseConfig;
  readonly handoff: HandoffConfig;
  readonly limits: LimitsConfig;
  readonly llm: LlmConfig;
  readonly workspaces: ReadonlyMap<WorkspaceName, WorkspaceProfile>;
  /** Seconds between claim attempts when no task is available. */
  readonly pollSeconds: number;
  /** Directory of mounted secret files, keyed by `secretRef`. */
  readonly secretsDir: string;
  readonly log: LogConfig;
  readonly intake: IntakeConfig;
}

export interface IntakeConfig {
  /**
   * Seconds between tracker intake passes. Deliberately NOT the poll interval: a
   * GitHub pass costs one request per repo in the installation, so polling it would
   * exhaust the hourly rate limit within minutes (see `intakeDue`).
   */
  readonly intervalSeconds: number;
}

export interface LogConfig {
  /** Records below this severity are dropped. Defaults to `info`. */
  readonly level: LogLevel;
}
