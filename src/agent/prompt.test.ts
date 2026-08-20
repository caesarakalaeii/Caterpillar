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
import { AUTHOR_STANDARDS, TEST_FIRST_STANDARD, WRITING_STANDARD } from "./standards.ts";
import {
  BRAINSTORM_SYSTEM_PROMPT,
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
