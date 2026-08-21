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
import { PLAN_LENSES, PR_LENSES, SABOTAGE_LENS, prLenses } from "./lenses.ts";

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

test("the sabotage lens is convened only when the diff touches source", () => {
  // A documentation-only diff has nothing to break, and convening a reviewer that can
  // only abstain costs a concurrent session and a copy of the checkout.
  assert.deepEqual(
    prLenses(true).map((l) => l.key),
    ["correctness", "design", "tests", "fit", "sabotage"],
  );
  assert.deepEqual(
    prLenses(false).map((l) => l.key),
    ["correctness", "design", "tests", "fit"],
  );
});

test("the sabotage lens is not a standing member of the council", () => {
  // `PR_LENSES` is what every other caller convenes. Adding it there would put a
  // writable copy of the checkout behind every documentation change.
  assert.ok(!PR_LENSES.includes(SABOTAGE_LENS));
});

test("the sabotage lens went through the shared factory", () => {
  // Hand-rolling its preamble would drop the blocking bar and the abstention rule that
  // every other reviewer is held to.
  assert.ok(SABOTAGE_LENS.prompt.includes(REVIEW_STANDARD));
  assert.match(SABOTAGE_LENS.prompt, /submit_verdict/);
});

test("no reviewer is told how many reviewers there are", () => {
  // The count was baked into the preamble as "four". A fifth lens makes it false for
  // every reviewer, and a reviewer that has miscounted its peers misjudges its own scope.
  for (const lens of [...PR_LENSES, ...PLAN_LENSES, SABOTAGE_LENS]) {
    assert.ok(!lens.prompt.includes("one of four independent reviewers"), lens.key);
  }
});

test("the sabotage lens overrides the shared instruction not to re-run the suite", () => {
  // It inherits `SHARED`, which forbids exactly the thing it exists to do. Without an
  // explicit override the reviewer obeys the preamble and abstains every time.
  assert.ok(
    SABOTAGE_LENS.prompt.includes("do not run the test suite\nagain to confirm it"),
    "the shared instruction is no longer inherited; update the override phrase too",
  );
  assert.ok(SABOTAGE_LENS.prompt.includes("does not apply to this lens"));
  assert.ok(SABOTAGE_LENS.prompt.includes("re-running it is the entire method"));
  assert.ok(SABOTAGE_LENS.prompt.includes("whether it FAILS when it should"));
});

test("the sabotage lens blocks on a sabotage the suite misses, and abstains otherwise", () => {
  assert.ok(SABOTAGE_LENS.prompt.includes("a test that does not test"));
  assert.ok(SABOTAGE_LENS.prompt.includes("could not complete the review"));
  assert.ok(
    SABOTAGE_LENS.prompt.includes("not a defect in the change"),
    "an unrunnable copy must not be reported as a fault in the diff",
  );
});

test("a plan reviewer is not handed the code-health standard", () => {
  // Nothing has been written yet. "Does this improve the health of the codebase" has no
  // referent for a plan, and a reviewer given a rule it cannot apply applies it anyway.
  for (const lens of PLAN_LENSES) {
    assert.ok(!lens.prompt.includes(CODE_HEALTH_STANDARD), lens.key);
  }
});
