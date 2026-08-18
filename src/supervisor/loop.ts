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
  repoSlug,
  type ProposedPlan,
  type RepoRef,
  type ProviderOutage,
  type SessionOutcome,
  type TaskId,
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
import type { WorkspaceUsage } from "../workspace/usage.ts";
import type { StateStore } from "../state/store.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import { intakeDue, intakeRef, type IntakePass } from "../intake/ingest.ts";
import type { AlertPass } from "../remediation/queue.ts";
import type { FiringAlert } from "../remediation/receiver.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { Notification, Notifier } from "../notify/discord.ts";
import type { Presence, ThreadCloser } from "../notify/bot.ts";
import { threadBindings, type ThreadIndex } from "../notify/threads.ts";
import type { ForgeFactory, WorkspaceScope } from "../forge/types.ts";
import type { Council } from "../review/council.ts";
import { renderVerdict, summariseVerdict } from "../review/decide.ts";
import type { Tracker, TrackerTransition } from "../tracker/types.ts";
import { ProviderCooldown } from "./cooldown.ts";
import type { CancelSignals } from "../redis/cancel.ts";
import type { ChatDrainer } from "../redis/inbox.ts";
import type { PresenceRegistry } from "../redis/presence.ts";
import type { SnapshotWriter } from "../redis/snapshot.ts";
import type { ChatOutcome, ChatRequest } from "./inbox.ts";
import { checkLimits, recordProgress, type ProgressEvidence } from "./progress.ts";
import { summarise } from "./snapshot.ts";

/**
 * How often a running session checks for a `/cancel`.
 *
 * A human is waiting on the reply, so this is seconds rather than a poll interval; it
 * costs one array filter over a queue that is almost always empty.
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
   * `/cancel`, or the wall clock. Honouring it is what stops a hung tool call from
   * wedging the whole runner: everything here is single-threaded, so a `bash` call that
   * never returns used to stop the poll, the chat drain and intake along with it.
   */
  run(spec: TaskSpec, state: TaskState, signal: AbortSignal): Promise<SessionOutcome>;
}

