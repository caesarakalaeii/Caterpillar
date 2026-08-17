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

/**
 * The character class alone is not enough: it admits `.` and `..`, which are legal
 * directory names and resolve to the task tree's PARENT — the state repo root. A dot
 * inside an id is ordinary, so the rule is "not made only of dots" rather than "no dots".
 */
export const isTaskId = (value: string): value is TaskId =>
  TASK_ID.test(value) && !/^\.+$/.test(value);

/**
 * A capability a runner advertises and a task may require. Claiming requires
 * `task.requires ⊆ runner.capabilities` (DESIGN.md §8).
 *
 * A capability is a fact about a machine that CANNOT be provisioned — a GPU, a USB
 * device, game files already on disk, a human in the room. Anything a runner could
 * install for itself does not belong here: as a claim predicate it would turn a solvable
 * problem into a task no runner ever claims, which reads from outside as a stuck
 * scheduler rather than a missing tool.
 */
export type Capability =
  | "linux"
  | "k8s"
  | "net"
  | "gpu"
  | "usb"
  | "human-present"
  /**
   * This runner can materialise a declared dev environment (DESIGN.md §8.1). ONE
   * capability, not one per language: `lua`, `go`, `python` and the rest are not
   * capabilities at all, they are things a runner with this one installs for itself.
   */
  | "nix";

/**
 * The single list. `config/load.ts` and `intake/spec.ts` both validate against it, and
 * they must agree — config accepting a capability intake refuses (or the reverse) is a
 * runner that advertises something no task can ask for.
 *
 * `as const satisfies` rather than a typed annotation so the array stays a literal tuple:
 * both are erased at load time, which `erasableSyntaxOnly` requires (DESIGN.md §16).
 *
 * A fourth copy lives in `scripts/install-runner.sh`, which cannot import. It is guarded
 * by a drift test in `domain/task.test.ts` instead.
 */
export const KNOWN_CAPABILITIES = [
  "linux",
  "k8s",
  "net",
  "gpu",
  "usb",
  "human-present",
  "nix",
] as const satisfies readonly Capability[];

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
 *
 * `remediation` is a task a firing alert created (DESIGN.md §20). It writes code and
 * ends in a pull request exactly as `implement` does, and §12 applies to it unchanged —
 * it is a separate kind only because its ORIGIN changes what the session should be told:
 * that the evidence comes from a cluster it may read and must never write, and that
 * "this needs a human, not a patch" is a legitimate outcome rather than a failure.
 */
export type TaskKind = "implement" | "brainstorm" | "remediation";

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

/**
 * A host, owner or repo name that is safe to put in a URL and in a path.
 *
 * Every component of a `RepoRef` becomes BOTH a segment of a clone URL and a directory
 * under `paths.mirrors`, so an unvalidated one is two bugs at once. `repos: ../../x`
 * used to parse into `{host: "..", owner: "..", name: "x"}`, and the mirror path for it
 * resolves above the directory the workspace believes it owns — which `syncMirror`
 * then removes and rebuilds. Requiring a leading alphanumeric rejects `.` and `..`
 * without needing to special-case them.
 */
const REPO_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/;
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `host/owner/name`, or `owner/name` with the host defaulting to github.com.
 *
 * ONE implementation on purpose. This used to be copied into intake, the store and the
 * plan materialiser; three copies meant a repo reference that intake refused could
 * still arrive through a plan, and the validation added to one was absent from the
 * other two.
 *
 * Returns undefined rather than throwing: every caller has a better error to give than
 * a stack trace, and two of the three turn it into a human-facing refusal.
 */
export const parseRepoRef = (raw: string): RepoRef | undefined => {
  const parts = raw.split("/").filter((p) => p.length > 0);

  const [host, owner, name] =
    parts.length === 3
      ? (parts as [string, string, string])
      : parts.length === 2
        ? (["github.com", ...(parts as [string, string])] as [string, string, string])
        : [undefined, undefined, undefined];

  if (host === undefined || owner === undefined || name === undefined) return undefined;
  if (!REPO_HOST.test(host)) return undefined;
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) return undefined;

  return { host, owner, name };
};

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
  /**
   * The dev environment the task's commands run in (DESIGN.md §8.1). Absent is the
   * common case: the repo's own `flake.nix` is found without anyone declaring it, and a
   * repo with no nix expression inherits the runner's environment as before.
   */
  readonly toolchain?: ToolchainSpec;
  readonly tracker?: TrackerRef;
}

/**
 * How a task's environment is produced.
 *
 * `inherit` — the runner's own environment. What every task got before §8.1 existed.
 * `nix` — materialised from `packages`, or from the repo's own nix expression when
 *   `packages` is absent.
 */
export type ToolchainMode = "inherit" | "nix";

