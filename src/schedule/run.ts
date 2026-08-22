/**
 * Turning an occurrence into a task, exactly once in the fleet. See DESIGN.md §22.
 *
 * Every runner reaches 09:00 at the same instant and every one of them can read the whole
 * state repo, so this is a race by construction. It is settled with the mechanism §5 proved
 * and §19 reused: `refs/schedules/<id>/<occurrence>` is created by a compare-and-swap
 * against an empty expected value, which exactly one push in the fleet can win. Nothing
 * renews it and nothing steals it — an occurrence that has been served does not become
 * unserved.
 *
 * The asymmetry it is shaped around is the digest's, restated for a schedule. Firing twice
 * is visible: two tasks, two branches, and a human who can see both. Firing NEVER is
 * silent: the ref says the occurrence is settled, no task exists, and nobody finds out
 * until they wonder why the Monday audit stopped happening. So the claim is taken before
 * the task is created and released again whenever creating it failed, and a failed CAS is
 * never read as "someone else did it" without asking whether the ref is there — a rejected
 * push is also what a dead network looks like.
 *
 * It runs on the HOUSEKEEPING loop, so it is deliberately cheap and deliberately bounded:
 * one occurrence per schedule per pass, no listener, no port, no Deployment (§22).
 */
import { EMPTY_USAGE, type TaskId, type TaskSpec, type TaskState } from "../domain/task.ts";
import type { Notifier } from "../notify/discord.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { ScheduleListing, ScheduleRecord } from "../state/store.ts";
import { scheduleTaskId, type Schedule } from "./definition.ts";
import { dueOccurrences, occurrenceId } from "./occurrence.ts";

/**
 * The marker ref for one occurrence. Never deleted once the occurrence is settled.
 *
 * Two path components rather than one flattened name, so `git for-each-ref
 * refs/schedules/<id>` answers "what has this schedule done" without a string match.
 */
export const scheduleRef = (schedule: string, occurrence: string): string =>
  `refs/schedules/${schedule}/${occurrence}`;

/** What a precheck decided. `detail` is recorded in the ledger either way. */
export interface PrecheckResult {
  /** True when the command exited 0 and the occurrence should become a task. */
  readonly ok: boolean;
  /** The exit code and the tail of the output, or why there was no output. */
  readonly detail: string;
}

/**
 * Runs a schedule's precheck in the task's toolchain environment.
 *
 * Injected rather than built here, for `digest/publish.ts`'s reason applied to a shell: the
 * command needs a worktree, a resolved nix environment and a timeout, all of which live in
 * the supervisor's workspace layer — and a class that reached into them could not be tested
 * without a checkout. A THROW from this means the precheck could not be run at all, which
 * is not the same answer as `ok: false` and is not treated as one.
 */
export type PrecheckRunner = (
  schedule: Schedule,
  signal?: AbortSignal,
) => Promise<PrecheckResult>;

/** The part of `StateStore` this path uses, written out for `AlertStore`'s reason. */
export interface ScheduleStore {
  listSchedules(): Promise<ScheduleListing>;
  hasTask(id: TaskId): Promise<boolean>;
  countOpenScheduleTasks(schedule: string): Promise<number>;
  readScheduleRecord(schedule: string, occurrence: string): Promise<ScheduleRecord | undefined>;
  writeScheduleRecord(
    schedule: string,
    occurrence: string,
    record: ScheduleRecord,
  ): Promise<void>;
  writeState(state: TaskState): Promise<void>;
  writeSpec(spec: TaskSpec): Promise<void>;
  commitAndPush(message: string, remote: string, branch: string): Promise<void>;
}

/** The claim protocol, narrowed to what firing needs from `LeaseManager`. */
export interface ScheduleClaim {
  claimOnce(ref: string, message: string): Promise<string | undefined>;
  hasRef(ref: string): Promise<boolean>;
  releaseRef(ref: string, oid: string): Promise<void>;
}

