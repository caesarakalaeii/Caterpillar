import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import { checkLimits, committedLine, madeProgress, recordProgress } from "./progress.ts";

const baseState = (overrides: Partial<TaskState> = {}): TaskState => ({
  id: asTaskId("TASK-1"),
  status: "ready",
  phase: "implementing",
  requires: ["linux"],
  sessions: 1,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 1, noProgressStreak: 0 },
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
  ...overrides,
});

test("any single form of evidence counts as progress", () => {
  assert.equal(
    madeProgress({ committed: true, acceptanceImproved: false, stepCompleted: false }),
    true,
  );
  assert.equal(
    madeProgress({ committed: false, acceptanceImproved: true, stepCompleted: false }),
    true,
  );
  assert.equal(
    madeProgress({ committed: false, acceptanceImproved: false, stepCompleted: true }),
    true,
  );
  assert.equal(
    madeProgress({ committed: false, acceptanceImproved: false, stepCompleted: false }),
    false,
  );
});

test("progress resets the streak and advances the high-water mark", () => {
  const record = recordProgress({ lastProgressSession: 2, noProgressStreak: 2 }, 5, {
    committed: true,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "handoff");
  assert.deepEqual(record, { lastProgressSession: 5, noProgressStreak: 0 });
});

test("no progress increments the streak but preserves the high-water mark", () => {
  const record = recordProgress({ lastProgressSession: 2, noProgressStreak: 1 }, 6, {
    committed: false,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "handoff");
  // lastProgressSession stays at 2 so the journal can show how long it has stalled,
  // not merely that it is stalled now.
  assert.deepEqual(record, { lastProgressSession: 2, noProgressStreak: 2 });
});

test("a session that stopped to ask a human does not extend the streak", () => {
  // A task in `awaiting-human` has nothing running (DESIGN.md §7), so it cannot be
  // going in circles — which is the only question §11.1 asks. Scoring the exit as a
  // stall is what fired CaterpillarTaskThrashing for BS-1540279100223127564-01: the
  // session before it was a rejected completion claim (streak 1), the session after it
  // asked a human and took the streak to 2, and the alert then fired for hours against
  // a task no runner was working.
  const record = recordProgress({ lastProgressSession: 2, noProgressStreak: 1 }, 4, {
    committed: false,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "ask-human");

  assert.deepEqual(record, { lastProgressSession: 2, noProgressStreak: 1 });
});

test("asking a human does not clear a streak that other sessions earned", () => {
  // Neutral, not forgiving. Clearing here would hand an agent a way to reset the
  // detector on demand: ask a question, get answered, spin, ask again. The streak the
  // stalled sessions earned is preserved for whatever runs next.
  const record = recordProgress({ lastProgressSession: 1, noProgressStreak: 2 }, 5, {
    committed: false,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "ask-human");

  assert.equal(record.noProgressStreak, 2);
});

test("a commit still counts when the session ended by asking a human", () => {
  // Progress is progress whatever the exit reason: the agent may commit real work and
  // then discover it needs a decision. The streak clears and the high-water mark moves.
  const record = recordProgress({ lastProgressSession: 1, noProgressStreak: 2 }, 5, {
    committed: true,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "ask-human");

  assert.deepEqual(record, { lastProgressSession: 5, noProgressStreak: 0 });
});

test("a session that merely ran out of context still extends the streak", () => {
  // The guard is for `ask-human` alone. A `handoff` is the ordinary end of a session
  // and says nothing about whether anything was achieved, so exempting it would blind
  // the detector to the exact failure it exists for — an agent burning context in
  // circles, which is what every one of those sessions looks like.
  const record = recordProgress({ lastProgressSession: 2, noProgressStreak: 1 }, 4, {
    committed: false,
    acceptanceImproved: false,
    stepCompleted: false,
  }, "handoff");

  assert.deepEqual(record, { lastProgressSession: 2, noProgressStreak: 2 });
});

test("the session limit parks the task", () => {
  const verdict = checkLimits(
    baseState({ sessions: 20, limits: { maxSessions: 20 } }),
    { maxSessions: 20 },
    { noProgressLimit: 3 },
  );
  assert.equal(verdict.kind, "park");
});

test("the no-progress detector parks a thrashing task", () => {
  const verdict = checkLimits(
    baseState({ progress: { lastProgressSession: 2, noProgressStreak: 3 } }),
    { maxSessions: 20 },
    { noProgressLimit: 3 },
  );
  assert.equal(verdict.kind, "park");
  if (verdict.kind === "park") {
    assert.match(verdict.reason, /no measurable/);
  }
});

test("a healthy task continues", () => {
  const verdict = checkLimits(baseState(), { maxSessions: 20 }, { noProgressLimit: 3 });
  assert.equal(verdict.kind, "continue");
});

test("the committed line names the branch and the tip a session left behind", () => {
  // GH-96: the sentence that would have stopped session 7 re-implementing the task.
  // It has to be readable on its own, because the next session reads the journal
  // without the state file open beside it.
  assert.deepEqual(
    committedLine(asTaskId("GH-96"), {
      committed: true,
      acceptanceImproved: false,
      stepCompleted: false,
      headOid: "6a5db6f0000000000000000000000000000000ab",
      baselineOid: "c320ff40000000000000000000000000000000cd",
    }),
    ["**Committed:** `agent/GH-96` is at `6a5db6f`, was `c320ff4`"],
  );
});

test("the committed line is omitted when the branch did not move", () => {
  // Nothing to say beats a line saying nothing: an entry that mentions the branch on
  // every session teaches the reader to skip it, which costs exactly the sessions this
  // line exists for.
  assert.deepEqual(
    committedLine(asTaskId("GH-96"), {
      committed: false,
      acceptanceImproved: false,
      stepCompleted: false,
      headOid: "6a5db6f0000000000000000000000000000000ab",
      baselineOid: "6a5db6f0000000000000000000000000000000ab",
    }),
    [],
  );
});

test("the committed line still names the tip when there is no baseline to compare", () => {
  // A first session, or a probe that could not resolve the fork point. The tip is the
  // half that matters — it is what the next session checks its own HEAD against.
  assert.deepEqual(
    committedLine(asTaskId("GH-96"), {
      committed: true,
      acceptanceImproved: false,
      stepCompleted: false,
      headOid: "6a5db6f0000000000000000000000000000000ab",
    }),
    ["**Committed:** `agent/GH-96` is at `6a5db6f`"],
  );
});

test("the committed line is omitted when the probe could not read a head at all", () => {
  // A repo-less spec, or a worktree the probe could not open. Claiming a commit with no
  // oid to check would be worse than silence: it is unfalsifiable by the next session.
  assert.deepEqual(
    committedLine(asTaskId("GH-96"), {
      committed: true,
      acceptanceImproved: false,
      stepCompleted: false,
    }),
    [],
  );
});
