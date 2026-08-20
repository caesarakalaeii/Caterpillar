/**
 * The engineering standards, and the one property that makes them worth having.
 *
 * These are text, so there is nothing here about what they SAY — a test asserting that a
 * paragraph contains the word "tests" pins nothing and breaks on every edit. What is
 * asserted is structural, and each of these has a way of quietly coming untrue:
 *
 *   The author and the reviewer must be graded on the SAME text. Two copies drift, and a
 *   change is then rejected for a rule its author was never given.
 *
 *   Every kind of session that writes code must carry them. `remediation` builds its
 *   prompt from `SYSTEM_PROMPT`, and the day someone writes it standalone the alert path
 *   silently loses the standards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHOR_STANDARDS,
  CODE_HEALTH_STANDARD,
  REVIEW_STANDARD,
  TEST_FIRST_STANDARD,
  WRITING_STANDARD,
} from "./standards.ts";

test("the author's standards are composed of the parts, verbatim", () => {
  // Composition rather than a fourth hand-written copy: the parts are quoted into the
  // lenses individually, and a paraphrase in the bundle would grade against text nobody
  // was given.
  for (const part of [CODE_HEALTH_STANDARD, TEST_FIRST_STANDARD, WRITING_STANDARD]) {
    assert.ok(AUTHOR_STANDARDS.includes(part), "a standard is missing from the bundle");
  }
});

test("the reviewer's standard is not in the author's bundle", () => {
  // It tells a reviewer when NOT to block. Handed to the author it reads as permission to
  // ship whatever survives a lenient reading.
  assert.ok(!AUTHOR_STANDARDS.includes(REVIEW_STANDARD));
});

test("every standard is markdown with a heading, so it can be spliced into a prompt", () => {
  for (const [name, standard] of Object.entries({
    CODE_HEALTH_STANDARD,
    TEST_FIRST_STANDARD,
    WRITING_STANDARD,
    REVIEW_STANDARD,
  })) {
    assert.match(standard, /^## /, `${name} must open with a heading`);
    assert.equal(standard, standard.trim(), `${name} must not carry stray whitespace`);
  }
});
