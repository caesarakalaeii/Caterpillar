/**
 * Runner and workspace configuration. See DESIGN.md §3.1 (workspaces).
 *
 * Config carries NO secrets. Every credential is referenced indirectly via
 * `secretRef` and resolved from the mounted SOPS secret at use time, so a config
 * dump is never a credential leak.
 */
import type { Capability, ForgeKind, TrackerKind, WorkspaceName } from "../domain/task.ts";
import type { LogLevel } from "../obs/log.ts";

/**
 * Who the runner authors as (DESIGN.md §9.7).
 *
 * One identity for both writers: the supervisor committing the state repo and the agent
 * committing in a task worktree. They are the same actor, and two identities would make
 * the audit trail read as though the fleet had a second author nobody configured.
 *
 * Deployment-specific by nature — it names the App installed for THIS deployment — which
 * is why it is configuration and not a constant. See `identity` in `load.ts` for the one
 * address shape that is refused, and why.
 */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

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
  /**
   * Wall-clock ceiling on ONE session, in seconds.
   *
   * Not a budget — a hang detector. pi's bash tool documents `timeout` as optional with
   * no default, so the model decides whether a command can block forever, and everything
   * in the supervisor is single-threaded: a `npm run dev` that never returns stops the
   * poll loop, the chat drain and intake with it, while the heartbeat keeps renewing the
   * lease and /healthz keeps answering 200. Generous on purpose; a session that
   * legitimately needs longer than this is one nobody is watching.
   */
  readonly maxSessionSeconds: number;
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

/**
 * How long the runner stops starting sessions after the provider refuses (§6.3).
 *
 * Not per task: the account is shared by every task on this runner, so the first
 * refusal is the answer for all of them.
 */
export interface CooldownConfig {
  /** Wait after the first refusal. Doubles per consecutive one. */
  readonly initialSeconds: number;
  /** Ceiling on one wait — also how often a long outage is re-checked. */
  readonly maxSeconds: number;
}

export interface LlmConfig {
  readonly auth: LlmAuthMode;
  readonly cooldown: CooldownConfig;
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

/** How this runner materialises a task's dev environment (DESIGN.md §8.1). */
export interface ToolchainConfig {
  /**
   * Flake reference supplying the packages an explicit `toolchain.packages` names.
   * PINNED to a revision, never `nixpkgs` unqualified: an unattended agent that picks up
   * a silent nixpkgs bump produces a red acceptance run with no diff to explain it.
   */
  readonly nixpkgs: string;
  /**
   * Ceiling on one environment resolve. Generous by default — a devShell that overrides
   * anything can miss the binary cache and build from source — but bounded, because a
   * nix evaluation that never returns would wedge the supervisor exactly like a hung
   * acceptance command would.
   */
  readonly timeoutSeconds: number;
  /**
   * Hours between `nix-collect-garbage` passes. The store shares a 20Gi PVC with the
   * mirrors and every task's worktree, so this is a requirement rather than hygiene.
   * Live environments are protected by the GC roots the resolver registers.
   */
  readonly gcIntervalHours: number;
  /** Days a store path survives with no GC root. */
  readonly gcKeepDays: number;
}

/**
 * The daily digest (DESIGN.md §19).
 *
 * `enabled` defaults to FALSE, for the same reason the web view's does: a digest is
 * published to the shared Discord channel and committed to the shared state repo, and a
 * runner someone started on a workstation must not begin doing either because it was
 * upgraded. The claim protocol makes double-posting impossible, not unwanted.
 */
export interface DigestConfig {
  readonly enabled: boolean;
  /**
   * Local hour at which a day is considered over, 0–23. The digest covers the 24 hours
   * ending here — see `digest/day.ts` for why it is not midnight-to-now.
   */
  readonly hour: number;
  /**
   * IANA zone, e.g. `Europe/Berlin`. Named rather than an offset so DST is the zone
   * database's problem: a fixed `+02:00` publishes an hour late for five months a year.
   */
  readonly timeZone: string;
  /**
   * Whether a model writes the prose paragraph over the day's work.
   *
   * The facts are free and come from git; this is the only part of a digest that costs
   * tokens. Turning it off leaves a complete document with a section missing, which is
   * why it is a separate switch from `enabled` — a runner minding its spend should not
   * have to choose between prose and no digest at all.
   */
  readonly summarise: boolean;
}

export interface RunnerConfig {
  readonly runnerId: string;
  readonly capabilities: readonly Capability[];
  /** Author and committer of everything this runner writes. */
  readonly identity: CommitIdentity;
  readonly toolchain: ToolchainConfig;
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
  readonly web: WebConfig;
  readonly digest: DigestConfig;
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

/**
 * The read-only web view (DESIGN.md §18).
 *
 * `enabled` defaults to FALSE. The view serves every session transcript the fleet has
 * produced, and a transcript quotes whatever the agent read; a runner on a workstation
 * must not begin answering for that because it was upgraded. In the cluster it is turned
 * on in the ConfigMap, where the Ingress that authenticates it is turned on too.
 */
export interface WebConfig {
  readonly enabled: boolean;
  /** Separate from the metrics port: the Ingress publishes this one and only this one. */
  readonly port: number;
  /** Log records held in memory for the view. Loki keeps the history. */
  readonly logCapacity: number;
  /** How often a live page re-fetches itself. */
  readonly refreshSeconds: number;
  /**
   * Refuse any request that did not arrive with an identity header from the
   * authenticating proxy.
   *
   * This is NOT authentication — anything already inside the cluster can set a header.
   * It is a fail-closed check on the one realistic failure: an Ingress whose forward-auth
   * annotations are dropped or misspelt, which otherwise publishes the whole state repo
   * to the internet and looks exactly like a working deployment.
   */
  readonly requireForwardedUser: boolean;
  /** Header carrying that identity. Lowercased — node lowercases what it receives. */
  readonly forwardedUserHeader: string;
}
