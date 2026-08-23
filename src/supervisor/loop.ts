/**
 * The supervisor loop. See DESIGN.md §6.
 *
 * One task at a time per runner. Scale by adding replicas — the git-ref leasing makes
 * the TASKS safe (DESIGN.md §2, Concurrency). Note what it does not make safe: leases are
 * per task, and the state branch is one shared resource that every runner pushes to, so
 * that half rests on `StateStore.push` rebasing rather than on the lease.
 *
 * Invariants this loop is responsible for:
 *   - never run a session without a held lease
 *   - verify lease ownership before every state push (fencing, §5.1)
 *   - never let the agent decide it is done (§12)
 *   - always persist the journal before exiting, including on error
 */
import { setTimeout as sleep } from "node:timers/promises";
import { stateRepoRef, workspaceScopeOf } from "../config/scope.ts";
import type { RunnerConfig, WorkspaceProfile } from "../config/types.ts";
import {
  addUsage,
  asRunnerId,
  asTaskId,
  capabilitiesSatisfy,
  claimOrder,
  EMPTY_USAGE,
  isClaimable,
  isTerminal,
  recordedReason,
  repoSlug,
  taskPullRequests,
  type ProposedPlan,
  type RepoRef,
  type ProviderOutage,
  type ReviewRecord,
  type SessionOutcome,
  type TaskId,
  type TaskPhase,
  type TaskPullRequest,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
  type UsageTotals,
  type WorkspaceName,
} from "../domain/task.ts";
import {
  brainstormId,
  brainstormSpec,
  parseRepo,
  qualifiedSlug,
  resolveWorkspace,
} from "../plan/brainstorm.ts";
import { layer, materialise, relayer } from "../plan/materialize.ts";
import type { Maintainer, PlanRevision, PlanSibling } from "../plan/maintain.ts";
import {
  heldLease,
  LeaseLostError,
  type Lease,
  type LeaseHandle,
  type LeaseManager,
  startHeartbeat,
} from "../state/lease.ts";
import { ToolchainError, type ToolchainResolver } from "../workspace/toolchain.ts";
import type { ReapResult } from "../workspace/worktree.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";
import type { StateStore } from "../state/store.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import { intakeDue, intakeRef, type IntakePass } from "../intake/ingest.ts";
import type { IntakeStatus } from "../intake/status.ts";
import type { AlertPass } from "../remediation/queue.ts";
import type { FiringAlert } from "../remediation/receiver.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { Notification, Notifier } from "../notify/discord.ts";
import type { Presence, ThreadCloser } from "../notify/bot.ts";
import { threadBindings, type ThreadIndex } from "../notify/threads.ts";
import type { ThreadBindingWriter } from "../redis/threads.ts";
import {
  landingFor,
  mergeNote,
  stopsTheSequence,
  type LandedPullRequest,
  type MergeOutcome,
} from "../forge/mergeability.ts";
import { unreachableSummary, type RepoReach } from "../forge/reach.ts";
import type { Forge, ForgeFactory, WorkspaceScope } from "../forge/types.ts";
import type { Council } from "../review/council.ts";
import { explainVerdict, renderVerdict, summariseVerdict } from "../review/decide.ts";
import type { Tracker, TrackerTransition } from "../tracker/types.ts";
import { ProviderCooldown } from "./cooldown.ts";
import { isNewerComment } from "../agent/review-guidance.ts";
import { SlotSteering, type SteeringFeed } from "../agent/steering.ts";
import type { CancelSignals } from "../redis/cancel.ts";
import type { ChatDrainer } from "../redis/inbox.ts";
import type { PresenceRegistry } from "../redis/presence.ts";
import type { SnapshotWriter } from "../redis/snapshot.ts";
import type { SteeringInbox } from "../redis/steering.ts";
import type { ChatOutcome, ChatRequest } from "./inbox.ts";
import { checkLimits, recordProgress, type ProgressEvidence } from "./progress.ts";
import { summarise } from "./snapshot.ts";

/**
 * How often a running session checks for a `/cancel`.
 *
 * **This stays separate from the housekeeping loop, and it is not redundant with it.**
 * Housekeeping now drains the inbox during a session (DESIGN.md §6.4), which removes the
 * original reason every other request kind needed a workaround — but a `/cancel` for the
 * task running ON THIS RUNNER is the one request housekeeping structurally cannot serve.
 * `applyPark` writes the state repo, and to write it must claim the lease; the lease is
 * held by the session it is being asked to stop, so `claim` returns undefined and the
 * request comes back `not-parkable: running`. Only code inside `workTask` can abort the
 * session, so only code inside `workTask` may take that request.
 *
 * `applyChatRequests` therefore leaves those requests queued for this watcher, and this
 * watcher takes nothing else — the rest write the state repo and housekeeping serves them.
 *
 * It also wants a tighter interval than housekeeping does, for a reason that survives the
 * split: a human is waiting on the Discord reply. Two seconds costs one array filter over
 * a queue that is almost always empty; the housekeeping interval is tuned against a git
 * fetch and a tracker sweep and has no business bounding an interaction.
 */
const CANCEL_POLL_MS = 2000;

/** One task's state as read by a single sweep of the task tree. */
interface TaskRecord {
  readonly id: TaskId;
  readonly state: TaskState;
}

export interface SessionRunner {
  /**
   * Runs one session and returns why it stopped. Never mutates task state.
   *
   * `signal` aborts the session in flight — pod shutdown, a lost lease, a human
   * `/cancel`, or the wall clock. Honouring it is what stops a hung tool call from wedging
   * the runner's ability to work anything ELSE: a `bash` call that never returns blocks
   * the work loop for as long as it hangs, and the work loop is where claiming lives.
   *
   * It no longer stops the chat drain, intake or leadership — those moved to the
   * housekeeping loop (§6.4) and keep running through a hung session. That is a reason the
   * signal matters MORE rather than less: a wedged runner now looks entirely healthy from
   * outside, because it is still answering.
   *
   * `steering` is the other direction: what a human types in the task's thread while this
   * is running (DESIGN.md §7.3). Optional because the interface has implementations that are
   * not the agent — and because a session that ignores it behaves exactly as every session
   * did before it existed.
   */
  run(
    spec: TaskSpec,
    state: TaskState,
    signal: AbortSignal,
    steering?: SteeringFeed,
  ): Promise<SessionOutcome>;
}

export interface Verifier {
  /**
   * Independently checks the §12 gates: acceptance commands exit 0, PR open, CI green.
   * Runs in the supervisor, never in the agent.
   */
  verify(
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{
    readonly passed: boolean;
    readonly detail: string;
    readonly prUrl?: string;
    /** Set when CI has not finished, which is not the same as a failed gate. */
    readonly pending?: boolean;
  }>;
}

export interface ProgressProbe {
  /** Gathers evidence that the last session accomplished something. */
  probe(spec: TaskSpec, state: TaskState): Promise<ProgressEvidence>;
}

export interface Intake {
  /** One pass over every tracker (DESIGN.md §14). */
  ingest(remote: string, branch: string): Promise<IntakePass>;
}

/** Whatever the webhook accepted since the last poll (§20). Implemented by `AlertQueue`. */
export interface AlertSource {
  drain(): readonly FiringAlert[];
}

/** Firing alerts → remediation specs (DESIGN.md §20). Implemented by `AlertProcessor`. */
export interface AlertIngester {
  process(
    alerts: readonly FiringAlert[],
    remote: string,
    branch: string,
  ): Promise<AlertPass>;
}

/**
 * The reaping half of `WorktreeManager`, as the loop needs it (DESIGN.md §3.1).
 *
 * Narrowed to two methods rather than taking the class, for the same reason `Verifier` and
 * `ProgressProbe` are interfaces: this is the one dependency in the loop whose failure mode
 * is destructive, and a structural type that names exactly the two calls makes the loop's
 * tests able to record them without standing up a git mirror per case.
 */
export interface WorktreeReaper {
  removeTaskWorktrees(task: TaskId, repos: readonly RepoRef[]): Promise<ReapResult>;
  reapStaleWorktrees(opts: { readonly live: ReadonlySet<TaskId> }): Promise<ReapResult>;
}

/** The idle-time work-volume measurement (§11). Implemented by `UsageMonitor`. */
export interface UsageReporter {
  /** Measures if the interval has elapsed; returns the fresh snapshot, or nothing. */
  maybeMeasure(): Promise<WorkspaceUsage | undefined>;
}

export interface Digester {
  /**
   * Publish the day's digest if one is due, and if this runner wins the claim for it
   * (DESIGN.md §19). Called every poll; does nothing on almost all of them.
   *
   * The signal is the pod's. Writing the digest's one paragraph is a model call, and a
   * shutdown must not wait on the provider to answer it.
   */
  maybePublish(now: Date, signal?: AbortSignal): Promise<void>;
}

export interface SupervisorDeps {
  readonly config: RunnerConfig;
  readonly store: StateStore;
  readonly leases: LeaseManager;
  readonly runner: SessionRunner;
  readonly verifier: Verifier;
  readonly progress: ProgressProbe;
  readonly notifier: Notifier;
  readonly metrics: AgentMetrics;
  readonly logger: Logger;
  /**
   * The one environment resolver. Here as well as inside the runner and the verifier
   * because the loop owns the only moment it is safe to collect the nix store: when this
   * runner has no task in flight.
   */
  readonly toolchain: ToolchainResolver;
  /**
   * The per-task checkouts on this runner's volume, so finished ones can be thrown away.
   *
   * Here for exactly the reason `toolchain` is: the loop owns the only moment it is safe
   * to remove a worktree — when the task that owns it has reached a state it will not
   * resume from in place, or when nothing on this runner has a claim on it at all. Every
   * other holder of a `WorktreeManager` (the session runner, the verifier, the probe, the
   * council) creates them and must never be the thing that deletes one.
   *
   * Optional so a `Supervisor` can be built without one, which the older tests in
   * `loop.test.ts` do. A runner without it simply never reaps, exactly as before.
   */
  readonly worktrees?: WorktreeReaper;
  /**
   * Measures the work volume (`workspace/usage.ts`). Optional: without one the supervisor
   * behaves exactly as it did before this existed, which is what the tests build.
   *
   * Here for the same reason `toolchain` is: the loop owns the only moment it is safe to
   * walk hundreds of thousands of inodes on a single-threaded process, which is when this
   * runner has no task in flight.
   */
  readonly usage?: UsageReporter;
  /**
   * The credential service, so a lost lease can revoke the task's credential at the
   * moment it is lost rather than when the session eventually returns. Optional because
   * nothing else in the loop needs it and the tests do not build one.
   */
  readonly credentials?: { deactivate(task: TaskId): Promise<void> };
  /**
   * Tracker → task ingestion. Optional: a runner with no trackers configured, or one
   * fed only by hand-committed specs (§14.4), does not need it.
   */
  readonly intake?: Intake;
  /**
   * Where the last pass's counts are remembered for the web view (§18). Optional and
   * purely observational — nothing in the loop reads it back, and a runner without one
   * ingests exactly as it did before this existed.
   */
  readonly intakeStatus?: IntakeStatus;
  /**
   * The daily digest (§19). Optional, and off by default: a digest is published to a
   * shared channel and a shared repo, so a runner has to be told to publish one.
   */
  readonly digest?: Digester;
  /**
   * The Alertmanager receiver's queue and the thing that empties it (§20). Optional and
   * off by default: without `remediation.enabled` there is no listener to fill it.
   *
   * Both together rather than one object, because the queue is filled by an HTTP handler
   * that must not know what happens next and drained here, where the state repo may be
   * written — the same split the chat inbox makes for the Discord bridge.
   */
  readonly alerts?: { readonly queue: AlertSource; readonly ingester: AlertIngester };
  /**
   * Requests arriving from the inbound Discord bridge (§7). Optional: without a bridge
   * a question is answered by committing the file by hand.
   */
  readonly inbox?: ChatDrainer;
  /**
   * Which replica acts on Discord (DESIGN.md §7). Refreshed on the HOUSEKEEPING loop,
   * which is the loop that also answers — so a renewed claim is now a claim backed by a
   * replica that can serve it. See `ChatLeadership`'s docstring for why that sentence is
   * the whole justification.
   */
  readonly chat?: { readonly refresh: () => Promise<void> };
  /**
   * In-memory view of every task, refreshed once per poll for the chat interface.
   * Optional: nothing in the loop reads it, and without a bridge nothing needs it.
   */
  readonly snapshot?: SnapshotWriter;
  /**
   * What the bot advertises it is doing (DESIGN.md §7.2). Fed from `survey`.
   *
   * Optional and write-only from here, like `snapshot` and for the same reason: nothing in
   * the loop reads it back, and a runner with no bot token has nowhere to publish it. The
   * narrow structural type keeps `notify/activity.ts` out of the loop's imports.
   */
  readonly activity?: {
    publish(tasks: readonly { id: TaskId; status: TaskStatus; phase: TaskPhase }[]): void;
  };
  /**
   * Cancel signals reaching a session already in flight (DESIGN.md §21).
   *
   * Optional, and its absence is not a loss of function: the in-process path through
   * `inbox.takeWhere` still works, and that is the whole mechanism on a single-replica
   * runner. This exists so a cancel typed at a SEPARATE bot process reaches the session at
   * all: that process has no path into this one's inbox, and the task's own lease is held
   * here, so no amount of housekeeping in this runner can serve it (§6.4).
   */
  readonly cancels?: CancelSignals;
  /**
   * Human input reaching a session already in flight (DESIGN.md §7.3).
   *
   * `cancels`' counterpart, and optional on the same terms: with no Redis the bot and this
   * loop are one process, so `applyAnswer` reaches the slot's own feed directly. This exists
   * for the separate bot, which can no more push into this heap than it can into its inbox.
   *
   * Absent entirely, a session simply cannot be steered — which is what every session was
   * before this, and the reason a rejected plan could only ever be re-run unchanged.
   */
  readonly steering?: SteeringInbox;
  /**
   * Advisory display of which runners are alive (DESIGN.md §21). Optional and, crucially,
   * never load-bearing: routing and claiming stay on leases in git (§5).
   */
  readonly runners?: PresenceRegistry;
  /**
   * Trackers to mirror lifecycle changes into, by workspace (DESIGN.md §9.5).
   * Optional: a workspace without a tracker is a supported configuration.
   */
  readonly trackers?: ReadonlyMap<WorkspaceName, Tracker>;
  /**
   * The review council (DESIGN.md §12.1). Optional: without one a task that passes the
   * §12 gates is done, exactly as it was before the council existed.
   */
  readonly council?: Council;
  /**
   * Reviewer forge identities by workspace — a SECOND app, not the one that opens PRs.
   * Optional, and its absence is a supported configuration: the council still runs and
   * still records verdicts, and merging stays a human act.
   */
  readonly reviewers?: ReadonlyMap<WorkspaceName, ForgeFactory>;
  /**
   * Whether a repo somebody just named is one the workspace's credential can actually
   * reach (DESIGN.md §9.1.1). The forge factories, narrowed to the one question the loop
   * asks of them — it does not mint here, and it must not be able to.
   *
   * Optional, and its absence is not a loss of correctness: without it the fleet behaves
   * exactly as it did before, which is to discover an unreachable repo when `git clone`
   * fails inside a session. Every use FAILS OPEN for the same reason — a forge that cannot
   * answer has told us nothing, and refusing work over that would be worse than the clone
   * failure it is trying to pre-empt.
   */
  readonly forges?: ReadonlyMap<WorkspaceName, RepoReach>;
  /**
   * Re-checks a plan's dependency graph when one of its tasks finishes (§14.3).
   * Optional: without it a plan's edges stay exactly as they were proposed.
   */
  readonly maintainer?: Maintainer;
  /**
   * Thread ↔ task index, rebuilt from the state repo on every poll (§14.3).
   *
   * The supervisor owns the authoritative copy because it owns the state repo; the
   * bridge only reads it. Rebuilding rather than incrementally updating means a pod
   * restart heals it for free — there is no separate durable index to fall out of step.
   */
  readonly threads?: ThreadIndex;
  /**
   * Where the thread↔task bindings are PUBLISHED for a standalone bot (§7).
   *
   * Optional and write-only, like `snapshot` and for the same reason. With the bot in
   * this process the local `threads` index is the whole truth and this is an in-memory
   * store nobody reads; with the bot split out it is the only way the binding can reach
   * it, because that process has no state repo to rebuild an index from.
   */
  readonly threadBindings?: ThreadBindingWriter;
  /**
   * Activity signal while a session runs (§7.1). Optional, and purely cosmetic: the
   * channel is silent between a question and its answer, so a task thinking for forty
   * minutes otherwise looks exactly like one that has died.
   */
  readonly presence?: Presence;
  /**
   * Ends a thread's conversation when its task is cancelled (§14.3). Optional, and
   * cosmetic in the same way the tracker is: the task is parked in git either way.
   */
  readonly closer?: ThreadCloser;
}

/**
 * A task's pull requests in `spec.repos` order.
 *
 * The order is the one the operator typed, which §14.3 already treats as meaningful — `repos[0]`
 * is the agent's working directory, so the first repo named is the one the change is centred on.
 * It is the closest thing to a dependency order the supervisor has, and merging is where that
 * matters: the repos of one change usually cannot land in either order.
 *
 * Anything not named by `spec.repos` keeps its relative place at the end rather than being
 * dropped — a PR is a fact about the forge, and silently omitting one from a merge would leave
 * it open with nothing saying so.
 */
const ordered = (
  repos: readonly RepoRef[],
  prs: readonly TaskPullRequest[],
): readonly TaskPullRequest[] => {
  const rank = (pr: TaskPullRequest): number => {
    const index = repos.findIndex(
      (repo) => repo.owner === pr.repo.owner && repo.name === pr.repo.name,
    );
    return index === -1 ? repos.length : index;
  };
  return [...prs].sort((a, b) => rank(a) - rank(b));
};

/**
 * Terminal statuses `/resume` may bring back.
 *
 * `parked` was the only one for a long time, and `failed` being left out was an
 * oversight rather than a decision: §7's argument for the command existing — that the
 * alternative is an operator editing `state.json`, which is a race against the loop that
 * owns the working copy — is the same argument, word for word, for a task that failed.
 *
 * It stopped being theoretical when a runner with no usable provider credential marked
 * six tasks `failed` in ninety seconds, for a reason that was nothing to do with any of
 * them, and stalled two more behind them: a plan's later waves are blocked by whatever
 * failed, so the fleet had eight tasks it could not touch and no command that could help.
 *
 * `done` is deliberately NOT here. Resuming it would re-run work that passed every gate
 * and merged — the one terminal status where coming back is not a recovery.
 */
const RESUMABLE: readonly TaskStatus[] = ["parked", "failed"];

/**
 * One task's session, as everything outside `workTask` needs to see it (DESIGN.md §6.4).
 *
 * **This type exists so that nothing task-scoped lives on the `Supervisor` instance any
 * more.** The loop was written throughout as "the current task": three fields —
 * `sessionInFlight`, `inFlightTask`, `cancelInFlight` — described the one session a runner
 * could have, and every terminal path assumed exclusivity over them. At N slots those
 * fields stop being a description and become a race: task B starting would overwrite task
 * A's cancel hook, and task A finishing would clear the flag task B is relying on.
 *
 * So a slot is a VALUE, one per in-flight task, and the supervisor holds a map of them.
 * The rule that replaces the old exclusivity assumption is: anything scoped to a task
 * lives here; anything scoped to the runner stays a field. `cooldown` is the load-bearing
 * example of the second kind — the provider is shared by every slot, so what one task
 * learned about it is true for all of them (§6.3).
 */
interface TaskSlot {
  readonly id: TaskId;
  readonly spec: TaskSpec;
  /**
   * The live claim, renewed by THIS slot's own heartbeat and nobody else's.
   *
   * Per slot rather than one heartbeat for the runner, because a lost lease has to fail
   * exactly one task. `LeaseLostError` for A means another runner owns A; it is evidence
   * about nothing else, and B's lease may be perfectly healthy. One shared renewal loop
   * would have to decide what a single failure means for every task at once, and every
   * answer to that is wrong.
   *
   * Mutable because a slot is registered at the instant its CAS wins, which is before
   * anything is renewing it: `openSlot` puts a `heldLease` snapshot here and `workTask`
   * replaces it with the real heartbeat. Nothing between those two points writes state,
   * so the snapshot is never used as a fence.
   */
  lease: LeaseHandle & { readonly stop: () => void };
  /**
   * Everything that may stop THIS session in flight, as one signal: shutdown, a lost
   * lease, a `/cancel` naming this task, the wall clock.
   *
   * Its scope is the containment boundary. Aborting it must never reach another slot, and
   * because it is created per slot rather than shared, that is structural rather than a
   * rule someone has to remember.
   */
  readonly interrupt: AbortController;
  /**
   * Stop this session, for a `/cancel` housekeeping drained (see `applyChatRequests`).
   *
   * On the slot rather than on the supervisor, which is the fix for the sharpest of the
   * three old fields: a single `cancelInFlight` on a two-slot runner would route every
   * cancel to whichever session installed itself last, so cancelling task A would stop
   * task B and leave A running — with the human told it had worked.
   */
  readonly cancel: () => void;
  /** True once a `/cancel` has been honoured for this task, so it is only logged once. */
  cancelled: boolean;
  /** Set by this slot's heartbeat when its own lease goes; never by any other slot's. */
  lost: LeaseLostError | undefined;
  /**
   * Human input for THIS task, for as long as the runner holds it (DESIGN.md §7.3).
   *
   * On the slot for `cancel`'s reason, one step further: a steer has to reach ONE session,
   * and the routing is by task id through `this.slots`. It outlives each individual session
   * because `workTask` drives a task through as many as it needs, and a sentence typed
   * during the changeover has nowhere else to wait.
   */
  readonly steering: SlotSteering;
  /**
   * The outage ANOTHER slot met, if one has been fanned out to this one (§6.3).
   *
   * The one field a slot does not set for itself, and it exists because the provider is
   * the one resource slots genuinely share. A cooldown is runner-scoped — what one task
   * learned about the account is true for all of them — so an outage has to stop this
   * runner claiming AND let go of what it is already holding. Without the fan-out, the
   * slot that met the wall would release and the other N-1 would keep hammering the same
   * refused endpoint until each met it separately, which is precisely the stampede
   * `ProviderCooldown` exists to prevent, divided by nothing.
   *
   * Read by `workTask` when its session comes back `interrupted`: with this set the task
   * goes down `releaseAfterOutage` instead of the plain interruption path, so it is
   * released to `ready` and charged nothing rather than left `running`.
   */
  outage: ProviderOutage | undefined;
}

export class Supervisor {
  /** 0 means "never ran", so the first pass happens at boot. */
  private lastIntakeAt = 0;

