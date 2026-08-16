/**
 * The digest's calendar, which is a LOCAL one.
 *
 * "What happened today" is a question about the operator's day, not about UTC's, and the
 * two disagree for two hours of every European evening — exactly the hours a digest that
 * fires at 18:00 is summarising. Every boundary here is therefore computed in a named
 * zone, and these tests pin the three things a naive implementation gets wrong: the day
 * boundary seen from UTC, the same boundary either side of a DST change, and the tail of
 * the evening that a midnight-to-publication window would never report at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dueWindows, isTimeZone, localDate, windowFor } from "./day.ts";

const BERLIN = "Europe/Berlin";
const AT_SIX = { hour: 18, timeZone: BERLIN } as const;

test("the local date is the operator's, not UTC's", () => {
  // 22:30Z in August is 00:30 the NEXT day in Berlin (CEST, +02:00). A digest keyed on
  // the UTC date would file this under a day that had already ended locally.
  assert.equal(localDate(new Date("2026-08-16T22:30:00Z"), BERLIN), "2026-08-17");
  assert.equal(localDate(new Date("2026-08-16T21:30:00Z"), BERLIN), "2026-08-16");
});

test("a window ends when it is published and covers the 24 hours before it", () => {
  const window = windowFor("2026-08-16", AT_SIX);

  assert.equal(window.end.toISOString(), "2026-08-16T16:00:00.000Z", "18:00 Berlin, CEST");
  assert.equal(window.start.toISOString(), "2026-08-15T16:00:00.000Z");
  assert.equal(window.dueAt.getTime(), window.end.getTime(), "it covers everything up to now");
});

test("consecutive windows meet exactly, so no hour is reported twice or lost", () => {
  // The obvious alternative — local midnight to the publication hour — silently drops
  // 18:00 to midnight from every digest, which is a working evening a day.
  const first = windowFor("2026-08-15", AT_SIX);
  const second = windowFor("2026-08-16", AT_SIX);

  assert.equal(first.end.getTime(), second.start.getTime());
});

test("a window across a DST change is still a whole local day", () => {
  // Berlin springs forward at 02:00 on 2026-03-29, so 18:00 to 18:00 across it is 23
  // hours of wall clock. Both ends must still be 18:00 where the operator is.
  const window = windowFor("2026-03-29", AT_SIX);

  assert.equal(window.start.toISOString(), "2026-03-28T17:00:00.000Z", "CET, +01:00");
  assert.equal(window.end.toISOString(), "2026-03-29T16:00:00.000Z", "CEST, +02:00");
  assert.equal(window.end.getTime() - window.start.getTime(), 23 * 60 * 60 * 1000);
});

test("the hour is a local wall clock, not a fixed offset", () => {
  const winter = windowFor("2026-01-15", AT_SIX);
  assert.equal(winter.end.toISOString(), "2026-01-15T17:00:00.000Z", "CET, +01:00");
});

test("nothing is due before the configured hour", () => {
  // 17:00 in Berlin. Today's digest is not due; yesterday's was.
  const due = dueWindows(new Date("2026-08-16T15:00:00Z"), AT_SIX);

  assert.deepEqual(
    due.map((w) => w.date),
    ["2026-08-15"],
  );
});

test("once the hour passes, today is due — and yesterday goes first", () => {
  // A runner that was down at 18:00 yesterday still owes that digest, and it must be
  // published in the order the days happened or the channel reads backwards.
  const due = dueWindows(new Date("2026-08-16T16:30:00Z"), AT_SIX);

  assert.deepEqual(
    due.map((w) => w.date),
    ["2026-08-15", "2026-08-16"],
  );
});

test("catch-up reaches back exactly one day", () => {
  // A runner that has been off for a week must not wake up and post seven digests into
  // the channel. The bound is the design, not an accident of the loop.
  const due = dueWindows(new Date("2026-08-16T16:30:00Z"), AT_SIX);

  assert.equal(due.length, 2);
});

test("a timezone that does not exist is refused rather than silently UTC", () => {
  // `Intl` throws on an unknown zone, and a config that quietly fell back to UTC would
  // fire the digest at the wrong hour forever without ever saying so.
  assert.equal(isTimeZone(BERLIN), true);
  assert.equal(isTimeZone("UTC"), true);
  assert.equal(isTimeZone("Mars/Olympus"), false);
  assert.equal(isTimeZone(""), false);
});

test("a fixed offset is refused, because it is wrong for half the year", () => {
  // `Intl` accepts these. Taking one would publish at 17:00 all winter and cover a window
  // shifted by an hour, silently — which is the exact failure a named zone exists to
  // prevent.
  assert.equal(isTimeZone("+02:00"), false);
  assert.equal(isTimeZone("-0500"), false);
});