export interface ScheduleRunnerOptions {
  readonly store: ScheduleStore;
  readonly leases: ScheduleClaim;
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly runner: string;
  readonly branch: string;
  /** Session cap stamped into each new task's `state.json`, as at intake. */
  readonly maxSessionsPerTask: number;
  /** Absent means every schedule's precheck is skipped and every occurrence fires. */
  readonly precheck?: PrecheckRunner;
  /** Counts occurrences by outcome, for a metric. */
  readonly onSettled?: (schedule: string, outcome: ScheduleRecord["outcome"]) => void;
}

export class ScheduleRunner {
  private readonly options: ScheduleRunnerOptions;

  /**
   * Whether this runner has settled an occurrence whose push has not landed.
   *
   * In memory, and that is the right scope: it exists only to make the NEXT pass call
   * `commitAndPush` again, and a restarted process reaches the same state through
   * `StateStore`'s own retry — its `stageCommitPush` pushes on a clean tree precisely
   * because a rejected push leaves the commit local.
   */
  private unpushed = false;

  constructor(options: ScheduleRunnerOptions) {
    this.options = options;
  }

  /**
   * Fire whatever is due. Never throws.
   *
   * One occurrence per schedule per pass, because `dueOccurrences` returns at most one —
   * see `CATCH_UP_OCCURRENCES`. Several SCHEDULES may fire in the same pass, and that is
   * not the same thing: they are independent units of work whose triggers happen to
   * coincide, and deferring one of them to the next pass would silently make a fleet with
   * six 09:00 schedules take six housekeeping intervals to start them.
   */
  async maybeFire(now: Date, signal?: AbortSignal): Promise<void> {
    const { store, logger } = this.options;

    let listing: ScheduleListing;
    try {
      listing = await store.listSchedules();
    } catch (error) {
      // A read of the state repo that fails is an IO problem the next pass may survive.
      // Nothing is written and nothing is claimed.
      logger.warn("schedule.list-failed", errorFields(error));
      return;
    }

    let fired = 0;
    let skipped = 0;
    let refused = 0;
    let changed = false;

    for (const schedule of listing.schedules) {
      if (signal?.aborted === true) break;
      if (!schedule.enabled) continue;

      for (const at of dueOccurrences(now, schedule.trigger)) {
        let outcome: ScheduleRecord["outcome"] | "nothing";
        try {
          outcome = await this.attempt(schedule, at, signal);
        } catch (error) {
          // One schedule that cannot be settled must not cost the others, and must never
          // cost the housekeeping pass: the loop has chat to drain and tasks to survey
          // either way.
          logger.error("schedule.failed", {
            schedule: schedule.id,
            occurrence: occurrenceId(at),
            ...errorFields(error),
          });
          continue;
        }

        if (outcome === "nothing") continue;
        this.options.onSettled?.(schedule.id, outcome);
        changed = true;
        if (outcome === "fired") fired += 1;
        if (outcome === "skipped") skipped += 1;
        if (outcome === "refused") refused += 1;
      }
    }

    // Committed once per pass rather than per occurrence: six schedules firing at 09:00
    // should be one push, and the state repo's history should read as scheduling events.
    //
    // `unpushed` is the second reason to commit, and it is what stops a rejected push from
    // stranding a task on one runner's disk. `commitAndPush` deliberately pushes even when
    // the tree is clean, because after a rejection the commit is local and nothing else will
    // send it — but only a CALL can do that, and an idle pass makes none. So a failure is
    // remembered until a push succeeds.
    if (changed || this.unpushed) {
      if (changed) logger.info("schedule.pass", { fired, skipped, refused });
      try {
        await store.commitAndPush(
          fired > 0
            ? `chore(schedules): fire ${fired} occurrence(s)`
            : "chore(schedules): record occurrences",
          "origin",
          this.options.branch,
        );
        this.unpushed = false;
      } catch (error) {
        // Nothing is rolled back and no claim is released. The tasks are written and their
        // claims are held, so the occurrences ARE settled here; what failed is publishing
        // the fact. Releasing the claims would be worse — it would invite a second runner to
        // create tasks this one has already written — and the retry above is what makes
        // keeping them safe rather than merely convenient.
        this.unpushed = true;
        logger.error("schedule.push-failed", errorFields(error));
      }
    }
  }

