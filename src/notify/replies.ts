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
        : `Resumed **${task}**, but ${outcome.exhausted} — resuming does not reset that, so it will park again after its next session unless the limit is raised.`;
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
    case "failed":
      return `Could not act on **${task}**: ${outcome.error}`;
  }
};

export const describeList = (
  tasks: readonly TaskSummary[],
  status?: TaskStatus,
): string => {
  const scope = status === undefined ? "" : ` in \`${status}\``;
  if (tasks.length === 0) return `No tasks${scope}.`;

  const shown = tasks.slice(0, MAX_LINES);
  const lines = shown.map(
    (task) =>
      `\`${task.id}\` — **${task.status}** · ${task.phase} · ${task.sessions} session${task.sessions === 1 ? "" : "s"}`,
  );
  const elided =
    tasks.length > shown.length ? [`…and ${tasks.length - shown.length} more.`] : [];

  return take(
    [`**${tasks.length}** task${tasks.length === 1 ? "" : "s"}${scope}`, "", ...lines, ...elided].join("\n"),
    CONTENT_LIMIT,
  );
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
