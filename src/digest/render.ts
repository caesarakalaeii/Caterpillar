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
    ...change.changes.flatMap(repo),
    ...unavailable(change),
  ];
};

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
