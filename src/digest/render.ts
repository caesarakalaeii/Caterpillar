/**
 * The digest as a human reads it. See DESIGN.md §19.
 *
 * ONE rendering for all three destinations. Discord, the state repo and the web view get
 * the same markdown, because a digest that says different things in different places is
 * one nobody can quote — and because the state repo's copy is the durable record of what
 * was announced, which it only is if it is what was announced.
 *
 * Markdown that Discord understands: headings, bold, bullets, links and inline code all
 * render there. Nothing here uses a table or an image, which do not.
 *
 * Two rules the layout follows, both learned from the notification frame (§11.2):
 *   - a number that could not be measured is DECLARED, never printed as zero. A task whose
 *     diff this runner cannot see says so; `0 files changed` on a merged pull request is a
 *     false statement, not a smaller one.
 *   - a transition is rendered as a transition. `done` alone does not say whether a task
 *     finished today or was already finished yesterday.
 */
import type { TaskStatus } from "../domain/task.ts";
import type {
  AttributionReport,
  AttributionTrend,
  AuthorSplit,
  RepoAttribution,
} from "./attribution.ts";
import type { DayDigest, OpenTask, RepoChange, TaskChange } from "./collect.ts";

export interface RenderOptions {
  readonly digest: DayDigest;
  /** The zone the window was computed in — the same one the reader lives in. */
  readonly timeZone: string;
  /** Which runner published this. A fleet has several, and exactly one wrote this file. */
  readonly runner: string;
  /** Prose over the day's work, when a model wrote one. */
  readonly narrative?: string;
  /** Why there is no prose, when there is none. Never left silent. */
  readonly narrativeError?: string;
}

export const renderDigest = (options: RenderOptions): string => {
  const { digest, timeZone } = options;

  return [
    `# Daily digest — ${digest.date}`,
    "",
    `${at(digest.from, timeZone)} → ${at(digest.to, timeZone)} · ${timeZone}`,
    "",
    `**${summaryLine(digest)}**`,
    "",
    ...narrative(options),
    ...moved(digest),
    ...authorship(digest.attribution),
    ...open(digest.open, timeZone),
    ...unreadable(digest),
    "---",
    "",
    `${spend(digest)} · published by \`${options.runner}\``,
    "",
  ].join("\n");
};

/** The one line that has to survive being read at a glance. */
export const summaryLine = (digest: DayDigest): string => {
  if (digest.quiet) return "Nothing moved.";

  const outcomes = ORDER.flatMap((status) => {
    const count = digest.totals.reached[status];
    return count === undefined || count === 0 ? [] : [`${count} ${status}`];
  });

  return [
    ...outcomes,
    `${plural(digest.totals.tasksTouched, "task")} touched`,
    plural(digest.totals.sessions, "session"),
    money(digest.totals.costUsd),
  ].join(" · ");
};

/** Reading order: what needs a human, then what finished, then the rest. */
const ORDER: readonly TaskStatus[] = [
  "awaiting-human",
  "done",
  "failed",
  "parked",
  "running",
  "ready",
];

const narrative = (options: RenderOptions): readonly string[] => {
  if (options.narrative !== undefined && options.narrative.trim() !== "") {
    return ["## What changed", "", options.narrative.trim(), ""];
  }
  if (options.narrativeError !== undefined) {
    // Said out loud. A digest that silently lost its prose looks exactly like one whose
    // summariser was never configured, and the difference matters to whoever is on call.
    return ["## What changed", "", `_No summary was written: ${options.narrativeError}._`, ""];
  }
  return [];
};

const moved = (digest: DayDigest): readonly string[] => {
  if (digest.quiet) {
    return [
      "## Moved today",
      "",
      "Nothing moved. No task was created, worked, parked or finished in this window.",
      "",
    ];
  }

  // No trailing blank of its own: every task block already ends with one, and a second
  // renders as a gap in Discord rather than as nothing.
  return ["## Moved today", "", ...digest.changed.flatMap(task)];
};

