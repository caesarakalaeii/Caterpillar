/**
 * Pull request review comments as a prompt section. See DESIGN.md §7.3.
 *
 * A human reviewing a change in the forge — which is the natural place to review one — used
 * to be talking into a void. Guidance reached a task only as prose in its Discord thread, so
 * the review council could block a change with a verdict and a human could not, except by
 * leaving the surface they were already looking at.
 *
 * Pure, and no IO, for `journal.ts`'s reason: the supervisor fetches (invariant 1, §9.2) and
 * this decides what the agent is shown. That split is what makes the interesting half —
 * which comments count — testable without a forge.
 *
 * Two rules are encoded below, and both are about a comment that should NOT be read as an
 * instruction:
 *
 *   A closed thread is not guidance. A resolved comment was said, dealt with and accepted;
 *   an outdated one was written against a line that no longer exists. Quoted in full they
 *   send the agent to redo work that already landed, and on an old pull request they are the
 *   bulk of what there is to read. So they are counted, not quoted — the count is what tells
 *   the agent a review happened, which is the thing a bare absence cannot say.
 *
 *   The fleet's own voice is not guidance. The agent replies to reviews and the reviewer
 *   identity posts approvals, both onto the same pull request. Fed back, they are a loop
 *   with no human in it — and since a human comment forgives a review round (§12.1), it
 *   would be a loop that forgives one on every session for the rest of the task's life.
 */
import { repoSlug } from "../domain/task.ts";
import type { ReviewComment } from "../forge/types.ts";

/**
 * Comments a human left that are still open — the ones that are actually an instruction.
 *
 * Exported because the round-count reset asks the same question the renderer does, and the
 * two answers must not be able to disagree: a section the agent was shown but that bought it
 * no round would park the task before it could act on what it had just read.
 */
export const actionableComments = (
  comments: readonly ReviewComment[],
): readonly ReviewComment[] =>
  comments.filter((c) => !c.fromFleet && !c.resolved && !c.outdated);

/**
 * When the newest open human comment was written, or `undefined` if there is none.
 *
 * The watermark the supervisor compares against what the council has already been shown, so
 * one objection forgives one round rather than every round from now on.
 *
 * A timestamp that does not parse is DROPPED rather than carried through: these are
 * forge-authored strings, `Date.parse` answers NaN for a bad one, and NaN compares false
 * against every watermark — so a single malformed comment would either forgive a round
 * forever or never, depending on which way the comparison happened to be written.
 */
export const newestHumanComment = (
  comments: readonly ReviewComment[],
): string | undefined => {
  let newest: { readonly at: string; readonly ms: number } | undefined;

  for (const comment of actionableComments(comments)) {
    const ms = Date.parse(comment.createdAt);
    if (Number.isNaN(ms)) continue;
    if (newest === undefined || ms > newest.ms) newest = { at: comment.createdAt, ms };
  }

  return newest?.at;
};

/**
 * Whether these comments should clear the review council's round count (§12.1, §7.3).
 *
 * The cap exists because the agent and the council can trade a task forever with nothing new
 * entering the loop, and a human objection is exactly something new — the same argument
 * §7.3 makes for typed guidance, reaching the same answer for the surface a reviewer is
 * actually looking at.
 *
 * `seen` is the newest comment a previous session already had forgiven for it. Forgiving
 * without it would delete the cap rather than inform it: one comment would buy a round on
 * every session for the rest of the task's life, and the loop the cap exists to detect would
 * run forever.
 *
 * A `seen` that does not parse is treated as no watermark at all. State files are written by
 * earlier deploys and edited by hand, and a NaN comparison is false in both directions — so
 * the alternative is quietly never forgiving anything again.
 */
export const reviewRoundsForgiven = (
  comments: readonly ReviewComment[],
  seen: string | undefined,
): boolean => isNewerComment(newestHumanComment(comments), seen);

/**
 * The same rule stated over timestamps, for the caller that has one rather than a list.
 *
 * The supervisor is that caller: it holds no minting forge (`SupervisorDeps.forges` is
 * narrowed to `RepoReach` on purpose), so what reaches it is the one timestamp the session
 * reported on its outcome. Sharing this rather than re-deriving the comparison there is what
 * keeps "newer than what was already acted on" from being written twice and drifting.
 */
export const isNewerComment = (
  comment: string | undefined,
  seen: string | undefined,
): boolean => {
  if (comment === undefined) return false;
  const seenMs = seen === undefined ? NaN : Date.parse(seen);
  return Number.isNaN(seenMs) || Date.parse(comment) > seenMs;
};

/** `path:line`, `path` or nothing — however much of a location the forge gave us. */
const where = (comment: ReviewComment): string => {
  if (comment.path === undefined) return "on the pull request";
  return comment.line === undefined
    ? `\`${comment.path}\``
    : `\`${comment.path}:${comment.line}\``;
};

/**
 * Comments grouped by the pull request they were left on, in the order they arrived.
 *
 * A multi-repo task opens one pull request per repo (§9.4.1), and a comment on
 * `index.ts` means nothing until the agent knows which checkout to open. `Map` preserves
 * insertion order, so the caller's repo order — `spec.repos`, primary first — is the
 * order they are read in.
 */
const byPullRequest = (
  comments: readonly ReviewComment[],
): ReadonlyMap<string, readonly ReviewComment[]> => {
  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const key = `${repoSlug(comment.repo)}#${comment.pr}`;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [comment]);
    else existing.push(comment);
  }
  return grouped;
};

/**
 * The review-comment section of a session's prompt, or `undefined` when there is nothing
 * to say.
 *
 * `undefined` rather than an empty string, because `prompt.ts` renders a heading for
 * anything non-blank: "Review comments on your pull request" with nothing under it reads as
 * a human having reviewed the change and said nothing, which is the opposite of the truth.
 */
export const renderReviewGuidance = (
  comments: readonly ReviewComment[],
): string | undefined => {
  const open = actionableComments(comments);
  if (open.length === 0) return undefined;

  const closed = comments.filter((c) => !c.fromFleet && (c.resolved || c.outdated));
  const lines: string[] = [
    "A human reviewed your pull request in the forge. These comments are unresolved — treat " +
      "them as you would guidance typed in the task's thread, and reply to them in the code " +
      "rather than by arguing in a commit message.",
  ];

  for (const [pull, group] of byPullRequest(open)) {
    lines.push("", `### ${pull}`, "");
    for (const comment of group) {
      lines.push(`- **${comment.author}** ${where(comment)}${comment.url === undefined ? "" : ` ([link](${comment.url}))`}`);
      // Indented as a block quote so a multi-line comment cannot be mistaken for the
      // surrounding prompt — a reviewer's own markdown headings would otherwise read as
      // sections of the prompt itself.
      for (const line of comment.body.trim().split("\n")) lines.push(`  > ${line}`);
    }
  }

  const resolved = closed.filter((c) => c.resolved).length;
  const outdated = closed.filter((c) => !c.resolved).length;
  if (resolved > 0 || outdated > 0) {
    const counts = [
      ...(resolved > 0 ? [`${resolved} resolved`] : []),
      ...(outdated > 0 ? [`${outdated} outdated`] : []),
    ].join(" and ");
    lines.push(
      "",
      `_${counts} comment(s) are not shown: a resolved thread has been accepted, and an ` +
        `outdated one was written against a line that no longer exists._`,
    );
  }

  return lines.join("\n");
};