export interface Verifier {
  /**
   * Independently checks the §12 gates: acceptance commands exit 0, PR open, CI green.
   * Runs in the supervisor, never in the agent.
   */
  verify(
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{ readonly passed: boolean; readonly detail: string; readonly prUrl?: string }>;
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
  readonly credentials?: { clearActive(): void };
  /**
   * Tracker → task ingestion. Optional: a runner with no trackers configured, or one
   * fed only by hand-committed specs (§14.4), does not need it.
   */
  readonly intake?: Intake;
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
   * Which replica acts on Discord (DESIGN.md §7). Refreshed here rather than on a timer
   * of its own: a timer would keep renewing the claim while a session blocked the loop,
   * advertising a holder that cannot answer anything.
   */
  readonly chat?: { readonly refresh: () => Promise<void> };
  /**
   * In-memory view of every task, refreshed once per poll for the chat interface.
   * Optional: nothing in the loop reads it, and without a bridge nothing needs it.
   */
  readonly snapshot?: SnapshotWriter;
  /**
   * Cancel signals reaching a session already in flight (DESIGN.md §21).
   *
   * Optional, and its absence is not a loss of function: the in-process path through
   * `inbox.takeWhere` still works, and that is the whole mechanism on a single-replica
   * runner. This exists so a cancel typed at a SEPARATE bot process reaches the session
   * without waiting for the poll loop — which is blocked for the session's whole duration.
   */
  readonly cancels?: CancelSignals;
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

export class Supervisor {
  /** 0 means "never ran", so the first pass happens at boot. */
  private lastIntakeAt = 0;

  private readonly deps: SupervisorDeps;

  /**
   * How long this runner is sitting out a provider outage (DESIGN.md §6.3).
   *
   * Runner-scoped and in memory only. In memory because it is a statement about right
   * now — a restarted pod SHOULD try again immediately, since the most likely reason
   * anyone restarted it is that they just fixed the provider.
   */
  private readonly cooldown: ProviderCooldown;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.cooldown = new ProviderCooldown(deps.config.llm.cooldown);
  }

  /** Runs until `signal` aborts. Restart-safe: all state comes from the repo. */
  async run(signal: AbortSignal): Promise<void> {
    const { config, logger } = this.deps;

    logger.info("supervisor.start", {
      runner: config.runnerId,
      capabilities: config.capabilities.join(","),
      pollSeconds: config.pollSeconds,
    });

    while (!signal.aborted) {
      // The whole iteration, for the same reason `workTask` below is wrapped: a failure
      // here belongs to one poll, not to the process. `store.pull` throws on any non-zero
      // git exit, `resolveEnv` awaits a token mint over an untimed fetch roughly hourly,
      // and `claimNext` reaches the network through `ls-remote` — so a blip in any of
      // them used to unwind out of `run()` into main's `finally`, which closes /healthz
      // and the credential socket and then blocks forever on `await bridge`. The result
      // was a live process, still answering Discord from a frozen snapshot, that polled
      // nothing and that systemd would never restart because it never exited.
      try {
        await this.pollOnce(signal);
      } catch (error) {
        if (signal.aborted) throw error;
        logger.error("poll.failed", errorFields(error));
        await sleep(config.pollSeconds * 1000);
      }
    }
  }

  /** One iteration of the poll loop. Throws only what the caller should log and retry. */
  private async pollOnce(signal: AbortSignal): Promise<void> {
    const { config, store, logger } = this.deps;

    await store.pull("origin", config.stateRepo.branch);

    // Advertise that this runner is alive (DESIGN.md §21). Here rather than on a timer,
    // for `ChatLeadership.refresh`'s reason: a timer would keep announcing presence while
    // a session blocked the loop, which is the one case where "alive" and "able to do
    // anything" come apart. ADVISORY — nothing routes or claims from it, and it never
    // throws (`redis/presence.ts`, `redis/guarded.ts`).
    await this.deps.runners?.heartbeat(asRunnerId(config.runnerId));

    // Both before claiming, so a task unparked by either is claimable on this same
    // iteration rather than sitting idle until the next poll. Both also run DURING a
    // provider cooldown: answering a question and ingesting an issue cost no tokens,
    // and a queue that keeps filling while the provider is down is the correct
    // behaviour — it is only starting sessions that has to stop.
    // Before the drain, because the drain is the holder's job: a replica that just lost
    // the claim must not serve the requests it collected while it had it.
    await this.deps.chat?.refresh();

    await this.applyChatRequests();
    await this.maybeIngest();
    await this.drainAlerts();
    await this.maybeDigest(signal);

    if (await this.coolingDown()) return;

    const claimed = await this.claimNext(await this.survey());
    if (claimed === undefined) {
        // Only when IDLE. The store is shared with every worktree and mirror on a 20Gi
        // volume so collecting is a requirement rather than hygiene, but a collection
        // racing a session on this same runner is a risk with no upside — there is always
        // another idle poll.
        await this.deps.toolchain.maybeCollectGarbage();

      // Idle-only for the same reason, and throttled harder still. The collection above
      // spends its time inside nix; this spends it inside THIS process — a `stat` per file
      // over a tree with one `node_modules` per task — and the loop is single-threaded, so
      // every millisecond here is a millisecond no task is claimed in. There is always
      // another idle poll, and disk fills over hours rather than seconds.
      await this.maybeMeasureUsage();

      // Debug, not info: at the default poll interval this is the single noisiest
      // line the supervisor could emit, and an idle runner is not news.
      logger.debug("poll.idle", { pollSeconds: config.pollSeconds });
      await sleep(config.pollSeconds * 1000);
      return;
    }

    try {
      await this.workTask(claimed.lease, claimed.spec, signal);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Another runner owns this task now. Drop everything without writing.
        logger.warn("lease.lost", { task: claimed.spec.id, ...errorFields(error) });
        return;
      }
      if (signal.aborted) throw error;

      // Any other failure belongs to the TASK, not the supervisor. Rethrowing here
      // exits the process, and because the claim is durable the restarted
      // supervisor re-claims the same task and dies again — one malformed task
      // wedges the whole runner permanently.
      //
      // `workTask` parks anything attributable to the task while it still holds the
      // lease, so reaching this point means the failure escaped that path. Log it
      // and keep polling rather than exiting.
      logger.error("supervisor.unhandled", {
        task: claimed.spec.id,
        ...errorFields(error),
      });
    }
  }

