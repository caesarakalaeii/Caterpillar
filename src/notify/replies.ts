/**
 * What the bot says back. See DESIGN.md §7.
 *
 * Pure: data in, markdown out. Every reply the chat interface produces is assembled
 * here so the wording is testable, and so silence is never the answer — a human who
 * types a command and gets nothing cannot tell a typo from an offline bridge.
 */
import type { TaskId, TaskStatus } from "../domain/task.ts";
import type { ChatOutcome } from "../supervisor/inbox.ts";
import { trackerItemUrl } from "../tracker/types.ts";
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
      // Names both, because `failed` was added to `RESUMABLE` and this line was not: it told
      // a human that a `running` task was "not parked", which is true and answers a question
      // nobody asked.
      return (
        `**${task}** is \`${outcome.status}\` — only \`parked\` and \`failed\` tasks come back. ` +
        `Nothing was written.`
      );
    case "merged":
      // `note` when there is one, because on a repo with a merge queue the pull request is
      // queued rather than merged and the difference is what the human is watching for.
      return outcome.note === undefined
        ? `Merged **${task}** — ${outcome.prUrl}`
        : `**${task}** — ${outcome.note} ${outcome.prUrl}`;
    case "started":
      return `Started **${outcome.task}**. It will read the repo and come back with its first question here.`;
    case "refused":
      return outcome.reason;
    case "not-mergeable":
      return `Could not merge **${task}**: ${outcome.reason}`;
    case "forced-done":
      // Never the word "merged", and the skipped gates named rather than implied: this is
      // the first thing a human reads back, so it is the first place the record could
      // start reading as a completion that was verified. It was not.
      return (
        `**${task}** is \`done\` by hand. Both acceptance gates were skipped — nothing was ` +
        `run, nothing was merged — and the journal says who decided and why.`
      );
    case "not-forceable":
      return `Could not force **${task}** done: ${outcome.reason}`;
    case "amended":
      return amendedReply(task, outcome);
    case "not-amendable":
      return `Could not amend **${task}**: ${outcome.reason}`;
    case "filed":
      return filedReply(task, outcome);
    case "not-filed":
      return `Could not file a report from **${task}**: ${outcome.reason}`;
    case "unknown-task":
      return `No task **${task}** in the state repo. Check the id from its notification.`;
    case "guided":
      return guidedReply(task, outcome);
    case "steered":
      // Deliberately not a message the bridge posts. A steer is acknowledged with a reaction
      // on the human's own message (§7.3) — refining an idea is many short replies, and a
      // line of confirmation under each one turns a conversation into a wall of receipts.
      // This wording exists for `/answer`, which is a command and does expect a reply.
      return `Sent to the session working **${task}**. It reads it at the end of its current step.`;
    case "finished":
      // Says the task is done and NOT how it got there. Since `/done`, a `done` task may
      // have been forced by hand with both §12 gates skipped and nothing merged, and this
      // one reply answers both kinds — so the old "it passed every gate and merged" would
      // be a verified-completion claim about a task nobody verified.
      return (
        `**${task}** is \`done\`, so there is nothing to send back to. Its journal has the ` +
        `record of how it got there. \`/brainstorm\` is how new work starts from here.`
      );
    case "not-waiting":
      return (
        `**${task}** is \`${outcome.status}\` and I could not reach the runner working it, so ` +
        `nothing was recorded. Try again in a moment.`
      );
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

/**
 * What was done with guidance, and what is left for the human to do.
 *
 * Three things have to be in it, and all three were missing from the surface this replaces —
 * which said nothing at all. That it was RECORDED, because the alternative reading of silence
 * is that it was discarded, and for a long time that reading was correct. That the council's
 * round budget was forgiven, because a resume that did not forgive it buys one more round and
 * parks again, and a human who is not told that concludes the guidance was ignored. And the
 * way back, once, at the end — a Resume button rides on this reply, so the text names the
 * command for the case where a button cannot be attached.
 */
const guidedReply = (
  task: TaskId,
  outcome: ChatOutcome & { readonly kind: "guided" },
): string => {
  const noted =
    outcome.notes <= 1 ? "Noted" : `Noted — ${outcome.notes} notes on **${task}** now`;
  const cleared = outcome.roundsCleared
    ? " The council's round count is back to zero, so it gets a full set of attempts."
    : "";
  const next = outcome.resumable
    ? ` Nothing runs until it is resumed: press the button, or \`/resume ${task}\`.`
    : " The next session reads it before it starts.";

  return `${noted}.${cleared}${next}`;
};

