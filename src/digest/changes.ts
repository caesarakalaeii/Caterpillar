/**
 * The code a task actually produced, read from this runner's bare mirrors. See DESIGN.md §19.
 *
 * Everything else in a digest comes from the state repo, which every runner has. This does
 * not: a task branch exists in the mirror of the runner that WORKED it, so a fleet of
 * several runners has a digest-publishing runner that can see some tasks' diffs and not
 * others. That asymmetry is declared rather than hidden — a repo with no mirror produces
 * no record here, and `collect.ts` turns the absence into a line saying so. A zeroed
 * diffstat would read as "this task changed nothing", which is the one wrong answer.
 *
 * Strictly local. No fetch, no credential, no network: the mirror is read exactly as it
 * stands, which is also why this can run while the credential service is refusing to
 * answer (DESIGN.md §9.2).
 */
import type { RepoRef, TaskId } from "../domain/task.ts";
import type { Git } from "../state/git.ts";
import type { AuthoredCommit } from "./attribution.ts";
import type { AuthorshipRead, ChangeReader, RepoChange } from "./collect.ts";

/**
 * Where a repo's mirror is, if this runner has one.
 *
 * Narrowed to the one method the digest needs, so a read-only path cannot reach the half
 * of `WorktreeManager` that clones, fetches and creates worktrees.
 */
export interface MirrorSource {
  localMirror(repo: RepoRef): Git | undefined;
}

/** Commit subjects per repo. A branch with more than this is summarised by its stat line. */
const MAX_COMMITS = 20;
/** Paths listed per repo. Enough to see the shape of a change without pasting a tree. */
const MAX_FILES = 25;

export class MirrorChangeReader implements ChangeReader {
  private readonly mirrors: MirrorSource;

  constructor(mirrors: MirrorSource) {
    this.mirrors = mirrors;
  }

  /**
   * Every commit in `repos` between two instants, and the repos that could not be read.
   *
   * Committer dates, matching the `--before` the state repo's own window uses
   * (`collect.ts`): a rebase resets the committer date to the moment the fleet pushed, so
   * that is the day the work landed. Author dates would report a cherry-picked month-old
   * patch as a month-old day.
   *
   * `--all`, because the interesting commits are on several refs at once — the fleet's work
   * on `agent/<task>`, a person's on the default branch — and a commit reachable from two
   * of them is listed once, so a merged branch the mirror still holds does not inflate the
   * fleet's share.
   *
   * `--no-merges`, because a merge introduces no line and its commits are already counted.
   * Keeping them would count a pull request's landing twice at commit level, and every
   * merge on GitHub is made by the author App (§12.1) — so the fleet's commit share would
   * rise every time a HUMAN's branch was merged.
   */
  async readAuthorship(
    repos: readonly RepoRef[],
    from: Date,
    to: Date,
  ): Promise<AuthorshipRead> {
    const commits: AuthoredCommit[] = [];
    const unavailable: string[] = [];

    for (const repo of repos) {
      const slug = `${repo.owner}/${repo.name}`;
      const git = this.mirrors.localMirror(repo);
      if (git === undefined) {
        unavailable.push(slug);
        continue;
      }

      // A mirror that is present and will not answer is as unreadable as an absent one, and
      // for the digest's purpose they are the same statement: this runner cannot say.
      const log = await git.tryRun(
        "log",
        "--all",
        "--no-merges",
        "--numstat",
        // Oldest first, like every other list in a digest: a day reads forwards.
        "--reverse",
        `--format=${RECORD}%H%x1f%ae%x1f%an`,
        `--since=${from.toISOString()}`,
        `--until=${to.toISOString()}`,
      );
      if (log.code !== 0) {
        unavailable.push(slug);
        continue;
      }

      commits.push(...parseAuthored(slug, log.stdout));
    }

    return { commits, unavailable };
  }

  async read(task: TaskId, repos: readonly RepoRef[]): Promise<readonly RepoChange[]> {
    const changes: RepoChange[] = [];
    for (const repo of repos) {
      const change = await this.readOne(task, repo).catch(() => undefined);
      if (change !== undefined) changes.push(change);
    }
    return changes;
  }

