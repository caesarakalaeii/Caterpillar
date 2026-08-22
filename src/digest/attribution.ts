/**
 * How much of a repository the fleet wrote, and which way that is going. See DESIGN.md §19.
 *
 * The rest of the digest answers "what moved today". This answers the question an owner
 * has after the fleet has been running for a month and which nothing else here can:
 * **what share of this repository's change is the fleet's, and is that share trending?**
 * A single day's share says almost nothing on its own — a day with one human commit in it
 * reads as 50% — so every figure is reported against the previous window.
 *
 * Pure, like `day.ts`: no clock, no IO, no repo. It is handed commits that somebody else
 * read out of a mirror, which is what makes an identity change mid-window and an
 * unreadable repo both testable without building either.
 *
 * Two rules it inherits from the sections around it rather than inventing:
 *
 *   - **Match the ADDRESS, never the display name** (§9.7). A forge resolves an address to
 *     an account, which is exactly why the identity is configuration; two people can share
 *     a display name, and a name match would credit one of them with the fleet's work.
 *   - **A repo that could not be read is NAMED, never counted as zero** (§19). A task
 *     branch lives in the mirror of the runner that worked it, so another runner has no
 *     history for that repo at all. `0%` there says the fleet wrote none of it, which is a
 *     false statement about a repo it may have written entirely.
 */

/** One commit, as a mirror reports it. The only evidence attribution needs. */
export interface AuthoredCommit {
  /** `owner/name`. */
  readonly repo: string;
  readonly sha: string;
  /** The author's email, verbatim from git. Case is not normalised by git. */
  readonly authorEmail: string;
  /** Present for the record, and deliberately NOT used to decide authorship. */
  readonly authorName?: string;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * The addresses that are the fleet.
 *
 * A LIST rather than one address, because §9.7's identity is deployment configuration: a
 * deployment that reinstalled its App has a retired address and a current one, and a
 * window straddling the change would otherwise read the retired half as a person's work —
 * inventing a contributor and halving the share on exactly the day the operator is most
 * likely to be looking.
 */
export interface FleetIdentity {
  readonly emails: readonly string[];
}

/** Commits and lines written by one side. */
export interface AuthorTotals {
  readonly commits: number;
  /** Insertions plus deletions. Deleting a hundred lines is work. */
  readonly lines: number;
}

/**
 * One side's share of a window, at commit and line level.
 *
 * A share is `undefined` rather than 0 when its denominator is 0. Zero would be a claim
 * ("the fleet wrote none of it") about a window in which nothing happened at all.
 */
export interface AuthorSplit {
  readonly fleet: AuthorTotals;
  readonly human: AuthorTotals;
  readonly fleetCommitShare?: number;
  readonly fleetLineShare?: number;
}

export interface RepoAttribution extends AuthorSplit {
  /** `owner/name`. */
  readonly repo: string;
}

/** Which way the fleet's share of lines moved against the previous window. */
export type AttributionTrend = "up" | "down" | "flat";

export interface AttributionReport {
  /** Per repo, busiest first. Repos with no readable history are not here. */
  readonly repos: readonly RepoAttribution[];
  readonly total: AuthorSplit;
  /** The previous window's fleet line share, when there was one to compare against. */
  readonly previousFleetLineShare?: number;
  /** Absent when there is nothing to compare against, or nothing to compare. */
  readonly trend?: AttributionTrend;
  /** Repos whose history this runner could not read. Named, never counted as zero. */
  readonly unavailable: readonly string[];
  /** False when no commit was seen at all — the difference between "none" and "nothing". */
  readonly measured: boolean;
}

export interface AttributeOptions {
  readonly identity: FleetIdentity;
  /** Commits inside the window being reported. */
  readonly commits: readonly AuthoredCommit[];
  /** Commits inside the window before it, for the trend. Absent means no comparison. */
  readonly previous?: readonly AuthoredCommit[];
  /** `owner/name` of repos the reader could not see. */
  readonly unavailable?: readonly string[];
}

/**
 * A share moves by less than this and it is called flat.
 *
 * A whole percentage point, because the denominator is one day of commits: a fleet that
 * wrote 74.6% yesterday and 75.1% today has not changed direction, and an arrow that
 * flips on rounding noise teaches a reader to ignore arrows.
 */
const FLAT_WITHIN = 0.01;

/** Split a window's commits by author, per repo and in total. */
export const attribute = (options: AttributeOptions): AttributionReport => {
  const fleetEmails = new Set(options.identity.emails.map((email) => email.toLowerCase()));
  const isFleet = (commit: AuthoredCommit): boolean =>
    fleetEmails.has(commit.authorEmail.toLowerCase());

  const byRepo = new Map<string, AuthoredCommit[]>();
  for (const commit of options.commits) {
    const existing = byRepo.get(commit.repo);
    if (existing === undefined) byRepo.set(commit.repo, [commit]);
    else existing.push(commit);
  }

  const repos = [...byRepo.entries()]
    .map(([repo, commits]) => ({ repo, ...split(commits, isFleet) }))
    .sort(byVolume);

  const total = split(options.commits, isFleet);
  const previous =
    options.previous === undefined ? undefined : split(options.previous, isFleet).fleetLineShare;

  return {
    repos,
    total,
    ...(previous === undefined ? {} : { previousFleetLineShare: previous }),
    ...trendOf(total.fleetLineShare, previous),
    unavailable: options.unavailable ?? [],
    measured: options.commits.length > 0,
  };
};

const split = (
  commits: readonly AuthoredCommit[],
  isFleet: (commit: AuthoredCommit) => boolean,
): AuthorSplit => {
  const fleet = { commits: 0, lines: 0 };
  const human = { commits: 0, lines: 0 };

  for (const commit of commits) {
    const side = isFleet(commit) ? fleet : human;
    side.commits += 1;
    side.lines += commit.insertions + commit.deletions;
  }

  return {
    fleet,
    human,
    ...shareOf("fleetCommitShare", fleet.commits, human.commits),
    ...shareOf("fleetLineShare", fleet.lines, human.lines),
  };
};

/**
 * `fleet / (fleet + human)`, or nothing when the denominator is zero.
 *
 * Keyed, so the caller spreads it: an absent share must be ABSENT rather than present and
 * zero, and returning `number | undefined` would put the decision at every call site.
 */
const shareOf = <Key extends string>(
  key: Key,
  fleet: number,
  human: number,
): Partial<Record<Key, number>> => {
  const whole = fleet + human;
  return whole === 0 ? {} : ({ [key]: fleet / whole } as Record<Key, number>);
};

/**
 * Busiest first: the repo where most happened is the one a reader wants at the top, and a
 * repo with one commit in it does not deserve the first line of the section.
 */
const byVolume = (a: RepoAttribution, b: RepoAttribution): number => {
  const lines = (entry: RepoAttribution): number => entry.fleet.lines + entry.human.lines;
  const commits = (entry: RepoAttribution): number => entry.fleet.commits + entry.human.commits;
  return lines(b) - lines(a) || commits(b) - commits(a) || a.repo.localeCompare(b.repo);
};

const trendOf = (
  now: number | undefined,
  before: number | undefined,
): { trend?: AttributionTrend } => {
  if (now === undefined || before === undefined) return {};
  const delta = now - before;
  if (Math.abs(delta) < FLAT_WITHIN) return { trend: "flat" };
  return { trend: delta > 0 ? "up" : "down" };
};