const task = (change: TaskChange): readonly string[] => {
  const facts = [
    `${change.from ?? "new"} → **${change.to}**`,
    plural(change.sessions, "session"),
    ...(change.costUsd > 0 ? [money(change.costUsd)] : []),
    ...(change.questionsAsked > 0 ? [plural(change.questionsAsked, "question")] : []),
    ...(change.answersGiven > 0 ? [`${plural(change.answersGiven, "answer")} given`] : []),
    ...(change.verdicts > 0 ? [`${plural(change.verdicts, "council verdict")}`] : []),
    ...(change.noProgressStreak > 0
      ? [`${plural(change.noProgressStreak, "session")} without progress`]
      : []),
    ...(change.prUrl === undefined
      ? []
      : [`[pull request](${change.prUrl})${change.prOpened ? " (opened today)" : ""}`]),
  ];

  return [
    `### \`${change.id}\` — ${change.title}`,
    "",
    facts.join(" · "),
    "",
    ...reverified(change),
    ...change.changes.flatMap(repo),
    ...unavailable(change),
  ];
};

/**
 * Whether the merged fix actually cleared the alert (DESIGN.md §20).
 *
 * Its own line rather than another entry in the fact list, because it is the one fact on a
 * remediation task that decides how to read all the others: `done` with an alert still
 * firing and `done` with it cleared are different days' work, and a reader scanning the
 * facts should not have to find this among the session counts.
 *
 * Nothing at all when there was no re-verification, which is every task from every other
 * intake path.
 */
const reverified = (change: TaskChange): readonly string[] =>
  change.reverified === undefined ? [] : [`Re-verified: **${change.reverified}**`, ""];

const repo = (change: RepoChange): readonly string[] => [
  `\`${change.repo}\` · ${plural(change.commits.length, "commit")} · ` +
    `${plural(change.filesChanged, "file")}, +${change.insertions}/-${change.deletions}`,
  "",
  ...change.commits.map((subject) => `- ${subject}`),
  "",
];

const unavailable = (change: TaskChange): readonly string[] => {
  const missing = change.changesUnavailable;
  if (missing === undefined || missing.length === 0) return [];

  return [
    `_No diff for ${missing.map((slug) => `\`${slug}\``).join(", ")} — no mirror of it on ` +
      `this runner, so the code it changed cannot be read from here._`,
    "",
  ];
};

/**
 * Who wrote the code, and which way that is going.
 *
 * After "Moved today" and before "Still open", because it is a claim about the whole window
 * rather than about any one task, and because the tasks above it are the evidence for it.
 *
 * Nothing here prints a share that was not measured. A percentage always looks like a
 * measurement — that is the whole risk of this section — so a window with no commits says
 * no commit was made, and a repo with no readable history is named rather than shown at 0%.
 */
const authorship = (report: AttributionReport | undefined): readonly string[] => {
  if (report === undefined) return [];

  if (!report.measured) {
    return [
      "## Authorship",
      "",
      "No commit was made in any repo this window's tasks name, so there is no authorship " +
        "to split.",
      "",
      ...unreadableRepos(report),
    ];
  }

  return [
    "## Authorship",
    "",
    ...shareLine(report),
    "",
    ...report.repos.map(repoShare),
    "",
    ...unreadableRepos(report),
  ];
};

/**
 * The fleet's share of the window, and the same share yesterday.
 *
 * Both numbers, not just the arrow. A direction with no baseline is one the reader cannot
 * check, and this is a figure an owner will quote at somebody.
 */
const shareLine = (report: AttributionReport): readonly string[] => {
  const { fleetLineShare, fleetCommitShare } = report.total;
  const before = report.previousFleetLineShare;

  // Both shares or neither. A window with a line share has lines, so it has commits, so it
  // has a commit share too — checking both is what says that in code rather than in prose.
  const now =
    fleetLineShare === undefined || fleetCommitShare === undefined
      ? `**${plural(commits(report.total), "commit")}** and no line changed — nothing to ` +
        "split at line level"
      : `The fleet wrote **${percent(fleetLineShare)}** of ` +
        `${plural(lines(report.total), "line")} and ${percent(fleetCommitShare)} of ` +
        `${plural(commits(report.total), "commit")}`;

  const trend =
    before === undefined || report.trend === undefined
      ? "No earlier window was measured, so there is nothing to compare it against."
      : `${TREND[report.trend]} from ${percent(before)} of lines in the previous window.`;

  return [`${now}. ${trend}`];
};

/** How a direction reads. A word, because Discord renders no icon a reader can rely on. */
const TREND: Readonly<Record<AttributionTrend, string>> = {
  up: "Up",
  down: "Down",
  flat: "Unchanged",
};

const repoShare = (entry: RepoAttribution): string => {
  const share = entry.fleetLineShare;
  const of =
    share === undefined
      ? "no line changed"
      : `fleet ${percent(share)} of ${plural(lines(entry), "line")}`;

  return (
    `- \`${entry.repo}\` · ${of} · ` +
    `${plural(commits(entry), "commit")} (${entry.fleet.commits} fleet, ${entry.human.commits} human)`
  );
};

