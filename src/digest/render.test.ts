/**
 * The document a human actually reads.
 *
 * One rendering serves all three destinations — Discord, the state repo and the web view —
 * because a digest that says different things in different places is a digest nobody can
 * quote. These tests pin the parts that carry meaning rather than the layout: that a
 * transition is shown as a transition, that an absent diff is DECLARED rather than
 * rendered as zero, and that a missing narrative says why instead of leaving a silence
 * that reads as a broken feature.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { attribute, type AuthoredCommit } from "./attribution.ts";
import type { DayDigest, TaskChange } from "./collect.ts";
import { renderDigest, summaryLine } from "./render.ts";

const change = (overrides: Partial<TaskChange> & Pick<TaskChange, "id">): TaskChange => ({
  title: "A task",
  to: "done",
  phase: "implementing",
  sessions: 1,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  prOpened: false,
  questionsAsked: 0,
  answersGiven: 0,
  verdicts: 0,
  noProgressStreak: 0,
  changes: [],
  ...overrides,
});

const digest = (overrides: Partial<DayDigest> = {}): DayDigest => ({
  date: "2026-08-16",
  from: "2026-08-15T16:00:00.000Z",
  to: "2026-08-16T16:00:00.000Z",
  changed: [],
  open: [],
  totals: {
    sessions: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    tasksTouched: 0,
    reached: {},
  },
  quiet: true,
  unreadable: [],
  ...overrides,
});

const render = (value: DayDigest, extra: { narrative?: string; narrativeError?: string } = {}): string =>
  renderDigest({ digest: value, timeZone: "Europe/Berlin", runner: "pod-7f3a", ...extra });

test("a finished task shows the transition, the pull request and the code", () => {
  const finished = change({
    id: asTaskId("TASK-118"),
    title: "resume clears the no-progress streak",
    from: "running",
    to: "done",
    sessions: 4,
    costUsd: 2.11,
    prUrl: "https://example.invalid/pr/44",
    prOpened: true,
    changes: [
      {
        repo: "caesar/caterpillar",
        commits: ["fix(notify): /resume reported success and did nothing"],
        filesChanged: 12,
        insertions: 430,
        deletions: 89,
        files: ["src/notify/commands.ts"],
      },
    ],
  });

  const text = render(digest({ changed: [finished], quiet: false }));

  assert.match(text, /TASK-118/);
  assert.match(text, /resume clears the no-progress streak/);
  assert.match(text, /running → \*\*done\*\*/, "a status alone does not say what moved");
  assert.match(text, /4 sessions/);
  assert.match(text, /\$2\.11/);
  assert.match(text, /https:\/\/example\.invalid\/pr\/44/);
  assert.match(text, /caesar\/caterpillar/);
  assert.match(text, /12 files/);
  assert.match(text, /\+430/);
  assert.match(text, /-89/);
  assert.match(text, /fix\(notify\): \/resume reported success and did nothing/);
});

test("a task created inside the window is shown as new, not as a transition from nothing", () => {
  const text = render(
    digest({
      changed: [change({ id: asTaskId("TASK-124"), to: "awaiting-human", questionsAsked: 1 })],
      quiet: false,
    }),
  );

  assert.match(text, /new → \*\*awaiting-human\*\*/);
  assert.match(text, /1 question/);
});

test("a diff this runner cannot see is declared, never rendered as zero", () => {
  // The failure mode: another runner worked the task, so this one has no mirror. Printing
  // `0 files changed` would state, falsely, that a merged pull request changed nothing.
  const text = render(
    digest({
      changed: [
        change({ id: asTaskId("TASK-9"), changes: [], changesUnavailable: ["acme/widget"] }),
      ],
      quiet: false,
    }),
  );

  assert.match(text, /acme\/widget/);
  assert.match(text, /not on this runner|no mirror/i);
  assert.doesNotMatch(text, /0 files/);
});

test("tasks still waiting are listed even though they did not move", () => {
  const text = render(
    digest({
      open: [
        {
          id: asTaskId("TASK-4"),
          title: "Blocked on you",
          status: "awaiting-human",
          phase: "implementing",
          since: "2026-08-14T09:00:00.000Z",
        },
      ],
    }),
  );

  assert.match(text, /TASK-4/);
  assert.match(text, /awaiting-human/);
});

test("a quiet day says so rather than rendering an empty document", () => {
  const text = render(digest());

  assert.match(text, /nothing moved/i);
  assert.match(text, /2026-08-16/);
});

test("the window is stated in local time, because that is what the day means", () => {
  const text = render(digest());

  // 16:00Z is 18:00 in Berlin. A digest that printed UTC would describe a day the reader
  // did not have.
  assert.match(text, /18:00/);
  assert.match(text, /Europe\/Berlin/);
});

