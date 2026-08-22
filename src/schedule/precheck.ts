/**
 * The precheck: one bounded command, run before a session is started. See DESIGN.md §22.
 *
 * This is the cheap answer to the residual §11.1 admits. Work whose only blocker is
 * external state — no dependency updates this week, no stale branches, no drifted docs —
 * currently costs a whole session to discover there was nothing to do, and §11.1 then
 * scores that session honestly as no progress. A command that exits non-zero costs a
 * second.
 *
 * It runs in the environment the SESSION would have had: the task's worktree, and the
 * toolchain the resolver produces for the same spec (§8.1). Anything else answers a
 * question about a different machine than the one that would do the work — a precheck that
 * says "no updates" from an environment without the package manager is not a fact about the
 * repository.
 *
 * Separate from `ScheduleRunner` because it is the only part of this subsystem that touches
 * a checkout. Keeping the runner free of the workspace layer is what lets its claim-and-
 * release logic be tested with fakes rather than with a git mirror.
 */
import { execFile } from "node:child_process";
import { asTaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import {
  TASK_SHELL_ARGS,
  type ResolvedEnv,
  type ToolchainResolver,
} from "../workspace/toolchain.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { renderScheduleSpec, type PrecheckResult, type PrecheckRunner } from "./run.ts";
import type { Schedule } from "./definition.ts";

export interface PrecheckDeps {
  readonly worktrees: WorktreeManager;
  /**
   * The same resolver a session and the acceptance gate use. A precheck run in a shell the
   * task will never see is a check about nothing (`workspace/toolchain.ts`).
   */
  readonly toolchain: ToolchainResolver;
  readonly logger: Logger;
}

/** How much of the command's output the ledger keeps. Enough to say why, not a build log. */
const DETAIL_CHARS = 2000;

/**
 * The occurrence id a precheck's worktree and environment are resolved against.
 *
 * A precheck happens BEFORE any occurrence has been decided, so there is no real one to
 * use — and using the occurrence that triggered it would give every occurrence its own
 * worktree, which is a fresh clone per morning for a check that is meant to be cheap. One
 * stable directory per schedule instead, reused and left in place; `maybeReapWorktrees`
 * sweeps it like any other once nothing claims it (§3.1).
 */
const PRECHECK_OCCURRENCE = "precheck";

/**
 * Build the `PrecheckRunner` the supervisor hands to `ScheduleRunner`.
 *
 * A THROW means the question could not be asked — no worktree, no toolchain — and the
 * caller reads it as "leave this occurrence to a runner that can". A returned `ok: false`
 * means the question was asked and answered no.
 */
export const schedulePrecheck = (deps: PrecheckDeps): PrecheckRunner => {
  return async (schedule: Schedule, signal?: AbortSignal): Promise<PrecheckResult> => {
    const precheck = schedule.precheck;
    if (precheck === undefined) {
      // The caller checks this before calling. Reaching here means the two have gone out of
      // step, and answering `ok: true` would fire every occurrence of every schedule
      // without consulting anything — a silent removal of the gate.
      throw new Error(`schedule '${schedule.id}' has no precheck to run`);
    }

    const repo = schedule.repos[0];
    if (repo === undefined) {
      // Unreachable: `parseSchedule` requires at least one repo. Stated rather than
      // asserted with a `!`, because the alternative is a `cwd` of `undefined`.
      throw new Error(`schedule '${schedule.id}' declares no repos`);
    }

    const task = asTaskId(`SCHED-${schedule.id}-${PRECHECK_OCCURRENCE}`);
    const worktree = await deps.worktrees.ensureWorktree(repo, task);
    const environment = await deps.toolchain.resolve(
      renderScheduleSpec(task, schedule, PRECHECK_OCCURRENCE),
      worktree,
    );

    const result = await runPrecheck(precheck.command, worktree, environment, {
      timeoutMs: precheck.timeoutSeconds * 1000,
      ...(signal === undefined ? {} : { signal }),
    });

    deps.logger.debug("schedule.precheck", {
      schedule: schedule.id,
      code: result.code,
      ok: result.code === 0,
    });

    return {
      ok: result.code === 0,
      detail:
        result.output.length === 0
          ? `exit ${result.code} (no output)`
          : `exit ${result.code}: ${result.output.slice(-DETAIL_CHARS)}`,
    };
  };
};

/**
 * Run one command, bounded, and never throw for its exit code.
 *
 * The timeout is a requirement rather than caution: this runs on the housekeeping loop,
 * which the chat drain, intake, the digest and the task survey share (§6.4). An unbounded
 * precheck holds every one of them. A killed command is reported as a non-zero exit and
 * therefore as "no" — a check that cannot answer within its own budget has not established
 * that there is work to do, and firing the occurrence on a timeout would make the slowest
 * possible precheck the one that always passes.
 */
const runPrecheck = (
  command: string,
  cwd: string,
  toolchain: ResolvedEnv,
  bounds: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolve) => {
    execFile(
      toolchain.shell,
      [...TASK_SHELL_ARGS, command],
      {
        cwd,
        env: toolchain.env,
        timeout: bounds.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(bounds.signal === undefined ? {} : { signal: bounds.signal }),
      },
      (error, stdout, stderr) => {
        // `execFile` reports a timeout or an abort with a SIGNAL and no numeric code, which
        // would otherwise read as exit 0. Anything that is not a clean exit is a non-zero
        // one here — see the note above about which way a timeout has to fall.
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        const killed = error !== null && typeof error.code !== "number";
        const output = `${stdout}\n${stderr}`.trim();
        // Named, because "exit 1" with a truncated build log is the least useful thing a
        // ledger entry could say about a precheck that never finished: the fix for a slow
        // one is a bigger `timeoutSeconds` or a cheaper command, and neither is suggested
        // by an exit code.
        const why =
          bounds.signal?.aborted === true
            ? "the runner is shutting down"
            : `it timed out after ${Math.round(bounds.timeoutMs / 1000)}s`;
        resolve({
          code,
          output: killed ? `${output}\n(the precheck was stopped: ${why})`.trim() : output,
        });
      },
    );
  });
