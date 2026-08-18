import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import { checkLimits, madeProgress, recordProgress } from "./progress.ts";

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
  });
  assert.deepEqual(record, { lastProgressSession: 5, noProgressStreak: 0 });
});

test("no progress increments the streak but preserves the high-water mark", () => {
  const record = recordProgress({ lastProgressSession: 2, noProgressStreak: 1 }, 6, {
    committed: false,
    acceptanceImproved: false,
    stepCompleted: false,
  });
  // lastProgressSession stays at 2 so the journal can show how long it has stalled,
  // not merely that it is stalled now.
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
