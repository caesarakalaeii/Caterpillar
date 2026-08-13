/**
 * Core domain vocabulary. See DESIGN.md §4 (state model) and §6 (session lifecycle).
 *
 * These types are the contract between the supervisor, the state repo, and every
 * forge/tracker adapter. Nothing here may depend on pi, git, or any transport.
 */

/** Opaque task identifier, e.g. `TASK-123`. */
export type TaskId = string & { readonly __brand: "TaskId" };

/** Identity of a single runner process, e.g. `pod-7f3a` or `workstation`. */
export type RunnerId = string & { readonly __brand: "RunnerId" };

/** Name of a workspace profile, e.g. `caesar` or `electric-boogaloo`. */
export type WorkspaceName = string & { readonly __brand: "WorkspaceName" };

export const asTaskId = (value: string): TaskId => value as TaskId;
export const asRunnerId = (value: string): RunnerId => value as RunnerId;
export const asWorkspaceName = (value: string): WorkspaceName => value as WorkspaceName;

/**
 * A capability a runner advertises and a task may require. Claiming requires
 * `task.requires ⊆ runner.capabilities` (DESIGN.md §8).
 */
export type Capability =
  | "linux"
  | "k8s"
  | "net"
  | "gpu"
  | "usb"
  | "human-present";

/** Lifecycle state of a task. Authoritative value lives in `state.json`. */
export type TaskStatus =
  | "ready"
  | "running"
  | "awaiting-human"
  | "parked"
  | "done"
  | "failed";

/** Coarse progress marker, for reporting only — never used for control flow. */
export type TaskPhase = "planning" | "implementing" | "verifying" | "review";

/** Which forge a repo lives on. Selects the ForgeCredentials implementation. */
export type ForgeKind = "github" | "forgejo";

/** Which tracker a task mirrors to. Selects the Tracker implementation. */
export type TrackerKind = "github-issues" | "vikunja";

/** A repository reference, always qualified by host so the forge is unambiguous. */
export interface RepoRef {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export const repoSlug = (repo: RepoRef): string => `${repo.owner}/${repo.name}`;

/** Back-reference to the tracker item a task was ingested from. */
export interface TrackerRef {
  readonly kind: TrackerKind;
  /** Tracker-native id. Vikunja task id, GitHub issue number, … */
  readonly id: string;
  /** Vikunja project id / GitHub repo slug, when the tracker needs it for lookups. */
  readonly container?: string;
}

/**
 * Immutable task definition. Written once at intake, never edited by the agent.
 * Serialized as front-matter + prose in `spec.md`.
 */
export interface TaskSpec {
  readonly id: TaskId;
  readonly workspace: WorkspaceName;
  /** Prose goal handed to the agent verbatim. */
  readonly goal: string;
  /** Repos the agent may touch. Becomes the forge token scope (DESIGN.md §9.1). */
  readonly repos: readonly RepoRef[];
  /** Capability predicate for claiming. */
  readonly requires: readonly Capability[];
  /**
   * Commands that must exit 0 before a task can be marked done. Run by the
   * SUPERVISOR, never by the agent (DESIGN.md §12).
   */
  readonly acceptance: readonly string[];
  readonly tracker?: TrackerRef;
}

/** Cumulative token/cost spend across every session of a task. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Lease ownership record, mirrored from `refs/leases/<id>` for observability. */
export interface TaskOwner {
  readonly runner: RunnerId;
  /** Object id of the lease commit this runner last pushed — its fencing token. */
  readonly leaseOid: string;
  readonly since: string;
}

export interface TaskLimits {
  readonly maxSessions: number;
}

export interface ProgressRecord {
  /** Session ordinal that last made measurable progress. */
  readonly lastProgressSession: number;
  /** Consecutive sessions with no progress. Parks the task at 3 (DESIGN.md §11.1). */
  readonly noProgressStreak: number;
}

/** Mutable control record — `state.json`. */
export interface TaskState {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  readonly requires: readonly Capability[];
  readonly sessions: number;
  readonly limits: TaskLimits;
  readonly usage: UsageTotals;
  readonly progress: ProgressRecord;
  readonly owner?: TaskOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Why a session stopped. Drives the supervisor's next move (DESIGN.md §6).
 *
 * `done-claimed` is deliberately not `done`: the agent only ever *claims*
 * completion, which triggers independent verification.
 */
export type SessionExitReason =
  | "handoff"
  | "ask-human"
  | "done-claimed"
  | "blocked"
  | "limit"
  | "error";

export interface SessionOutcome {
  readonly reason: SessionExitReason;
  /** Tokens/cost for this session alone. */
  readonly usage: UsageTotals;
  /** Context tokens at the moment the session stopped. */
  readonly contextTokens: number;
  /** Set when reason is `ask-human`. */
  readonly question?: string;
  /** Set when reason is `blocked` — the capabilities the task now needs. */
  readonly requires?: readonly Capability[];
  /** Set when reason is `error`. */
  readonly error?: string;
  /** Free-text summary appended to the journal. */
  readonly summary: string;
}

export const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

/** True when a runner advertising `capabilities` may claim a task needing `requires`. */
export const capabilitiesSatisfy = (
  capabilities: readonly Capability[],
  requires: readonly Capability[],
): boolean => requires.every((r) => capabilities.includes(r));
