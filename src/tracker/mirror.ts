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
 * Narrower than the agent's `EffectLedger`: a mirror has no result to replay, so the
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
 * Mirror one transition, at most once. Never throws.
 *
 * Handoffs are deliberately not mirrored anywhere — a multi-hour task would otherwise
 * become twenty comments of noise — which is why there is no `handoff` transition to pass.
 */
export const mirrorTransition = async (request: MirrorRequest): Promise<void> => {
  const { task, ref, tracker, transition, logger, ledger } = request;
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
  // A ledger failure means the state repo could not be read, which says nothing about
  // whether the mirror landed. Mirroring anyway risks a duplicate comment; not mirroring
  // risks a lifecycle change nobody can see, and that is the more expensive mistake.
  const already = await tryLanded(ledger, verb, transition, task, logger);
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

  await ledger?.record(verb, transition).catch((error: unknown) => {
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
  transition: TrackerTransition,
  task: TaskId,
  logger: Logger,
): Promise<boolean> => {
  if (ledger === undefined) return false;
  try {
    return await ledger.landed(verb, transition);
  } catch (error) {
    logger.warn("tracker.mirror-record-unreadable", {
      task,
      transition: transition.kind,
      ...errorFields(error),
    });
    return false;
  }
};
