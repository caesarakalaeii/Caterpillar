import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import { checkLimits, commitNote, madeProgress, recordProgress } from "./progress.ts";

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

test("a session that committed gets a journal line naming the branch, count and tip", () => {
  // GH-96's second defect. Sessions 2-3 committed 18 changes and pushed them; sessions
  // 4-7 each journalled "without a control-plane decision" and nothing else, so the
  // journal a later session read said that nothing had happened. Session 7 believed it
  // and implemented the whole task a second time.
  //
  // Written from the probe's evidence rather than from the agent's summary on purpose:
  // the summary is what a dying session fails to produce, and it is the only part of the
  // entry that can be wrong about the repository.
  assert.equal(
    commitNote(asTaskId("GH-96"), {
      committed: true,
      acceptanceImproved: false,
      stepCompleted: false,
      commits: 18,
      headOid: "c320ff4a7d1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c",
      baselineOid: "e0de61f0000000000000000000000000000000aa",
    }),
    "**Work on the branch:** 18 commits on `agent/GH-96`, tip `c320ff4`. " +
      "Read them before writing anything — they may already be the task.",
  );
});

test("one commit is not described as one commits", () => {
  // The line is read by a human as often as by an agent, and a journal that says
  // "1 commits" reads as generated noise rather than as a fact about the branch.
  const note = commitNote(asTaskId("T-1"), {
    committed: true,
    acceptanceImproved: false,
    stepCompleted: false,
    commits: 1,
    headOid: "abcdef1234567890abcdef1234567890abcdef12",
  });
  assert.match(note ?? "", /\b1 commit on\b/);
});

test("a branch with no commits on it gets no journal line at all", () => {
  // The entry must not claim work that does not exist, and "0 commits" in the journal
  // of every session that read code and wrote nothing is noise that hides the case
  // this line exists for.
  assert.equal(
    commitNote(asTaskId("T-1"), {
      committed: false,
      acceptanceImproved: false,
      stepCompleted: false,
      commits: 0,
      headOid: "abcdef1234567890abcdef1234567890abcdef12",
    }),
    undefined,
  );
});

test("a session that committed nothing new still reports what is on the branch", () => {
  // The case that cost GH-96 the duplicate implementation, and the reason this is not
  // conditioned on `committed`. Sessions 4-7 each added no commit of their own — so
  // `committed` was false for every one of them — while eighteen commits sat on the
  // branch. It is the standing total that a resumed session needs, not this session's
  // delta.
  assert.equal(
    commitNote(asTaskId("GH-96"), {
      committed: false,
      acceptanceImproved: false,
      stepCompleted: false,
      commits: 18,
      headOid: "c320ff4a7d1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c",
    }),
    "**Work on the branch:** 18 commits on `agent/GH-96`, tip `c320ff4`. " +
      "Read them before writing anything — they may already be the task.",
  );
});

test("a probe that could not count commits produces no line rather than a guess", () => {
  // `commitsSince` answers with nothing rather than throwing on a base this worktree does
  // not carry, and a probe on a repo it cannot read reports no head at all. Neither is a
  // branch with nothing on it, and saying so would be the sentence a resumed session
  // trusts most being the one that is wrong.
  assert.equal(
    commitNote(asTaskId("T-1"), {
      committed: false,
      acceptanceImproved: false,
      stepCompleted: false,
    }),
    undefined,
  );
});
