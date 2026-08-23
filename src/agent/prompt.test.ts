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
