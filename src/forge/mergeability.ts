/**
 * Whether a change can land, and how. See DESIGN.md §12.
 *
 * Pure: no forge calls, no git calls, no clock. Everything here is a decision or a
 * parse, so the two things that were previously implicit on the merge path can be
 * stated once and tested without a network.
 *
 * The two:
 *
 *   **A merge queue is a gate the repo's owners chose.** Merging directly into a base
 *   that requires one either fails or bypasses it, and bypassing is the worse outcome —
 *   it defeats the protection rather than reporting it. So a queue is enqueued, and
 *   "in queue" is carried as its own outcome. That third state is the whole point: §11.1
 *   records three sessions lost to CI `pending` being returned as a failed gate, and
 *   reporting a queued merge as either a success or a failure is the same mistake.
 *
 *   **A conflict is ordinary drift, not a terminal failure.** A task that ran for several
 *   sessions can end on a branch that no longer merges. Discovered at the merge, that is
 *   a failure after every gate has passed; discovered at session start, it is a rebase.
 */

/**
 * Whether the base branch of a pull request requires a merge queue.
 *
 * `unknown` is a first-class answer rather than an error, because the caller's response
 * to it is a decision and not an exception: Forgejo has no merge queue concept at all,
 * a token may lack the permission to read branch protection, and a forge can be down.
 * See `landingFor`.
 */
export type MergeQueueSupport = "required" | "absent" | "unknown";

/** How to land a pull request whose base has `support`. */
export type Landing = "merge" | "enqueue";

/** What happened to one pull request. `queued` is neither of the other two. */
export type MergeOutcome = "merged" | "queued";

/**
 * Enqueue only where a queue is known to be required.
 *
 * `unknown` merges. That is not optimism: the merge itself is the authority on whether
 * it is allowed, and GitHub refuses a direct merge into a queue-protected base with a
 * 405. So guessing wrong here costs a reported failure, while refusing to merge on an
 * unanswered question costs every repo whose forge cannot answer — which is all of
 * Forgejo, and any repo whose reviewer token reads no branch protection.
 */
export const landingFor = (support: MergeQueueSupport): Landing =>
  support === "required" ? "enqueue" : "merge";

/**
 * Does this outcome stop a multi-repo task's merge sequence?
 *
 * §9.4.1 merges in `spec.repos` order and stops at the first failure, because the repos
 * of one change usually cannot land in either order. A queued pull request has not
 * landed — it is waiting for its own CI run against the queue's speculative base — so
 * continuing would push the sibling onto a default branch whose counterpart may still
 * be rejected. Stopping leaves the remaining pull requests open, which is the state a
 * human can act on.
 */
export const stopsTheSequence = (outcome: MergeOutcome): boolean => outcome === "queued";

/** One pull request the council acted on, for the report. */
export interface LandedPullRequest {
  /** `owner/name`, as `repoSlug` spells it. */
  readonly slug: string;
  readonly pr: number;
  readonly outcome: MergeOutcome;
}

/**
 * One sentence for the message that announces the task is done.
 *
 * Returns `undefined` when nothing was acted on, so the caller keeps whatever it says
 * about having nothing to merge — that sentence names a different situation (no PR, no
 * reviewer identity) and is not this function's to guess at.
 *
 * A queued pull request is always named as queued. A reader told "merged" stops watching,
 * and the queue can still reject the change.
 */
export const mergeNote = (landed: readonly LandedPullRequest[]): string | undefined => {
  if (landed.length === 0) return undefined;

  const merged = landed.filter((one) => one.outcome === "merged").map(describe);
  const queued = landed.filter((one) => one.outcome === "queued").map(describe);

  const parts: string[] = [];
  if (merged.length > 0) parts.push(`merged ${merged.join(", ")}`);
  if (queued.length > 0) {
    parts.push(
      `added ${queued.join(", ")} to the repository's merge queue — the merge completes ` +
        `when the queue's own checks pass`,
    );
  }

  return `Approved by the review council and ${parts.join("; ")}.`;
};

const describe = (one: LandedPullRequest): string => `${one.slug}#${one.pr}`;

/** One file that does not merge, and how much of it does not. */
export interface ConflictFile {
  readonly path: string;
  /**
   * Conflicting hunks — `<<<<<<<` markers in the merged blob. Absent when there is no
   * blob to count them in, which is what a delete-versus-modify conflict looks like.
   */
  readonly hunks?: number;
}

export interface ConflictSummary {
  /** The tree `git merge-tree --write-tree` wrote, carrying the conflict markers. */
  readonly tree: string;
  /** Sorted by path, so two runs of the same state read the same. */
  readonly files: readonly ConflictFile[];
}

/** Enough of a `GitResult` to read; keeps this module free of the git module. */
export interface MergeTreeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

/**
 * What `git merge-tree --write-tree <base> <head>` said.
 *
 *   - `undefined` — merges cleanly (exit 0).
 *   - a `ConflictSummary` — conflicts, listed (exit 1).
 *   - `"unknown"` — git could not answer (exit 2 and up: a base this checkout does not
 *     carry, a missing object, git too old for `--write-tree`).
 *
 * The third case is separate from the first on purpose. Both mean "no conflicts to
 * report", but only one means "this branch merges", and folding them together would tell
 * a session its branch was fine because nobody could check.
 *
 * `markerCounts` maps path to `<<<<<<<` count and is the caller's to supply: counting
 * needs the merged blobs, which needs git. Absent, files are still named — a file to
 * rebase is worth reporting without its size.
 */
export const parseConflicts = (
  result: MergeTreeResult,
  markerCounts?: ReadonlyMap<string, number>,
): ConflictSummary | "unknown" | undefined => {
  if (result.code === 0) return undefined;
  if (result.code > 1) return "unknown";

  const lines = result.stdout.split("\n");
  const tree = (lines[0] ?? "").trim();
  if (tree.length === 0) return "unknown";

  const paths = new Set<string>();
  // Stage lines run until the blank line that separates them from git's messages. Read
  // by shape rather than by position: `Auto-merging x` has no tab, so a message that
  // arrives early cannot become a path.
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) break;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const path = line.slice(tab + 1).trim();
    if (path.length > 0) paths.add(path);
  }

  if (paths.size === 0) return "unknown";

  const files = [...paths].sort().map((path) => {
    const hunks = markerCounts?.get(path);
    return hunks === undefined ? { path } : { path, hunks };
  });

  return { tree, files };
};

/**
 * The prompt section handed to a session whose branch no longer merges (§12).
 *
 * Written as an instruction rather than a warning. The point is that the rebase happens
 * as ordinary work in the session that can afford it, instead of surfacing as a merge
 * failure after every gate has passed — which reads as terminal and is not.
 */
export const conflictGuidance = (
  base: string,
  summary: ConflictSummary | undefined,
): string | undefined => {
  if (summary === undefined || summary.files.length === 0) return undefined;

  const files = summary.files
    .map((file) => `- \`${file.path}\`${file.hunks === undefined ? "" : ` — ${file.hunks} hunks`}`)
    .join("\n");

  return (
    `Your branch no longer merges into \`${base}\`. These files conflict:\n\n${files}\n\n` +
    `This is ordinary drift, not a defect in your work: \`${base}\` moved while this task ` +
    `was running. Rebase onto \`${base}\` early in this session and resolve it as part of ` +
    `the work — left alone it becomes a merge failure after every gate has already passed, ` +
    `which costs a whole session to discover.`
  );
};
