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
import { prLenses, SABOTAGE_LENS } from "./lenses.ts";
import { parseRepoStandards } from "../agent/standards.ts";
import type { PrepareOptions, PrepareResult } from "./sabotage.ts";
import {
  planPrompt,
  reviewLenses,
  reviewerPlan,
  reviewPrompt,
  sabotageAbstentionFor,
  withSabotageCopy,
} from "./council.ts";

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

const WORKTREE = "/work/tasks/TASK-1/widget";
const COPY = "/work/tasks/TASK-1/.caterpillar/sabotage";

test("a read-only lens reviews the shared worktree with no writable tool and no budget", () => {
  const plan = reviewerPlan({
    lensKey: "correctness",
    worktree: WORKTREE,
    sabotageCopy: COPY,
    maxCommands: 40,
  });

  assert.equal(plan.cwd, WORKTREE);
  assert.deepEqual(plan.toolNames, ["read", "bash", "submit_verdict"]);
  assert.equal(plan.maxCommands, undefined);
});

test("the sabotage lens reviews its own copy, with write and edit and a command budget", () => {
  const plan = reviewerPlan({
    lensKey: SABOTAGE_LENS.key,
    worktree: WORKTREE,
    sabotageCopy: COPY,
    maxCommands: 12,
  });

  assert.equal(plan.cwd, COPY);
  assert.deepEqual(plan.toolNames, ["read", "bash", "write", "edit", "submit_verdict"]);
  assert.equal(plan.maxCommands, 12);
});

test("a sabotage reviewer with no copy is refused rather than pointed at the worktree", () => {
  // The one outcome that must be impossible: `write` and `edit` in the worktree the other
  // four reviewers are reading concurrently. A throw here fails the lens, which the
  // council records as an abstention; silently falling back would corrupt the review.
  assert.throws(
    () => reviewerPlan({ lensKey: SABOTAGE_LENS.key, worktree: WORKTREE, maxCommands: 40 }),
    /sabotage/i,
  );
});

test("no lens but sabotage is ever given a writable tool, copy or no copy", () => {
  for (const lens of prLenses(true)) {
    const plan = reviewerPlan({
      lensKey: lens.key,
      worktree: WORKTREE,
      sabotageCopy: COPY,
      maxCommands: 40,
    });
    if (lens.key === SABOTAGE_LENS.key) continue;

    assert.ok(!plan.toolNames.includes("write"), `${lens.key} was given write`);
    assert.ok(!plan.toolNames.includes("edit"), `${lens.key} was given edit`);
  }
});

test("a refused copy drops the sabotage lens and records why, instead of failing the council", () => {
  const round = sabotageAbstentionFor(prLenses(true), "no disk");

  assert.ok(!round.lenses.some((l) => l.key === SABOTAGE_LENS.key));
  assert.deepEqual(
    round.lenses.map((l) => l.key),
    prLenses(false).map((l) => l.key),
  );
  assert.equal(round.verdicts.length, 1);
  const [verdict] = round.verdicts;
  assert.equal(verdict?.lens, SABOTAGE_LENS.key);
  assert.equal(verdict?.abstained, true);
  assert.match(verdict?.summary ?? "", /no disk/);
});

const prepareOptions = (): PrepareOptions => ({
  checkoutRoot: WORKTREE,
  taskDir: "/work/tasks/TASK-1",
  minFreeGb: 5,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  task: "TASK-1",
});

test("the copy is removed even when the reviewers throw", async () => {
  // The guarantee worth pinning: a throw out of `Promise.all` must not leave a whole
  // second checkout of the task on disk.
  let cleaned = false;
  const prepare = async (): Promise<PrepareResult> => ({
    ok: true,
    path: COPY,
    cleanup: async () => {
      cleaned = true;
    },
  });

  await assert.rejects(
    withSabotageCopy(prepare, prepareOptions(), async () => {
      throw new Error("a reviewer died");
    }),
    /a reviewer died/,
  );
  assert.equal(cleaned, true);
});

test("a body that succeeds is handed the copy and still gets it cleaned up", async () => {
  let cleaned = false;
  const prepare = async (): Promise<PrepareResult> => ({
    ok: true,
    path: COPY,
    cleanup: async () => {
      cleaned = true;
    },
  });

  const seen = await withSabotageCopy(prepare, prepareOptions(), async (copy) => copy);

  assert.deepEqual(seen, { ok: true, path: COPY });
  assert.equal(cleaned, true);
});

test("a refusal reaches the body as a reason and needs no cleanup", async () => {
  const prepare = async (): Promise<PrepareResult> => ({ ok: false, reason: "no disk" });

  const seen = await withSabotageCopy(prepare, prepareOptions(), async (copy) => copy);

  assert.deepEqual(seen, { ok: false, reason: "no disk" });
});

test("the council convenes its lenses carrying the repos' own standards", () => {
  // The half of §12.2 the council owns. `review()` needs a provider, a worktree and five
  // concurrent sessions to reach, so the decision is extracted here for the same reason
  // `reviewerPlan` is: drop the standards at the call site and every review still runs,
  // still passes, and silently stops grading the rules a repository shipped.
  const standards = parseRepoStandards("acme/widget", "## tests: Rule\n\nCover the error path.\n");

  const graded = reviewLenses(undefined, false, standards).filter((lens) =>
    lens.prompt.includes("Cover the error path."),
  );

  assert.deepEqual(
    graded.map((lens) => lens.key),
    ["tests"],
  );
});

test("a configured lens set is still given the repos' standards", () => {
  // `options.lenses` exists so a caller can convene its own council. It must not be a way
  // to convene one that grades against less than the author was handed.
  const standards = parseRepoStandards("acme/widget", "## design: Rule\n\nNo new deps.\n");
  const only = prLenses(false).filter((lens) => lens.key === "design");

  assert.match(reviewLenses(only, false, standards)[0]?.prompt ?? "", /No new deps\./);
});

test("the sabotage lens joins or sits out exactly as it did before repo standards", () => {
  assert.deepEqual(
    reviewLenses(undefined, true, []).map((lens) => lens.key),
    ["correctness", "design", "tests", "fit", "sabotage"],
  );
  assert.deepEqual(
    reviewLenses(undefined, false, []).map((lens) => lens.key),
    ["correctness", "design", "tests", "fit"],
  );
});