  /**
   * Settle one occurrence of one schedule.
   *
   * `"nothing"` means this pass did not settle it and did not need to: it is already
   * settled, it belongs to another runner, or the claim could not be established and the
   * occurrence stays available.
   */
  private async attempt(
    schedule: Schedule,
    at: Date,
    signal?: AbortSignal,
  ): Promise<ScheduleRecord["outcome"] | "nothing"> {
    const { store, leases, logger } = this.options;
    const occurrence = occurrenceId(at);

    const task = scheduleTaskId(schedule.id, occurrence);
    if (task === undefined) {
      // Unreachable through `listSchedules`, which validates the id, and refused here
      // anyway: this is the last point before a string becomes a directory name.
      logger.warn("schedule.bad-id", { schedule: schedule.id, occurrence });
      return "nothing";
    }

    // The two LOCAL answers first, cheapest first. Both are on disk in a checkout this
    // runner already has, so a settled occurrence costs no network at all — which matters
    // because this runs every housekeeping pass for as long as the occurrence is within
    // the catch-up window.
    if ((await store.readScheduleRecord(schedule.id, occurrence)) !== undefined) return "nothing";
    if (await store.hasTask(task)) {
      logger.debug("schedule.exists", { task, schedule: schedule.id });
      return "nothing";
    }

    const ref = scheduleRef(schedule.id, occurrence);
    const oid = await leases
      .claimOnce(ref, `schedule ${schedule.id} ${occurrence} runner=${this.options.runner}`)
      .catch(() => undefined);

    if (oid === undefined) {
      // A failed CAS cannot distinguish a lost race from a dead network — both are a
      // rejected push — so the ref's existence is what answers it. Getting this backwards
      // would write off an occurrence nobody fired.
      const taken = await leases.hasRef(ref).catch(() => false);
      logger.debug(taken ? "schedule.claimed-elsewhere" : "schedule.claim-failed", {
        schedule: schedule.id,
        occurrence,
      });
      return "nothing";
    }

    try {
      return await this.settle(schedule, occurrence, task, signal);
    } catch (error) {
      // Hand the occurrence back. A claimed-but-unfired occurrence is invisible, and the
      // next pass — or another runner — must be able to try again.
      await leases.releaseRef(ref, oid).catch(() => undefined);
      throw error;
    }
  }