  /**
   * One repo, or nothing.
   *
   * Every step can legitimately fail — no mirror, no branch, a branch that never diverged
   * — and each of those means "this runner cannot say", not "an error occurred". Only a
   * branch with commits on it produces a record.
   */
  private async readOne(task: TaskId, repo: RepoRef): Promise<RepoChange | undefined> {
    const git = this.mirrors.localMirror(repo);
    if (git === undefined) return undefined;

    const head = await git.revParse(`refs/heads/agent/${task}`);
    if (head === undefined) return undefined;

    // The mirror's HEAD is a symbolic ref to its default branch, so the fork point is a
    // plain local merge-base — the same resolution the progress probe uses (§11.1).
    const base = await git.tryRun("symbolic-ref", "--short", "HEAD");
    if (base.code !== 0) return undefined;

    const forkPoint = await git.tryRun("merge-base", head, base.stdout.trim());
    if (forkPoint.code !== 0) return undefined;
    const range = `${forkPoint.stdout.trim()}..${head}`;

    const log = await git.tryRun("log", "--format=%s", "--reverse", range);
    const commits = log.code === 0 ? lines(log.stdout) : [];
    // A branch that exists but carries nothing is a task that was claimed and did no work.
    // It has a state.json entry saying so; it does not need a change record saying nothing.
    if (commits.length === 0) return undefined;

    const stat = await git.tryRun("diff", "--shortstat", range);
    const files = await git.tryRun("diff", "--name-only", range);

    return {
      repo: `${repo.owner}/${repo.name}`,
      commits: commits.slice(0, MAX_COMMITS),
      ...shortstat(stat.code === 0 ? stat.stdout : ""),
      files: (files.code === 0 ? lines(files.stdout) : []).slice(0, MAX_FILES),
    };
  }
}

/**
 * Starts each `git log` record. A NUL, because it cannot occur in a path, an address or a
 * display name, so a commit by someone whose name contains a newline cannot forge a record.
 */
const RECORD = "%x00";

/**
 * `git log --numstat` output into commits.
 *
 * Each record is `<sha>\x1f<email>\x1f<name>` followed by a `<added>\t<removed>\t<path>`
 * line per file. A binary file's counts are `-`, which parse to nothing and are counted as
 * zero lines: a 4 MiB PNG is not four million lines of authorship.
 */
const parseAuthored = (repo: string, output: string): readonly AuthoredCommit[] =>
  output.split("\0").flatMap((record) => {
    const [header, ...files] = record.split("\n");
    if (header === undefined || header.trim() === "") return [];

    const [sha, authorEmail, authorName] = header.split("\x1f");
    if (sha === undefined || authorEmail === undefined) return [];

    let insertions = 0;
    let deletions = 0;
    for (const file of files) {
      const [added, removed] = file.split("\t");
      insertions += digits(added);
      deletions += digits(removed);
    }

    return [
      {
        repo,
        sha,
        authorEmail,
        ...(authorName === undefined || authorName === "" ? {} : { authorName }),
        insertions,
        deletions,
      },
    ];
  });

/** A numstat count, or 0 for git's `-` and for anything that is not a count. */
const digits = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value)) return 0;
  return Number.parseInt(value, 10);
};

const lines = (output: string): readonly string[] =>
  output.split("\n").flatMap((line) => (line.trim() === "" ? [] : [line.trim()]));

/**
 * Parse `12 files changed, 430 insertions(+), 89 deletions(-)`.
 *
 * Each clause is optional in git's output — a change that only adds files has no
 * deletions clause at all — so each is matched independently rather than by one pattern
 * that silently returns nothing when a clause is missing.
 */
const shortstat = (
  output: string,
): { filesChanged: number; insertions: number; deletions: number } => ({
  filesChanged: number(output, /(\d+) files? changed/),
  insertions: number(output, /(\d+) insertions?\(\+\)/),
  deletions: number(output, /(\d+) deletions?\(-\)/),
});

const number = (text: string, pattern: RegExp): number => {
  const match = pattern.exec(text);
  return match === null ? 0 : Number.parseInt(match[1] as string, 10);
};
