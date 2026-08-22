/**
 * The clock a schedule fires on, which is a LOCAL one.
 *
 * "Every weekday at 09:00" is a statement about the operator's wall clock, and in Berlin
 * that is 07:00Z for five months of the year and 08:00Z for the other seven. Every
 * boundary here is therefore computed in a named zone, and these tests pin the three
 * things a naive implementation gets wrong: the occurrence seen from UTC, the same
 * occurrence either side of a DST change, and how far back a runner that has been away is
 * allowed to reach.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dueOccurrences, nextOccurrence, occurrenceId, parseCron } from "./occurrence.ts";

const BERLIN = "Europe/Berlin";

/** Weekdays at 09:00 — the example from the issue, and the one worth being right about. */
const WEEKDAYS_AT_NINE = { cron: "0 9 * * 1-5", timeZone: BERLIN } as const;

test("an occurrence is a local wall-clock time, not a fixed offset", () => {
  // 09:00 Berlin is 07:00Z in August (CEST) and 08:00Z in January (CET). A schedule
  // stored as an offset would be an hour wrong for seven months and never say so.
  const summer = nextOccurrence(new Date("2026-08-17T00:00:00Z"), WEEKDAYS_AT_NINE);
  assert.equal(summer?.toISOString(), "2026-08-17T07:00:00.000Z");

  const winter = nextOccurrence(new Date("2026-01-19T00:00:00Z"), WEEKDAYS_AT_NINE);
  assert.equal(winter?.toISOString(), "2026-01-19T08:00:00.000Z");
});

test("the next occurrence is strictly after now, so one instant fires once", () => {
  // Called with the occurrence itself, the answer must be the FOLLOWING one. A
  // non-strict comparison here would return the same instant forever, and a runner
  // polling every thirty seconds would fire the same occurrence until the minute passed.
  const at = new Date("2026-08-17T07:00:00Z");
  assert.equal(nextOccurrence(at, WEEKDAYS_AT_NINE)?.toISOString(), "2026-08-18T07:00:00.000Z");
});

test("a day the schedule excludes is skipped, not approximated", () => {
  // Saturday 09:00 and Sunday 09:00 are not occurrences of a weekday schedule: the next
  // one after Friday's is Monday's.
  const afterFriday = new Date("2026-08-21T07:00:01Z");
  assert.equal(
    nextOccurrence(afterFriday, WEEKDAYS_AT_NINE)?.toISOString(),
    "2026-08-24T07:00:00.000Z",
  );
});

test("an occurrence the clocks skip over still happens, exactly once", () => {
  // Berlin springs forward at 02:00 on 2026-03-29 (a Sunday), so 02:30 does not exist
  // that day. A schedule at 02:30 must still fire — the shifted instant, an hour past
  // the gap, which is what `instantOfWallClock` resolves a deleted wall clock to —
  // rather than be silently dropped for the year.
  const nightly = { cron: "30 2 * * *", timeZone: BERLIN } as const;
  const fired = nextOccurrence(new Date("2026-03-29T00:00:00Z"), nightly);

  assert.equal(fired?.toISOString(), "2026-03-29T01:30:00.000Z", "03:30 local, past the gap");

  // And once: searching on from it lands on the next day, not on a second reading of the
  // same missing minute.
  assert.equal(
    nextOccurrence(fired as Date, nightly)?.toISOString(),
    "2026-03-30T00:30:00.000Z",
  );
});

test("an occurrence the clocks repeat fires once, not twice", () => {
  // Berlin falls back at 03:00 on 2026-10-25, so 02:30 happens twice that morning — once
  // at 00:30Z in CEST and again at 01:30Z in CET. A daily schedule at 02:30 must produce
  // one occurrence that day, or the audit runs twice and the second run finds nothing to
  // do and spends a session saying so.
  const nightly = { cron: "30 2 * * *", timeZone: BERLIN } as const;

  const first = nextOccurrence(new Date("2026-10-24T12:00:00Z"), nightly) as Date;
  assert.equal(first.toISOString(), "2026-10-25T01:30:00.000Z");
  assert.equal(
    nextOccurrence(first, nightly)?.toISOString(),
    "2026-10-26T01:30:00.000Z",
    "the next one is the following day, not the other 02:30",
  );
});