export interface ToolchainSpec {
  readonly mode: ToolchainMode;
  /**
   * nixpkgs attribute names — `lua5_1`, `luarocks`, `go`, `nodejs_22`. Absent means "use
   * whatever the repo declares", which is the better answer when the repo declares
   * anything: the agent then gets the same environment a human contributor gets.
   */
  readonly packages?: readonly string[];
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
  | "error"
  /**
   * The model provider stopped answering — spend limit, rate limit, outage, expired
   * credential. NOT attributable to the task, which is the whole reason it is not
   * `error`: the task is released untouched and the RUNNER backs off (DESIGN.md §6.3).
   */
  | "provider-unavailable"
  /**
   * Something outside the session stopped it: the pod is shutting down, the lease was
   * lost, a human cancelled, or the session ran past its wall clock.
   *
   * Not attributable to the task either, and deliberately distinct from
   * `provider-unavailable` because it says nothing about the provider and must not
   * start a cooldown. The task is left claimable; whoever caused the interruption is
   * responsible for whatever happens next.
   */
  | "interrupted";

/** Why the provider stopped answering, as far as its own error message admits. */
export type OutageKind =
  /** The account is out of budget. Clears when the window rolls over or a human pays. */
  | "exhausted"
  /** Going too fast. Clears by itself, usually in under a minute. */
  | "rate-limited"
  /** The provider is down or overloaded. */
  | "unavailable"
  /** The credential was rejected. Waiting does not fix this one; a human must. */
  | "unauthorised"
  /** No response arrived at all. */
  | "network";

export interface ProviderOutage {
  readonly kind: OutageKind;
  /** HTTP status, when there was a response to read one from. */
  readonly status?: number;
  /** The provider's own sentence, for the log and for Discord. Never a credential. */
  readonly detail: string;
  /** How long the provider asked us to wait, when it said. */
  readonly retryAfterMs?: number;
}

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
  /** Set when reason is `error` or `provider-unavailable`. */
  readonly error?: string;
  /** Set when reason is `provider-unavailable`. */
  readonly outage?: ProviderOutage;
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
 * A task cut from a plan waits on its blockers. A blocker that is missing from the state
 * repo entirely counts as unsatisfied — a dangling dependency should stall its dependent
 * visibly rather than be treated as already met, which is what silently ignoring it
 * would do.
 *
 * `running` IS claimable, and that is not a loophole — it is what makes crash recovery
 * work at all. From the end of session 1 onward the pushed `state.json` says `running`,
 * because `recordSession` writes the same status object it was handed. So every task
 * past its first session that ends by any route other than a clean terminal transition
 * — a killed pod, a Keel roll on every push to main, even a graceful SIGTERM — is left
 * `running` on the remote with nothing that ever moves it back. Excluding it here made
 * the stale-lease steal in `LeaseManager.claim` unreachable for exactly the tasks that
 * needed it, which stranded one task per deploy, silently, forever.
 *
 * What decides whether a `running` task may actually be taken is the lease CAS, not this
 * predicate: a successful claim means the lease was absent or stale, i.e. the previous
 * holder is gone. Only that is an exclusion test, because only that is atomic. This
 * function is a filter over a snapshot read seconds earlier, and a filter over stale
 * data cannot establish exclusivity no matter which statuses it admits.
 */
export const isClaimable = (
  state: TaskState,
  statusOf: (id: TaskId) => TaskStatus | undefined,
): boolean =>
  (state.status === "ready" || state.status === "running") &&
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

/** A task the runner could take, and the one thing about its spec claiming depends on. */
export interface ClaimCandidate {
  readonly state: TaskState;
  readonly kind: TaskKind;
}

/**
 * A brainstorm outranks batch work, because someone is waiting on it.
 *
 * The two kinds are not the same sort of job. An implementation task is throughput — it
 * runs for as many sessions as it needs and nobody is watching any single one. A
 * brainstorm is a conversation: a human typed `/brainstorm`, a thread opened under it,
 * and they are looking at that thread now. It also costs almost nothing to let in,
 * because `ask_human` parks the task and releases the lease at the first question, so a
 * brainstorm holds the runner for one short session and gives it straight back.
 *
 * Without this a brainstorm could not start at all while the queue was non-empty, and
 * the reason was an accident of the id scheme rather than anything anyone decided: a
 * brainstorm's id is its Discord thread id, thread ids are snowflakes, and snowflakes
 * increase — so the NEWEST brainstorm always sorted LAST behind every task already
 * there, including the children of previous brainstorms. What that looked like from
 * Discord was a thread that opened and then stayed silent indefinitely.
 */
const claimRank = (candidate: ClaimCandidate): number =>
  candidate.kind === "brainstorm" ? 0 : 1;

/**
 * Claim order: a waiting human first, then earlier waves, then by id.
 *
 * The id remains the final tie-break, and every field before it is derived from state
 * both runners can read — so two runners sorting the same queue reach the same answer
 * rather than racing for the same task.
 */
export const claimOrder = (a: ClaimCandidate, b: ClaimCandidate): number =>
  claimRank(a) - claimRank(b) ||
  (a.state.plan?.wave ?? 0) - (b.state.plan?.wave ?? 0) ||
  a.state.id.localeCompare(b.state.id);

/**
 * A goal's first heading or first non-blank line, as a one-line name.
 *
 * Here rather than beside either caller because both the web view and the daily digest
 * name tasks this way, and two implementations would eventually disagree about what a
 * task is called depending on where you read it.
 */
export const goalHeadline = (goal: string): string | undefined => {
  for (const line of goal.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
};