/**
 * What an amendment actually changed, and how to change it again.
 *
 * Both ends of the diff, spelled out, because an amendment can be as broken as the criterion
 * it replaced — the real case was a criterion written as an escaped regex for a matcher that
 * compares with `includes()`. Re-amending is the only correction path, deliberately, so the
 * reply has to make the mistake visible without anybody opening the state repo, and has to
 * name the way to fix it.
 *
 * A side of the diff that is empty is left out rather than rendered as "Removed: none": on a
 * first amendment that adds a criterion, a line saying nothing was removed is a line that
 * exists to be skipped.
 */
const amendedReply = (
  task: TaskId,
  outcome: ChatOutcome & { readonly kind: "amended" },
): string => {
  const listed = (entries: readonly string[]): string =>
    entries.map((entry) => `\`${entry}\``).join(", ");

  return take(
    [
      `Amended **${task}** — \`amendments/${String(outcome.index).padStart(3, "0")}.yaml\`. ` +
        `\`spec.md\` is untouched.`,
      ...(outcome.removed.length === 0 ? [] : [`Removed: ${listed(outcome.removed)}`]),
      ...(outcome.added.length === 0 ? [] : [`Added: ${listed(outcome.added)}`]),
      `That list is the gate now. If it is still wrong, run \`/amend\` again — the highest ` +
        `amendment wins, so a second one corrects the first.`,
    ].join("\n"),
    CONTENT_LIMIT,
  );
};

/**
 * Where the filed item is, and what it is.
 *
 * The address is the whole reply. The button exists to stop somebody copying text between
 * two windows, and a reply that says "filed" and leaves them to go looking puts half of
 * that work back. Falls back to the ref when no web address can be built from it — see
 * `trackerItemUrl` for why guessing one is worse.
 *
 * `note` is rendered when there is one, and the only one there is says the item already
 * existed: a second press of a button that has been sitting in the channel for a week must
 * not read as a second report.
 */
const filedReply = (task: TaskId, outcome: ChatOutcome & { readonly kind: "filed" }): string => {
  const where = trackerItemUrl(outcome.ref) ?? `${outcome.ref.kind} item ${outcome.ref.id}`;
  const what = outcome.report === "bug" ? "bug report" : "feature request";
  const note = outcome.note === undefined ? "" : ` — ${outcome.note}`;

  return (
    `Filed a ${what} from **${task}**${note}: ${where}\n` +
    `It carries the \`agent-candidate\` label, so nothing picks it up as work until ` +
    `somebody relabels it.`
  );
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

/**
 * The review half of `/task`, and the reason this reply grew past six fields.
 *
 * A task the council keeps sending back showed as `ready`, then `ready`, then `parked`,
 * with nothing anywhere in Discord saying a review had happened at all — let alone what it
 * objected to or what a human could do about it. `rounds` answers how often, `reason`
 * answers why, and the last line answers whose move it is, because a count and a critique
 * still leave a reader guessing whether they are expected to act.
 */
const reviewLines = (task: TaskSummary): readonly string[] => {
  const review = task.review;
  if (review === undefined || review.rounds === 0) return [];

  const rounds = `${review.rounds} round${review.rounds === 1 ? "" : "s"}`;
  const outcome =
    review.last === "pass"
      ? "passed"
      : review.last === "changes"
        ? "sent back"
        : "no verdict recorded";

  return [
    "",
    `**Review council:** ${rounds}, last ${outcome}.`,
    ...(review.reason === undefined ? [] : [review.reason]),
    "",
    // Keyed on status, not on the task's kind, because the summary does not carry the kind
    // and guessing it from the id prefix would be wrong for exactly the tasks a plan cut.
    task.status === "parked" || task.status === "failed"
      ? `It will not be picked up again on its own. Say what to change in its thread — that ` +
        `resets the round count — then \`/resume ${task.id}\`` +
        (task.prUrl === undefined ? "." : `, or \`/merge ${task.id}\` to take the PR as it stands.`)
      : task.status === "running"
        ? `Say what to change in its thread and the session picks it up at the end of its ` +
          `current step — it does not have to be restarted.`
        : `It goes back to the agent by itself. Say what to change in its thread and the next ` +
          `session reads it before it starts.`,
  ];
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
      ...reviewLines(task),
    ].join("\n"),
    CONTENT_LIMIT,
  );
};

/** Acknowledgement shown the instant a button is clicked, before the loop has run. */
export const queued = (what: string, by: string): string =>
  `⏳ ${what} — queued by ${by}, applying on the next poll.`;