  /** With the claim held: decide, write, and record. */
  private async settle(
    schedule: Schedule,
    occurrence: string,
    task: TaskId,
    signal?: AbortSignal,
  ): Promise<ScheduleRecord["outcome"]> {
    const { store, logger } = this.options;

    const open = await store.countOpenScheduleTasks(schedule.id);
    if (open >= schedule.maxOpenTasks) {
      return await this.record(schedule, occurrence, {
        schedule: schedule.id,
        occurrence,
        outcome: "refused",
        detail:
          `\`${schedule.id}\` already has ${open} open task(s) and allows ` +
          `${schedule.maxOpenTasks}. The work from the last occurrence is the work.`,
      });
    }

    if (schedule.precheck !== undefined) {
      if (this.options.precheck === undefined) {
        // A schedule that declares a gate and a runner that cannot run one: firing anyway
        // would ignore the operator's condition, and recording a skip would write off an
        // occurrence over a fact about this process. Throw, so the claim goes back and a
        // runner that can answer gets the occurrence.
        throw new Error(
          `schedule '${schedule.id}' declares a precheck and this runner cannot run one`,
        );
      }
      // A throw is deliberately NOT caught here: it means the precheck could not be run —
      // no worktree, no toolchain — which is not evidence about the work, so the caller
      // releases the claim and leaves the occurrence to a runner that can answer.
      const result = await this.options.precheck(schedule, signal);
      if (!result.ok) {
        logger.info("schedule.precheck-skipped", {
          schedule: schedule.id,
          occurrence,
          detail: result.detail,
        });
        return await this.record(schedule, occurrence, {
          schedule: schedule.id,
          occurrence,
          outcome: "skipped",
          detail: result.detail,
        });
      }
    }

    const spec = renderScheduleSpec(task, schedule, occurrence);
    const now = new Date().toISOString();

    // ORDER IS LOAD-BEARING, exactly as at intake (§14.2) and on the alert path (§20):
    // state first, spec last, because `hasTask` keys on `spec.md`. A crash between the two
    // leaves a half-written task the claim loop skips rather than one it claims and cannot
    // read.
    //
    // The ledger entry comes AFTER both, and that ordering is forced by the release path: a
    // write that throws hands the claim back, and a "fired" record already on disk would
    // then stop this runner — and only this runner, since the record is unpushed — from ever
    // retrying the occurrence. So the record means "this occurrence is settled and needs no
    // retry", which is exactly what a released claim is not.
    await store.writeState({
      id: task,
      status: "ready",
      phase: "planning",
      requires: spec.requires,
      sessions: 0,
      limits: { maxSessions: this.options.maxSessionsPerTask },
      usage: EMPTY_USAGE,
      progress: { lastProgressSession: 0, noProgressStreak: 0 },
      createdAt: now,
      updatedAt: now,
    } satisfies TaskState);
    await store.writeSpec(spec);

    logger.info("schedule.fired", {
      task,
      schedule: schedule.id,
      occurrence,
      workspace: schedule.workspace,
      acceptance: schedule.acceptance.length,
    });

    const outcome = await this.record(schedule, occurrence, {
      schedule: schedule.id,
      occurrence,
      outcome: "fired",
      task,
    });

    await this.notify(schedule, occurrence, task);
    return outcome;
  }

  private async record(
    schedule: Schedule,
    occurrence: string,
    record: ScheduleRecord,
  ): Promise<ScheduleRecord["outcome"]> {
    await this.options.store.writeScheduleRecord(schedule.id, occurrence, record);
    return record.outcome;
  }

  /** A notification that fails is logged and forgotten: the record in git is the truth. */
  private async notify(schedule: Schedule, occurrence: string, task: TaskId): Promise<void> {
    try {
      await this.options.notifier.notify({
        kind: "schedule-task",
        task,
        schedule: schedule.id,
        occurrence,
      });
    } catch (error) {
      this.options.logger.warn("schedule.notify-failed", {
        schedule: schedule.id,
        ...errorFields(error),
      });
    }
  }
}

/**
 * The spec one occurrence becomes.
 *
 * Pure, so the one thing worth asserting about it — that the operator's prompt, repos and
 * acceptance commands arrive verbatim — is testable without a store.
 *
 * `kind` is deliberately absent, which means `implement` (§4.1). A scheduled task writes
 * code, opens a pull request and is gated by §12 exactly as a tracker-sourced one is;
 * nothing about its origin changes what the session must be told, so there is no fourth
 * task kind to select a system prompt with. That is the difference from `remediation`,
 * whose whole reason for existing as a kind is a brief about a cluster it must not write.
 */
export const renderScheduleSpec = (
  task: TaskId,
  schedule: Schedule,
  occurrence: string,
): TaskSpec => ({
  id: task,
  workspace: schedule.workspace,
  // Verbatim from the schedule, all three. The operator wrote them, and a runner that
  // synthesised acceptance commands would be writing the completion gate of a task it also
  // created — the one thing §12 exists to keep out of the fleet's own hands.
  repos: schedule.repos,
  requires: schedule.requires,
  acceptance: schedule.acceptance,
  goal: [
    schedule.prompt.trim(),
    "",
    "---",
    "",
    `This task was created by the schedule \`${schedule.id}\` for its ${occurrence} ` +
      `occurrence (${schedule.trigger.cron}, ${schedule.trigger.timeZone}).`,
    "",
    "Nobody is waiting on it, and there may be nothing to do. If the repository does not",
    "need the change this schedule is about, say so and stop — a pull request opened to",
    "have something to show for the session is worse than none, and the review council",
    "reads for exactly that.",
  ].join("\n"),
});
