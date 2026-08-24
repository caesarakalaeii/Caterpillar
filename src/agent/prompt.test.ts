/**
 * What each kind of session is actually told.
 *
 * Prompt text is not unit-testable in the usual sense and this does not try. It pins the
 * wiring — which prompt carries which block — because that is what silently comes undone:
 * the standards are spliced in one place and inherited in another, and an inheritance is
 * exactly the kind of thing a later edit replaces with a standalone string without
 * noticing that a whole task kind has stopped being held to anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTIFACT_BYTES } from "../state/store.ts";
import {
  AUTHOR_STANDARDS,
  TEST_FIRST_STANDARD,
  WRITING_STANDARD,
  parseRepoStandards,
} from "./standards.ts";
import {
  asTaskId,
  asWorkspaceName,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import {
  BRAINSTORM_SYSTEM_PROMPT,
  buildPrompt,
  REMEDIATION_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  systemPromptFor,
} from "./prompt.ts";

test("an implementation session is given the standards", () => {
  assert.ok(SYSTEM_PROMPT.includes(AUTHOR_STANDARDS));
});

test("a remediation session is held to the same standards as any other", () => {
  // It writes code, opens a pull request and is graded by the same council. The only
  // thing special about it is where the task came from — inheriting rather than
  // restating is what keeps that true.
  assert.ok(REMEDIATION_SYSTEM_PROMPT.includes(AUTHOR_STANDARDS));
  assert.ok(REMEDIATION_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT));
});

test("a brainstorm is held to test-first but not to commit conventions", () => {
  // It writes a plan, never a commit. Handing it the commit-message rules spends context
  // on instructions for tools it does not have — but the tasks it writes must demand
  // tests, because it is the one place a task's acceptance criteria are decided.
  assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(WRITING_STANDARD));
  assert.match(BRAINSTORM_SYSTEM_PROMPT, /test/i);
});

test("the implementation prompt is the default for an unknown or absent kind", () => {
  assert.equal(systemPromptFor(undefined), SYSTEM_PROMPT);
  assert.equal(systemPromptFor("implement"), SYSTEM_PROMPT);
  assert.equal(systemPromptFor("brainstorm"), BRAINSTORM_SYSTEM_PROMPT);
  assert.equal(systemPromptFor("remediation"), REMEDIATION_SYSTEM_PROMPT);
});

test("the attribution rules survive whatever else is added to the prompt", () => {
  // Guarded because it has been got wrong before and the failure is invisible until a
  // commit lands signed as somebody who does not work here. Anything appended to this
  // prompt must not push it out.
  for (const prompt of [SYSTEM_PROMPT, REMEDIATION_SYSTEM_PROMPT]) {
    assert.match(prompt, /Co-Authored-By/);
    assert.match(prompt, /Never sign your work/i);
    assert.match(prompt, /caterpillar@users\.noreply\.github\.com/);
  }
});

test("test-first reaches every session that can write code", () => {
  for (const kind of ["implement", "remediation"] as const) {
    assert.ok(systemPromptFor(kind).includes(TEST_FIRST_STANDARD), kind);
  }
});

test("an implementation session is given its repos' own standards", () => {
  // Spliced here and into the lenses from the same parse, so the author cannot be held to
  // a repo rule the council was not given, or the reverse (§12.2).
  const standards = parseRepoStandards("acme/web", "## tests: Rule\n\nCover the error path.\n");

  const prompt = systemPromptFor("implement", standards);
  assert.ok(prompt.startsWith(SYSTEM_PROMPT));
  assert.ok(prompt.includes("Cover the error path."));
  assert.ok(prompt.includes("acme/web"));
});

test("a session whose repos supply nothing gets the prompt unchanged", () => {
  for (const kind of ["implement", "remediation", "brainstorm"] as const) {
    assert.equal(systemPromptFor(kind, []), systemPromptFor(kind));
  }
});

test("a brainstorm is not given repo standards", () => {
  // It writes a plan, not code. The rules are for the sessions that implement its tasks,
  // and those read them from the repo themselves.
  const standards = parseRepoStandards("acme/web", "## tests: Rule\n\nCover the error path.\n");

  assert.equal(systemPromptFor("brainstorm", standards), BRAINSTORM_SYSTEM_PROMPT);
});

test("a remediation session is held to its repos' standards too", () => {
  const standards = parseRepoStandards("acme/web", "## design: Rule\n\nNo new dependencies.\n");

  assert.ok(systemPromptFor("remediation", standards).includes("No new dependencies."));
});

/**
 * The evidence directory, which is worth a line in the prompt only because it is
 * otherwise unreachable: a session whose task is a UI change cannot use a convention it
 * has never been told about, and the gate cannot infer one from the exit code.
 */
const SPEC: TaskSpec = {
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("acme"),
  goal: "Make the header not overlap the nav.",
  repos: [{ host: "github.com", owner: "acme", name: "widget" }],
  requires: [],
  acceptance: ["npm test"],
};

