/**
 * Mirroring one lifecycle change into a task's tracker (DESIGN.md §9.5).
 *
 * Always called AFTER the authoritative git write — the lease CAS for a claim, the state
 * push for everything else. The tracker is a VIEW, git wins when they disagree, and that
 * ordering is why a failure here only logs: an unreachable Vikunja must never fail a task.
 *
 * That ordering is also what makes the effect record necessary. A pod killed between the
 * comment and the state write comes back and mirrors the same transition again, and a
 * duplicate comment on a tracker item is permanent — it reads, to the human the item is
 * for, as an agent that has lost track of what it has said. §9.5 already said a mirror may
 * not FAIL a task; §4.4 adds that it may not double one either.
 *
 * A function rather than a method on the supervisor because it is policy, and policy that
 * can only be observed by running a whole poll loop is policy without a test.
 */
import type { TaskId, TrackerRef, WorkspaceName } from "../domain/task.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { EffectVerb } from "../state/effects.ts";
import type { Tracker, TrackerTransition } from "./types.ts";

/**
 * The effect record, as mirroring needs it.
 *
 * The same record as the agent's `EffectLedger` in `agent/tools.ts`, read through a
 * narrower shape rather than a second mechanism: a mirror has no result to replay, so the
 * question is only "did this already land", and there is nothing to hand back.
 */
export interface MirrorLedger {
  landed(verb: EffectVerb, args: unknown): Promise<boolean>;
  record(verb: EffectVerb, args: unknown): Promise<void>;
}

export interface MirrorRequest {
  readonly task: TaskId;
  /**
   * Which workspace's tracker this is, for the kind-mismatch log line.
   *
   * That mismatch is a CONFIG error rather than a task error, and the workspace is the
   * thing an operator has to go and edit — a line naming only the task sends them to the
   * wrong file.
   */
  readonly workspace?: WorkspaceName;
  /** Where the task came from. Absent means there is nothing to mirror into. */
  readonly ref?: TrackerRef;
  /** The workspace's tracker. Absent on a runner with none configured. */
  readonly tracker?: Tracker;
  readonly transition: TrackerTransition;
  /**
   * Which occurrence of this transition it is — the task's session index at the call site.
   *
   * Lifecycle transitions RECUR with identical arguments, which is what separates them
   * from a tool call inside one session. `claimed` carries only the runner id, and that is
   * `RUNNER_ID`, the pod name: stable across restarts. Without a discriminator the second
   * claim of a task by the same pod hashes to the first claim's request id and is skipped
   * — and `claimed` is the only transition that removes `needs-human` and re-adds
   * `agent-wip`, so the issue keeps advertising for help nobody needs (§9.5).
   *
   * The session index is the right grain because it is exactly the window a replay lives
   * in: a pod killed between the comment and the state write comes back in the SAME
   * session and must collapse, while a park answered by a human opens a new session and
   * must mirror. It is not part of the `TrackerTransition` — the tracker has no use for
   * it, it only keys the record.
   */
  readonly occurrence: number;
  readonly logger: Logger;
  /** Absent on a caller with no state repo behind it, which mirrors unconditionally. */
  readonly ledger?: MirrorLedger;
}

/**
 * `tracker.<kind>` — one effect verb per lifecycle transition.
 *
 * Derived from the kind rather than listed, so a new transition cannot be added without
 * getting a verb: `EffectVerb` names all four, and a fifth kind would fail to compile here.
 */
const verbFor = (transition: TrackerTransition): EffectVerb => `tracker.${transition.kind}`;

/**
 * What the request id is hashed over: the transition, plus which occurrence of it this is.
 *
 * Separate from the transition passed to the tracker so that the two cannot drift — the
 * tracker writes what §9.5 says, the record keys what distinguishes one attempt from the
 * next.
 */
const effectArgs = (transition: TrackerTransition, occurrence: number): unknown => ({
  transition,
  occurrence,
});

/**
 * Mirror one transition, at most once. Never throws.
 *
 * Handoffs are deliberately not mirrored anywhere — a multi-hour task would otherwise
 * become twenty comments of noise — which is why there is no `handoff` transition to pass.
 */
export const mirrorTransition = async (request: MirrorRequest): Promise<void> => {
  const { task, ref, tracker, transition, occurrence, logger, ledger } = request;
  if (ref === undefined || tracker === undefined) return;

  if (tracker.kind !== ref.kind) {
    // Config error: the workspace's tracker is not the one this task came from, so its ids
    // mean something else entirely. Writing anyway would comment on an unrelated item.
    logger.error("tracker.kind-mismatch", {
      task,
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
      specKind: ref.kind,
      workspaceKind: tracker.kind,
    });
    return;
  }

  const verb = verbFor(transition);
  const args = effectArgs(transition, occurrence);
  // A ledger failure means the state repo could not be read, which says nothing about
  // whether the mirror landed. Mirroring anyway risks a duplicate comment; not mirroring
  // risks a lifecycle change nobody can see, and that is the more expensive mistake.
  const already = await tryLanded(ledger, verb, args, task, logger);
  if (already) {
    logger.info("tracker.mirror-skipped", { task, tracker: tracker.kind, transition: transition.kind });
    return;
  }

  try {
    await tracker.transition(ref, transition, task);
  } catch (error) {
    // Not recorded: a mirror that failed must stay eligible for the next attempt, or the
    // retry that would have fixed it is skipped forever.
    logger.warn("tracker.mirror-failed", {
      task,
      tracker: tracker.kind,
      transition: transition.kind,
      ...errorFields(error),
    });
    return;
  }

  await ledger?.record(verb, args).catch((error: unknown) => {
    // The mirror LANDED. Failing here would undo nothing and hide the thing that worked;
    // the cost is that a replay may comment twice, which is what the record is for and not
    // what it guarantees.
    logger.warn("tracker.mirror-unrecorded", {
      task,
      transition: transition.kind,
      ...errorFields(error),
    });
  });
};

const tryLanded = async (
  ledger: MirrorLedger | undefined,
  verb: EffectVerb,
  args: unknown,
  task: TaskId,
  logger: Logger,
): Promise<boolean> => {
  if (ledger === undefined) return false;
  try {
    return await ledger.landed(verb, args);
  } catch (error) {
    // `verb` rather than the transition kind: it says the same thing (`tracker.parked`)
    // and it is what the lookup that failed was keyed on.
    logger.warn("tracker.mirror-record-unreadable", {
      task,
      verb,
      ...errorFields(error),
    });
    return false;
  }
};
