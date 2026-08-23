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
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import {
  EFFECTS_KEPT,
  effectFileName,
  effectRequestId,
  isEffectRequestId,
  prunableEffects,
  type EffectAge,
} from "./effects.ts";
import { Git } from "./git.ts";
import { StateStore } from "./store.ts";

const TASK = asTaskId("GH-acme-widget-98");
const OTHER = asTaskId("GH-acme-widget-99");

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const store = async (runner = "pod-7f3a"): Promise<StateStore> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-effects-"));
  roots.push(root);
  return new StateStore(root, new Git(root), undefined, runner);
};

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

const record = (requestId: string, at: string): EffectAge => ({ requestId, at });

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
  const undated: EffectAge = { requestId: "task_note-old" };

  assert.deepEqual(prunableEffects([...dated, undated]), ["task_note-old"]);
});

test("an effect that has not been recorded reads as absent", async () => {
  const subject = await store();
  const id = effectRequestId(TASK, "done", { summary: "landed" });

  assert.equal(await subject.recordedEffect(TASK, id), undefined);
});

test("a recorded effect replays its result", async () => {
  // The whole point: a pod killed between the side effect and the state write comes back,
  // recomputes the same id, and is handed what the first call returned.
  const subject = await store();
  const id = effectRequestId(TASK, "open_pr", { head: "agent/x", base: "main" });

  await subject.recordEffect(TASK, id, "open_pr", { number: 7, url: "https://x.invalid/7" });

  const replayed = await subject.recordedEffect<{ number: number }>(TASK, id);
  assert.equal(replayed?.result.number, 7);
  assert.equal(replayed?.verb, "open_pr");
  assert.equal(replayed?.runner, "pod-7f3a");
  assert.ok(replayed?.at !== undefined && replayed.at !== "");
});

test("one effect is one file, so two runners never write the same path", async () => {
  // §4.1's argument for the sharded journal, applied here: two runners recording the same
  // task must touch disjoint paths or one of their commits can never rebase.
  const subject = await store();
  const done = effectRequestId(TASK, "done", { summary: "landed" });
  const note = effectRequestId(TASK, "task_note", { text: "progress" });

  await subject.recordEffect(TASK, done, "done", null);
  await subject.recordEffect(TASK, note, "task_note", null);

  const files = await readdir(join(roots.at(-1) as string, "tasks", TASK, "effects"));
  assert.deepEqual(files.sort(), [effectFileName(done), effectFileName(note)].sort());
});

test("one task's record is not another task's", async () => {
  const subject = await store();
  const id = effectRequestId(TASK, "task_note", { text: "progress" });
  await subject.recordEffect(TASK, id, "task_note", null);

  assert.equal(await subject.recordedEffect(OTHER, id), undefined);
});

test("a request id that is not one path segment is refused", async () => {
  const subject = await store();

  await assert.rejects(
    () => subject.recordEffect(TASK, "../escape", "done", null),
    /not a usable effect request id/,
  );
  assert.equal(await subject.recordedEffect(TASK, "../escape"), undefined);
});

test("an unreadable record reads as absent rather than throwing", async () => {
  // The record is a fast path, never an authority. A half-written or hand-mangled file
  // must cost a repeated attempt, not a crashed session.
  const subject = await store();
  const id = effectRequestId(TASK, "done", { summary: "landed" });
  await subject.recordEffect(TASK, id, "done", null);

  const path = join(roots.at(-1) as string, "tasks", TASK, "effects", effectFileName(id));
  await writeFile(path, "{ not json", "utf8");

  assert.equal(await subject.recordedEffect(TASK, id), undefined);
});

test("a stray file in the effects directory is neither read nor deleted", async () => {
  // The directory is in a git repo a human can edit and a rebase can touch. A prune that
  // tried to interpret every name would either throw on one it could not parse or delete
  // something it did not write.
  const subject = await store();
  const dir = join(roots.at(-1) as string, "tasks", TASK, "effects");
  for (let n = 0; n <= EFFECTS_KEPT; n += 1) {
    const id = effectRequestId(TASK, "task_note", { text: `note ${n}` });
    await subject.recordEffect(TASK, id, "task_note", null);
    if (n === 0) await writeFile(join(dir, "README.json"), "left by a human\n", "utf8");
  }

  assert.ok(existsSync(join(dir, "README.json")), "a file this class did not write is not its to delete");
});

test("recording an effect prunes the task back under the cap", async () => {
  const subject = await store();
  const ids: string[] = [];
  for (let n = 0; n <= EFFECTS_KEPT; n += 1) {
    const id = effectRequestId(TASK, "task_note", { text: `note ${n}` });
    ids.push(id);
    await subject.recordEffect(TASK, id, "task_note", null);
  }

  const dir = join(roots.at(-1) as string, "tasks", TASK, "effects");
  assert.equal((await readdir(dir)).length, EFFECTS_KEPT);
  // The newest survives — it is the one a live session could still replay.
  assert.ok(existsSync(join(dir, effectFileName(ids.at(-1) as string))));
});
