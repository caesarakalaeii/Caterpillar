/**
 * The task listing, and why its order and its cap are one decision rather than two.
 *
 * The defect these pin was live: with 39 tasks on the fleet and a 25-line cap, `/tasks`
 * showed 23 FINISHED tasks and elided the one that was running. Every part of the fix —
 * the order, the counts, the footer that names the next command — exists because the
 * command that answers "what is it doing" was showing everything except that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskStatus } from "../domain/task.ts";
import { TaskSnapshot, type TaskSummary } from "../supervisor/snapshot.ts";
import { describeList } from "./replies.ts";

const at = (id: string, status: TaskStatus, updatedAt: string): TaskSummary => ({
  id: asTaskId(id),
  status,
  phase: "planning",
  sessions: 1,
  costUsd: 0,
  updatedAt,
});

/** `n` finished tasks, oldest first and named so they sort BEFORE anything interesting. */
const oldDone = (n: number): TaskSummary[] =>
  Array.from({ length: n }, (_, i) =>
    at(`BS-000${String(i).padStart(3, "0")}`, "done", `2026-08-14T10:${String(i).padStart(2, "0")}:00.000Z`),
  );

test("the running task is listed first, even behind thirty finished ones", () => {
  // THE bug. Ids like `BS-<snowflake>-07` sort oldest-brainstorm-first, and `survey` walks
  // the directory, so the incoming order put every finished task ahead of the live one and
  // the cap threw the live one away.
  const snapshot = new TaskSnapshot();
  snapshot.replace([
    ...oldDone(30),
    at("BS-9999-05", "running", "2026-08-18T13:00:00.000Z"),
  ]);

  const rendered = describeList(snapshot.all());
  const firstLine = rendered.split("\n").find((line) => line.startsWith("`"));

  assert.ok(firstLine?.includes("BS-9999-05"), `expected the running task first, got: ${firstLine}`);
  assert.ok(rendered.includes("**running**"));
});

test("the header counts the whole set, not the page", () => {
  // The half of the answer a capped list cannot give. "32 done" has to be visible without
  // paging to it, or the count of what exists is only reachable by exhausting the listing.
  const snapshot = new TaskSnapshot();
  snapshot.replace([
    ...oldDone(30),
    at("R-1", "running", "2026-08-18T13:00:00.000Z"),
    at("W-1", "awaiting-human", "2026-08-18T12:00:00.000Z"),
    at("Q-1", "ready", "2026-08-18T11:00:00.000Z"),
  ]);

  const rendered = describeList(snapshot.all());

  assert.match(rendered, /\*\*33\*\* tasks/);
  assert.match(rendered, /1 running/);
  assert.match(rendered, /1 awaiting-human/);
  assert.match(rendered, /1 ready/);
  assert.match(rendered, /30 done/);
  // Zero counts are dropped: six statuses of which four are usually 0 is noise on the one
  // line that has to be read at a glance.
  assert.ok(!rendered.includes("0 failed"), rendered);
});

test("a listing that does not fit says which command shows the rest", () => {
  // The old wording was "…and N more.", which states that something is missing and gives no
  // way to see it. That is the complaint, not the line count.
  const snapshot = new TaskSnapshot();
  snapshot.replace(oldDone(30));

  const page1 = describeList(snapshot.all());
  assert.match(page1, /page 1\/2/);
  assert.match(page1, /`\/tasks page:2` for the next 5/);

  const page2 = describeList(snapshot.all(), undefined, 2);
  assert.match(page2, /page 2\/2/);
  // Never points at the page already on screen.
  assert.ok(!page2.includes("page:2`"), page2);
  assert.match(page2, /Last page/);
});

test("pages do not repeat or skip a task", () => {
  // Only true because the snapshot sorts once and both pages slice the same order. A reader
  // that re-sorted would silently show some tasks twice and others never.
  const snapshot = new TaskSnapshot();
  snapshot.replace(oldDone(30));

  const ids = (rendered: string): string[] =>
    [...rendered.matchAll(/`(BS-\d+)`/g)].map((match) => match[1] ?? "");

  const first = ids(describeList(snapshot.all(), undefined, 1));
  const second = ids(describeList(snapshot.all(), undefined, 2));

  assert.equal(first.length, 25);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second]).size, 30, "every task appears exactly once");
});

test("a page past the end is the last page, not an error", () => {
  // The count changes between reading "2 pages" and asking for page 2. Refusing would be
  // tidier and worse to use.
  const snapshot = new TaskSnapshot();
  snapshot.replace(oldDone(30));

  const far = describeList(snapshot.all(), undefined, 99);
  assert.match(far, /page 2\/2/);
});

test("a page below the first is the first page", () => {
  // `page:0` and `page:-1` are as typeable as `page:99`, and the client-side `min_value` is
  // a convenience rather than a guarantee.
  const snapshot = new TaskSnapshot();
  snapshot.replace(oldDone(30));

  for (const page of [0, -1, 0.5]) {
    assert.match(describeList(snapshot.all(), undefined, page), /page 1\/2/, `page:${page}`);
  }
});

test("a filtered listing pages within the filter and says so", () => {
  const snapshot = new TaskSnapshot();
  snapshot.replace([...oldDone(30), at("R-1", "running", "2026-08-18T13:00:00.000Z")]);

  const done = describeList(snapshot.withStatus("done"), "done");

  assert.match(done, /\*\*30\*\* tasks in `done`/);
  assert.match(done, /`\/tasks status:done page:2`/);
  // The breakdown is one number inside a filter, so repeating the filter back says nothing.
  assert.ok(!done.includes("30 done ·"), done);
  assert.ok(!done.includes("status:` to filter"), done);
});

test("a listing that fits carries no page furniture at all", () => {
  const snapshot = new TaskSnapshot();
  snapshot.replace(oldDone(3));

  const rendered = describeList(snapshot.all());

  assert.ok(!rendered.includes("page"), rendered);
  assert.match(rendered, /\*\*3\*\* tasks/);
});

test("an empty listing says so, and says what was filtered", () => {
  assert.equal(describeList([]), "No tasks.");
  assert.equal(describeList([], "failed"), "No tasks in `failed`.");
});

test("tasks updated in the same millisecond keep a stable order", () => {
  // Several tasks cut from one plan are created in the same tick. A listing that shuffled
  // them between two runs of the same command reads as a bug.
  const same = "2026-08-18T13:00:00.000Z";
  const snapshot = new TaskSnapshot();
  snapshot.replace([at("P-3", "ready", same), at("P-1", "ready", same), at("P-2", "ready", same)]);

  assert.deepEqual(
    snapshot.all().map((task) => task.id),
    ["P-1", "P-2", "P-3"],
  );
});
