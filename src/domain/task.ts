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
 * A task id is a directory name under `tasks/`, so anything that is not one of these
 * characters could escape the task tree. Every id arriving from outside the state repo —
 * a chat command, a button's `custom_id`, a slash-command option — is checked with this
 * before it reaches the store.
 */
const TASK_ID = /^[A-Za-z0-9._-]+$/;

export const isTaskId = (value: string): value is TaskId => TASK_ID.test(value);

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

/**
 * What kind of work a task is.
 *
 * `implement` is everything that existed before: a goal, a repo, machine-checkable
 * acceptance criteria, ending in a pull request. `brainstorm` is a refinement
 * conversation that produces a PLAN and never touches the code — its completion gate is
 * the review council's verdict on that plan, not §12's acceptance commands, which is why
 * it is the one task kind permitted to declare none (DESIGN.md §14.3).
 */
export type TaskKind = "implement" | "brainstorm";

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
  /** Defaults to `implement` when the spec does not say. */
  readonly kind?: TaskKind;
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
  /** Branch head at the end of the last session — commits are detected by comparison. */
  readonly lastHeadOid?: string;
}

/** A pull request opened for this task. Recorded once, reused for verification. */
export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

/**
 * Review council history (DESIGN.md §12.1).
 *
 * `rounds` is the ping-pong guard: a council that requests changes sends the task back
 * to the same implementation agent, which can claim done again, which convenes the
 * council again. Without a ceiling the pair can trade the task until the session limit,
 * which reads from outside as a task that is running and getting nowhere.
 */
export interface ReviewRecord {
  readonly rounds: number;
  readonly last?: "pass" | "changes";
}

/**
 * A task's place in a plan (DESIGN.md §14.3).
 *
 * `blockedBy` is the authority; `wave` is DERIVED from it by longest-path layering and
 * stored only so a listing can be read and a claim ordered without recomputing the whole
 * graph. When they disagree, `blockedBy` is right — recompute.
 */
export interface PlanMembership {
  /** The brainstorm task this one was cut from. */
  readonly parent: TaskId;
  readonly wave: number;
  readonly blockedBy: readonly TaskId[];
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
  /** Set once the agent opens a PR; the completion gate needs it (§12). */
  readonly pr?: PullRequestRef;
  /** Absent until the council has run once. Older `state.json` files simply lack it. */
  readonly review?: ReviewRecord;
  /** Set on tasks cut from a plan (§14.3). Absent on everything else. */
  readonly plan?: PlanMembership;
  /** The Discord thread this task talks in, when it has one. */
  readonly chat?: { readonly threadId: string };
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
  | "plan-proposed"
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
  /** Set when the agent opened a PR during this session. */
  readonly pr?: PullRequestRef;
  /** Set when reason is `plan-proposed` — the decomposition awaiting the council. */
  readonly plan?: ProposedPlan;
  /** Free-text summary appended to the journal. */
  readonly summary: string;
}

/**
 * One task a brainstorm proposes. Local ids only — real `TaskId`s do not exist until the
 * plan is materialised, and the agent must not be able to choose them.
 */
export interface ProposedTask {
  /** Unique within the plan. Referenced by `dependsOn`. */
  readonly localId: string;
  readonly title: string;
  readonly goal: string;
  readonly repos: readonly string[];
  readonly requires: readonly string[];
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface ProposedPlan {
  readonly title: string;
  readonly summary: string;
  readonly tasks: readonly ProposedTask[];
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

/**
 * True when a task may be claimed right now (DESIGN.md §14.3).
 *
 * `ready` is necessary and no longer sufficient: a task cut from a plan waits on its
 * blockers. A blocker that is missing from the state repo entirely counts as unsatisfied
 * — a dangling dependency should stall its dependent visibly rather than be treated as
 * already met, which is what silently ignoring it would do.
 */
export const isClaimable = (
  state: TaskState,
  statusOf: (id: TaskId) => TaskStatus | undefined,
): boolean =>
  state.status === "ready" &&
  (state.plan?.blockedBy ?? []).every((id) => statusOf(id) === "done");

/**
 * True when a status is final — nothing will move this task again without a human.
 *
 * Lives here rather than beside the loop because more than the loop needs it: the thread
 * index uses it to decide whether a conversation is still worth listening to, and a
 * cycle would be the only alternative.
 */
export const isTerminal = (status: TaskStatus): boolean =>
  status === "done" || status === "failed" || status === "parked";

/** Claim order: earlier waves first, then by id so it is deterministic across runners. */
export const claimOrder = (a: TaskState, b: TaskState): number =>
  (a.plan?.wave ?? 0) - (b.plan?.wave ?? 0) || a.id.localeCompare(b.id);
