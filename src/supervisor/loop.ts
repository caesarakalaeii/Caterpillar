/**
 * The supervisor loop. See DESIGN.md §6.
 *
 * One task at a time per runner. Scale by adding replicas — the git-ref leasing
 * already makes that safe (DESIGN.md §2, Concurrency).
 *
 * Invariants this loop is responsible for:
 *   - never run a session without a held lease
 *   - verify lease ownership before every state push (fencing, §5.1)
 *   - never let the agent decide it is done (§12)
 *   - always persist the journal before exiting, including on error
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { RunnerConfig } from "../config/types.ts";
import {
  addUsage,
  capabilitiesSatisfy,
  type SessionOutcome,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
  type WorkspaceName,
} from "../domain/task.ts";
import { LeaseLostError, type Lease, type LeaseManager, startHeartbeat } from "../state/lease.ts";
import type { StateStore } from "../state/store.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import { intakeDue, type IntakePass } from "../intake/ingest.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { Notification, Notifier } from "../notify/discord.ts";
import type { Tracker, TrackerTransition } from "../tracker/types.ts";
import { checkLimits, recordProgress, type ProgressEvidence } from "./progress.ts";

export interface SessionRunner {
  /** Runs one session and returns why it stopped. Never mutates task state. */
  run(spec: TaskSpec, state: TaskState): Promise<SessionOutcome>;
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
   * Tracker → task ingestion. Optional: a runner with no trackers configured, or one
   * fed only by hand-committed specs (§14.4), does not need it.
   */
  readonly intake?: Intake;
  /**
   * Trackers to mirror lifecycle changes into, by workspace (DESIGN.md §9.5).
   * Optional: a workspace without a tracker is a supported configuration.
   */
  readonly trackers?: ReadonlyMap<WorkspaceName, Tracker>;
}

export class Supervisor {
  /** 0 means "never ran", so the first pass happens at boot. */
  private lastIntakeAt = 0;

