/**
 * What the summariser is allowed to know.
 *
 * The prose is the one part of a digest that is not derived from git, so the only defence
 * against it inventing a day is the evidence it is handed. These tests pin what goes into
 * the prompt — the agent's own journal and the commit subjects, both of which are facts —
 * and the bound that stops a retry storm's journal from becoming a 90k-token prompt.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import type { DayDigest, TaskChange } from "./collect.ts";
import { EVIDENCE_LIMIT, summaryPrompt } from "./summarise.ts";

const change = (overrides: Partial<TaskChange> & Pick<TaskChange, "id">): TaskChange => ({
  title: "A task",
  to: "done",
  phase: "implementing",
  sessions: 1,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  prOpened: false,
  questionsAsked: 0,
  answersGiven: 0,
  verdicts: 0,
  noProgressStreak: 0,
  changes: [],
  ...overrides,
});

const digest = (changed: readonly TaskChange[]): DayDigest => ({
  date: "2026-08-16",
  from: "2026-08-15T16:00:00.000Z",
  to: "2026-08-16T16:00:00.000Z",
  changed,
  open: [],
  totals: {
    sessions: changed.length,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    tasksTouched: changed.length,
    reached: {},
  },
  quiet: changed.length === 0,
  unreadable: [],
});

test("the prompt carries the facts, the journal and the commit subjects", () => {
  const prompt = summaryPrompt(
    digest([
      change({
        id: asTaskId("TASK-118"),
        title: "resume clears the streak",
        journal: "## Session 2\n\nFound the streak was never reset on resume.",
        changes: [
          {
            repo: "caesar/caterpillar",
            commits: ["fix(notify): clear the streak on resume"],
            filesChanged: 3,
            insertions: 40,
            deletions: 2,
            files: ["src/notify/commands.ts"],
          },
        ],
      }),
    ]),
    "Europe/Berlin",
  );

  assert.match(prompt, /TASK-118/);
  assert.match(prompt, /Found the streak was never reset on resume/, "the agent's own account");
  assert.match(prompt, /fix\(notify\): clear the streak on resume/, "what actually landed");
  assert.match(prompt, /src\/notify\/commands\.ts/);
});

test("evidence is bounded, and what was dropped is stated in the prompt", () => {
  // A day with twenty parked tasks can carry more journal than the context window holds.
  // Truncating silently would leave the model summarising a day it was shown a third of,
  // with no way to know that is what happened.
  const long = "x".repeat(3000);
  const many = Array.from({ length: 40 }, (_, index) =>
    change({ id: asTaskId(`TASK-${index}`), journal: long }),
  );

  const prompt = summaryPrompt(digest(many), "Europe/Berlin");

  assert.ok(
    [...prompt].length < EVIDENCE_LIMIT * 2,
    `the prompt grew to ${[...prompt].length} code points`,
  );
  assert.match(prompt, /journal.*omitted|omitted.*journal/i);
});

test("a quiet day still produces a prompt, and says the day was quiet", () => {
  const prompt = summaryPrompt(digest([]), "Europe/Berlin");

  assert.match(prompt, /nothing moved/i);
});