test("a narrative that could not be written says why", () => {
  // Silence here is indistinguishable from a feature that quietly stopped working, and
  // the facts below it are worth reading either way.
  const text = render(digest(), { narrativeError: "the model provider stopped answering" });

  assert.match(text, /the model provider stopped answering/);

  const written = render(digest(), { narrative: "Most of today went on the mirror path." });
  assert.match(written, /Most of today went on the mirror path\./);
});

test("the summary line counts outcomes, not tasks", () => {
  const line = summaryLine(
    digest({
      quiet: false,
      totals: {
        sessions: 14,
        costUsd: 7.4,
        inputTokens: 1_200_000,
        outputTokens: 84_000,
        tasksTouched: 3,
        reached: { done: 2, "awaiting-human": 1 },
      },
    }),
  );

  assert.match(line, /2 done/);
  assert.match(line, /1 awaiting-human/);
  assert.match(line, /14 sessions/);
  assert.match(line, /\$7\.40/);
});

test("a task the collector could not read is named, not silently dropped", () => {
  const text = render(digest({ unreadable: [asTaskId("TASK-BROKEN")] }));

  assert.match(text, /TASK-BROKEN/);
  assert.match(text, /would not parse/);
});

test("a timestamp that will not parse is printed rather than thrown over", () => {
  // `Intl` answers an invalid Date with a RangeError. One of those in here fails the
  // digest every day, identically, because the collector is deterministic.
  const text = render(
    digest({
      open: [
        {
          id: asTaskId("TASK-7"),
          title: "hand-edited",
          status: "parked",
          phase: "planning",
          since: "yesterday afternoon",
        },
      ],
    }),
  );

  assert.match(text, /yesterday afternoon/);
});

/* -------------------------------------------------------------------- attribution */

const FLEET_EMAIL = "316492202+caterpillar-agent[bot]@users.noreply.github.com";

const authored = (repo: string, email: string, lines: number): AuthoredCommit => ({
  repo,
  sha: `${repo}-${email}-${lines}`,
  authorEmail: email,
  insertions: lines,
  deletions: 0,
});

const withAttribution = (
  commits: readonly AuthoredCommit[],
  extra: { previous?: readonly AuthoredCommit[]; unavailable?: readonly string[] } = {},
): string =>
  render(
    digest({
      quiet: false,
      attribution: attribute({ identity: { emails: [FLEET_EMAIL] }, commits, ...extra }),
    }),
  );

test("authorship is rendered as a share of lines and of commits, per repo", () => {
  const text = withAttribution([
    authored("acme/widget", FLEET_EMAIL, 90),
    authored("acme/widget", "dev@example.invalid", 10),
  ]);

  assert.match(text, /## Authorship/);
  assert.match(text, /acme\/widget/);
  assert.match(text, /90%/, "the fleet's share of lines");
  assert.match(text, /90 line|90 of|100 lines/, "the absolute numbers, not only the ratio");
});

test("the share is shown against the previous window, because one day says nothing", () => {
  const text = withAttribution(
    [authored("acme/widget", FLEET_EMAIL, 75), authored("acme/widget", "dev@example.invalid", 25)],
    {
      previous: [
        authored("acme/widget", FLEET_EMAIL, 25),
        authored("acme/widget", "dev@example.invalid", 75),
      ],
    },
  );

  assert.match(text, /75%/);
  assert.match(text, /25%/, "the window it is compared against is stated, not only the arrow");
  assert.match(text, /\bup\b/i);
});

test("a first window with nothing to compare against says so rather than showing no change", () => {
  // "flat" would be a claim about a yesterday that was never measured.
  const text = withAttribution([authored("acme/widget", FLEET_EMAIL, 40)]);

  assert.doesNotMatch(text, /\bflat\b/i);
  assert.match(text, /no earlier window|nothing to compare/i);
});

test("a repo whose history this runner cannot read is named in the section", () => {
  // The §19 rule, again: this is the section where a silent zero would be most credible,
  // because a percentage always looks like a measurement.
  const text = withAttribution([authored("acme/widget", FLEET_EMAIL, 40)], {
    unavailable: ["acme/gadget"],
  });

  assert.match(text, /acme\/gadget/);
  assert.match(text, /no mirror|cannot be read/i);
  assert.doesNotMatch(text, /acme\/gadget[^\n]*0%/, "an unreadable repo has no share");
});

test("a window with no commits in it says nothing was committed, not that the fleet wrote none", () => {
  const text = withAttribution([]);

  assert.match(text, /## Authorship/);
  assert.match(text, /no commit/i);
  assert.doesNotMatch(text, /0%/);
});

test("a digest with no attribution at all has no authorship section", () => {
  // A runner with no mirrors and no identity configured must not print a heading whose
  // body would be an apology.
  const text = render(digest({ quiet: false }));

  assert.doesNotMatch(text, /## Authorship/);
});
