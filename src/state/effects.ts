/**
 * Effect records — idempotency for every supervisor-mediated verb. See DESIGN.md §4.4.
 *
 * `open_pr` has always been idempotent: asked for a branch that already carries an open
 * pull request it adopts that PR rather than failing, so a handoff, a lost state write, or
 * a human who opened it by hand does not strand the task. That is the right behaviour and
 * it was solved exactly once. Every other control verb — `done`, `handoff`, `ask_human`,
 * `task_note`, `submit_plan`, `publish_artifact` — and every tracker lifecycle mirror
 * (§9.5) can be interrupted between "the outside world changed" and "the state repo
 * recorded it". A pod killed in that window is an ORDINARY event here.
 *
 * The generalisation is three pieces, and this file is the first two:
 *
 *   1. a REQUEST ID derived from the task, the verb and a content hash of the arguments,
 *      so a replay computes the same id as the call that already landed;
 *   2. a durable per-task record under `tasks/<id>/effects/<request-id>.json`, ONE FILE
 *      per effect — the same shape as the journal's shards (§4.1), so two runners
 *      recording the same task write different paths and their commits still rebase;
 *   3. the check itself, which lives at each call site: `StateStore.recordedEffect`
 *      before acting, `StateStore.recordEffect` after.
 *
 * **A record is never the authority on its own.** If the record says a pull request was
 * opened and the forge says otherwise, the forge wins — `Forge.openPr` still asks. The
 * record is a fast path that skips a repeated side effect, not a source of truth about the
 * outside world, and every consumer is written so that a missing or stale record costs a
 * duplicate attempt rather than a wrong answer.
 */
import { createHash } from "node:crypto";
import type { TaskId } from "../domain/task.ts";

/**
 * The verbs whose effects are recorded.
 *
 * A closed union rather than a free string: the verb is half of the request id, so a typo
 * at one call site would silently produce an id that never matches the one the other call
 * site computes — an idempotency check that is always a miss, which is the failure mode
 * this whole file exists to remove and the one hardest to notice.
 *
 * The `tracker.*` members mirror `TrackerTransition.kind` (§9.5). A retried mirror must not
 * duplicate a comment or a label: it already may not fail a task, and now it may not double
 * either. `handoff` has no tracker transition, deliberately, so there is no member for it.
 */
export type EffectVerb =
  | "open_pr"
  | "done"
  | "handoff"
  | "ask_human"
  | "task_note"
  | "submit_plan"
  | "publish_artifact"
  | "tracker.claimed"
  | "tracker.question"
  | "tracker.parked"
  | "tracker.completed";

/**
 * One landed effect, as it is stored.
 *
 * `result` is what the verb returned and what a replay hands back in its place, so it must
 * be JSON — a `PrResult` for `open_pr`, the prose a tool answered with, `null` for a verb
 * whose only outcome is that it happened.
 */
export interface EffectRecord<T = unknown> {
  readonly requestId: string;
  readonly task: TaskId;
  readonly verb: EffectVerb;
  /** ISO 8601, stamped by the writer. What `prunableEffects` orders on. */
  readonly at: string;
  /** Which runner performed the effect. For an operator reading two runners' records. */
  readonly runner: string;
  readonly result: T;
}

/**
 * How many effect records one task keeps.
 *
 * Bounded because they accumulate and git never forgets: every runner clones the state repo
 * and pulls it on every poll, so an unbounded per-task directory is a cost paid on every
 * machine forever — the same argument as §17's artifact caps.
 *
 * The cap is on COUNT, oldest first, and that is sound because a replay is only ever of a
 * recent call: the window an effect record closes is between one side effect and the state
 * write that follows it, which is seconds. A record old enough to be pruned is one whose
 * session ended long ago. Sixty-four is comfortably more than the verbs of a long task's
 * single session, so nothing a live session might replay is ever a prune candidate.
 */
export const EFFECTS_KEPT = 64;

/** `<verb>-<64 hex>`; the verb is there so a directory listing reads as a history. */
const REQUEST_ID = /^[a-z_.]+-[0-9a-f]{64}$/;

export const isEffectRequestId = (value: string): boolean => REQUEST_ID.test(value);

/**
 * The request id for one call: deterministic in the task, the verb and the arguments.
 *
 * Deterministic is the whole point — a session that is replayed after a pod restart makes
 * the same call with the same arguments and must compute the same id, or the record it
 * would have matched is invisible and the effect happens twice.
 *
 * The task is in the hash as well as the arguments because two tasks may legitimately make
 * the identical call (`task_note` with the same text is not unusual), and their effects are
 * separate events that must not adopt one another's result.
 */
export const effectRequestId = (task: TaskId, verb: EffectVerb, args: unknown): string => {
  const hash = createHash("sha256")
    .update(`${task}\n${verb}\n${canonicalJson(args)}`)
    .digest("hex");
  return `${verb}-${hash}`;
};

/**
 * JSON with object keys in a fixed order, so two spellings of the same arguments hash
 * alike.
 *
 * The arguments arrive as a parsed tool call and nothing guarantees key order across two
 * model turns; `JSON.stringify` preserves insertion order, so it alone would give a replay
 * a different id than the original call. Arrays keep their order, because an array's order
 * is data.
 *
 * `undefined` is dropped exactly as `JSON.stringify` drops it, so an argument omitted and
 * an argument passed as `undefined` are the same call — which is what a caller spreading
 * optional fields into an object means by it.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
  return `{${entries.join(",")}}`;
};

export class InvalidEffectRequestIdError extends Error {
  constructor(value: string) {
    super(`'${value}' is not a usable effect request id`);
    this.name = "InvalidEffectRequestIdError";
  }
}

/**
 * The file one record lives in, inside `tasks/<id>/effects/`.
 *
 * Checked rather than trusted: the id reaches here from a caller and from a directory
 * listing, and it becomes a path segment inside the task tree. `..` is a legal directory
 * name that resolves to the task's parent, which is the same trap a task id (§4.1) and an
 * artifact name (§17) are anchored against.
 */
export const effectFileName = (requestId: string): string => {
  if (!isEffectRequestId(requestId)) throw new InvalidEffectRequestIdError(requestId);
  return `${requestId}.json`;
};

/**
 * The request ids to delete so a task is back under `EFFECTS_KEPT`, oldest first.
 *
 * Pure and separate from the store so the retention rule is testable without a git
 * checkout, and so there is one place that says what "bounded" means here.
 *
 * A record with no usable `at` sorts oldest. Records written before a field existed are a
 * shape this repo has met before (§14.2's rejections), and an undated record is by
 * definition older than anything the current deploy wrote — keeping it in preference to a
 * dated one would make the cap unable to evict its oldest entries at all.
 */
export const prunableEffects = (records: readonly EffectRecord[]): readonly string[] => {
  if (records.length <= EFFECTS_KEPT) return [];

  const byAge = [...records].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return byAge.slice(0, records.length - EFFECTS_KEPT).map((record) => record.requestId);
};

/** ISO timestamps sort chronologically as strings; anything unusable sorts first. */
const sortKey = (record: EffectRecord): string =>
  typeof record.at === "string" && record.at !== "" ? record.at : "";
