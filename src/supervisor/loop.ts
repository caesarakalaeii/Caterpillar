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
  asTaskId,
  capabilitiesSatisfy,
  claimOrder,
  EMPTY_USAGE,
  isClaimable,
  repoSlug,
  type ProposedPlan,
  type SessionOutcome,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
  type WorkspaceName,
} from "../domain/task.ts";
import { brainstormId, brainstormSpec, parseRepo, resolveWorkspace } from "../plan/brainstorm.ts";
import { layer, materialise, relayer } from "../plan/materialize.ts";
import type { Maintainer, PlanRevision, PlanSibling } from "../plan/maintain.ts";
import { LeaseLostError, type Lease, type LeaseManager, startHeartbeat } from "../state/lease.ts";
import type { StateStore } from "../state/store.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import { intakeDue, type IntakePass } from "../intake/ingest.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { Notification, Notifier } from "../notify/discord.ts";
import type { ThreadIndex } from "../notify/threads.ts";
import type { ForgeFactory } from "../forge/types.ts";
import type { Council } from "../review/council.ts";
import { renderVerdict, summariseVerdict } from "../review/decide.ts";
import type { Tracker, TrackerTransition } from "../tracker/types.ts";
import type { ChatInbox, ChatOutcome, ChatRequest } from "./inbox.ts";
import { checkLimits, recordProgress, type ProgressEvidence } from "./progress.ts";
import { summarise, type TaskSnapshot } from "./snapshot.ts";

/** One task's state as read by a single sweep of the task tree. */
interface TaskRecord {
  readonly id: TaskId;
  readonly state: TaskState;
}

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
   * Requests arriving from the inbound Discord bridge (§7). Optional: without a bridge
   * a question is answered by committing the file by hand.
   */
  readonly inbox?: ChatInbox;
  /**
   * In-memory view of every task, refreshed once per poll for the chat interface.
   * Optional: nothing in the loop reads it, and without a bridge nothing needs it.
   */
  readonly snapshot?: TaskSnapshot;
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

      // Both before claiming, so a task unparked by either is claimable on this same
      // iteration rather than sitting idle until the next poll.
      await this.applyChatRequests();
      await this.maybeIngest();

      const claimed = await this.claimNext(await this.survey());
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

    snapshot?.replace(records.map((record) => summarise(record.state)));
    this.deps.threads?.replace(
      records
        .filter((record) => record.state.chat !== undefined)
        .map((record) => [record.state.chat?.threadId ?? "", record.id] as const),
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

    // Earlier waves first, then by id. Without the sort this is `readdir` order, which
    // is alphabetical and would run a plan's wave-3 task before its wave-1 sibling
    // whenever the ids happened to fall that way.
    const ordered = [...records].sort((a, b) => claimOrder(a.state, b.state));

    for (const { id, state } of ordered) {
      if (!isClaimable(state, statusOf)) continue;
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
        if (reviewed.decision === "stalled") return true;

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
    lease: Lease,
    spec: TaskSpec,
    state: TaskState,
    plan: ProposedPlan,
  ): Promise<boolean> {
    const { store, config, council, logger } = this.deps;

    const reviewed =
      council === undefined
        ? { verdict: undefined, usage: EMPTY_USAGE }
        : await council.reviewPlan(spec, state, plan);

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
    lease: Lease,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{
    readonly state: TaskState;
    readonly decision: "pass" | "changes" | "stalled";
  }> {
    const { council, store, config, metrics, logger } = this.deps;
    if (council === undefined) return { state, decision: "pass" };

    const { verdict, usage } = await council.review(spec, state);
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
  private async maintainPlan(lease: Lease, spec: TaskSpec, state: TaskState): Promise<void> {
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

  private async park(
    lease: Lease,
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

    for (const request of inbox.drain()) {
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

    const repo = parseRepo(request.repo);
    if (repo === undefined) {
      return { kind: "refused", reason: `\`${request.repo}\` is not a repo — use \`owner/name\`.` };
    }

    const profile = resolveWorkspace(config.workspaces, repo);
    if (profile === undefined) {
      return {
        kind: "refused",
        reason:
          `No workspace owns \`${repo.owner}\` on ${repo.host}, and there is more than one ` +
          `configured, so I cannot guess which credentials to use.`,
      };
    }

    const id = brainstormId(request.threadId);
    if (await store.hasTask(id)) return { kind: "started", task: id };

    const spec = brainstormSpec({
      id,
      workspace: profile.name,
      topic: request.topic,
      repo,
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

    logger.info("brainstorm.created", { task: id, workspace: profile.name, repo: repoSlug(repo) });
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
   * A RUNNING task is refused rather than interrupted. Its lease is held by whichever
   * runner is working it, possibly on another machine, and the drain happens between
   * tasks rather than during one: there is no point at which this could stop a session
   * mid-turn. Refusing says so; pretending to cancel would leave the task running and
   * the human believing it was not.
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
      await store.appendJournal(request.task, state.sessions, "**Parked:** cancelled from chat.");
      await this.transition(lease, state, "parked");
      await this.push(lease, `chore(${request.task}): parked from chat`);
      logger.info("task.cancelled", { task: request.task, previous: state.status });
      return { kind: "parked" };
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

    const merge = await this.mergeReviewed(spec, state);
    if (!merge.merged) return { kind: "not-mergeable", reason: merge.note };

    // Merging a parked task settles it: the work is on the default branch, and leaving
    // it parked would invite a human to pick up something already shipped.
    const lease = await leases.claim(request.task);
    if (lease !== undefined) {
      try {
        await store.appendJournal(request.task, state.sessions, "**Merged** from chat.");
        await this.transition(lease, state, "done");
        await this.push(lease, `chore(${request.task}): merged from chat`);
      } finally {
        await leases.release(lease).catch(() => undefined);
      }
    } else {
      // The merge already happened; failing to record it is worth a log, not a retry.
      logger.warn("merge.unrecorded", { task: request.task, reason: "task is leased elsewhere" });
    }

    return { kind: "merged", prUrl: state.pr.url };
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
