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
import type { Notifier } from "../notify/discord.ts";
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

export interface SupervisorDeps {
  readonly config: RunnerConfig;
  readonly store: StateStore;
  readonly leases: LeaseManager;
  readonly runner: SessionRunner;
  readonly verifier: Verifier;
  readonly progress: ProgressProbe;
  readonly notifier: Notifier;
  readonly metrics: AgentMetrics;
  /**
   * Trackers to mirror lifecycle changes into, by workspace (DESIGN.md §9.5).
   * Optional: a workspace without a tracker is a supported configuration.
   */
  readonly trackers?: ReadonlyMap<WorkspaceName, Tracker>;
}

export class Supervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  /** Runs until `signal` aborts. Restart-safe: all state comes from the repo. */
  async run(signal: AbortSignal): Promise<void> {
    const { config, store } = this.deps;

    while (!signal.aborted) {
      await store.pull("origin", config.stateRepo.branch);

      const claimed = await this.claimNext();
      if (claimed === undefined) {
        await sleep(config.pollSeconds * 1000);
        continue;
      }

      try {
        await this.workTask(claimed.lease, claimed.spec, signal);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          // Another runner owns this task now. Drop everything without writing.
          continue;
        }
        if (signal.aborted) throw error;

        // Any other failure belongs to the TASK, not the supervisor. Rethrowing here
        // exits the process, and because the claim is durable the restarted
        // supervisor re-claims the same task and dies again — one malformed task
        // wedges the whole runner permanently. Park it with the reason instead, so
        // the failure is visible to a human and every other task keeps moving.
        await this.parkFailed(claimed.lease, claimed.spec, error);
      }
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
    const { store, leases, config, metrics } = this.deps;

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

        const outcome = await this.deps.runner.run(spec, state);
        metrics.handoffs.inc({ task: spec.id, reason: outcome.reason });
        metrics.tokens.inc({ task: spec.id, kind: "input" }, outcome.usage.inputTokens);
        metrics.tokens.inc({ task: spec.id, kind: "output" }, outcome.usage.outputTokens);
        metrics.cost.inc({ task: spec.id }, outcome.usage.costUsd);

        state = await this.recordSession(heartbeat.current(), spec, state, outcome);

        const done = await this.applyOutcome(heartbeat.current(), spec, state, outcome);
        if (done) return;
      }
    } finally {
      heartbeat.stop();
      const current = heartbeat.current();
      await leases.release(current).catch(() => undefined);
    }
  }

  /** Persist the journal and usage for a finished session. */
  private async recordSession(
    lease: Lease,
    spec: TaskSpec,
    state: TaskState,
    outcome: SessionOutcome,
  ): Promise<TaskState> {
    const { store, config, metrics } = this.deps;

    const session = state.sessions + 1;
    const evidence = await this.deps.progress.probe(spec, state);
    const progress = recordProgress(state.progress, session, evidence);

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
    const { store, notifier } = this.deps;

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
        await store.writeQuestion(spec.id, index, question);
        await this.transition(lease, state, "awaiting-human");
        await this.push(lease, `chore(${spec.id}): awaiting human input`);
        await this.mirror(spec, { kind: "question", question });
        await notifier.notify({
          kind: "question",
          task: spec.id,
          question,
          phase: state.phase,
        });
        return true;
      }

      case "done-claimed": {
        const result = await this.deps.verifier.verify(spec, state);
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
        await this.mirror(spec, { kind: "completed", prUrl });
        await notifier.notify({ kind: "done", task: spec.id, prUrl });
        return true;
      }

      case "limit":
        await this.park(lease, spec, state, outcome.summary);
        return true;

      case "error":
        await this.transition(lease, state, "failed");
        await this.push(lease, `chore(${spec.id}): failed`);
        await notifier.notify({
          kind: "failed",
          task: spec.id,
          error: outcome.error ?? outcome.summary,
        });
        return true;
    }
  }

  private async park(
    lease: Lease,
    spec: TaskSpec,
    state: TaskState,
    reason: string,
  ): Promise<void> {
    const { store, notifier } = this.deps;
    await store.appendJournal(spec.id, state.sessions, `**Parked:** ${reason}`);
    await this.transition(lease, state, "parked");
    await this.push(lease, `chore(${spec.id}): parked`);
    await this.mirror(spec, { kind: "parked", reason });
    await notifier.notify({ kind: "parked", task: spec.id, reason });
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
      const detail = parkError instanceof Error ? parkError.message : String(parkError);
      process.stderr.write(
        `${spec.id}: session failed and the task could not be parked (${detail}) — ` +
          `original error: ${reason}\n`,
      );
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
      process.stderr.write(
        `${spec.id}: tracker ref is '${ref.kind}' but workspace '${spec.workspace}' ` +
          `has '${tracker.kind}' — not mirroring\n`,
      );
      return;
    }

    try {
      await tracker.transition(ref, transition, spec.id);
    } catch (error) {
      process.stderr.write(
        `${spec.id}: mirroring '${transition.kind}' to ${tracker.kind} failed: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
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