/**
 * Repos with no readable history here.
 *
 * The same declaration `unavailable` makes for a task's diff, for the same reason: a task
 * branch lives in the mirror of the runner that worked it, so another runner has no history
 * for that repo at all. Leaving it out of the section would make the shares above look like
 * they covered everything.
 */
const unreadableRepos = (report: AttributionReport): readonly string[] => {
  if (report.unavailable.length === 0) return [];

  return [
    `_Not counted: ${report.unavailable.map((slug) => `\`${slug}\``).join(", ")} — no mirror ` +
      `of it on this runner, so its history cannot be read from here._`,
    "",
  ];
};

const lines = (split: AuthorSplit): number => split.fleet.lines + split.human.lines;
const commits = (split: AuthorSplit): number => split.fleet.commits + split.human.commits;

/** A share as whole percent. Tenths of a percent of one day's commits are noise. */
const percent = (share: number): string => `${Math.round(share * 100)}%`;

const open = (tasks: readonly OpenTask[], timeZone: string): readonly string[] => {
  if (tasks.length === 0) return [];

  return [
    "## Still open",
    "",
    ...tasks.map(
      (entry) =>
        `- \`${entry.id}\` **${entry.status}** since ${at(entry.since, timeZone)}` +
        ` — ${entry.title}` +
        (entry.prUrl === undefined ? "" : ` ([pull request](${entry.prUrl}))`),
    ),
    "",
  ];
};

/**
 * Tasks the collector could not read.
 *
 * Printed, not swallowed. Skipping them is what keeps one malformed record from costing the
 * whole day, but a task that disappeared from the report without a word is the one an
 * operator most needs pointed at.
 */
const unreadable = (digest: DayDigest): readonly string[] => {
  if (digest.unreadable.length === 0) return [];

  return [
    "## Could not be read",
    "",
    `${digest.unreadable.map((id) => `\`${id}\``).join(", ")} — the control record would not ` +
      "parse, so nothing above counts these. Everything else in this digest is unaffected.",
    "",
  ];
};

const spend = (digest: DayDigest): string =>
  [
    plural(digest.totals.sessions, "session"),
    `${tokens(digest.totals.inputTokens)} in / ${tokens(digest.totals.outputTokens)} out`,
    money(digest.totals.costUsd),
  ].join(" · ");

/**
 * An instant as the operator's wall clock shows it.
 *
 * The window is the whole point of the document, and stating it in UTC would describe a
 * day the reader did not have — the same reason the window is computed in a zone at all.
 *
 * A timestamp that will not parse is printed verbatim rather than thrown over. Most of
 * these come from `updatedAt` in a control record, which is model-adjacent data in a file a
 * human can also edit; `Intl` answers an invalid Date with a RangeError, and one of those
 * here would fail the digest — every day, identically, because the collector is
 * deterministic.
 */
const at = (iso: string, timeZone: string): string => {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;

  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
};

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** 1_240_000 → `1.2M`. A digest is read at a glance; nine digits are not. */
const tokens = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
