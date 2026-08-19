/**
 * The council's decision rule.
 *
 * This is the file where getting it wrong is most expensive in both directions: too
 * strict and every change ping-pongs until it parks, too lax and a change nobody
 * successfully reviewed merges itself. Both failure modes are asserted here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  explainVerdict,
  renderVerdict,
  summariseVerdict,
  type ReviewerVerdict,
} from "./decide.ts";

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

test("the one-line summary of an all-abstained council is not `blocked by` nothing", () => {
  // `decide` sends this back with zero blockers by construction, so the join over the
  // blocker list produced a sentence that stopped after "by" — in the one outcome where
  // the reader most needs to be told that no review happened.
  const nobody = decide([
    verdict({ lens: "correctness", abstained: true, decision: "changes" }),
    verdict({ lens: "design", abstained: true, decision: "changes" }),
  ]);

  assert.equal(nobody.blockers.length, 0);
  assert.doesNotMatch(summariseVerdict(nobody), /blocked by\s*$/);
  assert.match(summariseVerdict(nobody), /no reviewer completed a review \(2 abstained\)/);
  assert.match(explainVerdict(nobody), /abstention is not an approval/);
});

test("the explanation says what was objected to, not only who objected", () => {
  // The whole point: this is what Discord shows. `blocked by feasibility` named a lens and
  // gave the human nothing to act on, and the reasons were in a repo they had to clone.
  const blocked = decide([
    verdict({
      lens: "feasibility",
      title: "Feasibility",
      decision: "changes",
      blocking: true,
      summary: "Task 3 cannot be verified by the command it declares.",
      findings: [{ where: "task 3", what: "`npm test` does not exercise the new endpoint" }],
    }),
    verdict({ lens: "design" }),
  ]);

  const text = explainVerdict(blocked);
  assert.match(text, /Feasibility/);
  assert.match(text, /cannot be verified by the command it declares/);
  assert.match(text, /does not exercise the new endpoint/);
  // The lenses that passed are absent: this is the actionable half, and a reader acting on
  // it does not need the two opinions that asked for nothing.
  assert.doesNotMatch(text, /design/);
});

test("the explanation bounds its findings and says how many it dropped", () => {
  // Bounded before Discord's limit gets involved, so what survives is whole findings
  // rather than a sentence cut mid-word — and a dropped tail is stated, never implied.
  const many = decide([
    verdict({
      lens: "decomposition",
      title: "Decomposition",
      decision: "changes",
      blocking: true,
      summary: "Five tasks are one task.",
      findings: [1, 2, 3, 4, 5].map((n) => ({ where: `task ${n}`, what: `overlaps task ${n + 1}` })),
    }),
  ]);

  const text = explainVerdict(many);
  assert.match(text, /task 1/);
  assert.match(text, /task 3/);
  assert.match(text, /…and 2 more, in the full verdict\./);
  assert.doesNotMatch(text, /overlaps task 5/);
});