  /**
   * 0 means "never swept", and unlike `lastIntakeAt` that does NOT mean sweep at boot —
   * see `maybeReapWorktrees`, which only starts the clock on its first call. The
   * difference is deliberate: a missed intake pass is a task that arrives a few minutes
   * late, and a premature sweep is a directory that is gone.
   */
  private lastReapAt = 0;

  private readonly deps: SupervisorDeps;

  /**
   * How long this runner is sitting out a provider outage (DESIGN.md §6.3).
   *
   * Runner-scoped and in memory only. In memory because it is a statement about right
   * now — a restarted pod SHOULD try again immediately, since the most likely reason
   * anyone restarted it is that they just fixed the provider.
   */
  private readonly cooldown: ProviderCooldown;

  /**
   * Every task this runner has a session open for, keyed by id. Empty when idle.
   *
   * **The one piece of task-scoped state left on the supervisor, and it is a collection
   * rather than a task** — which is the whole shape of the change. It replaces
   * `sessionInFlight` (now `size > 0`), `inFlightTask` (now `has(id)`) and
   * `cancelInFlight` (now `get(id)?.cancel`), each of which described the one session a
   * runner could have and each of which two slots would have fought over.
   *
   * A slot is added the INSTANT its lease is won and removed in `workTask`'s `finally`,
   * so the window it covers includes the claim itself — see `claimUpTo` for why that
   * matters to a `/cancel` arriving between the CAS and the first turn.
   *
   * Read from both loops and mutated only from the work loop. No mutex: JavaScript runs
   * one thing at a time, and every read here is a single synchronous `get`/`has`/`size`
   * with no await inside it, so no reader can observe the map between two writes.
   */
  private readonly slots = new Map<TaskId, TaskSlot>();

  /**
   * Sessions that have been started and not yet settled, so shutdown can wait for them.
   *
   * Separate from `slots` because the two have different lifetimes on purpose: a slot is
   * removed the moment its session's `finally` runs, and this promise settles after the
   * whole of `workOnce`'s error handling — the park, the reap, the log line — has
   * finished. `workLoop` awaits these on the way out so an aborting runner does not
   * abandon a task mid-park.
   */
  private readonly running = new Map<TaskId, Promise<void>>();

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.cooldown = new ProviderCooldown(deps.config.llm.cooldown);
  }

  /**
   * Runs until `signal` aborts. Restart-safe: all state comes from the repo.
   *
   * TWO loops, not one (DESIGN.md §6.4). Housekeeping — pull, chat drain, intake, alerts,
   * digest, leadership — runs on `housekeepingSeconds` whether or not a session is in
   * flight; work — cooldown, claim, session — runs on its own and blocks for as long as
   * the session takes.
   *
   * They were one loop, and every housekeeping step therefore lived in the session's
   * shadow: a labelled issue was not ingested until the session ended, a `/resume` sat
   * unread in the inbox, and the Discord holder claim could neither be renewed nor stood
   * down from — the bot was online and answered nothing. `CANCEL_POLL_MS` and
   * `yieldToBrainstorm` were both built to work around exactly that, one request kind and
   * one session boundary at a time.
   *
   * This does NOT make the runner concurrent in the sense §6 rules out: there is still
   * exactly one `workTask` at a time, because there is still exactly one work loop. What
   * is now concurrent is housekeeping against a session, and the two of them share one git
   * checkout — which is why `StateStore` took a mutex, and why `pull` declines while a
   * session holds uncommitted state. Read that class's docstring before adding a third
   * caller here.
   *
   * Both loops are awaited together so that a throw escaping either — which should be
   * impossible; each contains its own — still ends `run`, rather than leaving one loop
   * turning and the process looking healthy.
   */
  async run(signal: AbortSignal): Promise<void> {
    const { config, logger } = this.deps;

    logger.info("supervisor.start", {
      runner: config.runnerId,
      capabilities: config.capabilities.join(","),
      pollSeconds: config.pollSeconds,
      housekeepingSeconds: config.housekeepingSeconds,
    });

    await Promise.all([this.housekeepingLoop(signal), this.workLoop(signal)]);
  }

  /**
   * Everything that must keep happening while a session runs.
   *
   * Containment is identical to the work loop's, and for the identical reason: a failure
   * belongs to ONE pass, never to the process. `store.pull` throws on any non-zero git
   * exit and `chat.refresh` reaches the network, so a blip in either used to unwind out of
   * `run()` into main's `finally`, which closes /healthz and the credential socket and
   * then blocks forever on `await bridge` — a live process, still answering Discord from a
   * frozen snapshot, that polled nothing and that systemd would never restart because it
   * never exited. Splitting the loop doubled the number of places that can happen, not
   * halved it.
   */
  private async housekeepingLoop(signal: AbortSignal): Promise<void> {
    const { config, logger } = this.deps;

    while (!signal.aborted) {
      try {
        await this.housekeepOnce(signal);
      } catch (error) {
        if (signal.aborted) return;
        logger.error("housekeeping.failed", errorFields(error));
      }
      await this.nap(config.housekeepingSeconds * 1000, signal);
    }
  }

  /** One housekeeping pass. Throws only what the caller should log and retry. */
  private async housekeepOnce(signal: AbortSignal): Promise<void> {
    const { config, store, logger } = this.deps;

    // Declines while a session holds uncommitted state, rather than resetting over it —
    // see `StateStore.pull`. Worth a line at debug when it does: a runner whose pulls are
    // all skipped is one whose `dirty` flag never got cleared, and the symptom otherwise
    // is a checkout that quietly stops tracking the remote.
    if ((await store.pull("origin", config.stateRepo.branch)) === "skipped") {
      logger.debug("housekeeping.pull-deferred", { reason: "session holds uncommitted state" });
    }

    // Advertise that this runner is alive (DESIGN.md §21). On the housekeeping loop and
    // not the work loop, for `ChatLeadership.refresh`'s reason inverted: the old objection
    // to a timer was that it would keep announcing presence while a session blocked the
    // loop — "alive" and "able to do anything" coming apart. Housekeeping IS the thing
    // that stays able to do something during a session, so a heartbeat from here means
    // what it says. ADVISORY — nothing routes or claims from it, and it never throws
    // (`redis/presence.ts`, `redis/guarded.ts`).
    await this.deps.runners?.heartbeat(asRunnerId(config.runnerId));

    // Before the drain, because the drain is the holder's job: a replica that just lost
    // the claim must not serve the requests it collected while it had it.
    await this.deps.chat?.refresh();

    // All of these run DURING a provider cooldown and during a session: answering a
    // question, ingesting an issue and filing an alert cost no tokens, and a queue that
    // keeps filling while the provider is down — or while this runner is busy — is the
    // correct behaviour. It is only STARTING sessions that has to stop.
    await this.applyChatRequests();
    await this.maybeIngest();
    await this.drainAlerts();
    await this.maybeDigest(signal);

    // AFTER the writes above, so the snapshot a human reads includes what this pass just
    // did rather than lagging it by an interval. This is the only thing keeping `/tasks`,
    // `/task`, autocomplete and the thread bindings current during a session — the work
    // loop's own call is inside the claim it is about to make, and does not come round
    // again until the session ends. See `survey`.
    await this.survey();

    // Only when IDLE, and this is the one housekeeping step that has to ask. The store is
    // shared with every worktree and mirror on a 20Gi volume so collecting is a
    // requirement rather than hygiene, but a collection racing a session on this same
    // runner is a risk with no upside — there is always another idle pass.
    if (this.slots.size === 0) await this.deps.toolchain.maybeCollectGarbage();
  }

  /**
   * Claim tasks and work them, forever, up to `concurrency` at a time (DESIGN.md §6.4).
   *
   * **It stopped being "claim one, block until it finishes" and became a scheduler.** The
   * old loop awaited `workTask` inline, so the loop body's duration WAS the session's, and
   * that is exactly what made a second slot impossible. Now each session runs as its own
   * promise in `running`, and this loop's only job is to keep free slots filled and to nap
   * between passes.
   *
   * At `concurrency: 1` — the default — this is the same behaviour it always had, arrived
   * at differently: one slot fills, every later pass finds it full, and the loop naps until
   * it frees. Nothing about a single-task runner changes.
   *
   * Deliberately holds no housekeeping. The sleep here is a claim BACKOFF — how long a
   * runner with a free slot waits before looking for work again — and nothing a human is
   * waiting on depends on it.
   */
  private async workLoop(signal: AbortSignal): Promise<void> {
    const { config, logger } = this.deps;

    while (!signal.aborted) {
      try {
        await this.workOnce(signal);
      } catch (error) {
        if (signal.aborted) break;
        logger.error("poll.failed", errorFields(error));
        await this.nap(config.pollSeconds * 1000, signal);
      }
    }

    // Sessions outlive the loop that started them, so shutting down means waiting for
    // them rather than walking away. Each has its own `finally` that stops a heartbeat,
    // releases a lease and closes a cancel subscription; abandoning one here would leave
    // the lease held until it went stale, which is the delay a redeploy pays before
    // another replica can pick the task up.
    //
    // `allSettled`, because every one of these already contains its own error handling
    // and a rejection at this point would take the other sessions' cleanup with it.
    await Promise.allSettled([...this.running.values()]);
  }

  /**
   * One pass of the scheduler: fill what slots are free, then nap.
   *
   * Throws only what the caller should log and retry. **Never throws on behalf of an
   * in-flight task** — a session's failure is contained inside its own promise (see
   * `startSlot`), so a task that dies here cannot unwind a pass that another task's
   * session is depending on.
   */
  private async workOnce(signal: AbortSignal): Promise<void> {
    const { config, logger, store } = this.deps;

    // Runner-scoped, and it gates the CLAIM rather than the sessions already running:
    // an outage stops this runner taking on anything new, and `releaseAfterOutage` is
    // what lets go of what it already has (§6.3).
    if (await this.coolingDown(signal)) return;

    // Full, so there is nothing to decide. Returning before the pull and the survey is
    // not only an optimisation: `pull` declines while any session holds the tree dirty,
    // and a saturated runner would otherwise walk `tasks/` once a poll to reach a claim
    // it already knows it cannot make.
    if (this.free() === 0) {
      this.publishSlots();
      logger.debug("poll.saturated", { inFlight: this.slots.size, concurrency: config.concurrency });
      await this.nap(config.pollSeconds * 1000, signal);
      return;
    }

    // BEFORE the claim, and not left to the housekeeping loop, even though housekeeping
    // pulls on its own timer. The old single loop did pull-then-claim in one pass, so a
    // claim was always decided from a checkout refreshed moments earlier; splitting the
    // loops broke that, because `pull` declines for as long as the tree is dirty and the
    // tree is dirty from `transition(running)` right through to `recordSession`. That is
    // the whole of a session. So at the instant a session ended, the very next claim was
    // decided from a view of `tasks/` that predated it — potentially hours old.
    //
    // The lease CAS does not save us there. `isClaimable` is a filter over local state and
    // says so in its own docstring; the CAS is only exclusive against a lease still HELD.
    // A task another runner finished and released hours ago is CAS-claimable and looks
    // ready in a stale `state.json`, so this runner would open a session on already-merged
    // work — which §6.2 names as the worst outcome the system has.
    //
    // Cheap where it is a no-op: mid-session the tree is dirty and this returns "skipped"
    // without running git. It is only ever a real pull when the tree is clean, which is
    // exactly when a claim is about to be made.
    await store.pull("origin", config.stateRepo.branch);

    // Bound rather than inlined into `claimUpTo`, because the reap below needs the SAME
    // survey this claim was decided from. Re-surveying for it would cost a second walk of
    // `tasks/` and, worse, could disagree with the claim: a task that appeared between the
    // two reads would be absent from the live set the sweep is handed.
    const records = await this.survey();

    // Fills every free slot in one pass rather than one per poll: at `concurrency: 4` a
    // runner coming up to a queue of ready work would otherwise take four poll intervals
    // to reach full, for no reason other than the shape of the old loop.
    //
    // Each claim registers its slot as it wins the lease, and `startSlot` takes ownership
    // from there — including of removing it. A throw out of `claimUpTo` therefore leaves
    // behind only slots that ARE running, which is what the `catch` inside it guarantees.
    const claimed = await this.claimUpTo(records, this.free());
    for (const { lease, spec } of claimed) this.startSlot(lease, spec, signal);
    this.publishSlots();

    if (this.slots.size === 0) {
      // The worktree half of the janitor (§3.1). On the WORK loop's idle branch and not in
      // housekeeping beside the nix collection, by the same test that put the usage walk
      // here: the nix collection spends its time inside nix, and this spends it inside THIS
      // process — a `stat` per file and then an `rm -rf` over a tree with one
      // `node_modules` per task. Housekeeping is what a human waiting on `/resume` is
      // waiting for, and it must not be blocked for either.
      //
      // The condition is now "no slot is occupied" rather than "the claim came back
      // empty", and that is a correction the extra slots forced rather than a
      // simplification. What makes the live set honest is that this runner holds NOTHING;
      // a pass that claimed nothing while three sessions were running would, on the old
      // wording, have swept the volume those three sessions are working in.
      await this.maybeReapWorktrees(records);

      // Idle-only, and left on the WORK loop rather than moved to housekeeping with the
      // nix collection. It spends its time inside THIS process — a `stat` per file over a
      // tree with one `node_modules` per task — and housekeeping is what a human waiting
      // on `/resume` is waiting for. Blocking it for a directory walk would reintroduce,
      // at a smaller scale, exactly the latency this split removed. The work loop when
      // idle has nothing better to do, and disk fills over hours rather than seconds.
      await this.maybeMeasureUsage();

      // Debug, not info: at the default poll interval this is the single noisiest
      // line the supervisor could emit, and an idle runner is not news.
      logger.debug("poll.idle", { pollSeconds: config.pollSeconds });
    }

    // Always, whether or not anything was claimed. This is the scheduler's tick, and
    // without it a runner with a free slot and nothing claimable would spin on `pull` and
    // `survey` as fast as git can answer.
    await this.nap(config.pollSeconds * 1000, signal);
  }

  /**
   * Run one session, and refuse to start one against a signal that has ALREADY aborted.
   *
   * A `SessionRunner` is handed the signal and is expected to honour it — every test in
   * `loop.test.ts` that pins "the abort must reach the session" is asserting exactly that,
   * and this deliberately does not weaken it: a signal that aborts DURING a session goes to
   * the runner and nowhere else, so a runner that ignores one is still a bug and still
   * visible as one.
   *
   * What it will not do is hand over a signal that aborted before the call. `AbortSignal`
   * fires a listener added after the abort exactly never, so a runner that subscribes to the
   * event — which is the obvious way to write one — waits forever for something that has
   * already happened. `workTask` then awaits a promise that will never settle, holding a
   * slot and a lease, with `/healthz` green: the runner-that-looks-healthy of §6.4, reached
   * through a dependency instead of through a hung command.
   *
   * **The window is real and this task widened it.** A `/cancel` may arrive between the CAS
   * that won the lease and the first turn — `openSlot` installs the cancel hook precisely so
   * that it can — and pushing the `running` transition put another network round trip in
   * there, which is also what makes the task visible as `running` early enough for an
   * operator to cancel it that fast. It is checked HERE, at the last statement before the
   * call, rather than at the top of the session loop, because everything in between (the
   * limits check, the reachability check, the transition and its push) is an await.
   *
   * `interrupted` is the right outcome to synthesise: it is what all four abort reasons
   * already produce, and `workTask` reads the slot's own flags to tell which one it was.
   */
  private async runSession(
    spec: TaskSpec,
    state: TaskState,
    signal: AbortSignal,
    steering: SteeringFeed,
  ): Promise<SessionOutcome> {
    if (signal.aborted) {
      return {
        reason: "interrupted",
        usage: EMPTY_USAGE,
        contextTokens: 0,
        summary: "the session was stopped before it started",
      };
    }
    return this.deps.runner.run(spec, state, signal, steering);
  }

  /** Slots this runner could still fill. Never negative. */
  private free(): number {
    return Math.max(0, this.deps.config.concurrency - this.slots.size);
  }

  /** Publish the two slot gauges. Cheap, and called wherever `slots` changed. */
  private publishSlots(): void {
    const { metrics, config } = this.deps;
    metrics.tasksInFlight.set({ runner: config.runnerId }, this.slots.size);
    metrics.slotsFree.set({ runner: config.runnerId }, this.free());
  }

  /**
   * Start one task's session as its own promise, and own its whole lifetime.
   *
   * **This is where per-slot containment is enforced**, and it is the load-bearing half of
   * working N tasks at once. `workOnce` used to `await workTask` inside its own
   * `try`/`catch`, so a task's failure was on the work loop's stack — which was fine while
   * there was one task, because unwinding the pass and unwinding the task were the same
   * act. With slots they are not: a throw reaching `workOnce` would abandon the pass that
   * every OTHER in-flight task's cleanup and reclaim depends on.
   *
   * So the promise here settles rather than rejects. Everything the old `catch` did is
   * still done, per task, in a place where doing it cannot reach a sibling:
   *
   *   - `LeaseLostError` drops THIS task and reaps THIS task's checkout. Another runner
   *     owns it now; that is a statement about one lease and about nothing else, so no
   *     other slot is touched.
   *   - any other failure is logged and the slot freed — the containment reasoning that
   *     used to read "a failure belongs to the TASK, not the supervisor" now has to hold
   *     per slot, and it does, because the boundary is this function rather than the loop.
   *
   * Deliberately NOT awaited by the caller. Awaiting it is what the old loop did and is
   * precisely what a slot is not allowed to do; `workLoop` awaits the collection once, on
   * shutdown.
   */
  private startSlot(lease: Lease, spec: TaskSpec, signal: AbortSignal): void {
    const { logger } = this.deps;

    const session = (async (): Promise<void> => {
      try {
        await this.workTask(lease, spec, signal);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          // Another runner owns this task now. Drop everything without writing.
          logger.warn("lease.lost", { task: spec.id, ...errorFields(error) });
          // And drop the checkout with it. Whoever holds the lease now is working the task
          // in their OWN `tasksDir`, from the branch on the remote; this runner's copy will
          // never be resumed and nothing will ever name it again, which is precisely the
          // orphan the periodic sweep exists to catch days later. Catching it here costs
          // one `rm -rf` and saves the disk in between.
          await this.reapTask(spec, "lease-lost");
          return;
        }

        // Any other failure belongs to the TASK, not the supervisor — and now, with more
        // than one slot, not to any other task either. Rethrowing would reach the work
        // loop, and because the claim is durable a restarted supervisor re-claims the same
        // task and dies again: one malformed task wedges the whole runner permanently, and
        // at N slots takes N-1 healthy sessions down on the way.
        //
        // `workTask` parks anything attributable to the task while it still holds the
        // lease, so reaching here means the failure escaped that path. A shutdown is not
        // logged as one of these: an aborted session is the pod stopping, not the task
        // misbehaving.
        if (signal.aborted) {
          logger.info("session.abandoned", { task: spec.id, ...errorFields(error) });
          return;
        }
        logger.error("supervisor.unhandled", { task: spec.id, ...errorFields(error) });
      } finally {
        this.running.delete(spec.id);
        this.publishSlots();
      }
    })();