const STATE: TaskState = {
  id: asTaskId("TASK-1"),
  status: "running",
  phase: "implementing",
  requires: [],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("a session is told where a gate may leave evidence", () => {
  const prompt = buildPrompt({ spec: SPEC, state: STATE });

  assert.match(prompt, /CATERPILLAR_EVIDENCE_DIR/);
  // Beside the criteria it belongs to, not in some later section: an agent reading about
  // the gate is the one moment this is relevant.
  assert.ok(prompt.indexOf("npm test") < prompt.indexOf("CATERPILLAR_EVIDENCE_DIR"));
  // From the cap the store enforces, not from prose beside it. A number transcribed here
  // and changed there sends every agent hunting for a limit that does not exist.
  assert.match(prompt, new RegExp(`${ARTIFACT_BYTES / 1024 ** 2} MiB`));
});

test("a brainstorm gets no evidence line, because it declares no acceptance criteria", () => {
  // Its own output is a plan. A brainstorm has no gate of its own to leave anything for.
  const prompt = buildPrompt({ spec: { ...SPEC, kind: "brainstorm" }, state: STATE });

  assert.doesNotMatch(prompt, /CATERPILLAR_EVIDENCE_DIR/);
});

/**
 * The amendment section (DESIGN.md §12.3).
 *
 * Two tasks were re-claimed into the same unsatisfiable criterion twice each because
 * nothing in the prompt said the ground had NOT moved. The inverse costs the same session:
 * the gate is amended, the prompt shows the new list with no explanation, and the next
 * session re-derives a failure that no longer exists.
 */
const AMENDED = {
  filed: ["npm test", "npm run lint"],
  history: [
    {
      index: 1,
      acceptance: ["npm test", "npm test -- src/widget"],
      why: "the repo-wide lint predates this branch and fails on files it does not touch",
      author: "operator",
      at: "2026-08-19T09:14:02.113Z",
    },
  ],
} as const;

test("a session on an amended task is told what changed and why, verbatim", () => {
  const spec = { ...SPEC, acceptance: AMENDED.history[0].acceptance };

  const prompt = buildPrompt({ spec, state: STATE, amendments: AMENDED });

  assert.ok(prompt.includes(AMENDED.history[0].why), "the reason must survive word for word");
  assert.match(prompt, /npm run lint/, "the criterion that went away is named");
  assert.match(prompt, /npm test -- src\/widget/, "so is the one that replaced it");
  assert.match(prompt, /operator/);
  assert.match(prompt, /2026-08-19T09:14:02\.113Z/);
});

test("an amendment is announced however many sessions ago it was filed", () => {
  // Deliberately not conditioned on recency. A stale-but-visible note costs a paragraph;
  // a missing one costs a session.
  const spec = { ...SPEC, acceptance: AMENDED.history[0].acceptance };

  const prompt = buildPrompt({
    spec,
    state: { ...STATE, sessions: 11 },
    amendments: AMENDED,
    journal: "session 1 through 11 happened",
  });

  assert.ok(prompt.includes(AMENDED.history[0].why));
});

test("a task with no amendment gets byte-for-byte the prompt it got before", () => {
  // The regression guard on the common path. Written out in full rather than as an
  // absence-of-the-word-amend check, because a section rendered empty, a stray blank line
  // or a moved heading are all invisible to that and all change every prompt in the fleet.
  const prompt = buildPrompt({ spec: SPEC, state: STATE });

  assert.equal(
    prompt,
    "# Task TASK-1\n" +
      "\n" +
      "Workspace: acme\n" +
      "Session: 1\n" +
      "Phase: implementing\n" +
      "Repos in scope: acme/widget\n" +
      "\n" +
      "## Goal\n" +
      "\n" +
      "Make the header not overlap the nav.\n" +
      "\n" +
      "## Acceptance criteria\n" +
      "\n" +
      "These are run by the supervisor, not by you. All must exit 0 before the task is done:\n" +
      "\n" +
      "- `npm test`\n" +
      "\n" +
      "A command may write a file into `$CATERPILLAR_EVIDENCE_DIR` — a screenshot, a trace, " +
      "a report. The supervisor commits whatever is there as an artifact of this task, " +
      "whether the command passed or failed, and shows it to the review council. It does " +
      "not change the verdict: the exit code is still the whole gate. Keep it under 1 MiB — " +
      "over the cap it is refused with its size in the failure text rather than truncated, " +
      "because half an image is not a smaller image.\n" +
      "\n" +
      "This is the first session. Start by orienting yourself in the repo, then begin.\n",
  );
});

test("an empty amendment history is the unamended prompt, not an empty section", () => {
  // `listAmendments` returns `[]` for the overwhelming majority of tasks, and the runner
  // passes what it read rather than deciding whether to pass anything.
  assert.equal(
    buildPrompt({ spec: SPEC, state: STATE, amendments: { filed: SPEC.acceptance, history: [] } }),
    buildPrompt({ spec: SPEC, state: STATE }),
  );
});

test("only the newest amendment is described, because only it is the gate", () => {
  // The highest number wins entirely (§12.3). Describing the diff of a superseded
  // amendment would name criteria that are not in force.
  const superseded = {
    index: 1,
    acceptance: ["npm test", "npm run typecheck"],
    why: "the first attempt, itself wrong",
    author: "operator",
    at: "2026-08-19T09:00:00.000Z",
  };
  const spec = { ...SPEC, acceptance: AMENDED.history[0].acceptance };

  const prompt = buildPrompt({
    spec,
    state: STATE,
    amendments: { filed: AMENDED.filed, history: [superseded, { ...AMENDED.history[0], index: 2 }] },
  });

  assert.ok(prompt.includes(AMENDED.history[0].why));
  assert.doesNotMatch(prompt, /npm run typecheck/);
  // But the count is said, so a reader knows the gate has been argued with twice.
  assert.match(prompt, /2 amendments/);
});
