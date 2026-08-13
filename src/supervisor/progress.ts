/**
 * Progress and budget limits. See DESIGN.md §11.1 and the Budget decision in §2.
 *
 * Two limits are enforced: max sessions per task, and the no-progress detector.
 * Hitting either PARKS the task for review rather than killing it — the work done
 * so far stays on the branch and in the journal.
 *
 * The no-progress detector is the one that catches the failure the others miss: an
 * agent burning tokens for hours while going in circles. Session count alone cannot
 * distinguish steady progress from thrashing.
 */
import type { ProgressRecord, TaskLimits, TaskState } from "../domain/task.ts";

/** Evidence that a session accomplished something measurable. */
export interface ProgressEvidence {
  /** A new commit landed on the task branch. */
  readonly committed: boolean;
  /** An acceptance command that previously failed now passes. */
  readonly acceptanceImproved: boolean;
  /** The agent recorded a completed step in the journal. */
  readonly stepCompleted: boolean;
  /** Branch head observed now — carried into the record as the next baseline. */
  readonly headOid?: string;
}

export const madeProgress = (evidence: ProgressEvidence): boolean =>
  evidence.committed || evidence.acceptanceImproved || evidence.stepCompleted;

export type LimitVerdict =
  | { readonly kind: "continue" }
  | { readonly kind: "park"; readonly reason: string };

export interface LimitOptions {
  readonly noProgressLimit: number;
}

/**
 * Fold a session's evidence into the progress record.
 *
 * `lastProgressSession` tracks the high-water mark so the journal can show how long
 * a task has been stalled, not merely that it is stalled now.
 */
export const recordProgress = (
  previous: ProgressRecord,
  session: number,
  evidence: ProgressEvidence,
): ProgressRecord => {
  const head =
    evidence.headOid ?? previous.lastHeadOid;
  const base = madeProgress(evidence)
    ? { lastProgressSession: session, noProgressStreak: 0 }
    : {
        lastProgressSession: previous.lastProgressSession,
        noProgressStreak: previous.noProgressStreak + 1,
      };

  return { ...base, ...(head !== undefined ? { lastHeadOid: head } : {}) };
};

/** Decide whether a task may start another session. */
export const checkLimits = (
  state: TaskState,
  limits: TaskLimits,
  options: LimitOptions,
): LimitVerdict => {
  if (state.sessions >= limits.maxSessions) {
    return {
      kind: "park",
      reason:
        `reached the session limit (${limits.maxSessions}). A task needing this many ` +
        `fresh contexts is usually mis-scoped rather than merely large.`,
    };
  }

  if (state.progress.noProgressStreak >= options.noProgressLimit) {
    return {
      kind: "park",
      reason:
        `${state.progress.noProgressStreak} consecutive sessions made no measurable ` +
        `progress (no commit, no newly passing acceptance command, no completed step). ` +
        `Last progress was session ${state.progress.lastProgressSession}.`,
    };
  }

  return { kind: "continue" };
};
