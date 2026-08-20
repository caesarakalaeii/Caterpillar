/**
 * The council's lenses.
 *
 * What is asserted here is the thing the lens design is FOR: that each concern has
 * exactly one owner, and that the text a reviewer grades against is the text the author
 * was given. Both fail silently. A second lens quietly acquiring an opinion about tests
 * produces two blocking objections to one defect and a task that ping-pongs to a park;
 * a reviewer paraphrasing the standards rejects work over a rule nobody was told.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHOR_STANDARDS,
  CODE_HEALTH_STANDARD,
  REVIEW_STANDARD,
  TEST_FIRST_STANDARD,
  WRITING_STANDARD,
} from "../agent/standards.ts";
import { PLAN_LENSES, PR_LENSES } from "./lenses.ts";

test("every reviewer is told when not to block", () => {
  // The council's expensive failure is not a missed bug, it is three reviewers sending a
  // correct change back over a preference.
  for (const lens of PR_LENSES) {
    assert.ok(lens.prompt.includes(REVIEW_STANDARD), lens.key);
  }
});

test("test discipline has exactly one owner", () => {
  const owners = PR_LENSES.filter((l) => l.prompt.includes(TEST_FIRST_STANDARD));

  assert.deepEqual(
    owners.map((l) => l.key),
    ["tests"],
  );
});

test("design and the written record have exactly one owner, and it is the same one", () => {
  // Deliberately one lens for both. They are the same question asked twice — will the
  // next reader understand this — and a fifth reviewer is a fifth concurrent session on
  // every round of every task, which is not what a thin pull request description costs.
  for (const standard of [CODE_HEALTH_STANDARD, WRITING_STANDARD]) {
    assert.deepEqual(
      PR_LENSES.filter((l) => l.prompt.includes(standard)).map((l) => l.key),
      ["design"],
    );
  }
});

test("the standards a reviewer grades against are the author's own, verbatim", () => {
  // The whole reason `agent/standards.ts` exists. Assembled from the same constants, so a
  // paraphrase on either side is a test failure rather than a rejected pull request.
  const everything = PR_LENSES.map((l) => l.prompt).join("\n");

  for (const part of [CODE_HEALTH_STANDARD, TEST_FIRST_STANDARD, WRITING_STANDARD]) {
    assert.ok(everything.includes(part), "a standard is graded against nowhere");
    assert.ok(AUTHOR_STANDARDS.includes(part), "a standard is graded against but never given");
  }
});

test("lens keys are unique and stable", () => {
  // They are written into verdict files, the journal and Discord. A duplicate would make
  // two reviewers indistinguishable in every one of those.
  for (const lenses of [PR_LENSES, PLAN_LENSES]) {
    const keys = lenses.map((l) => l.key);
    assert.equal(new Set(keys).size, keys.length, keys.join(","));
  }

  assert.deepEqual(
    PR_LENSES.map((l) => l.key),
    ["correctness", "design", "tests", "fit"],
  );
});

test("every lens is told to finish with submit_verdict", () => {
  for (const lens of [...PR_LENSES, ...PLAN_LENSES]) {
    assert.match(lens.prompt, /submit_verdict/, lens.key);
  }
});

test("a plan reviewer is not handed the code-health standard", () => {
  // Nothing has been written yet. "Does this improve the health of the codebase" has no
  // referent for a plan, and a reviewer given a rule it cannot apply applies it anyway.
  for (const lens of PLAN_LENSES) {
    assert.ok(!lens.prompt.includes(CODE_HEALTH_STANDARD), lens.key);
  }
});