  /**
   * Sit out a provider outage, if one is in progress. See DESIGN.md §6.3.
   *
   * Returns true when this poll must not claim anything. The wait is capped at ONE poll
   * interval per iteration rather than slept through in one go, so the loop keeps
   * pulling, answering chat and ingesting while it waits, and an abort is honoured
   * within a poll rather than within the cooldown.
   */
  private async coolingDown(): Promise<boolean> {
    const { config, metrics, logger } = this.deps;

    const remaining = this.cooldown.remainingMs(Date.now());
    metrics.providerCooldown.set({ runner: config.runnerId }, Math.ceil(remaining / 1000));
    if (remaining === 0) return false;

    logger.info("provider.cooling", { remainingSeconds: Math.ceil(remaining / 1000) });
    await sleep(Math.min(remaining, config.pollSeconds * 1000));
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
      return;
    }

    try {
      // Always info, never debug. At a 300s interval this is ~12 lines an hour, and it is
      // the ONLY evidence intake is alive: a pass that creates nothing is the normal case,
      // so hiding it makes a working intake and a broken one look identical from the logs.
      // `seen` is what separates them — it distinguishes "nobody labelled anything" from
      // "the tracker returned items and none became tasks".
      logger.info("intake.pass", { ...(await intake.ingest("origin", config.stateRepo.branch)) });
    } catch (error) {
      logger.warn("intake.failed", { ...errorFields(error) });
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
   * Read every task's state once, and publish the result to the chat snapshot.
   *
   * One pass serves both readers. Claiming already had to read every state to find a
   * `ready` one, so the snapshot rides along for free rather than costing a second
   * sweep of the task tree on every poll.
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
    // Terminal tasks drop out: a message in a bound thread is an ANSWER, so leaving a
    // finished conversation bound means an abandoned thread silently swallows whatever
    // is typed into it. `threadBindings` also settles who owns a thread several tasks
    // share — a plan's children inherit their brainstorm's.
    this.deps.threads?.replace(
      threadBindings(
        records.map((record) => ({
          id: record.id,
          status: record.state.status,
          ...(record.state.chat === undefined ? {} : { threadId: record.state.chat.threadId }),
        })),
      ),
    );
    return records;
  }

