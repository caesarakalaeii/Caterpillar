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
import type {
  ProgressRecord,
  SessionExitReason,
  TaskLimits,
  TaskState,
} from "../domain/task.ts";

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
  /**
   * What `committed` was actually decided against: the previous session's head, or the
   * branch's fork point on a first session. Reported so a "no progress" park can be
   * told apart from a probe that compared against the wrong thing — the failure mode
   * that made a productive first session look like a stall.
   */
  readonly baselineOid?: string;
}

export const madeProgress = (evidence: ProgressEvidence): boolean =>
  evidence.committed || evidence.acceptanceImproved || evidence.stepCompleted;

/**
 * Exit reasons that are neither progress nor a stall, so the streak is left alone.
 *
 * Only `ask-human`, and the argument is §11.1's own: the detector asks whether the
 * AGENT is going in circles. A session that stopped to ask a question is not circling —
 * it established that it needs something it cannot get from inside the worktree and
 * handed the decision to the person who can. §7 puts it plainly: "Nothing is running
 * while you think."
 *
 * §7 already conceded the point by clearing the streak when an ANSWER arrives, because
 * `awaiting-human` is only ever reached from a session that produced no commit. That
 * fixes the park and not the reading: between the question and the answer the task
 * carries a streak it did not earn, and `caterpillar_no_progress_streak` reports it.
 * BS-1540279100223127564-01 fired CaterpillarTaskThrashing that way — one honestly
 * stalled session, then one that asked a question, then hours of alert on a task with
 * nothing running. A task waiting too long on a human is a real problem, and §11 gives
 * it its own alert (`awaiting-human > 24h`) that says a human is the subject.
 *
 * Neutral rather than forgiving, which is why this is not simply `noProgressStreak: 0`.
 * Clearing would let an agent reset the detector on demand: stall, ask anything, get
 * answered, stall again. A streak earned by other sessions survives this one.
 *
 * `handoff` is deliberately NOT here. It is how most sessions end and says nothing
 * about whether anything was achieved, so exempting it would blind the detector to the
 * precise failure it exists for — an agent burning context in circles, every one of
 * whose sessions ends exactly that way.
 */
const neutralExit = (reason: SessionExitReason): boolean => reason === "ask-human";

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
 *
 * `reason` decides whether a session with no evidence counts against the streak, and is
 * required rather than optional: every fold is a session that ended somehow, and a new
 * call site that has not thought about the exit reason should be a compile error rather
 * than a silent extra point on somebody's streak.
 */
export const recordProgress = (
  previous: ProgressRecord,
  session: number,
  evidence: ProgressEvidence,
  reason: SessionExitReason,
): ProgressRecord => {
  const head =
    evidence.headOid ?? previous.lastHeadOid;
  // Evidence wins over the exit reason: an agent may commit real work and only then
  // discover it needs a decision, and that session moved the task forward.
  const base = madeProgress(evidence)
    ? { lastProgressSession: session, noProgressStreak: 0 }
    : {
        lastProgressSession: previous.lastProgressSession,
        noProgressStreak: previous.noProgressStreak + (neutralExit(reason) ? 0 : 1),
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
