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
import { describeList, describeOutcome, describeTask } from "./replies.ts";

const TASK = asTaskId("BS-1539374658363854934");

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: TASK,
  status: "parked",
  phase: "planning",
  sessions: 4,
  costUsd: 24.73,
  updatedAt: "2026-08-19T10:00:00.000Z",
  ...over,
});

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

/**
 * `/task` and the question it could not answer.
 *
 * A brainstorm the council kept sending back showed as `ready`, then `ready`, then
 * `parked`, and nothing in Discord ever said a review had happened — the verdicts were
 * files in a repo, and the snapshot this reply is served from carried no trace of them.
 */
test("a task the council sent back says how often, why, and whose move it is", () => {
  const rendered = describeTask(asTaskId("BS-153"), {
    ...at("BS-153", "ready", "2026-08-19T09:00:00.000Z"),
    review: {
      rounds: 3,
      last: "changes",
      reason: "**Feasibility** — task 2 declares no command that exercises the new endpoint.",
    },
  });

  assert.match(rendered, /3 rounds/);
  assert.match(rendered, /last sent back/);
  assert.match(rendered, /exercises the new endpoint/);
  // `ready` is the agent's move, and saying so is the half a count of rounds leaves out:
  // a reader who cannot tell whether they are expected to act assumes they are not.
  assert.match(rendered, /goes back to the agent by itself/);
});

test("a parked task names the commands that unpark it", () => {
  const rendered = describeTask(asTaskId("BS-153"), {
    ...at("BS-153", "parked", "2026-08-19T09:00:00.000Z"),
    review: { rounds: 3, last: "changes", reason: "**Decomposition** — five tasks are one task." },
  });

  assert.match(rendered, /will not be picked up again on its own/);
  assert.match(rendered, /\/resume BS-153/);
  // No PR on a brainstorm, so no merge is offered: a command that cannot work is worse
  // than no suggestion at all.
  assert.doesNotMatch(rendered, /\/merge/);
});

test("a parked task WITH a pull request offers the merge as well", () => {
  const rendered = describeTask(asTaskId("T-9"), {
    ...at("T-9", "parked", "2026-08-19T09:00:00.000Z"),
    prUrl: "https://github.com/acme/app/pull/4",
    review: { rounds: 3, last: "changes", reason: "**Correctness** — off by one." },
  });

  assert.match(rendered, /\/merge T-9/);
  assert.match(rendered, /\/resume T-9/);
});

test("a task no council has looked at says nothing about reviews", () => {
  // The reply is read at a glance. A "0 rounds, no verdict recorded" line on every task
  // that has never been reviewed is noise on the four fields that are always true.
  const rendered = describeTask(asTaskId("T-1"), at("T-1", "running", "2026-08-19T09:00:00.000Z"));

  assert.doesNotMatch(rendered, /Review council/);
  assert.match(rendered, /\*\*T-1\*\* — `running`/);
});

test("a task the council passed does not keep quoting an answered objection", () => {
  const rendered = describeTask(asTaskId("T-2"), {
    ...at("T-2", "done", "2026-08-19T09:00:00.000Z"),
    review: { rounds: 2, last: "pass" },
  });

  assert.match(rendered, /2 rounds, last passed/);
  assert.doesNotMatch(rendered, /sent back/);
});

test("guidance says it was recorded, that the budget was forgiven, and the way back", () => {
  // All three, because the surface this replaces said nothing at all — and silence read as
  // "discarded", which for a long time it was.
  const reply = describeOutcome(TASK, {
    kind: "guided",
    notes: 2,
    resumable: true,
    roundsCleared: true,
  });

  assert.match(reply, /2 notes/, "the human should be able to see their earlier note landed");
  assert.match(reply, /round count/, "a forgiven budget that is not stated reads as ignored");
  assert.match(reply, new RegExp(`/resume ${TASK}`), "the way back has to be named once");
});

test("guidance for a task that is not parked does not offer to resume it", () => {
  // It is already claimable. A resume would be a no-op the human was told to perform.
  const reply = describeOutcome(TASK, {
    kind: "guided",
    notes: 1,
    resumable: false,
    roundsCleared: false,
  });

  assert.doesNotMatch(reply, /resume/);
  assert.match(reply, /next session/);
});

test("a steer says the session picks it up without being restarted", () => {
  const reply = describeOutcome(TASK, { kind: "steered" });
  assert.match(reply, /current step/);
  assert.doesNotMatch(reply, /resume/, "restarting a session that is working is not the answer");
});

test("a done task is told to be done, and pointed somewhere that works", () => {
  const reply = describeOutcome(TASK, { kind: "finished" });
  assert.match(reply, /brainstorm/);
  // `finished` answers a second `/done`, `/resume` or `/merge` on an already-done task, and
  // that task may itself have been forced done with both gates skipped. So this one reply
  // cannot assert HOW the task got there: claiming it "passed every gate and merged" would
  // be the verified-completion lie that `/done` exists to keep out of the record.
  assert.doesNotMatch(reply, /\bpassed\b/i, "this reply cannot know the gates ran");
  assert.doesNotMatch(reply, /\bmerged\b/i, "this reply cannot know anything was merged");
});

test("a forced done says it was not verified, and never says it merged", () => {
  // The reply is the first thing a human reads back, so it is the first place the record
  // could start reading as a verified completion. It must not.
  const reply = describeOutcome(TASK, { kind: "forced-done" });
  assert.match(reply, /done/i);
  assert.match(reply, /gate/i, "the reader has to be told nothing was checked");
  // A DENIAL of the merge is fine and wanted; a claim of one is the lie. So the guard is
  // on the denial being PRESENT rather than on the word "merged" being absent: banning the
  // word outright rejected the very sentence that makes the reply truthful, and banning it
  // only at the start of a line let a mid-sentence "the PR was merged" through.
  assert.match(reply, /nothing was merged/i, "the reader must be told no merge happened");
  assert.doesNotMatch(
    reply,
    /(?<!nothing was )merged/i,
    "the only permitted use of the word is the denial",
  );
});

test("a refused force says to cancel it first", () => {
  const reply = describeOutcome(TASK, {
    kind: "not-forceable",
    reason: "it is running right now — `/cancel` it first",
  });
  assert.match(reply, /cancel/i);
});

test("a running task's review lines say guidance needs no restart", () => {
  // The wording that was wrong: it told a human to say what to change "before the next
  // session starts", which is advice for a mechanism that did not exist and a session that
  // was already running.
  const lines = describeTask(TASK, summary({ status: "running", review: { rounds: 1, last: "changes" } }));
  assert.match(lines, /current step/);
});

test("a failed task is offered the same way back as a parked one", () => {
  // `failed` is in `RESUMABLE` and was left out of every reply that named the recovery.
  const lines = describeTask(TASK, summary({ status: "failed", review: { rounds: 2, last: "changes" } }));
  assert.match(lines, new RegExp(`/resume ${TASK}`));
});
