/**
 * Tests for the post-merge re-verification decision (DESIGN.md §20).
 *
 * Every assertion here is about one property: a CLEAR is only ever returned on positive
 * evidence that the alert stopped. The whole reason §20 had no closing edge is that a
 * merged patch that changed nothing and a merged patch that fixed the incident looked
 * identical, and the cheap way to reintroduce that is to read "Alertmanager has gone
 * quiet" as "the alert cleared". Alertmanager going quiet is also what a dead
 * Alertmanager, a changed route and a restarted supervisor look like.
 *
 * So the tests are organised around the four things that can be true — cleared, still
 * firing, too early to say, and cannot be checked — and each one asserts that the other
 * three are not returned in its place.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeVerdict,
  MAX_SETTLE_SECONDS,
  reverifyAlert,
  settleWindowSeconds,
  DEFAULT_SETTLE_SECONDS,
  type AlertEvidence,
} from "./verify.ts";

const MERGED_AT = "2026-08-23T12:00:00.000Z";

/** `MERGED_AT` plus some minutes, as an ISO string. */
const after = (minutes: number): string =>
  new Date(Date.parse(MERGED_AT) + minutes * 60_000).toISOString();

const observed = (evidence: Omit<AlertEvidence & { kind: "observed" }, "kind">): AlertEvidence => ({
  kind: "observed",
  ...evidence,
});

test("a resolved delivery after the merge is a cleared alert, with how long it took", () => {
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ resolvedAt: after(4) }),
    settleSeconds: 600,
    now: Date.parse(after(5)),
  });

  assert.equal(verdict.kind, "cleared");
  assert.equal(verdict.kind === "cleared" ? verdict.elapsedMs : undefined, 4 * 60_000);
  assert.match(describeVerdict(verdict), /fix merged, alert cleared after 4m/);
});

test("a clear is reported as soon as it is seen, without waiting out the window", () => {
  // The settle window is a DEADLINE for a verdict, not a delay before one: an alert that
  // resolved a minute after the merge is answered a minute after the merge. Holding the
  // task for the remaining nine would keep a finished task open for no evidence.
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ resolvedAt: after(1) }),
    settleSeconds: 600,
    now: Date.parse(after(1)),
  });

  assert.equal(verdict.kind, "cleared");
});

test("a resolved delivery from BEFORE the merge does not clear the alert", () => {
  // The alert resolved, fired again, and the task was worked on that second firing. The
  // stale `resolvedAt` describes the first one and says nothing about the fix.
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ resolvedAt: after(-30), lastFiringAt: after(-10) }),
    settleSeconds: 600,
    now: Date.parse(after(20)),
  });

  assert.notEqual(verdict.kind, "cleared");
});

test("a firing delivery after the merge, once the window has elapsed, is still firing", () => {
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ lastFiringAt: after(9) }),
    settleSeconds: 600,
    now: Date.parse(after(11)),
  });

  assert.equal(verdict.kind, "still-firing");
  assert.equal(verdict.kind === "still-firing" ? verdict.lastFiringAt : undefined, after(9));
  assert.match(describeVerdict(verdict), /fix merged, alert still firing/);
});

test("a firing delivery inside the window is not yet a verdict", () => {
  // An alert that clears slowly fires once or twice more after the fix lands. Calling
  // that a failed remediation would park every task whose alert takes a scrape or two to
  // catch up — which is most of them.
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ lastFiringAt: after(2) }),
    settleSeconds: 600,
    now: Date.parse(after(3)),
  });

  assert.equal(verdict.kind, "waiting");
  assert.equal(verdict.kind === "waiting" ? verdict.remainingMs : undefined, 7 * 60_000);
});

test("silence inside the window is waiting, and silence after it cannot be checked", () => {
  const evidence = observed({ lastFiringAt: after(-5) });

  const early = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence,
    settleSeconds: 600,
    now: Date.parse(after(3)),
  });
  assert.equal(early.kind, "waiting");

  // THE LOAD-BEARING CASE. Nothing has been delivered since the merge: the alert may
  // have stopped, or Alertmanager may be down, or its route to this receiver may have
  // been changed. Absence of evidence is not evidence, so this is neither a clear nor a
  // failure — it is a task that could not be re-verified.
  const late = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence,
    settleSeconds: 600,
    now: Date.parse(after(20)),
  });
  assert.equal(late.kind, "unverifiable");
  assert.match(
    late.kind === "unverifiable" ? late.reason : "",
    /nothing has been delivered for this alert since the fix merged/i,
  );
  assert.match(describeVerdict(late), /could not be re-verified/);
});

test("evidence the supervisor could not read is unverifiable, never a clear", () => {
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: { kind: "unavailable", reason: "Loki is unreachable" },
    settleSeconds: 600,
    now: Date.parse(after(20)),
  });

  assert.equal(verdict.kind, "unverifiable");
  assert.match(verdict.kind === "unverifiable" ? verdict.reason : "", /Loki is unreachable/);
});

test("a merge timestamp that will not parse is unverifiable, never a clear", () => {
  // `mergedAt` comes out of a control record a human can also edit. A NaN comparison is
  // false in both directions, so an unguarded implementation would answer "cleared" or
  // "still firing" from a clock it never established.
  const verdict = reverifyAlert({
    mergedAt: "yesterday afternoon",
    evidence: observed({ resolvedAt: after(4) }),
    settleSeconds: 600,
    now: Date.parse(after(20)),
  });

  assert.equal(verdict.kind, "unverifiable");
  assert.match(verdict.kind === "unverifiable" ? verdict.reason : "", /merge timestamp/i);
});

test("a delivery timestamp that will not parse is ignored rather than trusted", () => {
  const verdict = reverifyAlert({
    mergedAt: MERGED_AT,
    evidence: observed({ resolvedAt: "not a date" }),
    settleSeconds: 600,
    now: Date.parse(after(20)),
  });

  assert.equal(verdict.kind, "unverifiable");
});

test("the settle window is bounded: an absent, absurd or negative one is clamped", () => {
  assert.equal(settleWindowSeconds(undefined), DEFAULT_SETTLE_SECONDS);
  assert.equal(settleWindowSeconds(300), 300);
  // A wait-forever window is what the bound exists to refuse: an alert that never clears
  // and one that clears slowly must be distinguishable within a KNOWN time.
  assert.equal(settleWindowSeconds(MAX_SETTLE_SECONDS * 10), MAX_SETTLE_SECONDS);
  assert.equal(settleWindowSeconds(0), DEFAULT_SETTLE_SECONDS);
  assert.equal(settleWindowSeconds(-60), DEFAULT_SETTLE_SECONDS);
});

test("a verdict describes itself in one line, and the four read differently", () => {
  // §19 asks for a digest line, and a silent success must not look like a silent failure.
  // Four distinct sentences is the whole requirement.
  const lines = [
    describeVerdict({ kind: "cleared", elapsedMs: 240_000 }),
    describeVerdict({ kind: "still-firing", lastFiringAt: after(9) }),
    describeVerdict({ kind: "waiting", remainingMs: 120_000 }),
    describeVerdict({ kind: "unverifiable", reason: "Loki is unreachable" }),
  ];

  assert.equal(new Set(lines).size, 4);
  for (const line of lines) {
    assert.ok(line.length > 0);
    assert.ok(!line.includes("\n"), `a digest line is one line: ${JSON.stringify(line)}`);
  }
});
