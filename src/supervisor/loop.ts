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
} from "../domain/task.ts";
import { LeaseLostError, type Lease, type LeaseManager, startHeartbeat } from "../state/lease.ts";
import type { StateStore } from "../state/store.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import type { Notifier } from "../notify/discord.ts";
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
  verify(spec: TaskSpec): Promise<{ readonly passed: boolean; readonly detail: string; readonly prUrl?: string }>;
}

export interface ProgressProbe {
  /** Gathers evidence that the last session accomplished something. */
  probe(spec: TaskSpec): Promise<ProgressEvidence>;
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
        throw error;
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
    const evidence = await this.deps.progress.probe(spec);
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
        await notifier.notify({
          kind: "question",
          task: spec.id,
          question,
          phase: state.phase,
        });
        return true;
      }

      case "done-claimed": {
        const result = await this.deps.verifier.verify(spec);
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
        await notifier.notify({
          kind: "done",
          task: spec.id,
          prUrl: result.prUrl ?? "(no PR recorded)",
        });
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
    await notifier.notify({ kind: "parked", task: spec.id, reason });
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