  private readonly deps: SupervisorDeps;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
  }

  /** Runs until `signal` aborts. Restart-safe: all state comes from the repo. */
  async run(signal: AbortSignal): Promise<void> {
    const { config, store, logger } = this.deps;

    logger.info("supervisor.start", {
      runner: config.runnerId,
      capabilities: config.capabilities.join(","),
      pollSeconds: config.pollSeconds,
    });

    while (!signal.aborted) {
      await store.pull("origin", config.stateRepo.branch);

      // Before claiming, so an item ingested now is claimable on this same iteration.
      await this.maybeIngest();

      const claimed = await this.claimNext();
      if (claimed === undefined) {
        // Debug, not info: at the default poll interval this is the single noisiest
        // line the supervisor could emit, and an idle runner is not news.
        logger.debug("poll.idle", { pollSeconds: config.pollSeconds });
        await sleep(config.pollSeconds * 1000);
        continue;
      }

      try {
        await this.workTask(claimed.lease, claimed.spec, signal);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          // Another runner owns this task now. Drop everything without writing.
          logger.warn("lease.lost", { task: claimed.spec.id, ...errorFields(error) });
          continue;
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
  }

  /**
   * Run an intake pass if one is due.
   *
   * Rate-limited independently of the poll interval — see `intakeDue` for the arithmetic.
   * Failures never propagate: intake is best-effort and the state repo is authoritative,
   * so a tracker outage must not stop the supervisor from working tasks it already has.
   */
  private async maybeIngest(): Promise<void> {
    const { intake, config, logger } = this.deps;
    if (intake === undefined) return;
    if (!intakeDue(this.lastIntakeAt, Date.now(), config.intake.intervalSeconds)) return;

    // Stamped BEFORE the pass, not after: a pass that throws must still wait out the
    // interval, or a tracker returning errors would be retried on every poll — the exact
    // request storm the interval exists to prevent.
    this.lastIntakeAt = Date.now();

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

  /** First claimable task whose requirements this runner satisfies. */
  private async claimNext(): Promise<{ readonly lease: Lease; readonly spec: TaskSpec } | undefined> {
    const { store, leases, config } = this.deps;

    for (const id of await store.listTasks()) {
      const state = await store.readState(id).catch(() => undefined);
      if (state === undefined || state.status !== "ready") continue;
      if (!capabilitiesSatisfy(config.capabilities, state.requires)) continue;

      const spec = await store.readSpec(id).catch(() => undefined);
      if (spec === undefined) continue;

      const lease = await leases.claim(id);
      if (lease === undefined) continue;

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
   * The heartbeat runs for the whole duration; if it fails, `abortOnLeaseLoss` fires
   * and the next lease check throws, unwinding without writing anything.
   */
  private async workTask(lease: Lease, spec: TaskSpec, signal: AbortSignal): Promise<void> {
    const { store, leases, config, metrics, logger } = this.deps;

    let lost: LeaseLostError | undefined;
    const heartbeat = startHeartbeat(
      leases,
      lease,
      config.lease.heartbeatSeconds,
      (error) => {
        lost = error;
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
          await this.park(heartbeat.current(), spec, state, verdict.reason);
          return;
        }

        state = await this.transition(heartbeat.current(), state, "running");
        metrics.sessions.inc({ task: spec.id });

        logger.info("session.start", {
          task: spec.id,
          session: state.sessions + 1,
          phase: state.phase,
        });

        const outcome = await this.deps.runner.run(spec, state);

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

        state = await this.recordSession(heartbeat.current(), spec, state, outcome);

        const done = await this.applyOutcome(heartbeat.current(), spec, state, outcome);
        if (done) return;
      }
    } catch (error) {
      // Parking happens HERE rather than in the caller, because the `finally` below
      // releases the lease on the way out and `park` -> `push` -> `assertHeld` would
      // then fail against a ref that no longer exists — every park after a session
      // error died with "lease is no longer held by this runner", leaving the task
      // `ready` to be re-claimed and to fail again on the very next poll.
      //
      // The heartbeat is stopped FIRST so the lease oid stops moving underneath the
      // CAS, and the CURRENT lease is used, not the one claim returned: heartbeats
      // have renewed it since, so the original oid is already stale.
      heartbeat.stop();
      if (error instanceof LeaseLostError) throw error;
      if (signal.aborted) throw error;
      await this.parkFailed(heartbeat.current(), spec, error);
    } finally {
      heartbeat.stop();
      await leases.release(heartbeat.current()).catch(() => undefined);
    }
  }

  /** Persist the journal and usage for a finished session. */
  private async recordSession(
    lease: Lease,
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
    lease: Lease,
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
        await this.notify({ kind: "question", task: spec.id, question, phase: state.phase });
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

        await this.transition(lease, state, "done");
        await this.push(lease, `chore(${spec.id}): done`);
        // Mirrored only here, after both §12 gates passed and git already says done.
        const prUrl = result.prUrl ?? state.pr?.url ?? "(no PR recorded)";
        logger.info("task.done", { task: spec.id, sessions: state.sessions, prUrl });
        await this.mirror(spec, { kind: "completed", prUrl });
        await this.notify({ kind: "done", task: spec.id, prUrl });
        return true;
      }

      case "limit":
        await this.park(lease, spec, state, outcome.summary);
        return true;

      case "error":
        logger.error("task.failed", {
          task: spec.id,
          session: state.sessions,
          error: outcome.error ?? outcome.summary,
        });
        await this.transition(lease, state, "failed");
        await this.push(lease, `chore(${spec.id}): failed`);
        await this.notify({ kind: "failed", task: spec.id, error: outcome.error ?? outcome.summary });
        return true;
    }
  }

  private async park(
    lease: Lease,
    spec: TaskSpec,
    state: TaskState,
    reason: string,
  ): Promise<void> {
    const { store, logger } = this.deps;
    logger.warn("task.parked", { task: spec.id, sessions: state.sessions, reason });
    await store.appendJournal(spec.id, state.sessions, `**Parked:** ${reason}`);
    await this.transition(lease, state, "parked");
    await this.push(lease, `chore(${spec.id}): parked`);
    await this.mirror(spec, { kind: "parked", reason });
    await this.notify({ kind: "parked", task: spec.id, reason });
  }

  /**
   * Park a task whose session raised an error the supervisor cannot attribute.
   *
   * Best-effort by design: if parking ITSELF fails — an unreachable state repo, a lost
   * network — this logs and returns rather than throwing. Propagating here would exit
   * the process and reintroduce exactly the crash loop it exists to prevent.
   */
  private async parkFailed(lease: Lease, spec: TaskSpec, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    try {
      const state = await this.deps.store.readState(spec.id);
      await this.park(lease, spec, state, `session failed: ${reason}`);
    } catch (parkError) {
      this.deps.logger.error("task.park-failed", {
        task: spec.id,
        originalError: reason,
        ...errorFields(parkError),
      });
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
  private async notify(notification: Notification): Promise<void> {
    try {
      await this.deps.notifier.notify(notification);
    } catch (error) {
      this.deps.logger.warn("notify.failed", {
        task: notification.task,
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
    lease: Lease,
    state: TaskState,
    status: TaskStatus,
  ): Promise<TaskState> {
    const next: TaskState = {
      ...state,
      status,
      owner: {
        runner: lease.runner,
        leaseOid: lease.oid,
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
  private async push(lease: Lease, message: string): Promise<void> {
    await this.deps.leases.assertHeld(lease);
    await this.deps.store.commitAndPush(
      message,
      "origin",
      this.deps.config.stateRepo.branch,
    );
  }
}

/** Convenience for callers that want to know whether a status is terminal. */
export const isTerminal = (status: TaskStatus): boolean =>
  status === "done" || status === "failed" || status === "parked";

export type { TaskId };
