/**
 * Effect records: the generalisation of `open_pr`'s idempotency (DESIGN.md §4.4, §13).
 *
 * Two properties carry the whole feature, and both are asserted here rather than through a
 * session, because a session can only be observed by running one:
 *
 *   - the request id is a pure function of the task, the verb and the arguments, so a
 *     replay after a pod restart computes the SAME id as the call that already landed;
 *   - the record is one file per effect, so two runners recording the same task write
 *     different paths and their commits still rebase (§4.1's argument for the journal).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import {
  EFFECTS_KEPT,
  effectFileName,
  effectRequestId,
  isEffectRequestId,
  prunableEffects,
  type EffectRecord,
} from "./effects.ts";

const TASK = asTaskId("GH-acme-widget-98");
const OTHER = asTaskId("GH-acme-widget-99");

test("a request id is the same for the same task, verb and arguments", () => {
  const args = { summary: "landed the schema" };

  assert.equal(
    effectRequestId(TASK, "done", args),
    effectRequestId(TASK, "done", { summary: "landed the schema" }),
  );
});

test("a request id ignores the order the argument keys were written in", () => {
  // The arguments arrive as a parsed tool call, and nothing guarantees key order across
  // two model turns. An id that depended on it would miss the replay it exists to catch.
  const first = effectRequestId(TASK, "open_pr", { head: "agent/x", base: "main" });
  const second = effectRequestId(TASK, "open_pr", { base: "main", head: "agent/x" });

  assert.equal(first, second);
});

test("a request id separates the task, the verb and the arguments", () => {
  const args = { summary: "done" };
  const ids = new Set([
    effectRequestId(TASK, "done", args),
    effectRequestId(OTHER, "done", args),
    effectRequestId(TASK, "handoff", args),
    effectRequestId(TASK, "done", { summary: "different" }),
  ]);

  assert.equal(ids.size, 4);
});

test("a request id names its verb, and is one usable path segment", () => {
  const id = effectRequestId(TASK, "task_note", { text: "progress" });

  assert.ok(id.startsWith("task_note-"), id);
  assert.ok(isEffectRequestId(id), id);
  assert.equal(effectFileName(id), `${id}.json`);
});

test("a request id that could climb out of the effects directory is refused", () => {
  // The id reaches `effectFileName` from a record on disk and from a caller, and it
  // becomes a path segment inside the task tree — the trap a task id is guarded against.
  for (const bad of ["../escape", "a/b", "", ".", "..", "done-" + "x".repeat(200)]) {
    assert.equal(isEffectRequestId(bad), false, bad);
    assert.throws(() => effectFileName(bad), /not a usable effect request id/, bad);
  }
});

const record = (requestId: string, at: string): EffectRecord => ({
  requestId,
  task: TASK,
  verb: "task_note",
  at,
  runner: "pod-7f3a",
  result: null,
});

test("nothing is prunable while a task is under the cap", () => {
  const records = Array.from({ length: EFFECTS_KEPT }, (_, n) =>
    record(`task_note-${n}`, `2026-08-13T09:0${n % 10}:00.000Z`),
  );

  assert.deepEqual(prunableEffects(records), []);
});

test("the oldest effects over the cap are prunable, newest kept", () => {
  // Bounded on purpose: every runner clones the state repo and git keeps whatever lands
  // in it forever. A replay is only ever of a recent call, so the cap is on age by proxy.
  const records = Array.from({ length: EFFECTS_KEPT + 3 }, (_, n) =>
    record(`task_note-${n}`, new Date(Date.UTC(2026, 7, 13, 9, n)).toISOString()),
  );

  assert.deepEqual(prunableEffects(records), ["task_note-0", "task_note-1", "task_note-2"]);
});

test("a record with no timestamp is pruned before one that has a timestamp", () => {
  // Records written before `at` existed must not outlive dated ones: an undated record is
  // by definition older than anything this deploy wrote.
  const dated = Array.from({ length: EFFECTS_KEPT }, (_, n) =>
    record(`task_note-${n}`, new Date(Date.UTC(2026, 7, 13, 9, n)).toISOString()),
  );
  const undated: EffectRecord = { ...record("task_note-old", ""), at: undefined as never };

  assert.deepEqual(prunableEffects([...dated, undated]), ["task_note-old"]);
});