  /** First claimable task whose requirements this runner satisfies. */
  private async claimNext(
    records: readonly TaskRecord[],
  ): Promise<{ readonly lease: Lease; readonly spec: TaskSpec } | undefined> {
    const { store, leases, config } = this.deps;

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
      if (!isClaimable(state, statusOf)) continue;
      if (!capabilitiesSatisfy(config.capabilities, state.requires)) continue;

      const spec = await store.readSpec(id).catch(() => undefined);
      if (spec === undefined) continue;
      candidates.push({ id, spec, state });
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

    for (const { id, spec, state } of candidates) {
      const lease = await leases.claim(id);
      if (lease === undefined) continue;

      // The CAS is what established this was safe to take, so by here the previous
      // holder is gone. Say so: a reclaim is a pod that died mid-task, and the whole
      // failure used to be invisible — the task simply stopped, with no line anywhere
      // connecting it to the deploy that killed it.
      if (state.status === "running") {
        this.deps.logger.warn("task.reclaimed", {
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

      this.deps.logger.info("task.claimed", {
        task: id,
        runner: lease.runner,
        workspace: spec.workspace,
        sessions: state.sessions,
      });
      await this.mirror(spec, { kind: "claimed", runner: lease.runner });
      return { lease, spec };
    }
    return undefined;
  }

  /**
   * Drive one task through as many sessions as it needs, until it parks or completes.
   *
   * The heartbeat runs for the whole duration; if it fails the session is aborted at
   * once and the next lease check throws, unwinding without writing anything.
   */
  private async workTask(lease: Lease, spec: TaskSpec, signal: AbortSignal): Promise<void> {
    const { store, leases, config, metrics, logger } = this.deps;

    // Everything that may stop a session in flight, as one signal. Losing the lease used
    // to set a flag that was only read at the TOP of the loop, so a lease lost at t=60s
    // let the session run out the rest of its budget — still minting tokens for every
    // push — while another runner worked the same branch.
    const interrupt = new AbortController();
    const stopOnShutdown = (): void => interrupt.abort();
    signal.addEventListener("abort", stopOnShutdown, { once: true });

    // The poll loop — and with it the inbox drain — is blocked for the whole duration of
    // a session, so a `/cancel` submitted while the agent is working would otherwise sit
    // in the queue until the session it was meant to stop had already ended, with the
    // operator's Discord reply hanging until then. This watches for that ONE request and
    // leaves everything else queued: the rest write the state repo, and this session
    // holds the lease those writes would have to fence against.
    let cancelled = false;
    const stop = (): void => {
      if (cancelled) return;
      logger.info("task.cancel-requested", { task: spec.id });
      cancelled = true;
      interrupt.abort();
    };

    // Two paths to the same abort, because a cancel can arrive from two places.
    //
    // The interval is the original one and covers a cancel submitted IN THIS PROCESS: the
    // request is sitting in the in-process queue, and `takeWhere` is what pulls out that
    // ONE request while leaving everything else — which writes the state repo this session
    // holds the lease for — queued. It settles `cancelling` rather than `parked`, because
    // the session unwinds at a turn boundary and the park lands on the poll after that.
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

    let lost: LeaseLostError | undefined;
    const heartbeat = startHeartbeat(
      leases,
      lease,
      config.lease.heartbeatSeconds,
      (error) => {
        lost = error;
        // Immediately, not at the next loop iteration. The credential goes with it:
        // `CredentialService.active` outlived the lease that justified it, so a session
        // that had already lost its claim kept getting fresh tokens minted on demand.
        logger.warn("lease.lost-mid-session", { task: spec.id, ...errorFields(error) });
        this.deps.credentials?.clearActive();
        interrupt.abort();
      },
    );

    try {
      while (!signal.aborted) {
        if (lost !== undefined) throw lost;

        let state = await store.readState(spec.id);

        const verdict = checkLimits(state, state.limits, {
          noProgressLimit: config.limits.noProgressLimit,
        });
        if (verdict.kind === "park") {
          await this.park(heartbeat, spec, state, verdict.reason);
          return;
        }

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
          outcome = await this.deps.runner.run(spec, state, interrupt.signal);
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
            cancelled,
            leaseLost: lost !== undefined,
            shuttingDown: signal.aborted,
          });

          // A CANCEL is different from the other three, and this is the half that is easy
          // to miss: stopping the session is not cancelling the task. An interrupted task
          // is left `running`, which is claimable (§6.2) — so without this the very next
          // poll would re-claim it and start the session over, and the operator would
          // watch the thing they cancelled carry on working.
          //
          // Only when the lease is still ours: a cancel that raced a lost lease has no
          // standing to write, and `park` fences anyway.
          if (cancelled && lost === undefined) {
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

        state = await this.recordSession(heartbeat, spec, state, outcome);

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
      // Or a long-lived supervisor accumulates one subscriber connection per task it has
      // ever run. Swallowed, because a failure to unsubscribe from a socket that is
      // already gone must not be the thing that fails a finished session.
      await cancelWatch?.close().catch(() => undefined);
      signal.removeEventListener("abort", stopOnShutdown);
      await leases.release(await heartbeat.current()).catch(() => undefined);
    }
  }

  /**
   * Hand the runner back when someone is waiting on a brainstorm (DESIGN.md §14.3).
   *
   * `workTask` drives ONE task through as many sessions as it needs, and the poll loop —
   * and with it the chat drain and the next claim — is blocked for all of them. A task
   * that keeps handing off therefore owns the runner indefinitely, which is how a human
   * typing `/brainstorm` got a thread that opened and then said nothing: twenty minutes
   * and six sessions, in the run this was written from.
   *
   * Deliberately NOT an interrupt. `/cancel` aborts a session because the human's whole
   * intent is to stop it; here the session is doing legitimate work, and an interrupted
   * session records nothing at all (§6.4) — so cutting one short to start a conversation
   * would throw away everything it had done since the last boundary. Waiting for the
   * boundary costs the human the tail of one session and costs the task nothing.
   *
   * The task is put back to `ready` rather than left `running`. Both are claimable, but
   * `running` is the crash-recovery path: re-claiming one logs `task.reclaimed` and
   * writes a journal entry about a runner that "stopped without parking or finishing it",
   * which would be a lie told once per brainstorm, in the task's permanent record.
   *
   * The request itself is left in the queue. This code cannot serve it — creating the
   * task writes the state repo, and that is the loop's to do — so it only gets out of
   * the way, and `applyChatRequests` drains it on the very next poll.
   */
  private async yieldToBrainstorm(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<boolean> {
    const { inbox, logger } = this.deps;
    if (inbox === undefined) return false;
    if (!(await inbox.some((request) => request.kind === "brainstorm"))) return false;

    logger.info("task.yielded", { task: spec.id, sessions: state.sessions, to: "brainstorm" });
    await this.transition(lease, state, "ready");
    await this.push(lease, `chore(${spec.id}): released for a waiting brainstorm`);
    return true;
  }

  /** Persist the journal and usage for a finished session. */
  private async recordSession(
    lease: LeaseHandle,
    spec: TaskSpec,
    state: TaskState,
    outcome: SessionOutcome,
  ): Promise<TaskState> {
    const { store, config, metrics, logger } = this.deps;

    const session = state.sessions + 1;
    const evidence = await this.deps.progress.probe(spec, state);
    const progress = recordProgress(state.progress, session, evidence);

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
      noProgressStreak: progress.noProgressStreak,
    });

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

    if (outcome.reason === "handoff" || outcome.reason === "blocked") {
      await store.writeHandoff(spec.id, outcome.summary);
    }

    metrics.noProgress.set({ task: spec.id }, progress.noProgressStreak);

    const next: TaskState = {
      ...state,
      sessions: session,
      usage: addUsage(state.usage, outcome.usage),
      progress,
      // A PR opened this session must survive into later ones — the completion gate
      // looks it up from state, not from the transcript.
      ...(outcome.pr !== undefined ? { pr: outcome.pr } : {}),
    };

    await store.writeState(next);
    await this.push(lease, `chore(${spec.id}): session ${session} — ${outcome.reason}`);
    void config;
    return next;
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
        // Same task, fresh session. Nothing to notify — Discord stays a signal channel.
        return false;

      case "blocked": {
        // Capability re-routing: release so a runner that can do it picks it up.
        const requires = outcome.requires ?? state.requires;
        await this.transition(lease, { ...state, requires }, "ready");
        await this.push(lease, `chore(${spec.id}): needs ${requires.join(", ")}`);
        return true;
      }

      case "ask-human": {
        const question = outcome.question ?? outcome.summary;
        const index = state.sessions;
        // The question TEXT is deliberately not logged: it is agent-authored prose that
        // can quote anything it read, including a file it should not have. The index
        // locates it in `tasks/<id>/questions/` for anyone who needs it.
        logger.info("task.awaiting-human", { task: spec.id, questionIndex: index });
        await store.writeQuestion(spec.id, index, question);
        await this.transition(lease, state, "awaiting-human");
        await this.push(lease, `chore(${spec.id}): awaiting human input`);
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
          detail: result.detail,
        });
        if (!result.passed) {
          // Claim rejected. Back to ready with the failure in the journal, so the
          // next session sees why rather than re-claiming blindly.
          await store.appendJournal(
            spec.id,
            state.sessions,
            `**Completion claim REJECTED by verification:**\n\n${result.detail}`,
          );
          await this.transition(lease, state, "ready");
          await this.push(lease, `chore(${spec.id}): completion claim rejected`);
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
        await this.transition(lease, reviewed.state, "done");
        await this.push(lease, `chore(${spec.id}): done`);
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
        return true;
      }

      case "plan-proposed": {
        const plan = outcome.plan;
        if (plan === undefined) {
          // The tool sets both or neither, so this is unreachable. Back to `ready` rather
          // than parking: a session that ended with nothing to act on is a lost session,
          // not a broken task.
          await this.transition(lease, state, "ready");
          await this.push(lease, `chore(${spec.id}): plan session produced nothing`);
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
        await this.transition(lease, state, "failed");
        await this.push(lease, `chore(${spec.id}): failed`);
        await this.notifyTask(state, {
          kind: "failed",
          task: spec.id,
          error: outcome.error ?? outcome.summary,
        });
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

    let rejection: string | undefined;
    if (reviewed.verdict !== undefined) {
      const text = renderVerdict(reviewed.verdict);
      await store.writeVerdict(spec.id, state.sessions, text);
      await store.appendJournal(spec.id, state.sessions, text);
      if (reviewed.verdict.decision === "changes") rejection = summariseVerdict(reviewed.verdict);
    }

    // Materialisation validates too — cycles, missing acceptance criteria, unknown
    // capabilities — and a plan the council liked can still be unbuildable. Both refusals
    // come back the same way, so the agent has one thing to react to.
    const cut = rejection === undefined
      ? materialise(plan, {
          parent: spec.id,
          workspace: spec.workspace,
          defaultRepos: spec.repos,
          // The plan is the agent's own text. Without this a session could hand its
          // successor a credential for any repo it named (§9.1).
          scope: this.workspaceScope(spec.workspace),
        })
      : ({ kind: "rejected", reason: rejection } as const);

    const rounds = (state.review?.rounds ?? 0) + (cut.kind === "rejected" ? 1 : 0);
    const next: TaskState = {
      ...state,
      usage: addUsage(state.usage, reviewed.usage),
      review: { rounds, last: cut.kind === "rejected" ? "changes" : "pass" },
    };
    await store.writeState(next);

    if (cut.kind === "rejected") {
      await store.appendJournal(
        spec.id,
        state.sessions,
        `**The plan was not accepted:**\n\n${cut.reason}`,
      );

      if (rounds >= config.limits.maxReviewRounds) {
        await this.park(lease, spec, next, `the plan was rejected ${rounds} times`);
        return true;
      }

      await this.transition(lease, next, "ready");
      await this.push(lease, `chore(${spec.id}): plan sent back`);
      await this.notifyTask(next, { kind: "verdict", task: spec.id, summary: cut.reason });
      return false;
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

    await store.writeVerdict(spec.id, state.sessions, text);
    await store.appendJournal(spec.id, state.sessions, text);

    const next: TaskState = {
      ...state,
      // The council's own tokens belong to the task that convened it, or a reviewed
      // task looks cheaper than it was and the cost of reviewing is invisible.
      usage: addUsage(state.usage, usage),
      review: { rounds, last: verdict.decision },
    };
    await store.writeState(next);
    metrics.council.inc({ task: spec.id, decision: verdict.decision });

    if (verdict.decision === "pass") {
      await this.push(lease, `chore(${spec.id}): review council passed`);
      return { state: next, decision: "pass" };
    }

    if (rounds >= config.limits.maxReviewRounds) {
      // The council and the agent are not converging. Parking beats a fourth attempt:
      // from outside, a task trading itself back and forth looks identical to one that
      // is working.
      logger.warn("council.stalled", { task: spec.id, rounds });
      await this.park(lease, spec, next, `review council requested changes ${rounds} times`, {
        kind: "review-stalled",
        task: spec.id,
        rounds,
        summary: summariseVerdict(verdict),
        ...(next.pr === undefined ? {} : { prUrl: next.pr.url }),
        canMerge: this.deps.reviewers?.get(spec.workspace) !== undefined,
      });
      return { state: next, decision: "stalled" };
    }

    await this.transition(lease, next, "ready");
    await this.push(lease, `chore(${spec.id}): review council requested changes`);
    await this.notifyTask(next, {
      kind: "verdict",
      task: spec.id,
      summary: summariseVerdict(verdict),
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

      const changed = await this.applyRevision(membership.parent, records, revision, open);
      if (changed === 0) {
        logger.info("plan.unchanged", { plan: membership.parent, note: revision.note });
        return;
      }

      await this.push(lease, `chore(${membership.parent}): plan graph revised`);
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

    const pr = state.pr;
    const repo = spec.repos[0];
    if (pr === undefined || repo === undefined) {
      return { merged: false, note: "No PR was recorded, so nothing was merged." };
    }

    const factory = reviewers?.get(spec.workspace);
    if (factory === undefined) {
      return { merged: false, note: "No reviewer identity is configured — merging is yours." };
    }

    const forge = await factory.forTask(spec);
    try {
      await forge.approve(repo, pr.number, "Approved by the caterpillar review council.");
      await forge.merge(repo, pr.number);
      logger.info("pr.merged", { task: spec.id, pr: pr.number });
      return { merged: true, note: "Approved by the review council and merged." };
    } catch (error) {
      logger.warn("pr.merge-failed", { task: spec.id, pr: pr.number, ...errorFields(error) });
      return {
        merged: false,
        note: `Could not merge: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await forge.revoke().catch(() => undefined);
    }
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

    const released: TaskState = {
      ...state,
      ...(counts ? { sessions: state.sessions + 1 } : {}),
      usage: addUsage(state.usage, spent),
    };

    // ALWAYS pushed, even when nothing else changed. Only `ready` is claimable, and a
    // task last pushed as `running` — which is every task past its first session — would
    // otherwise be stranded there by an outage no human is going to hear about in time.
    await this.transition(lease, released, "ready");
    await this.push(lease, `chore(${spec.id}): released — the provider stopped answering`);

    // Once per incident. The runner re-checks on a back-off, and a message per attempt
    // would be this failure mode wearing a different hat.
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
    await store.appendJournal(spec.id, state.sessions, `**Parked:** ${reason}`);
    await this.transition(lease, state, "parked");
    await this.push(lease, `chore(${spec.id}): parked`);
    await this.mirror(spec, { kind: "parked", reason });
    await this.notify(notification ?? { kind: "parked", task: spec.id, reason });
  }

  /**
   * Park a task whose session raised an error the supervisor cannot attribute.
   *
   * Best-effort by design: if parking ITSELF fails — an unreachable state repo, a lost
   * network — this logs and returns rather than throwing. Propagating here would exit
   * the process and reintroduce exactly the crash loop it exists to prevent.
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
   * Runs HERE, on the loop's thread of control, because the loop owns the state repo —
   * a websocket handler writing it concurrently would interleave git invocations in one
   * working copy. Each request is settled with what actually happened, so the human who
   * typed or clicked it gets told rather than guessing from silence.
   */
  private async applyChatRequests(): Promise<void> {
    const { logger, inbox } = this.deps;
    if (inbox === undefined) return;

    for (const request of await inbox.drain()) {
      try {
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

    const spec = brainstormSpec({
      id,
      workspace: profile.name,
      topic: request.topic,
      repos,
      author: request.author,
    });

    const now = new Date().toISOString();
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

    logger.info("brainstorm.created", {
      task: id,
      workspace: profile.name,
      repos: spec.repos.map(repoSlug).join(", "),
    });
    return { kind: "started", task: id };
  }

  private async applyAnswer(request: ChatRequest & { readonly kind: "answer" }): Promise<ChatOutcome> {
    const { store, config, logger } = this.deps;

    const state = await store.tryReadState(request.task);
    if (state === undefined) return { kind: "unknown-task" };
    if (state.status !== "awaiting-human") return { kind: "not-waiting", status: state.status };

    const pending = await store.pendingQuestion(request.task);
    if (pending === undefined) {
      // `awaiting-human` with nothing unanswered is a state repo someone edited by
      // hand. Refusing beats inventing an index and burying the answer.
      return { kind: "not-waiting", status: state.status };
    }

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

    logger.info("answer.applied", { task: request.task, questionIndex: pending.index });
    return { kind: "applied", index: pending.index };
  }

  /**
   * Park a task on request — `/cancel`.
   *
   * A task running ON THIS RUNNER never reaches here: `workTask` intercepts its own
   * task's park requests while the session is in flight and aborts it, because the poll
   * loop — and with it this drain — is blocked for the whole duration of a session. That
   * path used to refuse outright, which left deleting the pod as the only way to stop a
   * session, and that in turn stranded the task (§6.2).
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
      await store.appendJournal(request.task, state.sessions, "**Parked:** cancelled from chat.");
      await this.transition(handle, state, "parked");
      await this.push(handle, `chore(${request.task}): parked from chat`);
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
      await store.appendJournal(request.task, state.sessions, "**Resumed:** from chat.");
      // `lastProgressSession` is history and stays put; only the streak is forgiven, so
      // the journal can still show how long the task has actually been stalled.
      await this.transition(
        handle,
        { ...state, progress: { ...state.progress, noProgressStreak: 0 } },
        "ready",
      );
      await this.push(handle, `chore(${request.task}): resumed from chat`);
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
    if (state.pr === undefined) return { kind: "not-mergeable", reason: "no PR was ever opened" };

    const spec = await store.readSpec(request.task).catch(() => undefined);
    if (spec === undefined) return { kind: "not-mergeable", reason: "the task has no readable spec" };
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
        await store.appendJournal(request.task, state.sessions, "**Merged** from chat.");
        await this.transition(handle, state, "done");
        await this.push(handle, `chore(${request.task}): merged from chat`);
      } catch (error) {
        // The merge already happened; failing to record it is worth a log, not a retry.
        logger.warn("merge.unrecorded", { task: request.task, ...errorFields(error) });
      }

      return { kind: "merged", prUrl: state.pr.url };
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

  private async notifyTask(state: TaskState, notification: Notification): Promise<void> {
    await this.notify(notification, state.chat?.threadId);
  }

  private async notify(notification: Notification, threadId?: string): Promise<void> {
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
    return next;
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