test("catch-up reaches back exactly one occurrence", () => {
  // A pod that has been off for a week must not fire seven audits at once. The bound is
  // the design (§22), not an accident of the loop: Keel rolls this pod on every push to
  // main, so missing ONE occurrence is routine and missing five means nobody was home.
  const friday = new Date("2026-08-21T09:00:00Z"); // 11:00 Berlin, two hours late.
  const due = dueOccurrences(friday, WEEKDAYS_AT_NINE);

  assert.deepEqual(
    due.map((at) => at.toISOString()),
    ["2026-08-21T07:00:00.000Z"],
  );

  const weekLate = new Date("2026-08-28T09:00:00Z");
  assert.deepEqual(
    dueOccurrences(weekLate, WEEKDAYS_AT_NINE).map((at) => at.toISOString()),
    ["2026-08-28T07:00:00.000Z"],
    "a week away owes the latest occurrence and nothing older",
  );
});

test("an occurrence nobody was there for goes stale rather than firing late", () => {
  // Count alone is not a bound. "The previous occurrence" of a weekly schedule can be six
  // days old, and firing a Monday audit on Saturday evening produces a task nobody asked
  // for against a repo that has moved on. `MAX_LATENESS_MS` is the second bound.
  const weekly = { cron: "0 9 * * 1", timeZone: BERLIN } as const;

  const soonAfter = new Date("2026-08-24T09:00:00Z"); // 11:00 Berlin, two hours late.
  assert.equal(dueOccurrences(soonAfter, weekly).length, 1);

  const nextDay = new Date("2026-08-25T09:00:00Z"); // A day late.
  assert.deepEqual(dueOccurrences(nextDay, weekly), []);
});

test("nothing is due before the first occurrence has passed", () => {
  // 08:00 Berlin on a Monday: today's 09:00 has not happened yet, and Friday's is older
  // than the catch-up bound.
  const due = dueOccurrences(new Date("2026-08-24T06:00:00Z"), WEEKDAYS_AT_NINE);
  assert.deepEqual(due, []);
});

test("an occurrence id is the instant in UTC, so two runners agree on the name", () => {
  // It becomes a git ref (`refs/schedules/<id>/<occurrence>`), so it must be derivable
  // from the instant alone by every runner in the fleet, and it must contain nothing a
  // ref cannot: no colon, no plus sign.
  assert.equal(occurrenceId(new Date("2026-08-17T07:00:00Z")), "2026-08-17T0700Z");
  assert.equal(occurrenceId(new Date("2026-01-19T08:00:00Z")), "2026-01-19T0800Z");
});

test("a cron expression that cannot fire is refused, not left to never match", () => {
  // 31 February matches nothing, ever. A schedule that silently never fires looks exactly
  // like a runner that is not scheduling — so it is refused when the file is committed
  // (§22), which is the only moment a human is watching.
  assert.equal(parseCron("0 9 31 2 *"), undefined);
});

test("a malformed cron expression is refused rather than guessed at", () => {
  for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "a 9 * * *"]) {
    assert.equal(parseCron(bad), undefined, `'${bad}' must not parse`);
  }
});

test("the five fields, the ranges and the steps a schedule may use", () => {
  // Ranges, lists, steps and `*` — the subset every cron writer expects. Nothing more:
  // `@daily`, `L`, `#` and seconds are deliberately absent (§22).
  assert.notEqual(parseCron("*/15 * * * *"), undefined);
  assert.notEqual(parseCron("0 0,12 * * *"), undefined);
  assert.notEqual(parseCron("0 9 1-7 */2 SUN"), undefined);
  assert.notEqual(parseCron("0 9 * * 0"), undefined, "Sunday as 0");
  assert.notEqual(parseCron("0 9 * * 7"), undefined, "and Sunday as 7");
});

test("both spellings of Sunday select the same day", () => {
  const asZero = { cron: "0 9 * * 0", timeZone: BERLIN } as const;
  const asSeven = { cron: "0 9 * * 7", timeZone: BERLIN } as const;
  const from = new Date("2026-08-17T00:00:00Z"); // A Monday.

  assert.equal(
    nextOccurrence(from, asZero)?.toISOString(),
    nextOccurrence(from, asSeven)?.toISOString(),
  );
});

test("day-of-month and day-of-week are a union when both are restricted", () => {
  // Cron's one genuine oddity, and it is load-bearing: `0 9 1 * 1` means "the first of
  // the month AND every Monday", not their intersection. Implementing it as an AND makes
  // a schedule fire roughly a tenth as often as its author expects.
  const both = { cron: "0 9 1 * 1", timeZone: BERLIN } as const;

  // 2026-09-01 is a Tuesday: it fires because the day of month matches.
  assert.equal(
    nextOccurrence(new Date("2026-08-31T23:00:00Z"), both)?.toISOString(),
    "2026-09-01T07:00:00.000Z",
  );
  // 2026-09-07 is the next Monday: it fires because the day of week matches.
  assert.equal(
    nextOccurrence(new Date("2026-09-01T07:00:01Z"), both)?.toISOString(),
    "2026-09-07T07:00:00.000Z",
  );
});
