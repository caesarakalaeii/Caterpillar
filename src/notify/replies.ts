/**
 * What the bot says back. See DESIGN.md §7.
 *
 * Pure: data in, markdown out. Every reply the chat interface produces is assembled
 * here so the wording is testable, and so silence is never the answer — a human who
 * types a command and gets nothing cannot tell a typo from an offline bridge.
 */
import type { TaskId, TaskStatus } from "../domain/task.ts";
import type { ChatOutcome } from "../supervisor/inbox.ts";
import type { TaskSummary } from "../supervisor/snapshot.ts";
import { CONTENT_LIMIT, take } from "./discord.ts";

/** Lines a listing shows before it starts eliding. Well inside the 2000-point limit. */
const MAX_LINES = 25;

/** What actually happened to a queued request. */
export const describeOutcome = (task: TaskId, outcome: ChatOutcome): string => {
  switch (outcome.kind) {
    case "applied":
      return `Answered **${task}** (question ${outcome.index}). It is \`ready\` and will be claimed on the next poll.`;
    case "parked":
      return `Parked **${task}**. It will not be claimed again until someone runs \`/resume ${task}\`.`;
    case "resumed":
      return outcome.exhausted === undefined
        ? `Resumed **${task}**. It is \`ready\` and will be claimed on the next poll.`
        : // "on the next claim", NOT "after its next session": `checkLimits` runs before
          // the first session, so a task resumed at its session limit parks again having
          // run nothing. Saying otherwise sends the human away expecting work to happen.
          `Resumed **${task}**, but ${outcome.exhausted} — resuming does not reset that, so it will park again on the next claim, without running, unless the limit is raised.`;
    case "not-resumable":
      return `**${task}** is \`${outcome.status}\`, not \`parked\` — nothing was written.`;
    case "merged":
      return `Merged **${task}** — ${outcome.prUrl}`;
    case "started":
      return `Started **${outcome.task}**. It will read the repo and come back with its first question here.`;
    case "refused":
      return outcome.reason;
    case "not-mergeable":
      return `Could not merge **${task}**: ${outcome.reason}`;
    case "unknown-task":
      return `No task **${task}** in the state repo. Check the id from its notification.`;
    case "not-waiting":
      return `**${task}** is \`${outcome.status}\`, not waiting on an answer — nothing was written.`;
    case "not-parkable":
      return `**${task}** is already \`${outcome.status}\` — nothing was written.`;
    case "cancelling":
      return (
        `Stopping **${task}**. The session finishes the step it is on, then unwinds — ` +
        `it will show as \`parked\` within a poll. Nothing from this session is recorded.`
      );
    case "failed":
      return `Could not act on **${task}**: ${outcome.error}`;
  }
};

/** Statuses in the order the header counts them — the arc a task travels. */
const COUNT_ORDER: readonly TaskStatus[] = [
  "running",
  "awaiting-human",
  "ready",
  "parked",
  "failed",
  "done",
];

/**
 * `1 running · 4 ready · 31 done`, over the WHOLE set rather than the page.
 *
 * This is the half of the answer a capped list cannot give. Counted over everything and
 * stated before the lines, so "31 done" is visible without paging to it, and a page 2 that
 * happens to hold nothing interesting still says what the fleet looks like. Zero counts are
 * dropped: six statuses of which four are usually 0 is noise on the one line that has to be
 * read at a glance.
 */
const counts = (tasks: readonly TaskSummary[]): string =>
  COUNT_ORDER.map((status) => ({ status, n: tasks.filter((t) => t.status === status).length }))
    .filter((entry) => entry.n > 0)
    .map((entry) => `${entry.n} ${entry.status}`)
    .join(" · ");

/**
 * The task listing, newest first, one page at a time.
 *
 * Ordering is the snapshot's (`supervisor/snapshot.ts`) and deliberately not re-done here:
 * pagination over a list this function reordered would repeat and skip tasks across pages.
 *
 * `page` is 1-based because it is typed by a human into a slash command, and clamped rather
 * than refused — a page past the end returns the LAST page with a note. Refusing would be
 * technically tidier and worse to use: the count of tasks changes between the moment someone
 * reads "3 pages" and the moment they ask for page 3.
 */
export const describeList = (
  tasks: readonly TaskSummary[],
  status?: TaskStatus,
  page = 1,
): string => {
  const scope = status === undefined ? "" : ` in \`${status}\``;
  if (tasks.length === 0) return `No tasks${scope}.`;

  const pages = Math.max(1, Math.ceil(tasks.length / MAX_LINES));
  // Clamped at both ends: `page:0` and `page:-1` are as typeable as `page:99`.
  const current = Math.min(Math.max(Math.trunc(page), 1), pages);
  const start = (current - 1) * MAX_LINES;
  const shown = tasks.slice(start, start + MAX_LINES);

  const lines = shown.map(
    (task) =>
      `\`${task.id}\` — **${task.status}** · ${task.phase} · ${task.sessions} session${task.sessions === 1 ? "" : "s"}`,
  );

  const header =
    `**${tasks.length}** task${tasks.length === 1 ? "" : "s"}${scope}` +
    (pages > 1 ? ` · page ${current}/${pages}` : "") +
    // Only when listing everything: inside `status:done` the breakdown is one number and
    // repeating the filter back at the reader tells them nothing.
    (status === undefined ? ` · ${counts(tasks)}` : "");

  // The command to type is spelled out rather than a bare "…and N more". The old wording
  // said a number was missing and gave no way to reach it, which is the whole complaint this
  // rewrite answers — so the footer's job is to name the next command, never to point at the
  // page already on screen.
  const filterHint = status === undefined ? " · `status:` to filter" : "";
  const command = `/tasks${status === undefined ? "" : ` status:${status}`}`;
  const footer =
    pages === 1
      ? []
      : [
          "",
          current < pages
            ? `\`${command} page:${current + 1}\` for the next ${Math.min(MAX_LINES, tasks.length - (start + shown.length))}${filterHint}`
            : `Last page · \`${command} page:1\` to start over${filterHint}`,
        ];

  return take([header, "", ...lines, ...footer].join("\n"), CONTENT_LIMIT);
};

export const describeTask = (id: TaskId, task: TaskSummary | undefined): string => {
  if (task === undefined) {
    return `No task **${id}** in the state repo. It may not have been ingested yet.`;
  }

  return take(
    [
      `**${task.id}** — \`${task.status}\``,
      `Phase: ${task.phase}`,
      `Sessions: ${task.sessions}`,
      `Cost: $${task.costUsd.toFixed(2)}`,
      ...(task.prUrl === undefined ? [] : [`PR: ${task.prUrl}`]),
      `Updated: ${task.updatedAt}`,
    ].join("\n"),
    CONTENT_LIMIT,
  );
};

/** Acknowledgement shown the instant a button is clicked, before the loop has run. */
export const queued = (what: string, by: string): string =>
  `⏳ ${what} — queued by ${by}, applying on the next poll.`;
