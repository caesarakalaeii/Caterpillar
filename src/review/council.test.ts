/**
 * What the council actually puts in front of a reviewer.
 *
 * The council itself needs a provider and a worktree to test; these two functions are the
 * part that decides what gets reviewed, and they are pure. The evidence block is the one
 * worth pinning: `tests` is the only lens that can reach a verdict on commit order, and it
 * can only do that if the order reaches it. Drop the argument at the call site and every
 * review still runs, still passes, and silently stops grading the thing this was built for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asTaskId,
  asWorkspaceName,
  type ProposedPlan,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import type { Commit } from "./tdd.ts";
import { planPrompt, reviewPrompt } from "./council.ts";

const SPEC: TaskSpec = {
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("acme"),
  goal: "Refuse a spec that declares no repos.",
  repos: [{ host: "github.com", owner: "acme", name: "widget" }],
  requires: [],
  acceptance: ["npm test"],
};

const STATE: TaskState = {
  id: asTaskId("TASK-1"),
  status: "running",
  phase: "verifying",
  requires: [],
  sessions: 2,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PLAN: ProposedPlan = {
  title: "Tighten intake",
  summary: "One task.",
  tasks: [
    {
      localId: "a",
      title: "Refuse empty repos",
      goal: "Refuse a spec that declares no repos.",
      repos: [],
      requires: [],
      acceptance: ["npm test"],
      dependsOn: [],
    },
  ],
};

const commits: readonly Commit[] = [
  { oid: "aaa1111", subject: "Add a failing test for the empty case", files: ["src/spec.test.ts"] },
  { oid: "bbb2222", subject: "Refuse a spec with no repos", files: ["src/spec.ts"] },
];

test("the commit order reaches the reviewer", () => {
  const prompt = reviewPrompt(SPEC, STATE, "base0", commits);

  assert.match(prompt, /Test-first evidence/);
  assert.match(prompt, /aaa1111/);
  assert.match(prompt, /bbb2222/);
  // Ordered as committed, not as git prints it. The whole verdict inverts otherwise.
  assert.ok(prompt.indexOf("aaa1111") < prompt.indexOf("bbb2222"));
});

test("with no commit series the reviewer is told so, not shown an empty section", () => {
  // `branchPoint` returns undefined on a worktree whose default branch will not resolve.
  // A missing section reads as "no source commits", which is a claim about the change
  // rather than about the evidence.
  const prompt = reviewPrompt(SPEC, STATE, undefined);

  assert.match(prompt, /Test-first evidence/);
  assert.match(prompt, /could not be determined/i);
});

test("the reviewer is still told the goal and the criteria", () => {
  // Guarding the rest of the prompt against the section inserted into the middle of it.
  const prompt = reviewPrompt(SPEC, STATE, "base0", commits);

  assert.match(prompt, /Refuse a spec that declares no repos\./);
  assert.match(prompt, /`npm test`/);
  assert.match(prompt, /already verified as passing/i);
});

test("a plan reviewer gets no test-first evidence, because nothing has been written", () => {
  const prompt = planPrompt(SPEC, PLAN);

  assert.doesNotMatch(prompt, /Test-first evidence/);
  assert.match(prompt, /Refuse empty repos/);
});
