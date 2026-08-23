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
  TaskId,
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
  /**
   * How many commits the task branch carries beyond its fork point — the STANDING total,
   * not this session's delta.
   *
   * The total rather than the delta because of what it is for: `commitNote` puts it in the
   * journal so a resumed session cannot mistake work that exists for work that does not,
   * and GH-96's sessions 4-7 each added nothing while eighteen commits sat on the branch.
   * A delta would have read as zero on every one of them, which is what the journal already
   * said.
   *
   * Absent when the probe could not count — a repo it cannot read, or a fork point this
   * worktree does not carry. Absent is not zero, and `commitNote` keeps them apart.
   */
  readonly commits?: number;
}

export const madeProgress = (evidence: ProgressEvidence): boolean =>
  evidence.committed || evidence.acceptanceImproved || evidence.stepCompleted;

/** How much of an oid a human reads before they stop. Matches `git log --abbrev-commit`. */
const ABBREVIATED_OID = 7;

/**
 * The journal's sentence about what is on the task branch, or nothing to say.
 *
 * This exists because of what a journal entry looked like when a session died without
 * reaching a control-plane verb. GH-96's sessions 2-3 committed and pushed 18 commits;
 * sessions 4-7 each recorded "without a control-plane decision" and no more, so the
 * journal that session 7 read said nothing had happened. It believed the journal and
 * re-implemented the entire task, discovering the truth only when `git push` was refused
 * as non-fast-forward. Two independent implementations of one task reached the remote.
 *
 * Derived from the PROBE's evidence and never from the agent's summary, which is the whole
 * point: the summary is the part of the entry that a dying session fails to write and the
 * only part that can be wrong about the repository. `recordSession` has this evidence
 * already — it probes on every session, whatever the exit reason.
 *
 * Says "on the branch" rather than "pushed". The probe runs after the session's credential
 * lease has closed (§9.2), so this runner cannot reach the remote to check, and the mirror
 * keeps no remote-tracking ref for `agent/*` (see `MIRROR_REFSPECS`). Naming the branch is
 * what makes the line actionable anyway: a session handed the branch name and a count can
 * run `git log` itself, and since `WorktreeManager.ensureSessionCheckout` now guarantees
 * the worktree is at or ahead of the remote tip, what is on the branch is everything that
 * was pushed.
 *
 * Absent evidence produces no line. A `commits` the probe could not count is not a branch
 * with nothing on it, and a journal that says "0 commits" in every entry of every session
 * that only read code buries the one entry this sentence exists for.
 */
export const commitNote = (task: TaskId, evidence: ProgressEvidence): string | undefined => {
  const { commits, headOid } = evidence;
  if (commits === undefined || commits === 0 || headOid === undefined) return undefined;

  const plural = commits === 1 ? "commit" : "commits";
  return (
    `**Work on the branch:** ${commits} ${plural} on \`agent/${task}\`, ` +
    `tip \`${headOid.slice(0, ABBREVIATED_OID)}\`. ` +
    "Read them before writing anything — they may already be the task."
  );
};

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
