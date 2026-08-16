/**
 * The council's decision rule.
 *
 * This is the file where getting it wrong is most expensive in both directions: too
 * strict and every change ping-pongs until it parks, too lax and a change nobody
 * successfully reviewed merges itself. Both failure modes are asserted here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, renderVerdict, summariseVerdict, type ReviewerVerdict } from "./decide.ts";

const verdict = (over: Partial<ReviewerVerdict> = {}): ReviewerVerdict => ({
  lens: "correctness",
  title: "Correctness",
  decision: "pass",
  blocking: false,
  summary: "Looks right.",
  findings: [],
  ...over,
});

test("three passes pass", () => {
  const result = decide([
    verdict({ lens: "correctness" }),
    verdict({ lens: "design" }),
    verdict({ lens: "fit" }),
  ]);

  assert.equal(result.decision, "pass");
  assert.equal(result.blockers.length, 0);
});

test("one blocking objection outvotes two passes", () => {
  // Not a majority rule. Two reviewers who did not look at the thing the third found
  // are not evidence against it — a defect is not a preference.
  const result = decide([
    verdict({ lens: "correctness", decision: "changes", blocking: true, summary: "off by one" }),
    verdict({ lens: "design" }),
    verdict({ lens: "fit" }),
  ]);

  assert.equal(result.decision, "changes");
  assert.deepEqual(
    result.blockers.map((b) => b.lens),
    ["correctness"],
  );
});

test("non-blocking changes are said, not enforced", () => {
  // The expensive failure mode is three reviewers sending a correct change back over a
  // naming preference. `changes` without `blocking` is a comment.
  const result = decide([
    verdict({ decision: "changes", blocking: false, summary: "could use a better name" }),
    verdict({ lens: "design", decision: "changes", blocking: false }),
    verdict({ lens: "fit" }),
  ]);

  assert.equal(result.decision, "pass");
});

test("an abstention is never an approval", () => {
  const result = decide([
    verdict({ lens: "correctness", abstained: true, decision: "changes" }),
    verdict({ lens: "design" }),
    verdict({ lens: "fit" }),
  ]);

  assert.equal(result.abstentions.length, 1);
  assert.equal(result.blockers.length, 0, "an abstention must not block either");
  assert.equal(result.decision, "pass", "two real approvals still carry it");
  assert.match(renderVerdict(result), /ABSTAINED/);
  assert.match(renderVerdict(result), /not an approval/);
});

test("a council where nobody reviewed does not merge", () => {
  // The only outcome that must never be silently treated as consensus.
  assert.equal(decide([]).decision, "changes");
});

test("a council where EVERY reviewer abstained does not merge either", () => {
  // The same outcome as an empty council, arrived at differently: three reviewers were
  // convened and none of them reviewed anything. Counting zero blocking objections as
  // consensus is how a provider outage would have merged an unread change.
  const result = decide([
    verdict({ lens: "correctness", abstained: true, decision: "changes" }),
    verdict({ lens: "design", abstained: true, decision: "changes" }),
    verdict({ lens: "fit", abstained: true, decision: "changes" }),
  ]);

  assert.equal(result.decision, "changes");
  assert.equal(result.abstentions.length, 3);
});

test("a rejected verdict reads as instructions, not as a score", () => {
  // This text goes into the journal, which is what the next session actually reads. If
  // it does not say WHERE and WHAT, the next session re-derives the objection or ignores it.
  const text = renderVerdict(
    decide([
      verdict({
        lens: "correctness",
        decision: "changes",
        blocking: true,
        summary: "Throws on an empty repo list.",
        findings: [{ where: "src/agent/runner.ts:107", what: "spec.repos[0] is undefined when intake allows an empty list" }],
      }),
      verdict({ lens: "design" }),
      verdict({ lens: "fit" }),
    ]),
  );

  assert.match(text, /CHANGES REQUESTED/);
  assert.match(text, /src\/agent\/runner\.ts:107/);
  assert.match(text, /spec\.repos\[0\] is undefined/);
});

test("the one-line summary names who blocked", () => {
  const blocked = decide([
    verdict({ lens: "fit", decision: "changes", blocking: true }),
    verdict({ lens: "design", decision: "changes", blocking: true }),
  ]);

  assert.equal(summariseVerdict(blocked), "blocked by fit, design");
  assert.match(summariseVerdict(decide([verdict()])), /passed 1 lens/);
});