    this.running.set(spec.id, session);
  }

  /**
   * Sleep, but wake at once when the pod is shutting down.
   *
   * Both loops sleep, and with the split there are now two of them to wait for on the way
   * out: a plain `sleep` would make SIGTERM take up to a poll interval to be noticed by
   * each, and `run` awaits both. `AbortSignal` rather than a timer handle so the wakeup is
   * the same signal everything else in the supervisor already honours.
   *
   * The rejection is swallowed. An abort here is not a failure — it is the loop being told
   * to stop, and the `while` condition above is what acts on it.
   */
  private async nap(ms: number, signal: AbortSignal): Promise<void> {
    await sleep(ms, undefined, { signal }).catch(() => undefined);
  }

  /**
   * Sit out a provider outage, if one is in progress. See DESIGN.md §6.3.
   *
   * Returns true when the WORK loop must not claim anything. Housekeeping is unaffected
   * and always was: pulling, answering a question and ingesting an issue cost no tokens,
   * so a provider outage is no reason to stop any of them — it is only starting sessions
   * that has to wait. That used to be arranged by ordering, with everything cheap placed
   * ahead of this gate in the one loop; now it is arranged by the loops being separate,
   * which is the same guarantee without depending on statement order.
   *
   * The wait is still capped at ONE poll interval per iteration rather than slept through
   * in one go, so an abort is honoured within a poll rather than within the cooldown, and
   * the metric is re-published on the way round.
   */
  private async coolingDown(signal: AbortSignal): Promise<boolean> {
    const { config, metrics, logger } = this.deps;

    const remaining = this.cooldown.remainingMs(Date.now());
    metrics.providerCooldown.set({ runner: config.runnerId }, Math.ceil(remaining / 1000));
    if (remaining === 0) return false;

    logger.info("provider.cooling", { remainingSeconds: Math.ceil(remaining / 1000) });
    await this.nap(Math.min(remaining, config.pollSeconds * 1000), signal);
    return true;
  }

  /**
   * Run an intake pass if one is due.
   *
   * Rate-limited independently of the poll interval — see `intakeDue` for the arithmetic.
   * Failures never propagate: intake is best-effort and the state repo is authoritative,
   * so a tracker outage must not stop the supervisor from working tasks it already has.
   */
  private async maybeIngest(): Promise<void> {
    const { intake, config, logger, leases } = this.deps;
    if (intake === undefined) return;
    if (!intakeDue(this.lastIntakeAt, Date.now(), config.intake.intervalSeconds)) return;

    // Stamped BEFORE the pass, not after: a pass that throws must still wait out the
    // interval, or a tracker returning errors would be retried on every poll — the exact
    // request storm the interval exists to prevent.
    this.lastIntakeAt = Date.now();

    // One runner in the fleet serves each interval — see `intakeRef` for why this is a
    // rate-limit requirement and not tidiness. With one replica it is a single ls-remote
    // that always wins, which is the same cost the digest claim already pays.
    const ref = intakeRef(this.lastIntakeAt, config.intake.intervalSeconds);
    const claimed = await leases.claimOnce(ref, `intake runner=${config.runnerId}`).catch(() => {
      // A claim that ERRORS is not a claim another runner won, and skipping on it would
      // let a state-repo blip stop intake fleet-wide and silently. Ingest anyway: a
      // duplicated pass is idempotent (`hasTask`), a skipped one is work nobody sees.
      logger.warn("intake.claim-failed", { ref });
      return "claim-failed";
    });

    if (claimed === undefined) {
      logger.debug("intake.claimed-elsewhere", { ref });
      // Recorded, not silently dropped. With four replicas three of them lose the claim
      // every interval, and a page that showed nothing for them would say "intake has
      // never run here" about a fleet ingesting perfectly well.
      this.deps.intakeStatus?.record({
        at: new Date().toISOString(),
        ref,
        runner: config.runnerId,
        outcome: "claimed-elsewhere",
      });
      return;
    }

    try {
      // Always info, never debug. At a 300s interval this is ~12 lines an hour, and it is
      // the ONLY evidence intake is alive: a pass that creates nothing is the normal case,
      // so hiding it makes a working intake and a broken one look identical from the logs.
      // `seen` is what separates them — it distinguishes "nobody labelled anything" from
      // "the tracker returned items and none became tasks".
      const pass = await intake.ingest("origin", config.stateRepo.branch);
      logger.info("intake.pass", { ...pass });
      this.deps.intakeStatus?.record({
        ...pass,
        at: new Date().toISOString(),
        ref,
        runner: config.runnerId,
        outcome: "ingested",
      });
    } catch (error) {
      logger.warn("intake.failed", { ...errorFields(error) });
      // No counts on a failure, rather than zeroes: a pass that threw part-way through
      // knows neither how many items it saw nor how many it would have refused, and
      // zeroes would render as "the tracker had nothing to say".
      this.deps.intakeStatus?.record({
        at: new Date().toISOString(),
        ref,
        runner: config.runnerId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Measure the work volume, if it is time, and publish what came back.
   *
   * Never throws, and that is a requirement rather than caution. This is observability:
   * the whole point of it is to be running when something is wrong, which is exactly when
   * a filesystem is most likely to answer a `stat` with an error. A measurement that could
   * take down a poll would be a monitor that fails first and loudest during the incident
   * it was installed to explain — so the failure mode is a warning and a stale gauge.
   *
   * The rate limit lives in `UsageMonitor` rather than here, next to the numbers it
   * throttles, exactly as `maybeCollectGarbage` keeps its own.
   */
  private async maybeMeasureUsage(): Promise<void> {
    const { usage, metrics, config, logger } = this.deps;
    if (usage === undefined) return;

    try {
      const measured = await usage.maybeMeasure();
      if (measured === undefined) return;

      metrics.recordUsage(config.runnerId, measured);
      logger.info("workspace.usage", {
        mirrorBytes: measured.mirrorBytes,
        taskBytes: measured.taskBytes,
        nixBytes: measured.nixBytes,
        otherBytes: measured.otherBytes,
        freeBytes: measured.fs.freeBytes,
        totalBytes: measured.fs.totalBytes,
        durationMs: measured.durationMs,
        partial: measured.partial,
      });
    } catch (error) {
      logger.warn("workspace.usage-failed", { ...errorFields(error) });
    }
  }

  /**
   * Turn whatever the alert receiver accepted since the last poll into tasks (§20).
   *
   * Every tick, not on an interval of its own: the queue is in memory and already bounded
   * by the receiver, so there is no rate limit to respect — the work is proportional to
   * what Alertmanager actually delivered, and an empty queue costs an array swap. Ahead of
   * the cooldown gate, like intake, because creating a task spends no tokens and a queue
   * that keeps filling while the provider is down is the correct behaviour.
   *
   * Failures never propagate. An alert that cannot be filed is one task that does not
   * exist yet and will be re-delivered while it keeps firing; a throw here would stop the
   * runner from working the tasks it already has.
   */
  private async drainAlerts(): Promise<void> {
    const { alerts, config, logger } = this.deps;
    if (alerts === undefined) return;

    const queued = alerts.queue.drain();
    if (queued.length === 0) return;

    try {
      logger.info("alert.pass", {
        ...(await alerts.ingester.process(queued, "origin", config.stateRepo.branch)),
      });
    } catch (error) {
      logger.warn("alert.pass-failed", errorFields(error));
    }
  }

  /**
   * Publish the day's digest, if one is due (DESIGN.md §19).
   *
   * Ahead of the cooldown gate, like intake, and for the same reason: a day that has ended
   * has ended whether or not the provider is answering, and everything in a digest except
   * its one paragraph of prose is measured from git and costs no tokens. A digest
   * published during an outage simply says why it has no prose.
   *
   * Failures never propagate. `DailyDigest` already swallows its own and releases its
   * claim so the day can be retried; this catch is for the one thing it cannot handle —
   * itself throwing — because a report about the fleet must never be what stops the fleet.
   */
  private async maybeDigest(signal: AbortSignal): Promise<void> {
    const { digest, logger } = this.deps;
    if (digest === undefined) return;

    try {
      await digest.maybePublish(new Date(), signal);
    } catch (error) {
      logger.warn("digest.pass-failed", errorFields(error));
    }
  }

  /**
   * Sweep orphaned worktrees off this runner's volume, if it is time (DESIGN.md §3.1).
   *
   * Called only from the idle branch, and rate-limited exactly the way
   * `ToolchainResolver.maybeCollectGarbage` rate-limits itself — including the detail that
   * looks like an off-by-one and is not: the FIRST call only starts the clock. Stamping at
   * construction instead would make a runner that is crash-looping every few minutes sweep
   * on every boot, which is the one moment its worktrees are most likely to be wanted, by
   * the very tasks it is about to re-claim.
   *
   * **The live set is stated, never inferred.** It comes from the survey this poll already
   * did, and it is every task the state repo does not consider finished: `ready`,
   * `running` and `awaiting-human` all resume against a checkout that may be this one. A
   * `running` task on another replica is in the set too, and that is correct rather than
   * merely safe — this runner cannot tell from a status whether the directory it is
   * looking at belongs to the session that is happening elsewhere, and the cost of being
   * wrong in that direction is one directory surviving a few more days.
   *
   * Never throws. A sweep that fails is a disk-space problem for later; a sweep that
   * unwound into `pollOnce` would cost the runner a poll for a chore nobody asked for.
   */
  private async maybeReapWorktrees(records: readonly TaskRecord[]): Promise<void> {
    const { worktrees, config, logger } = this.deps;
    if (worktrees === undefined) return;

    const now = Date.now();
    if (this.lastReapAt === 0) {
      this.lastReapAt = now;
      return;
    }
    if (now < this.lastReapAt + config.workspace.reap.intervalHours * 60 * 60 * 1000) return;
    // Stamped BEFORE the sweep, like the intake pass: a sweep that throws must still wait
    // out the interval rather than being retried on every idle poll.
    this.lastReapAt = now;

    // A survey that saw NOTHING is not a fleet with no tasks — it is a state repo this
    // runner could not read. `survey` skips a state that fails to parse and `listTasks`
    // walks a checkout that a failed pull can leave empty, so an empty result and "every
    // task is finished" are indistinguishable from here, and one of those two readings
    // hands the sweep an empty live set and every directory on the volume. A real state
    // repo always holds at least the task this runner has been working, so refusing to
    // sweep on an empty survey costs one interval and nothing else.
    if (records.length === 0) {
      logger.debug("worktree.reap-skipped", { reason: "the task survey came back empty" });
      return;
    }

    const live = new Set(
      records.filter((record) => !isTerminal(record.state.status)).map((record) => record.id),
    );

    try {
      const reaped = await worktrees.reapStaleWorktrees({ live });
      this.recordReap(reaped, "swept");
    } catch (error) {
      logger.warn("worktree.reap-failed", errorFields(error));
    }
  }

  /**
   * Throw away one task's checkout, now that this runner is finished with it.
   *
   * Called only from the terminal paths that will not resume IN PLACE — see the call
   * sites. `handoff` and `awaiting-human` deliberately do not call it: both resume against
   * this very directory, and reaping there would trade a few gigabytes for a re-clone and
   * a re-install on every handoff, which costs more of everything than it saves.
   *
   * Never throws, for the same reason `parkFailed` does not: this runs after the task's
   * state has already been pushed, so a failure here can only turn a completed task into
   * a supervisor error. Disk is worth a warn and nothing more.
   */
  private async reapTask(spec: TaskSpec, reason: string): Promise<void> {
    const { worktrees, logger } = this.deps;
    if (worktrees === undefined) return;

    try {
      const reaped = await worktrees.removeTaskWorktrees(spec.id, spec.repos);
      this.recordReap(reaped, "targeted", reason);
    } catch (error) {
      logger.warn("worktree.reap-failed", { task: spec.id, reason, ...errorFields(error) });
    }
  }

  /**
   * One log line and two counters per reap that removed something.
   *
   * Silent when it removed nothing, which is the overwhelmingly common case for the sweep:
   * a healthy runner reaps everything targeted, so a sweep that finds nothing is the
   * system working and a line a day saying so is noise. A reap that DID remove something
   * is always worth a line at info — it is the only record that a number of gigabytes
   * left this volume, and "where did the disk go" is asked after the fact, from logs.
   */
  private recordReap(reaped: ReapResult, kind: "targeted" | "swept", reason?: string): void {
    const { metrics, logger } = this.deps;
    if (reaped.worktrees === 0) return;

    metrics.worktreesReaped.inc({ kind }, reaped.worktrees);
    metrics.worktreeBytesReaped.inc({ kind }, reaped.bytes);
    logger.info("worktree.reaped", {
      kind,
      ...(reason === undefined ? {} : { reason }),
      worktrees: reaped.worktrees,
      approxBytes: reaped.bytes,
      approxMegabytes: Math.round(reaped.bytes / (1024 * 1024)),
      tasks: reaped.tasks.join(","),
    });
  }

  /**
   * Read every task's state once, and publish the result to the chat snapshot.
   *
   * One pass serves several readers. Claiming has to read every state to find a `ready`
   * one, and `/tasks`, `/task` and autocomplete are served from the snapshot it publishes
   * on the way past (DESIGN.md §7), so the snapshot rides along rather than costing a
   * second sweep of the task tree.
   *
   * **Called from housekeeping as well as from the work loop, and that is not redundant.**
   * The work loop calls it because it is about to claim; housekeeping calls it because the
   * two things it publishes are things a human reads. Left on the work loop alone they
   * would freeze for the whole of a session — `/tasks` would answer from a snapshot taken
   * hours ago, still showing the running task as `ready`, and `threads` would not learn
   * about a task created since, so an `!answer` typed into its thread would find no
   * binding and be swallowed. That is the same defect the loop split exists to fix,
   * arriving through the reader rather than through the writer.
   *
   * It is only a read, so running it from both loops is safe without the store's mutex:
   * `listTasks` and `readState` touch the filesystem and never git. The two publishes are
   * whole-snapshot `replace` calls, so the loser of a race publishes a complete and
   * slightly older view rather than a torn one.
   *
   * A state that fails to parse is skipped rather than fatal — it is one task the
   * runner cannot see, not a runner that cannot run.
   */
  private async survey(): Promise<readonly TaskRecord[]> {
    const { store, snapshot } = this.deps;

    const records: TaskRecord[] = [];
    for (const id of await store.listTasks()) {
      const state = await store.readState(id).catch(() => undefined);
      if (state === undefined) continue;
      records.push({ id, state });
    }

    // Awaited: with Redis configured this is a write over the network, and a floating
    // promise here would let the poll finish before the bot could see the new list.
    // Never throws — `RedisSnapshotStore` degrades — so it cannot fail the survey.
    await snapshot?.replace(records.map((record) => summarise(record.state)));
    // `done` tasks drop out and nothing else does. A message in a bound thread is acted on
    // whatever the task's status, so a `parked` or `failed` task stays bound — that is where
    // guidance goes (§7.3), and unbinding it was what made a stalled brainstorm unreachable
    // from the very thread its park notification pointed at. `threadBindings` also settles
    // who owns a thread several tasks share — a plan's children inherit their brainstorm's.
    const bindings = threadBindings(
      records.map((record) => ({
        id: record.id,
        status: record.state.status,
        ...(record.state.chat === undefined ? {} : { threadId: record.state.chat.threadId }),
      })),
    );
    this.deps.threads?.replace(bindings);

    // And out to the ephemeral plane, for a bot that is not in this process (§7). Awaited
    // and never throwing, exactly like the snapshot write above: a binding that arrives a
    // poll late means an `!answer` in a new thread finds nothing to route to, and the
    // human is told so rather than answered.
    await this.deps.threadBindings?.publish(
      bindings.map(([threadId, task]) => ({ threadId, task })),
    );

    // What the bot shows in Discord's member list (`notify/activity.ts`). Here rather than
    // anywhere else for the reason the two calls above are: this is the one place in the
    // process that has just read EVERY task's committed state, which is what makes the
    // presence fleet-wide instead of a report on this replica. Synchronous, never throws,
    // and only sends when the rendered line actually changed — see `FleetActivity.publish`.
    this.deps.activity?.publish(
      records.map((record) => ({
        id: record.id,
        status: record.state.status,
        phase: record.state.phase,
      })),
    );
    return records;
  }

  /**
   * Claim up to `slots` claimable tasks this runner satisfies the requirements of.
   *
   * The bounded form of what used to be `claimNext`, and the change is entirely local
   * bookkeeping: **leasing already made concurrent claims safe across the fleet** (§5,
   * `state/lease.ts`), because a claim is a compare-and-swap on a git ref and has been
   * exclusive against every other replica since the day it was written. Four replicas at
   * one slot each and one replica at four slots race through the identical CAS. What is
   * new is only that this process now has more than one thing to keep track of.
   *
   * Returns what it won, in claim order, capped at `slots`. Zero is a normal answer and
   * the overwhelmingly common one — an idle fleet has nothing claimable.
   *
   * Tasks already in a slot on THIS runner are skipped before the CAS is attempted. The
   * CAS would refuse them anyway (this runner holds the lease, and `claim` declines a live
   * one), but reaching it would cost an `ls-remote` per in-flight task per poll, and —
   * worse — a stale lease belonging to this very process is one this process would
   * cheerfully steal from itself, ending with two sessions on one worktree.
   */
  private async claimUpTo(
    records: readonly TaskRecord[],
    slots: number,
  ): Promise<readonly { readonly lease: Lease; readonly spec: TaskSpec }[]> {
    const { store, leases, config, metrics, logger } = this.deps;
    if (slots <= 0) return [];

    const statusOf = (id: TaskId): TaskStatus | undefined =>
      records.find((record) => record.id === id)?.state.status;

    // The spec is read BEFORE the sort, not inside the loop, because the order now
    // depends on the task's kind and `state.json` does not carry it. Only for tasks that
    // survive the cheap filters — a state repo holds every task the fleet has ever run,
    // and reading all of their specs on every poll to order the two that are claimable
    // would be a sweep of the whole tree once a minute forever.
    //
    // A spec that cannot be read drops out here rather than being claimed and failing
    // later, which is what the old `continue` did one step further down.
    // `id` is carried alongside rather than taken from `state.id`: the directory name is
    // what `listTasks` walked and what the lease ref keys on, and nothing validates that
    // the two agree.
    const candidates: { readonly id: TaskId; readonly spec: TaskSpec; readonly state: TaskState }[] =
      [];
    for (const { id, state } of records) {
      // Ours already — see the docstring. Before `isClaimable`, because a task this runner
      // is working reads `running`, which IS claimable (§6.2) by design.
      if (this.slots.has(id)) continue;
      if (!isClaimable(state, statusOf)) continue;
      if (!capabilitiesSatisfy(config.capabilities, state.requires)) continue;

      const spec = await store.readSpec(id).catch(() => undefined);
      if (spec === undefined) continue;
      candidates.push({ id, spec, state });
    }

    // Counted BEFORE the claims, over what this runner would have taken had it had room.
    // This is the series that separates "the fleet has nothing to do" from "the fleet is
    // saturated", and both look like an idle runner from every other metric. `slots` is
    // what `workOnce` had free at the top of the pass, so the arithmetic is honest even
    // when a claim below loses its CAS to another replica.
    if (candidates.length > slots) {
      metrics.claimsRejectedFull.inc({ runner: config.runnerId }, candidates.length - slots);
      logger.debug("claim.capped", {
        claimable: candidates.length,
        slots,
        concurrency: config.concurrency,
      });
    }

    // A waiting human first, then earlier waves, then by id. Without the sort this is
    // `readdir` order, which is alphabetical and would run a plan's wave-3 task before
    // its wave-1 sibling whenever the ids happened to fall that way.
    candidates.sort((a, b) =>
      claimOrder(
        { state: { ...a.state, id: a.id }, kind: a.spec.kind ?? "implement" },
        { state: { ...b.state, id: b.id }, kind: b.spec.kind ?? "implement" },
      ),
    );

    const won: { readonly lease: Lease; readonly spec: TaskSpec }[] = [];

    for (const { id, spec, state } of candidates) {
      if (won.length >= slots) break;

      const lease = await leases.claim(id);
      if (lease === undefined) continue;

      // Registered as ours the INSTANT the lease is won, not when `startSlot` gets the
      // result back. Several awaits follow before that (the reclaim journal, the mirror),
      // and housekeeping drains chat throughout them: a `/cancel` naming this task arriving
      // in that window would be taken by the drain rather than left for the in-session
      // watcher, fail `leases.claim` against the lease just taken here, and answer the
      // human "not-parkable: running" about a task this very process is about to start —
      // the exact reply `applyChatRequests` excludes the request to avoid. Recoverable by
      // retrying, but it reads as a bug to the person typing it.
      //
      // The slot is PROVISIONAL until `workTask` installs the real heartbeat and cancel
      // hook — see `openSlot`. A cancel landing in this window aborts the controller
      // before the session ever reads it, and `workTask` sees an already-aborted signal
      // and unwinds, which is the outcome the human asked for.
      const slot = this.openSlot(id, spec, lease);

      // Anything from here to the return is a claim that has been WON and could still
      // throw — the reclaim journal writes the state repo, the tracker mirror reaches the
      // network. The slot must not outlive a failure to start, or every later `/cancel`
      // for that task is silently swallowed: the drain keeps leaving it for an in-session
      // watcher that does not exist. Releasing the lease too, because nothing is going to
      // work this task and holding it just delays whoever would.
      try {
        // The CAS is what established this was safe to take, so by here the previous
        // holder is gone. Say so: a reclaim is a pod that died mid-task, and the whole
        // failure used to be invisible — the task simply stopped, with no line anywhere
        // connecting it to the deploy that killed it.
        if (state.status === "running") {
          logger.warn("task.reclaimed", {
            task: id,
            runner: lease.runner,
            sessions: state.sessions,
          });
          await store.appendJournal(
            id,
            state.sessions,
            "The runner holding this task stopped without parking or finishing it — a " +
              "restart, a lost lease, or a killed pod. The lease has since gone stale, so " +
              `${lease.runner} has taken it over. Work already pushed to the task branch ` +
              "is intact; anything the previous session had not committed is not.",
          );
        }

        logger.info("task.claimed", {
          task: id,
          runner: lease.runner,
          workspace: spec.workspace,
          sessions: state.sessions,
          inFlight: this.slots.size,
          concurrency: config.concurrency,
        });
        await this.mirror(spec, { kind: "claimed", runner: lease.runner });
      } catch (error) {
        // Contained per CLAIM, for `startSlot`'s reason one step earlier: at N slots a
        // throw here would abandon the tasks already claimed in this same pass, which have
        // leases held and no session started. Logged and skipped instead — the task stays
        // exactly as it was and the next pass may claim it again.
        this.closeSlot(slot);
        await leases.release(lease).catch(() => undefined);
        logger.error("claim.failed", { task: id, ...errorFields(error) });
        continue;
      }

      won.push({ lease, spec });
    }

    return won;
  }

  /**
   * Register a provisional slot the moment its lease is won.
   *
   * Provisional in exactly one respect: the lease handle is a `heldLease` snapshot rather
   * than a heartbeat, because nothing renews a claim until `workTask` starts one. Every
   * other field is final, and `cancel` in particular works from this instant — a
   * `/cancel` arriving between the CAS and the first turn aborts the controller, and
   * `workTask` finds the signal already aborted and unwinds without running anything.
   */
  private openSlot(id: TaskId, spec: TaskSpec, lease: Lease): TaskSlot {
    const interrupt = new AbortController();
    const slot: TaskSlot = {
      id,
      spec,
      lease: { ...heldLease(lease), stop: () => undefined },
      interrupt,
      cancelled: false,
      lost: undefined,
      // From this instant too, and for `cancel`'s reason: a slot is registered the moment
      // its CAS wins, and `applyChatRequests` can route a steer to it before the first turn
      // has run. With nothing subscribed yet it buffers, and the first session takes it.
      steering: new SlotSteering(),
      outage: undefined,
      cancel: () => {
        if (slot.cancelled) return;
        this.deps.logger.info("task.cancel-requested", { task: id });
        slot.cancelled = true;
        interrupt.abort();
      },
    };

    this.slots.set(id, slot);
    this.publishSlots();
    return slot;
  }

  /** Give a slot back. Idempotent, and the only place `slots` shrinks. */
  private closeSlot(slot: TaskSlot): void {
    // By identity, not by id: a task claimed, released and re-claimed within one process
    // has two slot objects, and deleting by id alone would let the FIRST one's cleanup
    // evict the second one's live entry.
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
    this.publishSlots();
  }

  /**
   * Drive one task through as many sessions as it needs, until it parks or completes.
   *
   * The heartbeat runs for the whole duration; if it fails the session is aborted at
   * once and the next lease check throws, unwinding without writing anything.
   */
  private async workTask(lease: Lease, spec: TaskSpec, signal: AbortSignal): Promise<void> {
    const { store, leases, config, metrics, logger } = this.deps;

    // The slot `claimUpTo` registered when this task's CAS won. Everything that used to be
    // a field on the supervisor now lives in it, which is what lets a second session run
    // beside this one without either of them noticing.
    //
    // Its absence is a programming error rather than a condition to handle: a slot is
    // opened before this is called and closed in the `finally` below, so a missing one
    // means someone called `workTask` outside the scheduler.
    const slot = this.slots.get(spec.id);
    if (slot === undefined) throw new Error(`no slot is open for ${spec.id}`);

    // Everything that may stop THIS session in flight, as one signal. Losing the lease
    // used to set a flag that was only read at the TOP of the loop, so a lease lost at
    // t=60s let the session run out the rest of its budget — still minting tokens for
    // every push — while another runner worked the same branch.
    //
    // On the slot rather than local to this call, so a `/cancel` that arrives during the
    // claim (`openSlot`) reaches the same controller this session is about to read.
    const interrupt = slot.interrupt;
    const stopOnShutdown = (): void => interrupt.abort();
    signal.addEventListener("abort", stopOnShutdown, { once: true });

    // Housekeeping drains everything else during a session, but not this: a `/cancel` for
    // THIS task cannot be served from there, because serving it means writing the state
    // repo, writing means claiming the lease, and the lease is held by the session being
    // cancelled. So this watches for that one request kind and `applyChatRequests` leaves
    // it alone. See `CANCEL_POLL_MS`.
    //
    // `slot.cancel` and not a local closure: with N slots a cancel has to reach ONE
    // session, and the routing is by task id through `this.slots`. A single supervisor
    // field — which is what this was — would send every cancel to whichever session
    // installed itself last, so cancelling A would stop B and leave A running.
    const stop = slot.cancel;

    // THREE paths to the same abort, because a cancel can arrive from three places.
    //
    // The FIRST is `slot.cancel` itself, for a cancel that HOUSEKEEPING drained. It has to
    // exist because a queue may have no selective take (`ChatDrainer.selective`), in which
    // case the drain takes every request including this one, and having taken it off the
    // list it cannot leave it for the interval below. `applyChatRequests` looks the slot up
    // by task, calls this and settles the request itself. The slot is removed in the
    // `finally` at the end of the session, so a stale hook cannot abort a LATER session on
    // a cancel for this one.

    // The interval is the original one and covers a cancel submitted IN THIS PROCESS to a
    // queue that CAN take selectively: the request is sitting in the in-process queue, and
    // `takeWhere` pulls out that ONE request while leaving everything else — which writes
    // the state repo this session holds the lease for — queued. It settles `cancelling`
    // rather than `parked`, because the session unwinds at a turn boundary and the park
    // lands on the poll after that. Against a non-selective queue this yields nothing and
    // the handler above is what serves the cancel; it is harmless either way.
    const watchCancels = setInterval(() => {
      void (async (): Promise<void> => {
        const requests =
          (await this.deps.inbox?.takeWhere(
            (request) => request.kind === "park" && request.task === spec.id,
          )) ?? [];
        if (requests.length === 0) return;
        stop();
        for (const request of requests) request.settle({ kind: "cancelling" });
      })().catch((error: unknown) => logger.warn("task.cancel-poll-failed", errorFields(error)));
    }, CANCEL_POLL_MS);
    watchCancels.unref();

    // The signal path covers a cancel submitted by ANOTHER process — the standalone bot
    // (DESIGN.md §21). `watch` delivers it over pub/sub within a round trip and also
    // checks the durable key once on subscribe, so a cancel published in the gap between
    // this session starting and the subscription being established is not lost. Without
    // Redis this is the in-process implementation and costs nothing.
    const cancelWatch = await this.deps.cancels?.watch(spec.id, stop);

    // The same crossing, in the opposite direction (DESIGN.md §7.3). A message typed in the
    // task's thread at a SEPARATE bot process has no path into this heap, so it arrives here
    // — over pub/sub within a round trip, plus a drain on subscribe for anything published
    // in the gap while this was being established.
    //
    // Scoped to the whole of `workTask` rather than to one session, because a task runs as
    // many sessions as it needs and a sentence typed during a changeover has nowhere else to
    // wait. `SlotSteering` buffers it and the next session's `take()` finds it.
    const steerWatch = await this.deps.steering?.watch(spec.id, (text) => {
      logger.info("task.steered", { task: spec.id, chars: text.length });
      slot.steering.push(text);
    });

    // **One heartbeat per slot, renewing one lease.** The renewal is a CAS on
    // `refs/leases/<task>`, so the fencing `assertHeld` performs is per lease and stays so
    // however many slots are open: each slot's pushes are checked against its own ref and
    // no other's.
    //
    // What the split buys is containment of the FAILURE. Everything the `onLost` callback
    // does below is scoped to this slot — its own `lost` field, its own credential, its own
    // abort controller — so a stalled renewal for task A drops A and leaves B running with
    // a lease that was never in question. A shared heartbeat could not have that property
    // at all: one CAS failure would have to be read as evidence about every task at once.
    const heartbeat = startHeartbeat(
      leases,
      lease,
      config.lease.heartbeatSeconds,
      (error) => {
        slot.lost = error;
        // Immediately, not at the next loop iteration. The credential goes with it: this
        // task's entry outlived the lease that justified it, so a session that had already
        // lost its claim kept getting fresh tokens minted on demand.
        //
        // By task id, and only this one. The single global clear this replaced would, on a
        // runner working two tasks, have revoked the credential of a session whose lease
        // was perfectly healthy — a lost lease here is not evidence about anything there.
        logger.warn("lease.lost-mid-session", { task: spec.id, ...errorFields(error) });
        void this.deps.credentials?.deactivate(spec.id).catch(() => undefined);
        interrupt.abort();
      },
    );
    // Replaces the `heldLease` snapshot `openSlot` put there. From here on anything asking
    // the slot for its lease gets a token that tracks the renewals.
    slot.lease = heartbeat;

    try {
      while (!signal.aborted) {
        if (slot.lost !== undefined) throw slot.lost;

        let state = await store.readState(spec.id);

        // **Nothing is started against a signal that has already aborted.** The loop's own
        // condition watches the POD's signal; this watches THIS SLOT's, and they are not the
        // same question — a `/cancel`, a lost lease and the wall clock all abort the slot
        // while the pod is perfectly healthy.
        //
        // The window is real and this task widened it. A cancel can arrive between the CAS
        // that won the lease and the first turn (`openSlot` installs the hook precisely so
        // that it can), and everything in between — the reclaim journal, the reachability
        // check, and now the `running` push below — is a network round trip. Without this,
        // the session was started anyway and `SessionRunner.run` was handed an
        // already-aborted signal: correct implementations return at once, but one that only
        // subscribes to `abort` waits for an event that has already happened and never
        // fires. That is not a hypothetical implementation — it is what the fixture in
        // `loop.test.ts` does, and it hung the file rather than failing it.
        //
        // Treated exactly like a session that ran and was interrupted, because that is what
        // it is from the task's point of view: nothing is recorded (no session count, no
        // journal entry — §6.4), and a cancel still parks, because stopping a session is
        // not the same as cancelling a task and an interrupted task is left claimable.
        if (interrupt.signal.aborted) {
          logger.info("session.pre-empted", {
            task: spec.id,
            session: state.sessions + 1,
            cancelled: slot.cancelled,
            leaseLost: slot.lost !== undefined,
            providerOutage: slot.outage !== undefined,
          });
          if (slot.cancelled && slot.lost === undefined) {
            await this.deps.cancels?.clear(spec.id);
            await this.park(heartbeat, spec, state, "cancelled from chat");
          }
          return;
        }

        const verdict = checkLimits(state, state.limits, {
          noProgressLimit: config.limits.noProgressLimit,
        });
        if (verdict.kind === "park") {
          await this.park(heartbeat, spec, state, verdict.reason);
          return;
        }

        // Before a session, not during one. A task whose repo the credential cannot reach
        // cannot be worked at all: the first thing the session does is clone, and the
        // failure there costs a session, a journal entry about git, and a park reason that
        // names an installation id instead of the repo (§9.1.1).
        //
        // Re-asked every session rather than once per task, because the answer changes
        // without the task changing — an App uninstalled mid-task, or one installed a
        // minute ago by the human who read the last park reason. The listing behind it is
        // cached, so asking again is free in the steady state.
        const unreachable = await this.unreachableRepos(spec.workspace, spec.repos);
        if (unreachable !== undefined) {
          await this.park(heartbeat, spec, state, unreachable);
          return;
        }

        // Written and NOT pushed, deliberately — whatever this session commits next
        // carries it. Pushing it here was tried and reverted: it makes the task visible as
        // `running` before the session it names has started, and a `/cancel` arriving in
        // that window is then answered by a park with no session to stop. `loop.test.ts`
        // pins that ("a cancel from another process reaches a session in flight"), and it
        // is pinning something real rather than an accident of timing.
        //
        // The cost is that `StateStore.dirty` — one flag for the whole checkout — stays set
        // for the length of every session, so at `concurrency: N` the tree is clean only
        // when every slot is momentarily between commits and `pull` declines more often
        // than it used to. That is a REFRESH RATE, not a correctness property: the state
        // repo is authoritative but never urgent, skipping is the safe direction (see
        // `StateStore.pull`), and a slot commits several times per session. It is worth
        // knowing about, and §6.5 records it as the one thing about slots that gets worse
        // rather than better with N.
        state = await this.transition(heartbeat, state, "running");
        metrics.sessions.inc({ task: spec.id });

        logger.info("session.start", {
          task: spec.id,
          session: state.sessions + 1,
          phase: state.phase,
        });

        // Held for exactly the session, and stopped in a `finally` — an indicator left
        // running after a crash would be a lie that outlives the thing it described.
        const stopTyping = this.showWorking(state);
        // The wall clock. pi's bash tool documents `timeout` as optional with no
        // default, so the MODEL chooses whether a command can hang — `npm run dev`, a
        // test runner waiting on stdin, or a nix build against a dead cache never
        // settles, and everything here is single-threaded, so the poll, the chat drain
        // and intake stop with it. The ceiling is generous: it exists to bound a hang,
        // not to bound honest work.
        const deadline = setTimeout(() => {
          logger.error("session.timeout", {
            task: spec.id,
            session: state.sessions + 1,
            maxSeconds: config.limits.maxSessionSeconds,
          });
          interrupt.abort();
        }, config.limits.maxSessionSeconds * 1000);
        deadline.unref();

        let outcome: SessionOutcome;
        try {
          outcome = await this.runSession(spec, state, interrupt.signal, slot.steering);
        } finally {
          clearTimeout(deadline);
          stopTyping();
        }

        logger.info("session.end", {
          task: spec.id,
          session: state.sessions + 1,
          reason: outcome.reason,
          contextTokens: outcome.contextTokens,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsd: outcome.usage.costUsd,
          error: outcome.error,
        });

        metrics.handoffs.inc({ task: spec.id, reason: outcome.reason });
        metrics.tokens.inc({ task: spec.id, kind: "input" }, outcome.usage.inputTokens);
        metrics.tokens.inc({ task: spec.id, kind: "output" }, outcome.usage.outputTokens);
        metrics.cost.inc({ task: spec.id }, outcome.usage.costUsd);

        if (outcome.reason === "interrupted") {
          // Nothing about the SESSION is recorded. It did not reach a decision, and
          // writing a session count and a journal entry for a pod restart would charge
          // the task for an interruption that says nothing about it — the same reasoning
          // as `releaseAfterOutage`, minus the cooldown, because no provider misbehaved.
          logger.info("session.interrupted", {
            task: spec.id,
            session: state.sessions + 1,
            cancelled: slot.cancelled,
            leaseLost: slot.lost !== undefined,
            shuttingDown: signal.aborted,
            providerOutage: slot.outage !== undefined,
          });

          // A FOURTH reason to be interrupted, and the only one slots introduced: another
          // task on this runner met the provider wall and `fanOutOutage` aborted this
          // session too. Handled here rather than left to the plain interruption path,
          // because the two want opposite things from the task's state — an interruption
          // leaves it `running` (claimable, so the next poll resumes it), and an outage has
          // to leave it `ready` with the cooldown recorded, or this runner would re-claim it
          // on the very next pass and meet the same wall.
          //
          // The lease still has to be ours. A cancel or a lost lease that raced the fan-out
          // has better standing than this does, and `park`/`push` fence anyway.
          if (slot.outage !== undefined && !slot.cancelled && slot.lost === undefined) {
            await this.releaseAfterOutage(
              heartbeat,
              spec,
              state,
              slot.outage,
              outcome.usage,
              "session",
            );
            return;
          }

          // A CANCEL is different from the other three, and this is the half that is easy
          // to miss: stopping the session is not cancelling the task. An interrupted task
          // is left `running`, which is claimable (§6.2) — so without this the very next
          // poll would re-claim it and start the session over, and the operator would
          // watch the thing they cancelled carry on working.
          //
          // Only when the lease is still ours: a cancel that raced a lost lease has no
          // standing to write, and `park` fences anyway.
          if (slot.cancelled && slot.lost === undefined) {
            // Cleared before the park, so a task cancelled and then resumed inside the
            // signal TTL does not immediately cancel itself again on the session that
            // resumes it. Never throws — see `redis/guarded.ts`.
            await this.deps.cancels?.clear(spec.id);
            await this.park(heartbeat, spec, state, "cancelled from chat");
          }
          return;
        }

        if (outcome.reason === "provider-unavailable") {
          // `outage` is set by `buildOutcome` for every one of these; the fallback is
          // here so a future caller cannot turn a missing field into an uncooled runner.
          await this.releaseAfterOutage(
            heartbeat,
            spec,
            state,
            outcome.outage ?? { kind: "unavailable", detail: outcome.summary },
            outcome.usage,
            "session",
          );
          return;
        }

        // The provider answered, so whatever this runner was sitting out is over.
        if (this.cooldown.clear()) {
          logger.info("provider.recovered", { task: spec.id });
          await this.notifyTask(state, { kind: "provider-recovered", task: spec.id });
        }

        state = await this.recordSession(heartbeat, spec, state, outcome, slot.steering);

        const done = await this.applyOutcome(heartbeat, spec, state, outcome);
        if (done) return;

        if (await this.yieldToBrainstorm(heartbeat, spec, state)) return;
      }
    } catch (error) {
      // Parking happens HERE rather than in the caller, because the `finally` below
      // releases the lease on the way out and `park` -> `push` -> `assertHeld` would
      // then fail against a ref that no longer exists — every park after a session
      // error died with "lease is no longer held by this runner", leaving the task
      // `ready` to be re-claimed and to fail again on the very next poll.
      //
      // The heartbeat is stopped FIRST so the lease oid stops moving underneath the CAS.
      // The heartbeat ITSELF is what gets passed down, never a `Lease` read out of it:
      // renewals rotate the token, so any snapshot taken here is stale by the time a
      // push reaches `assertHeld`.
      heartbeat.stop();
      if (error instanceof LeaseLostError) throw error;
      if (signal.aborted) throw error;
      await this.parkFailed(heartbeat, spec, error);
    } finally {
      heartbeat.stop();
      clearInterval(watchCancels);
      // Before anything that can throw or await: housekeeping runs concurrently, and a
      // slot outliving its session would route a `/cancel` naming this task to a hook that
      // aborts nothing, having told the human it was cancelling. Giving the slot back here
      // rather than in `startSlot`'s `finally` is deliberate — the slot is what a claim
      // consumes, and by this point the session is over: the terminal write has landed and
      // the only thing left is cleanup, so holding a slot through it would idle a session's
      // worth of capacity behind an `rm -rf`.
      this.closeSlot(slot);
      // Or a long-lived supervisor accumulates one subscriber connection per task it has
      // ever run. Swallowed, because a failure to unsubscribe from a socket that is
      // already gone must not be the thing that fails a finished session.
      await cancelWatch?.close().catch(() => undefined);
      await steerWatch?.close().catch(() => undefined);
      signal.removeEventListener("abort", stopOnShutdown);
      await leases.release(await heartbeat.current()).catch(() => undefined);
    }
  }

  /**
   * Hand back ONE SLOT when someone is waiting on a brainstorm (DESIGN.md §14.3).
   *
   * **It used to hand back the whole runner, and that is the part slots changed.** The
   * original reasoning was sound while it held: `workTask` drives one task through as many
   * sessions as it needs, the work loop was blocked for all of them, so a task that keeps
   * handing off owned the runner indefinitely — which is how a human typing `/brainstorm`
   * got a thread that opened and then said nothing for twenty minutes and six sessions.
   * With one slot, "give up the slot" and "give up the runner" were the same act, so the
   * bluntness cost nothing.
   *
   * At N slots they are different acts and the difference matters in both directions:
   *
   *   - It is still NEEDED, including at the default N=1. Housekeeping (§6.4) drains the
   *     request, creates the task and answers the thread while this session runs, so the
   *     human is no longer talking to silence — but a brainstorm still cannot be CLAIMED
   *     until a slot frees, and on a saturated runner nothing frees one. Draining without
   *     yielding produces a task that exists and never starts.
   *   - It must no longer fire when a slot is already free. A runner at `concurrency: 4`
   *     with one session running has three slots the very next pass will claim the
   *     brainstorm into; releasing this task as well would cost a session boundary, a state
   *     push and a re-claim to solve a problem that does not exist. So the yield is
   *     conditional on `free() === 0`, and at N=1 that condition is always true — which is
   *     why nothing about a single-slot runner changes.
   *
   * Deliberately NOT an interrupt. `/cancel` aborts a session because the human's whole
   * intent is to stop it; here the session is doing legitimate work, and an interrupted
   * session records nothing at all (§6.4) — so cutting one short to start a conversation
   * would throw away everything it had done since the last boundary. Waiting for the
   * boundary costs the human the tail of one session and costs the task nothing.
   *
   * The check is `some`, not `takeWhere`, precisely because housekeeping owns the serving
   * of it: taking the request to look at it would strand the human it exists for.
   *
   * The task is put back to `ready` rather than left `running`. Both are claimable, but
   * `running` is the crash-recovery path: re-claiming one logs `task.reclaimed` and
   * writes a journal entry about a runner that "stopped without parking or finishing it",
   * which would be a lie told once per brainstorm, in the task's permanent record.
   *
   * The request itself is left in the queue for `applyChatRequests` on the housekeeping
   * loop, which may well have drained it already. This code only gets out of the way.
   */
  private async yieldToBrainstorm(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<boolean> {
    const { inbox, logger, config } = this.deps;
    if (inbox === undefined) return false;
    // A slot is already free, so the next pass claims the brainstorm without anybody
    // giving anything up. Checked BEFORE the queue: `some` may reach the network, and
    // asking a question whose answer cannot change the outcome is a round trip per session
    // boundary on every runner with room.
    if (this.free() > 0) return false;
    if (!(await inbox.some((request) => request.kind === "brainstorm"))) return false;

    logger.info("task.yielded", {
      task: spec.id,
      sessions: state.sessions,
      to: "brainstorm",
      concurrency: config.concurrency,
    });
    await this.unit(async () => {
      await this.transition(lease, state, "ready");
      await this.push(lease, `chore(${spec.id}): released a slot for a waiting brainstorm`);
    });
    return true;
  }

  /**
   * Persist the journal and usage for a finished session.
   *
   * `steering` is journalled here and nowhere else, and this is the only place it can be:
   * writing the state repo needs the lease, the session holds it for its whole run, and this
   * is the first point after the session where the lease is still held and a journal shard is
   * already being written (DESIGN.md §7.3).
   *
   * What ARRIVED is recorded, not what the model read. `shouldStopAfterTurn` exits pi's loop
   * before it polls the steering queue, so a sentence that landed in the same turn as an
   * `ask_human` was queued and never seen — and the journal is what the next session reads,
   * so recording it puts the guidance back in front of the agent. The cost of being wrong
   * that way is one repeated instruction; the cost of the other way is a human's correction
   * disappearing between two sessions.
   */
  private async recordSession(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    outcome: SessionOutcome,
    steering?: SlotSteering,
  ): Promise<TaskState> {
    const { store, config, logger } = this.deps;

    const session = state.sessions + 1;
    const evidence = await this.deps.progress.probe(spec, state);
    const progress = recordProgress(state.progress, session, evidence, outcome.reason);

    // The evidence, not just the resulting streak: a task parked for "no progress" is
    // otherwise indistinguishable from a probe that failed to SEE the progress, which
    // is exactly the bug SMOKE-1 hit and nothing in the logs could have shown.
    logger.info("progress.probe", {
      task: spec.id,
      session,
      committed: evidence.committed,
      acceptanceImproved: evidence.acceptanceImproved,
      stepCompleted: evidence.stepCompleted,
      headOid: evidence.headOid,
      baselineOid: evidence.baselineOid,
      // Distinguishes the fork-point fallback from a recorded head, which is what makes
      // a first-session verdict readable at all.
      firstSession: state.progress.lastHeadOid === undefined,
      // Logged alongside the evidence because it can now change the verdict: an
      // `ask-human` exit leaves the streak alone (`neutralExit`), so a reader comparing
      // the evidence against the streak needs to see why they disagree.
      reason: outcome.reason,
      noProgressStreak: progress.noProgressStreak,
    });

    this.publishNoProgress(spec.id, progress.noProgressStreak);

    const next: TaskState = {
      ...state,
      sessions: session,
      usage: addUsage(state.usage, outcome.usage),
      progress,
      // A PR opened this session must survive into later ones — the completion gate
      // looks it up from state, not from the transcript. Both shapes, for
      // `taskPullRequests`' reason: `prs` is what the gates read and `pr` is what every
      // display reader already reads.
      ...(outcome.pr !== undefined ? { pr: outcome.pr } : {}),
      ...(outcome.prs !== undefined ? { prs: outcome.prs } : {}),
      ...this.forgiveReviewRounds(spec, state, outcome),
    };

    // Three files and a commit as ONE unit — the journal shard, the handoff and the state.
    // This is the unit two slots collided over, and both halves of the fix are needed: the
    // unit stops a sibling session writing INTO this window, and `StateStore.pending` stops
    // its already-written files being staged by this commit. The probe above stays outside:
    // it runs git in the task's own worktree and has nothing to do with the state checkout.
    const steered = steering?.arrived() ?? [];

    await this.unit(async () => {
      await store.appendJournal(
        spec.id,
        session,
        [
          `**Exit:** ${outcome.reason}`,
          `**Context at exit:** ${outcome.contextTokens} tokens`,
          "",
          outcome.summary,
        ].join("\n"),
      );

      // Its own shard, after the exit rather than inside it: the exit summary is the agent's
      // prose about its own session, and a human's instruction filed inside it would read as
      // something the agent decided. Separate entries also survive a `handoff` overwriting
      // `handoff.md`, which is the file the summary above competes with.
      if (steered.length > 0) {
        await store.appendJournal(
          spec.id,
          session,
          [
            `**Steered by the operator** during session ${session}:`,
            "",
            ...steered.map((text) => `> ${text.replace(/\n/g, "\n> ")}`),
          ].join("\n"),
        );
      }

      if (outcome.reason === "handoff" || outcome.reason === "blocked") {
        await store.writeHandoff(spec.id, outcome.summary);
      }

      await store.writeState(next);
      await this.push(lease, `chore(${spec.id}): session ${session} — ${outcome.reason}`);
    });
    // AFTER the push, so a failed commit leaves the guidance to be recorded by the next
    // session rather than dropping it on a write that never landed.
    if (steered.length > 0) {
      logger.info("task.steered-recorded", { task: spec.id, session, messages: steered.length });
      steering?.clearArrived();
    }
    void config;
    return next;
  }

  /**
   * Clear the council's round count when a human commented on the pull request (§7.3, §12.1).
   *
   * The same departure typed guidance makes, for the same surface-independent reason: the cap
   * exists to detect a loop with nothing new entering it, and a human objection is precisely
   * something new. Left unforgiven, a task already at the cap parks on the very next
   * rejection — so the objection is never tested, and the human concludes, correctly, that
   * commenting on the pull request had no effect.
   *
   * Written HERE rather than in `convene` because of the ordering: `recordSession` runs
   * before `applyOutcome`, which is what convenes the council. Forgiven afterwards, the round
   * has already been counted and the task has already parked.
   *
   * The watermark moves whether or not there was anything to forgive, so one comment buys one
   * round rather than a round on every session for the rest of the task's life. `last` and
   * `reason` stay put, exactly as `applyGuidance` leaves them: a human who commented wants to
   * see what they are answering.
   */
  private forgiveReviewRounds(
    spec: TaskSpec,
    state: TaskState,
    outcome: SessionOutcome,
  ): { readonly review?: ReviewRecord } {
    const comment = outcome.reviewComment;
    if (comment === undefined) return {};

    const review = state.review ?? { rounds: 0 };
    if (!isNewerComment(comment, review.commentSeen)) return {};

    this.deps.logger.info("review.rounds-forgiven", {
      task: spec.id,
      rounds: review.rounds,
      commentAt: comment,
    });
    return { review: { ...review, rounds: 0, commentSeen: comment } };
  }

  /**
   * Act on why the session stopped. Returns true when the task is finished with
   * this runner (parked, done, or failed).
   */
  private async applyOutcome(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    outcome: SessionOutcome,
  ): Promise<boolean> {
    const { store, logger } = this.deps;

    switch (outcome.reason) {
      case "handoff":
        // Same task, fresh session. Nothing to notify — Discord stays a signal channel,
        // and nothing to reap: the next session resumes against this exact worktree, which
        // is the entire reason `ensureWorktree` reuses one rather than re-creating it.
        return false;

      case "blocked": {
        // Capability re-routing: release so a runner that can do it picks it up.
        const requires = outcome.requires ?? state.requires;
        await this.unit(async () => {
          await this.transition(lease, { ...state, requires }, "ready");
          await this.push(lease, `chore(${spec.id}): needs ${requires.join(", ")}`);
        });
        return true;
      }

      case "ask-human": {
        const question = outcome.question ?? outcome.summary;
        const index = state.sessions;
        // The question TEXT is deliberately not logged: it is agent-authored prose that
        // can quote anything it read, including a file it should not have. The index
        // locates it in `tasks/<id>/questions/` for anyone who needs it.
        // No reap. `awaiting-human` is the clearest case in the whole switch: the session
        // that answers this question is the same task on the same branch, and it will be
        // claimed by this runner as often as not. Deleting the checkout while a human
        // types would buy disk for exactly as long as it takes them to answer.
        logger.info("task.awaiting-human", { task: spec.id, questionIndex: index });
        await this.unit(async () => {
          await store.writeQuestion(spec.id, index, question);
          await this.transition(lease, state, "awaiting-human");
          await this.push(lease, `chore(${spec.id}): awaiting human input`);
        });
        // OUTSIDE the unit, both of them. The tracker and Discord are views, git is
        // authoritative, and holding the state checkout across a network round trip to
        // either would block every other slot's writes on an unrelated service.
        await this.mirror(spec, { kind: "question", question });
        await this.notifyTask(state, { kind: "question", task: spec.id, question, phase: state.phase });
        return true;
      }

      case "done-claimed": {
        const result = await this.deps.verifier.verify(spec, state);
        logger.info("verification.result", {
          task: spec.id,
          session: state.sessions,
          passed: result.passed,
          pending: result.pending === true,
          detail: result.detail,
        });
        if (result.pending === true) {
          // NOT a rejection, and deliberately not journalled as one. The verifier already
          // waited out `limits.ciSettleSeconds` and CI is still running, so there is
          // still nothing an agent could usefully do: the acceptance commands pass and
          // the branch will not change while nobody is working on it.
          //
          // Release the task WITHOUT starting another session on it. Spending one here
          // is what parked BS-...-07 — three sessions that could only wait, each
          // truthfully scored no-progress by §11.1, on work that was already finished.
          // Coming back through a later poll costs nothing and lets the runner do real
          // work in between.
          logger.info("task.awaiting-ci", { task: spec.id, session: state.sessions });
          // One unit, like every other write-then-push in this switch. Without the hold
          // this commit stages the whole writable tree, which at N slots means a sibling
          // session's deliberately-uncommitted `state.json` lands under this task's
          // message and that sibling's own commit finds nothing to record.
          await this.unit(async () => {
            await store.appendJournal(
              spec.id,
              state.sessions,
              `**Completion claim not yet decided — CI is still running.** Acceptance ` +
                `commands passed. No action is needed: the task was released and will be ` +
                `re-checked when CI reports.\n\n${result.detail}`,
            );
            await this.transition(lease, state, "ready");
            await this.push(lease, `chore(${spec.id}): awaiting CI`);
          });
          return true;
        }
        if (!result.passed) {
          // Claim rejected. Back to ready with the failure in the journal, so the
          // next session sees why rather than re-claiming blindly.
          await this.unit(async () => {
            await store.appendJournal(
              spec.id,
              state.sessions,
              `**Completion claim REJECTED by verification:**\n\n${result.detail}`,
            );
            await this.transition(lease, state, "ready");
            await this.push(lease, `chore(${spec.id}): completion claim rejected`);
          });
          return false;
        }

        // The third gate. Runs only once the §12 pair has passed, so the council is
        // never asked to re-litigate whether the tests pass — it reads the change.
        const reviewed = await this.convene(lease, spec, state);
        if (reviewed.decision === "changes") return false;
        // Both finish with this task for now. `stalled` waits for a human; `outage`
        // waits for the provider, with the task already released and the runner cooling.
        if (reviewed.decision === "stalled" || reviewed.decision === "outage") return true;

        // BEFORE the merge, not after. `push` fences, but a merge is irreversible and
        // crosses a system boundary, so fencing it afterwards fences nothing: `convene`
        // takes minutes (§5.1 records 207s), and in that window a lease can go stale, an
        // operator can `/cancel`, and another runner can park the task and push. The
        // council would then return `pass` and this runner would merge a PR for a task
        // the human had already cancelled — with `assertHeld` throwing afterwards, and
        // the throw logged at warn and discarded. §5.1 says every push verifies lease
        // ownership first; a merge deserves the same, first.
        await this.deps.leases.assertHeld(await lease.current());

        const merge = await this.mergeReviewed(spec, reviewed.state);
        await this.unit(async () => {
          await this.transition(lease, reviewed.state, "done");
          await this.push(lease, `chore(${spec.id}): done`);
        });
        // Mirrored only here, after every gate passed and git already says done.
        const prUrl = result.prUrl ?? reviewed.state.pr?.url ?? "(no PR recorded)";
        logger.info("task.done", {
          task: spec.id,
          sessions: reviewed.state.sessions,
          prUrl,
          merged: merge.merged,
        });
        await this.mirror(spec, { kind: "completed", prUrl });
        await this.notifyTask(reviewed.state, {
          kind: "done",
          task: spec.id,
          prUrl,
          note: merge.note,
        });
        // After the task is recorded as done, never before: a maintenance pass that
        // fails must not be able to unmake a completed task.
        await this.maintainPlan(lease, spec, reviewed.state);
        // And last of all, the disk. `done` is the one terminal status nothing comes back
        // from — `/resume` explicitly refuses it, because the work passed every gate and
        // merged — so the checkout has no further reader on this runner or any other.
        // After the push and after the notification, so a reap that somehow fails cannot
        // be what stops a completed task from being recorded as one.
        await this.reapTask(spec, "done");
        return true;
      }

      case "plan-proposed": {
        const plan = outcome.plan;
        if (plan === undefined) {
          // The tool sets both or neither, so this is unreachable. Back to `ready` rather
          // than parking: a session that ended with nothing to act on is a lost session,
          // not a broken task.
          await this.unit(async () => {
            await this.transition(lease, state, "ready");
            await this.push(lease, `chore(${spec.id}): plan session produced nothing`);
          });
          return false;
        }
        return this.applyPlan(lease, spec, state, plan);
      }

      case "limit":
        await this.park(lease, spec, state, outcome.summary);
        return true;

      case "provider-unavailable":
        // Unreachable: `workTask` acts on this BEFORE the session is recorded, because
        // not recording it is the entire point (see `releaseAfterOutage`). Kept so the
        // switch stays exhaustive — a new exit reason with no home here should be a
        // compile error — and harmless if it is ever reached: the task stays claimable.
        await this.transition(lease, state, "ready");
        return true;

      case "interrupted":
        // Also unreachable for the same reason — `workTask` returns on this before
        // recording. Left claimable rather than parked: an interruption says nothing
        // about the task, and parking it would demand a human for a pod restart.
        await this.transition(lease, state, "ready");
        return true;

      case "error":
        logger.error("task.failed", {
          task: spec.id,
          session: state.sessions,
          error: outcome.error ?? outcome.summary,
        });
        await this.unit(async () => {
          await this.transition(lease, state, "failed");
          await this.push(lease, `chore(${spec.id}): failed`);
        });
        await this.notifyTask(state, {
          kind: "failed",
          task: spec.id,
          error: outcome.error ?? outcome.summary,
        });
        // `failed` IS resumable by a human (see `RESUMABLE`), and this still reaps. The
        // difference from a park is what the next session would find: a task that failed
        // did so because a session raised an error the supervisor could not attribute, and
        // the checkout that produced it is as likely to be the cause as the cure — a
        // half-applied patch, a corrupted index, a dependency tree installed against the
        // wrong toolchain. `/resume` on a failed task re-creates the worktree from the
        // mirror and the branch on the remote, which is every byte of the work and none of
        // the wreckage.
        await this.reapTask(spec, "failed");
        return true;
    }
  }

  /**
   * A brainstorm proposed a plan (DESIGN.md §14.3).
   *
   * Reviewed by the council with the plan lenses, then — and only then — cut into real
   * tasks. Returns true when the brainstorm is finished with this runner.
   *
   * Materialisation happens in the SUPERVISOR. The agent proposes local ids and the
   * supervisor assigns the real ones, for the same reason it assigns everything else: a
   * task id is a directory in the state repo, and the thing being audited does not get to
   * name the audit trail.
   */
  private async applyPlan(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    plan: ProposedPlan,
  ): Promise<boolean> {
    const { store, config, council, logger } = this.deps;

    const reviewed =
      council === undefined
        ? { verdict: undefined, usage: EMPTY_USAGE, outage: undefined }
        : await council.reviewPlan(spec, state, plan);

    // Reviewers that never reached the provider have not rejected this plan. Cutting it
    // into tasks on their silence, or recording a rejection they did not make, would
    // both be verdicts nobody reached. The brainstorm is released instead and proposes
    // again once the provider answers — one session's cost, against a permanent record
    // of a decision nobody made (§6.3).
    if (reviewed.outage !== undefined) {
      await this.releaseAfterOutage(lease, spec, state, reviewed.outage, reviewed.usage, "council");
      return true;
    }

    // Both halves of the story: `summary` names who objected, `detail` says to what. They
    // are carried separately all the way to Discord because they survive differently — a
    // long verdict is truncated to fit a message and the one-liner never is.
    const rejection =
      reviewed.verdict?.decision === "changes"
        ? {
            summary: summariseVerdict(reviewed.verdict),
            detail: explainVerdict(reviewed.verdict),
          }
        : undefined;

    // Materialisation validates too — cycles, missing acceptance criteria, unknown
    // capabilities — and a plan the council liked can still be unbuildable. Both refusals
    // come back the same way, so the agent has one thing to react to. Pure, so it is above
    // the unit: nothing it does touches the checkout.
    const cut = rejection === undefined
      ? materialise(plan, {
          parent: spec.id,
          workspace: spec.workspace,
          defaultRepos: spec.repos,
          // The plan is the agent's own text. Without this a session could hand its
          // successor a credential for any repo it named (§9.1).
          scope: this.workspaceScope(spec.workspace),
        })
      : ({ kind: "rejected", reason: rejection.detail } as const);

    // A materialisation refusal has no council behind it to summarise, and its `reason` is
    // already a full sentence naming the offending child. So the headline states the
    // category and the reason itself carries the specifics — the alternative was a header
    // that repeated the body verbatim.
    const headline = rejection?.summary ?? "the plan cannot be built as proposed";

    // Narrowed HERE rather than at the notification below. The unit returns an outcome
    // string, so `outcome === "sent-back"` implies a rejected cut without TypeScript being
    // able to see it — which is how the notification came to send `rejection ?? ""` and
    // post an empty message for every plan refused by materialisation.
    const objections = cut.kind === "rejected" ? cut.reason : undefined;

    const rounds = (state.review?.rounds ?? 0) + (cut.kind === "rejected" ? 1 : 0);
    const next: TaskState = {
      ...state,
      usage: addUsage(state.usage, reviewed.usage),
      review: {
        rounds,
        last: cut.kind === "rejected" ? "changes" : "pass",
        // The reason lands in `state.json` and so in the snapshot, which is the only copy
        // `/task` can reach: the verdict file needs a clone and the journal needs a clone
        // (§snapshot). Cleared on acceptance so a passing task does not keep quoting the
        // objection it has already answered.
        ...(cut.kind === "rejected" ? { reason: recordedReason(cut.reason) } : {}),
        // Carried forward, unlike everything else here. It is not a fact about this round:
        // it records which review comment has already been forgiven a round, and dropping
        // it would let the same comment forgive one again on the next session (§7.3).
        ...(state.review?.commentSeen === undefined
          ? {}
          : { commentSeen: state.review.commentSeen }),
      },
    };

    // A whole plan's worth of writes as ONE unit — see `unit`, and this is the largest one
    // in the loop: a verdict, a journal entry, the brainstorm's own state, and then a
    // `state.json` and a `spec.md` PER CHILD TASK. Split across two commits by a sibling
    // slot's `git add -A tasks`, half a plan would land in a commit belonging to another
    // task, and the wave that half describes would be claimable with no spec to read.
    const outcome = await this.unit(async () => {
      if (reviewed.verdict !== undefined) {
        const text = renderVerdict(reviewed.verdict);
        await store.writeVerdict(spec.id, state.sessions, text);
        await store.appendJournal(spec.id, state.sessions, text);
      }

      await store.writeState(next);

      if (cut.kind === "rejected") {
        await store.appendJournal(
          spec.id,
          state.sessions,
          `**The plan was not accepted:**\n\n${cut.reason}`,
        );

        if (rounds >= config.limits.maxReviewRounds) {
          logger.warn("plan.stalled", { task: spec.id, rounds, summary: headline });
          // The headline, not the objections: `park` puts its reason in a log field, a
          // tracker comment and a journal entry, and the journal already has the objections
          // in full from the append above. The notification is where the detail belongs —
          // hence the override, which is also what keeps a brainstorm from being offered a
          // Merge button for a pull request it never opened.
          await this.park(
            lease,
            spec,
            next,
            `the plan was sent back ${rounds} times — ${headline}`,
            { kind: "plan-stalled", task: spec.id, rounds, summary: headline, detail: cut.reason },
          );
          return "parked" as const;
        }

        await this.transition(lease, next, "ready");
        await this.push(lease, `chore(${spec.id}): plan sent back`);
        return "sent-back" as const;
      }

      for (const child of cut.tasks) {
        // ORDER IS LOAD-BEARING, exactly as at intake: state first, spec last. `hasTask`
        // keys on `spec.md`, so a crash between the two leaves a task the claim loop skips
        // and the next pass can recreate cleanly.
        await store.writeState({
          id: child.spec.id,
          status: "ready",
          phase: "planning",
          requires: child.spec.requires,
          sessions: 0,
          limits: { maxSessions: config.limits.maxSessionsPerTask },
          usage: EMPTY_USAGE,
          progress: { lastProgressSession: 0, noProgressStreak: 0 },
          plan: child.plan,
          ...(next.chat === undefined ? {} : { chat: next.chat }),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await store.writeSpec(child.spec);
      }

      await store.appendJournal(
        spec.id,
        state.sessions,
        [
          `**Plan accepted: ${plan.title}**`,
          "",
          ...cut.tasks.map((c) => `- \`${c.spec.id}\` — wave ${c.plan.wave}`),
        ].join("\n"),
      );
      await this.transition(lease, next, "done");
      await this.push(lease, `chore(${spec.id}): plan cut into ${cut.tasks.length} task(s)`);
      return "cut" as const;
    });

    if (outcome === "parked") return true;
    if (outcome === "sent-back") {
      await this.notifyTask(next, {
        kind: "verdict",
        task: spec.id,
        summary: headline,
        detail: objections ?? headline,
      });
      return false;
    }
    if (cut.kind === "rejected") return false;

    logger.info("plan.materialised", {
      task: spec.id,
      tasks: cut.tasks.length,
      waves: Math.max(...cut.tasks.map((c) => c.plan.wave)) + 1,
    });
    await this.notifyTask(next, {
      kind: "plan-ready",
      task: spec.id,
      title: plan.title,
      tasks: cut.tasks.map((c) => ({ id: c.spec.id, wave: c.plan.wave })),
    });
    return true;
  }

  /**
   * Convene the review council (DESIGN.md §12.1).
   *
   * `pass` when no council is configured: this is the third gate, not a replacement for
   * the first two, and a runner without one behaves exactly as it did before.
   *
   * The verdict is written and pushed BEFORE anything acts on it. A council that decided
   * and then lost the pod would otherwise cost its whole spend and be re-run from
   * scratch, and the next session would never learn what it had said.
   */
  private async convene(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{
    readonly state: TaskState;
    readonly decision: "pass" | "changes" | "stalled" | "outage";
  }> {
    const { council, store, config, metrics, logger } = this.deps;
    if (council === undefined) return { state, decision: "pass" };

    const { verdict, usage, outage } = await council.review(spec, state);

    // Reviewers that could not reach the provider have not reviewed anything, and a
    // verdict is a permanent document. Written now it would say "could not complete
    // this review" three times over, in the file the next session reads as its
    // instructions. So nothing is recorded and the council is convened again later.
    if (outage !== undefined) {
      await this.releaseAfterOutage(lease, spec, state, outage, usage, "council");
      return { state, decision: "outage" };
    }

    const text = renderVerdict(verdict);
    const rounds = (state.review?.rounds ?? 0) + (verdict.decision === "changes" ? 1 : 0);

    const summary = summariseVerdict(verdict);
    const detail = explainVerdict(verdict);

    const next: TaskState = {
      ...state,
      // The council's own tokens belong to the task that convened it, or a reviewed
      // task looks cheaper than it was and the cost of reviewing is invisible.
      usage: addUsage(state.usage, usage),
      review: {
        rounds,
        last: verdict.decision,
        // See `applyPlan`: the objections have to be in state to be reachable from `/task`.
        ...(verdict.decision === "changes" ? { reason: recordedReason(detail) } : {}),
        // See `applyPlan` again: the review-comment watermark is not a fact about this
        // round and must survive it, or the same comment forgives a round twice (§7.3).
        ...(state.review?.commentSeen === undefined
          ? {}
          : { commentSeen: state.review.commentSeen }),
      },
    };

    // The verdict, the journal entry, the state and whichever push follows, as one unit —
    // see `unit`. The council REVIEW is deliberately above it: that takes minutes (§5.1
    // records 207s), and holding the state checkout across one would stop every other slot
    // writing and stop housekeeping pulling for the whole of it.
    //
    // `park` below is itself a unit and nests harmlessly: `StateStore.exclusive` recognises
    // the async context already holding the lock, so the inner acquisition runs immediately
    // rather than deadlocking on this one.
    const stalled = await this.unit(async () => {
      await store.writeVerdict(spec.id, state.sessions, text);
      await store.appendJournal(spec.id, state.sessions, text);
      await store.writeState(next);
      metrics.council.inc({ task: spec.id, decision: verdict.decision });

      if (verdict.decision === "pass") {
        await this.push(lease, `chore(${spec.id}): review council passed`);
        return false;
      }

      if (rounds >= config.limits.maxReviewRounds) {
        // The council and the agent are not converging. Parking beats a fourth attempt:
        // from outside, a task trading itself back and forth looks identical to one that
        // is working.
        logger.warn("council.stalled", { task: spec.id, rounds, summary });
        // One line, for the same reason as `applyPlan`'s park: the verdict is already in
        // the journal in full, and `park`'s reason is also a log field and a tracker
        // comment. The objections travel on the notification instead.
        await this.park(
          lease,
          spec,
          next,
          `review council requested changes ${rounds} times — ${summary}`,
          {
            kind: "review-stalled",
            task: spec.id,
            rounds,
            summary,
            detail,
            ...(next.pr === undefined ? {} : { prUrl: next.pr.url }),
            canMerge: this.deps.reviewers?.get(spec.workspace) !== undefined,
          },
        );
        return true;
      }

      await this.transition(lease, next, "ready");
      await this.push(lease, `chore(${spec.id}): review council requested changes`);
      return false;
    });

    if (verdict.decision === "pass") return { state: next, decision: "pass" };
    if (stalled) return { state: next, decision: "stalled" };

    await this.notifyTask(next, {
      kind: "verdict",
      task: spec.id,
      summary,
      detail,
      ...(next.pr === undefined ? {} : { prUrl: next.pr.url }),
    });
    return { state: next, decision: "changes" };
  }

  /**
   * Re-check a plan's dependency graph after one of its tasks finishes (§14.3).
   *
   * Runs only for a task that belongs to a plan, and never throws: the task is already
   * `done` and pushed by this point, and a maintenance pass is an improvement to the
   * schedule, not a gate on the work.
   *
   * Every guard lives HERE rather than in the prompt. The maintainer can propose edges
   * between any ids it likes; what actually gets applied is filtered down to siblings of
   * the same plan that have not started, and the whole revision is dropped if the result
   * would contain a cycle.
   */
  private async maintainPlan(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<void> {
    const { maintainer, store, logger } = this.deps;
    const membership = state.plan;
    if (maintainer === undefined || membership === undefined) return;

    try {
      const records = await this.planRecords(membership.parent, spec.id);
      const open = records.filter((r) => r.state.status === "ready" || r.state.status === "parked");
      if (open.length === 0) return;

      const siblings: PlanSibling[] = [];
      for (const record of open) {
        const siblingSpec = await store.readSpec(record.id).catch(() => undefined);
        if (siblingSpec === undefined) continue;
        siblings.push({
          id: record.id,
          status: record.state.status,
          wave: record.state.plan?.wave ?? 0,
          blockedBy: record.state.plan?.blockedBy ?? [],
          goal: siblingSpec.goal,
        });
      }

      const { revision } = await maintainer.revise(spec, state, siblings);
      if (revision === undefined) return;

      // The revision rewrites a `state.json` PER SIBLING and then commits, so it is one
      // unit — see `unit`. A partial one is worse than none: waves are recomputed across
      // the whole graph (`relayer`), so half of them landing in a sibling slot's commit
      // leaves the plan describing a schedule nobody proposed. The maintainer's own model
      // call stays above it.
      const changed = await this.unit(async () => {
        const applied = await this.applyRevision(membership.parent, records, revision, open);
        if (applied === 0) return 0;
        await this.push(lease, `chore(${membership.parent}): plan graph revised`);
        return applied;
      });
      if (changed === 0) {
        logger.info("plan.unchanged", { plan: membership.parent, note: revision.note });
        return;
      }

      await this.notifyTask(state, {
        kind: "plan-revised",
        task: membership.parent,
        changed,
        note: revision.note,
      });
    } catch (error) {
      logger.warn("plan.maintain-failed", { task: spec.id, ...errorFields(error) });
    }
  }

  /** Every task belonging to `parent`, optionally excluding one. */
  private async planRecords(
    parent: TaskId,
    exclude?: TaskId,
  ): Promise<readonly TaskRecord[]> {
    const { store } = this.deps;
    const records: TaskRecord[] = [];

    for (const id of await store.listTasks()) {
      if (id === exclude) continue;
      const state = await store.readState(id).catch(() => undefined);
      if (state?.plan?.parent !== parent) continue;
      records.push({ id, state });
    }
    return records;
  }

  /**
   * Apply a proposed revision, filtered to what it is allowed to touch.
   *
   * Returns how many tasks actually changed. A revision that would introduce a cycle is
   * discarded WHOLE rather than partially: applying the half that happens to be acyclic
   * would leave a graph nobody proposed and nobody reviewed.
   */
  private async applyRevision(
    parent: TaskId,
    records: readonly TaskRecord[],
    revision: PlanRevision,
    open: readonly TaskRecord[],
  ): Promise<number> {
    const { store, logger } = this.deps;

    const openIds = new Set(open.map((r) => r.id));
    const inPlan = new Set(records.map((r) => r.id));
    const edges = new Map<TaskId, readonly TaskId[]>(
      records.map((r) => [r.id, r.state.plan?.blockedBy ?? []]),
    );

    let changed = 0;
    for (const update of revision.updates) {
      const task = asTaskId(update.task);
      // A task that has already started, or is not part of this plan at all, is not the
      // maintainer's to reschedule.
      if (!openIds.has(task)) {
        logger.info("plan.revision-ignored", { plan: parent, task: update.task });
        continue;
      }

      const blockers = update.blockedBy
        .map((id) => asTaskId(id))
        .filter((id) => inPlan.has(id) && id !== task);
      const current = edges.get(task) ?? [];
      if (blockers.length === current.length && blockers.every((id) => current.includes(id))) {
        continue;
      }

      edges.set(task, blockers);
      changed += 1;
    }

    if (changed === 0) return 0;

    const graph = [...edges].map(([id, blockedBy]) => ({ id, blockedBy }));
    if (layer(graph.map((g) => ({ localId: g.id, dependsOn: [...g.blockedBy] }))).kind === "cycle") {
      logger.warn("plan.revision-cyclic", { plan: parent });
      return 0;
    }

    const waves = relayer(graph);
    for (const record of records) {
      const blockedBy = edges.get(record.id) ?? [];
      await store.writeState({
        ...record.state,
        plan: {
          parent,
          wave: waves.get(record.id) ?? 0,
          blockedBy,
        },
      });
    }
    return changed;
  }

  /**
   * Approve and merge, through the REVIEWER identity (DESIGN.md §12.1).
   *
   * Never throws, and never fails the task. By this point every gate has passed and git
   * already records the work as complete; a forge that refuses the merge is the same
   * class of problem as a tracker that refuses a comment (README invariant 6). The
   * outcome is reported instead, in the message that announces the task is done.
   *
   * Without a reviewer identity this does nothing at all. The primary App authored the
   * PR, and GitHub will not let an author approve their own — so a merge attempt from it
   * is refused by the very branch protection that makes review meaningful (§9.1).
   */
  private async mergeReviewed(
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{ readonly merged: boolean; readonly note: string }> {
    const { reviewers, logger } = this.deps;

    const prs = taskPullRequests(spec.repos, state);
    if (prs.length === 0) {
      return { merged: false, note: "No PR was recorded, so nothing was merged." };
    }

    const factory = reviewers?.get(spec.workspace);
    if (factory === undefined) {
      return { merged: false, note: "No reviewer identity is configured — merging is yours." };
    }

    const forge = await factory.forTask(spec);
    const inOrder = ordered(spec.repos, prs);
    const landed: LandedPullRequest[] = [];
    try {
      // IN `spec.repos` ORDER, and stopping at the first failure. The order is the one the
      // human typed and the one §14.3 already treats as meaningful — `repos[0]` is the working
      // directory — and it is the closest thing to a dependency order this has. Continuing past
      // a failure would land a later repo whose counterpart did not land, which for the change
      // that motivated this (`viewer_public` read by an extension before the gateway sends it)
      // is exactly the broken intermediate state the split was arranged to avoid.
      for (const pr of inOrder) {
        const outcome = await this.landOne(forge, spec, pr);
        landed.push({ slug: repoSlug(pr.repo), pr: pr.number, outcome });
        // A QUEUED pull request stops the sequence for the same reason a failure does: it
        // has not landed. The queue runs the change's checks against a speculative base and
        // can still reject it, so pushing the sibling onto its default branch now risks
        // exactly the half-landed state the ordering rule exists to prevent — and unlike a
        // failure there is nothing to report as broken, so the remaining pull requests are
        // simply left open for the human the note names them to.
        if (stopsTheSequence(outcome)) break;
      }

      // `landed` is short of `inOrder` exactly when the loop broke on a queued pull
      // request. Naming the ones left open is the difference between "the change is
      // landing" and a human wondering why a sibling repo never moved.
      const untouched = inOrder.slice(landed.length).map((pr) => `${repoSlug(pr.repo)}#${pr.number}`);
      // `prs` is non-empty and the loop always lands its first entry, so `mergeNote` always
      // has something to say. The fallback is a sentence rather than an empty string because
      // this is rendered into Discord, and a blank message says nothing at all.
      const note = mergeNote(landed) ?? "Approved by the review council; nothing to merge.";

      return {
        merged: true,
        note:
          untouched.length === 0
            ? note
            : `${note} ${untouched.join(", ")} ${untouched.length === 1 ? "is" : "are"} not ` +
              `merged yet: the repos of one change land in order, and the one ahead of ` +
              `${untouched.length === 1 ? "it" : "them"} is still in a queue.`,
      };
    } catch (error) {
      logger.warn("pr.merge-failed", {
        task: spec.id,
        landed: landed.map((one) => `${one.slug}#${one.pr}:${one.outcome}`).join(", "),
        ...errorFields(error),
      });
      const reason = error instanceof Error ? error.message : String(error);
      // What DID land is named, always. A partial merge is the one outcome where "could not
      // merge" on its own is actively misleading: some of the change is on the default branch
      // and a human has to know which half before deciding what to do about the rest.
      const done = mergeNote(landed);
      return {
        merged: false,
        note:
          done === undefined
            ? `Could not merge: ${reason}`
            : `${done} Then could not merge the rest: ${reason}. The remaining pull ` +
              `request(s) are open and the change is half-landed.`,
      };
    } finally {
      await forge.revoke().catch(() => undefined);
    }
  }

  /**
   * Approve one pull request, then land it the way its base branch allows.
   *
   * The detection is asked per pull request rather than once per task: a multi-repo task's
   * repos are configured by different people and there is no reason they agree about
   * queues. `mergeQueue` never throws, so a forge that cannot answer takes the direct
   * merge — which is the behaviour that existed before queues were detected at all.
   */
  private async landOne(
    forge: Forge,
    spec: TaskSpec,
    pr: TaskPullRequest,
  ): Promise<MergeOutcome> {
    const { logger } = this.deps;

    await forge.approve(pr.repo, pr.number, "Approved by the caterpillar review council.");

    const support = await forge.mergeQueue(pr.repo, pr.number);
    const fields = { task: spec.id, repo: repoSlug(pr.repo), pr: pr.number };
    if (support === "unknown") {
      // Logged rather than swallowed silently: the merge still happens, and if a
      // queue-protected repo starts refusing merges this line is where the reason is.
      logger.info("pr.merge-queue-unknown", fields);
    }

    if (landingFor(support) === "enqueue") {
      await forge.enqueue(pr.repo, pr.number);
      logger.info("pr.enqueued", fields);
      return "queued";
    }

    await forge.merge(pr.repo, pr.number);
    logger.info("pr.merged", fields);
    return "merged";
  }

  /**
   * The model provider stopped answering. See DESIGN.md §6.3.
   *
   * Everything here is about NOT holding the task responsible for it:
   *
   *   - the task goes back to `ready`, not `parked` and not `failed`. It did nothing
   *     wrong, and a park needs a human to undo — an account limit that clears by
   *     itself would otherwise leave a queue of tasks needing hand-resumption.
   *   - the progress probe does not run and `progress` is not touched. The no-progress
   *     detector answers "is the AGENT going in circles", and feeding an outage into it
   *     is how a spend limit came to park a task for "no measurable progress".
   *   - a session that never got a token back writes no history: no journal entry, no
   *     session count. It cost nothing and proves nothing, and one entry per attempt is
   *     precisely the retry-storm spam `agent/journal.ts` exists to bound.
   *   - a session that DID work before the wall is recorded in full, minus the probe.
   *     Its tokens were spent and its commits are on the branch; pretending otherwise
   *     would lose the accounting and re-run the work.
   *   - the release itself is always pushed, even when there is nothing else to say.
   *     Only `ready` is claimable, and every task past its first session was last
   *     pushed as `running`.
   *
   * The runner then stops claiming until the cooldown expires, which is the part that
   * turns one refused request into a pause instead of a sweep through the whole queue.
   *
   * **And it fans the outage out to every OTHER slot** (`fanOutOutage`), which is the half
   * slots added. The cooldown was always runner-scoped — an account limit is a property of
   * the account, not of the task that happened to trip it — but with one slot "stop
   * claiming" and "let go of what you hold" were the same sentence. With N they are not,
   * and releasing only the slot that met the wall would leave N-1 sessions hammering the
   * same refused endpoint until each met it separately: N journal entries, N cooldown
   * records extending the back-off geometrically, and the stampede the cooldown exists to
   * prevent, arriving one task at a time.
   */
  private async releaseAfterOutage(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    outage: ProviderOutage,
    /** Tokens already spent before the wall. Charged to the task either way. */
    spent: UsageTotals,
    /** Which LLM caller met the wall — a session has a journal, the council does not. */
    origin: "session" | "council",
  ): Promise<void> {
    const { store, config, metrics, logger } = this.deps;

    const entry = this.cooldown.record(Date.now(), outage);
    const waitSeconds = Math.ceil(entry.waitMs / 1000);

    // BEFORE this task's own release, and deliberately: the release below writes the state
    // repo and reaches Discord, so it takes seconds during which the other sessions are
    // still spending requests against a provider that has already refused one. Signalling
    // first costs nothing — the fan-out is synchronous and only sets flags and aborts — and
    // each of those sessions then unwinds through this same function on its own.
    this.fanOutOutage(spec.id, outage);

    metrics.providerOutages.inc({ kind: outage.kind });
    metrics.providerCooldown.set({ runner: config.runnerId }, waitSeconds);
    logger.warn("provider.unavailable", {
      task: spec.id,
      during: origin,
      kind: outage.kind,
      status: outage.status,
      detail: outage.detail,
      waitSeconds,
      // Distinguishes a session cut off mid-work from one that never started — the
      // difference between a session worth recording and one that did not happen.
      outputTokens: spent.outputTokens,
    });

    // A session that got a token back happened; one that did not, did not.
    const counts = origin === "session" && spent.outputTokens > 0;

    const released: TaskState = {
      ...state,
      ...(counts ? { sessions: state.sessions + 1 } : {}),
      usage: addUsage(state.usage, spent),
    };

    // One unit, and here it matters more than anywhere else: the fan-out sends every other
    // in-flight task down this same path within milliseconds, so this is the one write
    // sequence N slots are GUARANTEED to attempt simultaneously rather than merely likely
    // to. Without the unit, four tasks released by one spend limit would produce one commit
    // carrying four `state.json` files under one task's message, and three tasks whose
    // release was never recorded — left `running`, which no human hears about.
    await this.unit(async () => {
      if (counts) {
        await store.appendJournal(
          spec.id,
          state.sessions + 1,
          [
            `**Interrupted:** ${outage.detail}`,
            "",
            "The model provider stopped answering mid-session. Nothing about this task " +
              "caused it and nothing here is a verdict on the work; the next session " +
              "picks up from the branch as usual.",
          ].join("\n"),
        );
      }

      // ALWAYS pushed, even when nothing else changed. Only `ready` is claimable, and a
      // task last pushed as `running` — which is every task past its first session — would
      // otherwise be stranded there by an outage no human is going to hear about in time.
      await this.transition(lease, released, "ready");
      await this.push(lease, `chore(${spec.id}): released — the provider stopped answering`);
    });

    // Once per incident. The runner re-checks on a back-off, and a message per attempt
    // would be this failure mode wearing a different hat.
    //
    // `entry.first` is what keeps that true across slots as well as across attempts: the
    // fan-out sends N-1 more tasks through this function within seconds, and every one of
    // them finds the streak already non-zero. So four concurrent tasks meeting one spend
    // limit produce one Discord message, not four.
    if (entry.first) {
      await this.notifyTask(state, {
        kind: "provider-unavailable",
        task: spec.id,
        detail: outage.detail,
        retryInSeconds: waitSeconds,
      });
    }
  }

  /**
   * Tell every OTHER in-flight task that the provider has stopped answering (§6.3).
   *
   * Synchronous, and does nothing but set a flag and abort: it is called from inside one
   * task's release path, and a fan-out that awaited anything would let the other sessions
   * spend more requests while it did so — or, worse, fail and leave them running with the
   * outage already recorded.
   *
   * It does NOT release the other tasks itself, and that boundary is the point. Releasing
   * task B means writing B's state and pushing under B's lease, and doing that from inside
   * A's stack is exactly the cross-task coupling slots are supposed to remove: a push that
   * failed for B would surface as A's failure, and A's `catch` would park A. So each slot
   * is interrupted and unwinds through its OWN `releaseAfterOutage`, under its own lease,
   * with its own error handling.
   *
   * At `concurrency: 1` this always has nothing to do — there is no other slot — which is
   * why a single-task runner behaves exactly as it did before.
   */
  private fanOutOutage(met: TaskId, outage: ProviderOutage): void {
    const { logger } = this.deps;

    for (const slot of this.slots.values()) {
      if (slot.id === met) continue;
      // Already told. A second abort is harmless, but a second log line would make one
      // incident look like several.
      if (slot.outage !== undefined) continue;

      logger.warn("provider.fanned-out", { task: slot.id, from: met, kind: outage.kind });
      slot.outage = outage;
      slot.interrupt.abort();
    }
  }

  /**
   * The configured bound on the repos a workspace's credential may reach (§9.1).
   *
   * Throws for an unconfigured workspace rather than returning a permissive default: a
   * scope that cannot be resolved must not become a scope that allows everything.
   */
  private workspaceScope(workspace: WorkspaceName): WorkspaceScope {
    const profile = this.deps.config.workspaces.get(workspace);
    if (profile === undefined) {
      throw new Error(`no workspace profile configured for '${workspace}'`);
    }
    return workspaceScopeOf(profile, stateRepoRef(this.deps.config.stateRepo));
  }

  /**
   * The repos this workspace cannot reach, as one sentence — or undefined when it can
   * reach them all, and also when nobody could be asked.
   *
   * Those two are deliberately the same answer. A forge that throws has told us nothing
   * about an installation: `/installation/repositories` behind a 500, a DNS blip, an
   * expired key. Reading that as "unreachable" would refuse a `/brainstorm` or park a task
   * over a hiccup, which is strictly worse than the mid-session clone failure this exists
   * to pre-empt — that failure is at least self-explanatory now (`explainUnprocessable`).
   *
   * So: a refusal only ever comes from a forge that answered.
   */
  private async unreachableRepos(
    workspace: WorkspaceName,
    repos: readonly RepoRef[],
  ): Promise<string | undefined> {
    const reach = this.deps.forges?.get(workspace);
    if (reach === undefined) return undefined;

    try {
      const unreachable = await reach.unreachable(repos);
      return unreachable.length === 0 ? undefined : unreachableSummary(unreachable);
    } catch (error) {
      this.deps.logger.warn("repo.reach-unknown", { workspace, ...errorFields(error) });
      return undefined;
    }
  }

  /**
   * Park a task and tell whoever needs to know.
   *
   * Deliberately does NOT reap the worktree, and this is the boundary the reaping rules
   * turn on. `parked` is terminal in the sense that nothing moves the task without a
   * human, but it is resumable IN PLACE: `/resume` puts it back to `ready` and the next
   * session claims the same branch in the same directory. Every park has a human in its
   * future — a question to answer, a limit to raise, a decision to make — and throwing
   * the checkout away would charge that human's answer a full clone and a full dependency
   * install for a directory that was going to be used within the day.
   *
   * The sweep is what covers the park nobody ever answers. `workspace.reap.keepHours`
   * outlives a weekend by design, and a task parked longer than that has stopped being a
   * question anyone is about to answer.
   */
  private async park(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    reason: string,
    /** Overrides the default park notification when a park has a more specific story. */
    notification?: Notification,
  ): Promise<void> {
    const { store, logger } = this.deps;
    logger.warn("task.parked", { task: spec.id, sessions: state.sessions, reason });
    // Journal, state and commit as one unit — see `unit`. The tracker and the notification
    // stay outside it: both are views of what git already says, and holding the state
    // checkout across a Discord round trip would stall every other slot's writes.
    await this.unit(async () => {
      await store.appendJournal(spec.id, state.sessions, `**Parked:** ${reason}`);
      await this.transition(lease, state, "parked");
      await this.push(lease, `chore(${spec.id}): parked`);
    });
    await this.mirror(spec, { kind: "parked", reason });
    // `notifyTask`, not `notify`. This was the ONE task-scoped notification that dropped the
    // thread, and it was the one that could least afford to: every other outcome of a review
    // round reaches the thread through `notifyTask`, so a plan sent back for the third time
    // appeared in the thread and the park that ENDED it appeared in the channel — read from
    // the thread, the conversation simply stopped. Worse, `plan-stalled`'s own prose says
    // "say what to change — here in this thread — then `/resume`", and it was being posted
    // somewhere that is not the thread. The class of bug is the argument for routing by task
    // rather than by call site; `park` is the last call site that did not.
    await this.notifyTask(state, notification ?? { kind: "parked", task: spec.id, reason });
  }

  /**
   * Park a task whose session raised an error the supervisor cannot attribute.
   *
   * Best-effort by design: if parking ITSELF fails — an unreachable state repo, a lost
   * network — this logs and returns rather than throwing. Propagating here would exit
   * the process and reintroduce exactly the crash loop it exists to prevent.
   *
   * It reaps nothing, because it parks: see `park` for why a park keeps its checkout. The
   * most common reason to reach here is a toolchain that would not build, and the human
   * who fixes the flake wants the very next session to be a resolve and not a re-clone.
   */
  private async parkFailed(lease: LeaseHandle, spec: TaskSpec, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    // A toolchain that would not materialise is named for what it is. "session failed" is
    // wrong and misleading here — no session ran, and the fix is a nix expression or a
    // runner, not anything the agent could have done differently (DESIGN.md §8.1).
    const detail =
      error instanceof ToolchainError
        ? `the dev environment (${error.source}) could not be prepared: ${reason}`
        : `session failed: ${reason}`;

    try {
      const state = await this.deps.store.readState(spec.id);
      await this.park(lease, spec, state, detail);
    } catch (parkError) {
      this.deps.logger.error("task.park-failed", {
        task: spec.id,
        originalError: reason,
        ...errorFields(parkError),
      });
    }
  }

  /**
   * Apply requests submitted by the inbound bridge (DESIGN.md §7).
   *
   * Runs on the HOUSEKEEPING loop, which is independent of whether a session is in flight
   * — that is the point of the split (§6.4). It used to run on the one poll loop, which
   * was blocked for the whole of every session, so a `/resume` or an `/answer` submitted
   * at the start of a four-hour task sat unread for four hours.
   *
   * It still runs on exactly ONE thread of control, and it must: it writes the state repo,
   * and a websocket handler doing the same thing concurrently would interleave git
   * invocations in one working copy. What changed is which loop that thread belongs to,
   * not that there is one. `StateStore`'s mutex is what keeps it honest against the work
   * loop's writes.
   *
   * Each request is settled with what actually happened, so the human who typed or clicked
   * it gets told rather than guessing from silence.
   */
  private async applyChatRequests(): Promise<void> {
    const { logger, inbox } = this.deps;
    if (inbox === undefined) return;

    // A `/cancel` for a task this runner is running right now must not reach `applyPark`:
    // parking claims the lease, the session is holding it, and the human would be told
    // "not-parkable: running" about a task this very process is running. Only in-session
    // code can stop a session. There are two ways to keep that request away from
    // `applyPark`, and which one applies depends on the queue.
    //
    // **A membership test over the slots, not a comparison against one id.** This was
    // `request.task === this.inFlightTask`, which at N slots would have answered "not
    // mine" for every session but one — so a cancel for task A while B was also running
    // went to `applyPark`, failed its CAS against A's own live lease, and told the human
    // "not-parkable: running" about the exact task they were watching this process work.
    const isMyCancel = (request: ChatRequest): boolean =>
      request.kind === "park" && this.slots.has(request.task);

    // Whether ANY of my tasks could be the subject of a cancel in this drain. The
    // selective path costs a `takeWhere` with a predicate, and with no slots open there is
    // nothing for it to exclude.
    const mine = this.slots.size > 0;

    // LEAVE IT QUEUED, when the queue can take selectively: the `CANCEL_POLL_MS` watcher
    // inside the session picks it up on its own tighter interval.
    //
    // DRAIN IT AND ROUTE IT HERE otherwise. `ChatDrainer.selective` is `false` for the
    // Redis queue, whose `takeWhere` returns empty unconditionally — using it there would
    // drain nothing at all for the whole of a session, which is the exact defect the
    // housekeeping split exists to remove, and would additionally strand the cancel,
    // since the in-session watcher polls that same empty `takeWhere`. So on a
    // non-selective queue the drain takes everything and the slot's own `cancel` hook stops
    // that one session directly. See `redis/inbox.ts`.
    const taken =
      mine && inbox.selective
        ? await inbox.takeWhere((request) => !isMyCancel(request))
        : await inbox.drain();

    for (const request of taken) {
      try {
        // Off the list already, so it cannot be handed back to the watcher. Settled
        // `cancelling` rather than `parked` for the watcher's reason: the session unwinds
        // at a turn boundary and the park lands after that.
        //
        // Routed to the ONE slot the request names. That is what makes a cancel targeted
        // rather than a broadcast: `slot.cancel` aborts that slot's own controller, and no
        // other slot shares it.
        const cancelling = request.kind === "park" ? this.slots.get(request.task) : undefined;
        if (cancelling !== undefined) {
          logger.info("chat.cancel-routed", { task: cancelling.id });
          cancelling.cancel();
          request.settle({ kind: "cancelling" });
          continue;
        }
        request.settle(await this.applyChatRequest(request));
      } catch (error) {
        // Never fatal: a state repo that rejects one request must not stop the runner
        // from working every other task.
        logger.error("chat.failed", {
          kind: request.kind,
          ...(request.kind === "brainstorm" ? {} : { task: request.task }),
          ...errorFields(error),
        });
        request.settle({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private applyChatRequest(request: ChatRequest): Promise<ChatOutcome> {
    switch (request.kind) {
      case "answer":
        return this.applyAnswer(request);
      case "park":
        return this.applyPark(request);
      case "resume":
        return this.applyResume(request);
      case "merge":
        return this.applyMerge(request);
      case "brainstorm":
        return this.applyBrainstorm(request);
    }
  }

  /**
   * Create a brainstorm task from a `/brainstorm` (DESIGN.md §14.3).
   *
   * No lease is taken. The task does not exist yet, so there is nothing to lease and
   * nothing for another runner to be halfway through — the write is a creation, and the
   * id is unique by construction because it comes from a Discord thread id. It is
   * `commitAndPush` rather than `push` for exactly that reason: `assertHeld` has no lease
   * to check.
   */
  private async applyBrainstorm(
    request: ChatRequest & { readonly kind: "brainstorm" },
  ): Promise<ChatOutcome> {
    const { store, config, logger } = this.deps;

    const repos: RepoRef[] = [];
    for (const raw of request.repos) {
      const repo = parseRepo(raw);
      if (repo === undefined) {
        return { kind: "refused", reason: `\`${raw}\` is not a repo — use \`owner/name\`.` };
      }
      repos.push(repo);
    }

    // Every repo must land in the SAME workspace. Not a tidiness check: a workspace is one
    // forge, one owner, one credential bundle (§3.1), and a session holding credentials for
    // two of them is precisely the blast radius the workspace model exists to bound (§9.1).
    // A brainstorm that spans two is refused outright rather than narrowed to one, because
    // silently dropping a repo the human asked for produces a plan about half a system.
    const byWorkspace = new Map<WorkspaceName, string[]>();
    let profile: WorkspaceProfile | undefined;
    for (const repo of repos) {
      const owner = resolveWorkspace(config.workspaces, repo);
      if (owner === undefined) {
        return {
          kind: "refused",
          reason:
            `No workspace owns \`${repo.owner}\` on ${repo.host}, and there is more than one ` +
            `configured, so I cannot guess which credentials to use.`,
        };
      }
      profile ??= owner;
      byWorkspace.set(owner.name, [...(byWorkspace.get(owner.name) ?? []), qualifiedSlug(repo)]);
    }

    if (byWorkspace.size > 1) {
      const where = [...byWorkspace]
        .map(([name, slugs]) => `\`${name}\` (${slugs.join(", ")})`)
        .join(" and ");
      return {
        kind: "refused",
        reason:
          `Those repos are in different workspaces: ${where}. A workspace is one credential ` +
          `bundle, and one brainstorm session cannot hold two — run a brainstorm per ` +
          `workspace instead.`,
      };
    }
    // Also the empty-list refusal: `profile` is set by the loop above for every repo that
    // resolved, so undefined here means there were none to resolve. One refusal rather
    // than two, and it cannot drift out of step with the loop that fills it.
    if (profile === undefined) {
      return { kind: "refused", reason: "A brainstorm needs at least one repo to read." };
    }

    const id = brainstormId(request.threadId);
    if (await store.hasTask(id)) return { kind: "started", task: id };

    // The last thing a repo name is checked against, and the only one that involves the
    // forge: can this workspace's credential reach it at all (§9.1.1)? Everything above is
    // shape and configuration, and a name that satisfies both can still be a repo that does
    // not exist — `acme/allchat` for `all-chat` parsed, resolved, became a task,
    // was claimed, and died in `git clone --mirror` a session later.
    //
    // After the idempotency check, not before: a repeated `/brainstorm` in a thread that
    // already has one is answered from the state repo, so it costs no request and cannot be
    // refused after the fact. A task that already exists is the session preflight's problem.
    const unreachable = await this.unreachableRepos(profile.name, repos);
    if (unreachable !== undefined) {
      return {
        kind: "refused",
        reason:
          `${unreachable} Fix the name, or install the App on it, and run \`/brainstorm\` ` +
          `again — nothing has been created.`,
      };
    }

    const spec = brainstormSpec({
      id,
      workspace: profile.name,
      topic: request.topic,
      repos,
      author: request.author,
    });

    const now = new Date().toISOString();
    // One unit — see `unit`. Housekeeping runs on a single thread of control, so this used
    // to have only the work loop's ONE session to race; with N slots it has N, and a state
    // written here with its spec swept into a session's commit is a task the claim loop
    // skips forever (`hasTask` keys on `spec.md`).
    await this.unit(async () => {
      // Same load-bearing order as intake: state first, spec last, because `hasTask` keys
      // on `spec.md` (§14).
      await store.writeState({
        id,
        status: "ready",
        phase: "planning",
        requires: [],
        sessions: 0,
        limits: { maxSessions: config.limits.maxSessionsPerTask },
        usage: EMPTY_USAGE,
        progress: { lastProgressSession: 0, noProgressStreak: 0 },
        chat: { threadId: request.threadId },
        createdAt: now,
        updatedAt: now,
      });
      await store.writeSpec(spec);
      await store.commitAndPush(`chore(${id}): brainstorm started`, "origin", config.stateRepo.branch);
    });

    logger.info("brainstorm.created", {
      task: id,
      workspace: profile.name,
      repos: spec.repos.map(repoSlug).join(", "),
    });
    return { kind: "started", task: id };
  }

  /**
   * Everything a human types at a task, routed by what the task is currently doing.
   *
   * One entry point deliberately: in a task's own thread every message is this request
   * (§7.1), and the bridge has no way to know — and no business knowing — whether the task
   * is mid-session or parked. So the decision is made HERE, where the state is, and there are
   * four answers rather than the two there used to be:
   *
   *   `awaiting-human` with a question open → the answer file, exactly as before.
   *   `running`                             → a steer, delivered to the live session (§7.3).
   *   `ready`/`parked`/`failed`             → guidance, journalled for the next session.
   *   `done`                                → nothing to say to it, and `/resume` refuses it.
   *
   * What this replaced returned `not-waiting` for everything but the first, and the bridge
   * dropped that outcome without a word. The text was READ and then discarded — while a park
   * notification, a verdict notification and `/task` were all telling the human to "say what
   * to change in this thread". Three surfaces documented a path that ended in a `return`.
   */
  private async applyAnswer(request: ChatRequest & { readonly kind: "answer" }): Promise<ChatOutcome> {
    const { store, config, logger } = this.deps;

    const state = await store.tryReadState(request.task);
    if (state === undefined) return { kind: "unknown-task" };

    // Not `isTerminal`: `parked` and `failed` are exactly the statuses guidance exists for.
    // `done` is the one where there is nothing to ask for — it passed every gate and merged,
    // and `/resume` refuses it for the same reason (`RESUMABLE`).
    if (state.status === "done") return { kind: "finished" };

    const pending =
      state.status === "awaiting-human" ? await store.pendingQuestion(request.task) : undefined;

    // Everything that is not an answer to an open question. Note that `awaiting-human` with
    // nothing unanswered lands here rather than being refused: that is a state repo someone
    // edited by hand, and recording the text as guidance loses nothing, where the refusal it
    // replaced lost the human's sentence.
    if (pending === undefined) return this.applyGuidance(request, state);

    // One unit — see `unit`. The answer FILE is the record of the answer (§4.1), and a
    // sibling slot's commit sweeping it up while this one commits nothing is how an answer
    // reported `applied` and was never readable by the session it was written for.
    await this.unit(async () => {
      await store.writeAnswer(request.task, pending.index, request.text);
      await store.appendJournal(
        request.task,
        state.sessions,
        `**Answer from the operator:**\n\n${request.text}`,
      );
      await store.writeState({
        ...state,
        status: "ready",
        // The streak that made the task park is not the next session's fault, and a
        // task resumed at the limit parks again on the very next claim without ever
        // running. Answering IS the progress.
        progress: { ...state.progress, noProgressStreak: 0 },
      });
      await store.commitAndPush(
        `chore(${request.task}): answered question ${pending.index}`,
        "origin",
        config.stateRepo.branch,
      );
    });

    // After the push, like every other observation in this method: a gauge that ran ahead
    // of the state repo would report a forgiveness that never landed.
    this.publishNoProgress(request.task, 0);
    logger.info("answer.applied", { task: request.task, questionIndex: pending.index });
    return { kind: "applied", index: pending.index };
  }

  /**
   * Record what a human said about a task that was not waiting to be asked (DESIGN.md §7.3).
   *
   * The path that did not exist, and whose absence is what made a stalled brainstorm
   * unfixable. BS-1539374658363854934 was sent back 13 times against a cap of 3: the park
   * notification asked for guidance, the guidance was discarded, `/resume` bought exactly one
   * more round, and the same plan was refused by the same lens. Ten times.
   *
   * Two destinations, decided by whether a session is holding the lease:
   *
   * **Running.** Nothing is written here — it CANNOT be, since writing means claiming the
   * lease and the session holds it (`applyPark` has the same constraint for the same reason).
   * The message goes on the steering plane instead. A slot on this runner has its feed
   * reached directly; a session on ANOTHER runner is reached through Redis, and with no Redis
   * there is only one runner so the direct path is the whole mechanism. The journal entry is
   * written later, by that session's own `recordSession`.
   *
   * **Anything else.** The journal, which is what the next session's prompt is built from
   * (`agent/prompt.ts`), plus two counters:
   *
   *   `noProgressStreak` is cleared, for `applyAnswer`'s reason word for word — a task
   *   resumed at the limit parks again on the very next claim having run nothing, so the
   *   command would report success and do nothing.
   *
   *   `review.rounds` is cleared, and this is a DEPARTURE from §12.1, which says the round
   *   budget is not forgiven by a resume. That rule is right for a bare resume and wrong
   *   here, and the distinction is information: the cap exists because the agent and the
   *   council can trade a task forever with nothing new entering the loop, and guidance is
   *   precisely something new entering the loop. Without this the fix does not work — the
   *   next rejection is round 14 against a cap of 3, so the task parks again immediately and
   *   the guidance is never tested. A bare `/resume` still forgives nothing, and `describeOutcome`
   *   says which of the two happened rather than letting a human find out by watching.
   */
  private async applyGuidance(
    request: ChatRequest & { readonly kind: "answer" },
    state: TaskState,
  ): Promise<ChatOutcome> {
    const { store, leases, logger } = this.deps;

    if (state.status === "running") {
      const slot = this.slots.get(request.task);
      if (slot !== undefined) {
        slot.steering.push(request.text);
        logger.info("guidance.steered", { task: request.task, where: "local" });
        return { kind: "steered" };
      }
      // Running somewhere this heap cannot reach. Only the fleet-wide plane can carry it, and
      // `crossesProcesses` is why that is checked rather than assumed: the in-memory inbox
      // accepts every push and would report "sent to the session" for a task on another
      // machine, which is the report-success-and-do-nothing failure this whole path replaced.
      const reachable = this.deps.steering?.crossesProcesses === true;
      const delivered = reachable && (await this.deps.steering?.push(request.task, request.text));
      logger.info("guidance.steered", {
        task: request.task,
        where: "fleet",
        reachable,
        delivered: delivered === true,
      });
      return delivered === true ? { kind: "steered" } : { kind: "not-waiting", status: state.status };
    }

    // Taken for the write and released immediately, exactly as `applyPark` and `applyResume`
    // do: every push verifies lease ownership first (§5.1). Unclaimable means another runner
    // got there first, which for a task the state says is not running means it has just been
    // claimed — so it IS about to read the journal, and steering is the honest answer.
    const lease = await leases.claim(request.task);
    if (lease === undefined) {
      // Another runner got there first, which for a task the state says is not running means it
      // has just been CLAIMED — so it is about to read whatever it is given. The local inbox is
      // enough when the claimant is this process (its `steerWatch` drains what is pending on
      // subscribe); anything else needs the plane, for the reason above.
      const local = this.slots.has(request.task) || this.deps.steering?.crossesProcesses === true;
      const delivered = local && (await this.deps.steering?.push(request.task, request.text));
      return delivered === true ? { kind: "steered" } : { kind: "not-waiting", status: state.status };
    }

    const rounds = state.review?.rounds ?? 0;
    const roundsCleared = rounds > 0;

    try {
      const handle = heldLease(lease);
      await this.unit(async () => {
        await store.appendJournal(
          request.task,
          state.sessions,
          `**Guidance from the operator:**\n\n${request.text}`,
        );
        await store.writeState({
          ...state,
          progress: { ...state.progress, noProgressStreak: 0 },
          // `rounds` only. `last` and `reason` are the record of what the council actually
          // said and stay put — a human who resumes wants to see what they are answering,
          // and `/task` reads both from here.
          ...(state.review === undefined ? {} : { review: { ...state.review, rounds: 0 } }),
        });
        await this.push(handle, `chore(${request.task}): guidance from chat`);
      });
    } finally {
      await leases.release(lease).catch(() => undefined);
    }

    this.publishNoProgress(request.task, 0);
    logger.info("guidance.recorded", {
      task: request.task,
      status: state.status,
      chars: request.text.length,
      reviewRounds: rounds,
    });

    // Counted from the journal rather than remembered, so the number is right after a restart
    // and right when two people are typing. Best-effort: the guidance is already committed,
    // and a reply that says "1" when it was the third costs nothing next to not replying.
    const notes = await this.guidanceCount(request.task);

    return {
      kind: "guided",
      notes,
      resumable: RESUMABLE.includes(state.status),
      roundsCleared,
    };
  }

  /**
   * How many pieces of guidance a task carries, by reading the journal back.
   *
   * One on failure, not zero: the entry this is counting has just been committed, so zero is
   * the one answer that is certainly wrong, and "at least yours" is what a reader needs.
   */
  private async guidanceCount(task: TaskId): Promise<number> {
    try {
      const journal = await this.deps.store.readJournal(task);
      return journal === undefined
        ? 1
        : Math.max(1, journal.split("**Guidance from the operator:**").length - 1);
    } catch {
      return 1;
    }
  }

  /**
   * Park a task on request — `/cancel`.
   *
   * A task running ON THIS RUNNER never reaches here: `workTask` intercepts its own task's
   * park requests while the session is in flight and aborts it. Housekeeping drains during
   * a session now (§6.4), so this is no longer about the drain being blocked — it is that
   * parking takes the lease the session itself holds, so only in-session code can serve it.
   * `applyChatRequests` excludes exactly that request for this reason. The in-session path
   * used to refuse outright, which left deleting the pod as the only way to stop a session,
   * and that in turn stranded the task (§6.2).
   *
   * A task running on ANOTHER runner IS refused here. Nothing in this process can reach
   * into that one, and pretending to cancel would leave the task running with the human
   * believing it was not.
   *
   * The lease is taken for the write and released immediately, because every push
   * verifies ownership first (§5.1) and this one is no exception.
   */
  private async applyPark(request: ChatRequest & { readonly kind: "park" }): Promise<ChatOutcome> {
    const { store, leases, logger } = this.deps;

    const state = await store.tryReadState(request.task);
    if (state === undefined) return { kind: "unknown-task" };
    if (isTerminal(state.status)) return { kind: "not-parkable", status: state.status };

    const lease = await leases.claim(request.task);
    // Unclaimable means another runner holds it — which is what `running` looks like
    // from here, and the one case where the stored status may already be stale.
    if (lease === undefined) return { kind: "not-parkable", status: "running" };

    try {
      const handle = heldLease(lease);
      await this.unit(async () => {
        await store.appendJournal(request.task, state.sessions, "**Parked:** cancelled from chat.");
        await this.transition(handle, state, "parked");
        await this.push(handle, `chore(${request.task}): parked from chat`);
      });
      logger.info("task.cancelled", { task: request.task, previous: state.status });

      // After the push, never before: the thread's last word must describe what git
      // already says, and a failure here must not leave a task running with a closed
      // conversation.
      const threadId = state.chat?.threadId;
      if (threadId !== undefined) {
        await this.deps.closer?.close(
          threadId,
          `**${request.task}** was cancelled. This thread is closed — start a new ` +
            `\`/brainstorm\` if you want to pick the idea up again.`,
        );
      }
      return { kind: "parked" };
    } finally {
      await leases.release(lease).catch(() => undefined);
    }
  }

  /**
   * Put a parked task back in the queue — `/resume`. The inverse of `applyPark`.
   *
   * `parked` is terminal (`isTerminal`), so nothing in the loop leaves it. Until this
   * existed the only way back was an operator editing `state.json` in the state repo,
   * which is not a manual version of this command but a different and worse thing: the
   * loop owns that working copy, so an out-of-band push lands between its pull and its
   * push and the push is rejected. That is not hypothetical — it cost BS-1537785980415778816-03
   * a session, and then `parkFailed` could not park it either, for the same reason.
   *
   * ONLY from `parked`. `failed` is left alone deliberately: it means a session ended in
   * a way the supervisor could not attribute to the task, and re-queueing that without a
   * human reading the journal invites the same failure on a loop. `done` is not
   * re-openable at all — a new task is the honest way to ask for more work.
   *
   * It DOES clear `noProgressStreak`, and only that. **Corrected on 2026-08-16**, when a
   * resume and the re-park that undid it landed in the state repo five seconds apart:
   *
   *     09:41:20  chore(BS-…-01): resumed from chat
   *     09:41:25  chore(BS-…-01): parked
   *
   * `workTask` evaluates `checkLimits` BEFORE the first session, so a task resumed at the
   * no-progress limit parked itself on the very next claim having run nothing at all. The
   * command reported success and did nothing, which is worse than refusing. `applyAnswer`
   * had already met this and says why: the streak that made a task park is not the next
   * session's fault. Answering is progress; so is a human reading a parked task and
   * saying keep going.
   *
   * `sessions` and the review rounds are still NOT reset. Those are budgets, and the fix
   * for "it used its twenty sessions" is a human deciding to raise the limit, not a
   * command that quietly forgives it — so the reply says so rather than letting the human
   * discover it on the next claim.
   */
  private async applyResume(
    request: ChatRequest & { readonly kind: "resume" },
  ): Promise<ChatOutcome> {
    const { store, leases, logger } = this.deps;

    const state = await store.tryReadState(request.task);
    if (state === undefined) return { kind: "unknown-task" };
    if (!RESUMABLE.includes(state.status)) {
      return { kind: "not-resumable", status: state.status };
    }
    // Remembered before the transition, because the reply says which terminal status the
    // task is coming back FROM and `transition` overwrites it.
    const from = state.status;

    // Taken for the write and released immediately, exactly as `applyPark` does: every
    // push verifies lease ownership first (§5.1), and a resume is no exception. A parked
    // task is held by nobody, so this only fails if another runner got here first.
    const lease = await leases.claim(request.task);
    if (lease === undefined) return { kind: "not-resumable", status: "running" };

    try {
      const handle = heldLease(lease);
      await this.unit(async () => {
        await store.appendJournal(request.task, state.sessions, "**Resumed:** from chat.");
        // `lastProgressSession` is history and stays put; only the streak is forgiven, so
        // the journal can still show how long the task has actually been stalled.
        await this.transition(
          handle,
          { ...state, progress: { ...state.progress, noProgressStreak: 0 } },
          "ready",
        );
        await this.push(handle, `chore(${request.task}): resumed from chat`);
      });
      this.publishNoProgress(request.task, 0);
      logger.info("task.resumed", {
        task: request.task,
        sessions: state.sessions,
        maxSessions: state.limits.maxSessions,
        // What it WAS, since that is the thing being forgiven.
        noProgressStreak: state.progress.noProgressStreak,
      });

      // The one limit resuming does not forgive, said now rather than discovered on the
      // next claim — which is where it is discovered, not after a session: `checkLimits`
      // runs before the first one.
      const exhausted =
        state.sessions >= state.limits.maxSessions
          ? `it has used ${state.sessions} of ${state.limits.maxSessions} sessions`
          : undefined;

      return { kind: "resumed", from, ...(exhausted === undefined ? {} : { exhausted }) };
    } finally {
      await leases.release(lease).catch(() => undefined);
    }
  }

  /**
   * Merge a task's PR on request — the `Merge anyway` button on a stalled review.
   *
   * The one place a human overrides the council. It goes through the same reviewer
   * identity the automatic path uses, so it is subject to the same branch protection and
   * leaves the same approving review behind: an override is recorded on the PR, not
   * smuggled past it.
   */
  private async applyMerge(request: ChatRequest & { readonly kind: "merge" }): Promise<ChatOutcome> {
    const { store, leases, logger } = this.deps;

    const state = await store.tryReadState(request.task);
    if (state === undefined) return { kind: "unknown-task" };
    const spec = await store.readSpec(request.task).catch(() => undefined);
    if (spec === undefined) return { kind: "not-mergeable", reason: "the task has no readable spec" };
    // After the spec, because knowing whether a PR exists now needs the repos to pair a legacy
    // `pr` with (`taskPullRequests`).
    if (taskPullRequests(spec.repos, state).length === 0) {
      return { kind: "not-mergeable", reason: "no PR was ever opened" };
    }
    if (this.deps.reviewers?.get(spec.workspace) === undefined) {
      return {
        kind: "not-mergeable",
        reason:
          "no reviewer identity is configured for this workspace, and the app that " +
          "opened the PR cannot approve its own — merge it yourself",
      };
    }

    // The lease FIRST, then the merge. This ran the other way round, which meant a task
    // being actively worked by another runner could have its PR merged out from under
    // the session still writing to that branch — the claim below would then fail, and
    // the only trace was a `merge.unrecorded` warning about an irreversible act that had
    // already happened. Refusing is the safe direction: nothing has been merged, and the
    // human gets told why.
    const lease = await leases.claim(request.task);
    if (lease === undefined) {
      return {
        kind: "not-mergeable",
        reason:
          "another runner holds this task right now — it is still being worked, so " +
          "merging would land a branch that is still moving. Try again once it parks.",
      };
    }

    try {
      const merge = await this.mergeReviewed(spec, state);
      if (!merge.merged) return { kind: "not-mergeable", reason: merge.note };

      // Merging a parked task settles it: the work is on the default branch, and leaving
      // it parked would invite a human to pick up something already shipped.
      const handle = heldLease(lease);
      try {
        await this.unit(async () => {
          await store.appendJournal(request.task, state.sessions, "**Merged** from chat.");
          await this.transition(handle, state, "done");
          await this.push(handle, `chore(${request.task}): merged from chat`);
        });
      } catch (error) {
        // The merge already happened; failing to record it is worth a log, not a retry.
        logger.warn("merge.unrecorded", { task: request.task, ...errorFields(error) });
      }

      // The primary's url, which is what the reply renders. `merge.note` already names every
      // repo when there was more than one, so the count is not lost — and it is carried back
      // rather than dropped because on a queue-protected base nothing has merged yet, and a
      // reply saying "Merged" would be untrue.
      const primary = state.pr ?? taskPullRequests(spec.repos, state)[0];
      return { kind: "merged", prUrl: primary?.url ?? "(merged)", note: merge.note };
    } finally {
      await leases.release(lease).catch(() => undefined);
    }
  }

  /**
   * Post to the human signal channel (DESIGN.md §11). Never throws.
   *
   * Same reasoning as `mirror`, and the same ordering: always after the authoritative
   * git write, and a failure only logs. Discord going down — or a webhook deleted in
   * the UI, which answers 404 forever — must not unwind into `workTask`'s catch and
   * park a task that was just verified and pushed as `done`. The notification would
   * then have rewritten the very state it exists to announce.
   */
  /**
   * Notify in the task's own thread when it has one (§14.3).
   *
   * A brainstorm and everything cut from it talk in the thread the conversation started
   * in, so a plan's questions and outcomes stay together instead of interleaving with
   * every other task in the channel.
   */
  /**
   * Show activity in the task's thread while it works. Never throws.
   *
   * Only for a task that HAS a thread: a typing indicator in the main channel would be
   * permanent — the runner always has something in flight — and a signal that is always
   * on carries no information.
   */
  private showWorking(state: TaskState): () => void {
    const threadId = state.chat?.threadId;
    const presence = this.deps.presence;
    if (threadId === undefined || presence === undefined) return () => undefined;

    try {
      return presence.working(threadId);
    } catch {
      return () => undefined;
    }
  }

  /**
   * Tell Discord about a task, in the task's own thread when it has one.
   *
   * The ONLY way this loop notifies, and that is structural rather than tidy. It replaced a
   * pair — this and a `notify(notification, threadId?)` whose thread argument was optional —
   * and the optional argument was the whole defect: `park` omitted it, so the park at the end
   * of a review loop went to the channel while every round before it went to the thread, and
   * `plan-stalled`'s own prose ("say what to change — here in this thread") was posted
   * somewhere that is not the thread. A call site that CANNOT forget the thread cannot
   * reintroduce that, and taking the state rather than the id is what makes it impossible:
   * every caller already has the state, and nowhere else knows where a task talks.
   *
   * Fleet-scoped notifications — the digest (§19) and a refused alert (§20) — do not come
   * through here at all. They belong to no task, so they have no thread, and they are sent by
   * `digest/publish.ts` and `remediation/queue.ts` against the notifier directly.
   */
  private async notifyTask(state: TaskState, notification: Notification): Promise<void> {
    const threadId = state.chat?.threadId;
    try {
      await this.deps.notifier.notify(
        notification,
        threadId === undefined ? {} : { threadId },
      );
    } catch (error) {
      this.deps.logger.warn("notify.failed", {
        // A digest is about the fleet (§19) and a refused alert never became a task (§20),
        // so those two are the notifications with nothing to name here.
        ...(notification.kind === "digest" || notification.kind === "alert-refused"
          ? {}
          : { task: notification.task }),
        kind: notification.kind,
        ...errorFields(error),
      });
    }
  }

  /**
   * Mirror a lifecycle change into the task's tracker (DESIGN.md §9.5).
   *
   * Always after the authoritative git write — the lease CAS for a claim, the state
   * push for everything else. The tracker is a VIEW, git wins when they disagree, and
   * that ordering is why a failure here only logs: an unreachable Vikunja must never
   * fail a task, and the next transition overwrites the view anyway.
   *
   * Handoffs are deliberately not mirrored: a multi-hour task would otherwise become
   * twenty comments of noise.
   */
  private async mirror(spec: TaskSpec, transition: TrackerTransition): Promise<void> {
    const ref = spec.tracker;
    if (ref === undefined) return;

    const tracker = this.deps.trackers?.get(spec.workspace);
    if (tracker === undefined) return;

    if (tracker.kind !== ref.kind) {
      // Config error: the workspace's tracker is not the one this task came from, so
      // its ids mean something else entirely. Writing anyway would comment on an
      // unrelated item.
      this.deps.logger.error("tracker.kind-mismatch", {
        task: spec.id,
        workspace: spec.workspace,
        specKind: ref.kind,
        workspaceKind: tracker.kind,
      });
      return;
    }

    try {
      await tracker.transition(ref, transition, spec.id);
    } catch (error) {
      this.deps.logger.warn("tracker.mirror-failed", {
        task: spec.id,
        tracker: tracker.kind,
        transition: transition.kind,
        ...errorFields(error),
      });
    }
  }

  /**
   * Publish a task's no-progress streak to the gauge Prometheus scrapes.
   *
   * `recordSession` used to be the only caller, which made the gauge a snapshot of the
   * last session this runner happened to record, with nothing to correct it afterwards.
   * Three other sites forgive the streak in state — an answer, guidance, a resume — so
   * the series reported a number the state no longer held for as long as the process
   * lived. It exists so that each of those has one obvious thing to call, next to the
   * log line it already writes.
   *
   * `caterpillar_no_progress_streak >= 2` is an alerting rule, so a stale sample is not
   * cosmetic: it pages somebody about a task that is fine. Dropping the series when a
   * task ENDS is the other half, and belongs to `transition` rather than here — that is
   * the funnel every status change goes through.
   */
  private publishNoProgress(task: TaskId, streak: number): void {
    this.deps.metrics.noProgress.set({ task }, streak);
  }

  private async transition(
    lease: LeaseHandle,
    state: TaskState,
    status: TaskStatus,
  ): Promise<TaskState> {
    const held = await lease.current();
    const next: TaskState = {
      ...state,
      status,
      owner: {
        runner: held.runner,
        leaseOid: held.oid,
        since: state.owner?.since ?? new Date().toISOString(),
      },
    };
    await this.deps.store.writeState(next);
    this.deps.metrics.taskStatus.set({ task: state.id, status }, 1);
    // A terminal task has no next session, so its streak stops being a measurement of
    // anything. The STATE keeps it — it is the record of why the task parked — but the
    // gauge is a claim about right now, and nothing expires it (`Metric.remove`).
    if (isTerminal(status)) this.deps.metrics.noProgress.remove({ task: state.id });
    return next;
  }

  /**
   * Run `body` — a write-then-push unit — with the state checkout to this slot alone.
   *
   * **This is what N slots made mandatory, and `StateStore.exclusively` was kept for it.**
   * That method's own docstring says so: "Nothing in the supervisor calls this yet… the cost
   * of that route is attribution (another writer's commit may carry these files) rather than
   * durability. This exists for a caller that cannot accept even that cost." A runner with
   * one slot could accept it, because the only other writer was housekeeping, whose writes
   * belong to a DIFFERENT task and land in a commit whose message is at worst imprecise.
   *
   * At N slots it stops being about tidiness. Two sessions ending within a millisecond of
   * each other each write a journal shard, a `handoff.md` and a `state.json`, and then each
   * commits; without the hold, whichever gets there first stages the other's half-written
   * files under its own message and the second finds a clean tree and commits nothing.
   * `Serial` does not prevent it: every individual git call is properly ordered, and the
   * damage happens in the interval between one writer's last `writeFile` and its own
   * `git add`, which it had handed to whoever asked next. Not hypothetical —
   * `loop.test.ts`'s "two slots writing state at once" reproduced it on the first run, with
   * `chore(CONC-WRITE-A): session 1` carrying six files across two tasks.
   *
   * **This is one of TWO halves and neither is sufficient.** The other is
   * `StateStore.pending`: staging is now scoped to the paths a writer actually wrote,
   * because `transition("running")` deliberately leaves a `state.json` uncommitted for the
   * whole of a session, so at any instant every other in-flight task has one sitting in
   * this tree — a window no lock can close, since it has been open for minutes. This hold
   * stops a concurrent writer entering; that scoping stops an already-written file being
   * swept up.
   *
   * The unit is therefore the whole of a logical operation, from its first write to its
   * push, and never any wider. In particular it must NOT span a session: the model call
   * takes minutes and holding the state checkout across one would stop every other slot
   * writing and stop housekeeping pulling.
   *
   * Re-entrant within one async context by construction (`StateStore.exclusive` keys on
   * `AsyncLocalStorage`), so a unit nested inside a unit — `applyOutcome` calling `park`,
   * `convene` calling `releaseAfterOutage` — runs immediately on the hold it already has
   * rather than deadlocking on it.
   */
  private unit<T>(body: () => Promise<T>): Promise<T> {
    return this.deps.store.exclusively(() => body());
  }

  /**
   * Push state. Verifies lease ownership FIRST — a partitioned runner must not
   * resurrect stale work (DESIGN.md §5.1).
   */
  private async push(lease: LeaseHandle, message: string): Promise<void> {
    // Resolved HERE, not by the caller: everything between the claim and this line may
    // have taken minutes, and the token has moved if it did.
    await this.deps.leases.assertHeld(await lease.current());
    await this.deps.store.commitAndPush(
      message,
      "origin",
      this.deps.config.stateRepo.branch,
    );
  }
}

export { isTerminal };
export type { TaskId };
