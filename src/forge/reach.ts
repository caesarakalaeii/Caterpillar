/**
 * Can this workspace's credential reach the repos a task names? See DESIGN.md §9.1.1.
 *
 * Every path that creates a task takes repo names from a human or from an agent — a
 * Discord `/brainstorm`, an `agent` block in an issue, a plan the previous session wrote.
 * `assertWorkspaceScope` bounds which repos are ALLOWED, and `parseRepoRef` bounds which
 * strings are shaped like one, but nothing asked whether the credential can actually
 * reach them. So the answer arrived at the worst possible moment — `git clone --mirror`,
 * inside a session, as:
 *
 *     caterpillar-cred: GitHub /app/installations/…/access_tokens failed with 422:
 *       the App is not installed on one of the requested repositories
 *     fatal: could not read Username for 'https://github.com/…': terminal prompts disabled
 *
 * — a task parked on a git exit code, one session spent, and nothing in the message
 * naming the repo at fault.
 *
 * The most common cause is not a missing installation at all: it is a NAME. Someone types
 * `caesarakalaeii/allchat` for a repo called `all-chat`, and GitHub answers the mint with
 * the same 422 for a repo that does not exist as for one the App cannot see — so the mint
 * cannot tell the operator which of the two it is, and the useful reply ("did you mean
 * all-chat?") needs the installation's repo list rather than the mint's refusal.
 *
 * Hence this: the question is asked at the DOOR, where the answer can name the repo,
 * offer the near miss, and cost a refusal instead of a session.
 *
 * It is not a security boundary and must never be treated as one — `assertWorkspaceScope`
 * is that (§9.1), and it is checked at the mint regardless of anything here. This is a
 * usability check: it turns a mid-session git failure into a sentence typed back at the
 * person who named the repo.
 */
import { repoSlug, type RepoRef } from "../domain/task.ts";

/** A repo a workspace's credential cannot reach, and the sentence that says why. */
export interface UnreachableRepo {
  readonly repo: RepoRef;
  /**
   * Human-facing and self-contained: it names the repo, so it reads correctly in a
   * Discord reply, a park reason and a tracker comment without a caller adding context.
   */
  readonly reason: string;
}

/**
 * Asks a forge which of the named repos its credential cannot reach.
 *
 * Implemented by `ForgeFactory` — one per workspace, which is the unit a credential
 * belongs to. Consumers that only ask the question (the supervisor's brainstorm door,
 * intake) depend on this rather than on the whole factory.
 *
 * MUST throw rather than report a repo unreachable when the forge cannot be asked. A
 * refusal is a durable decision that stops work; a 500 or a DNS failure is not evidence
 * about an installation, and callers fail open on a throw deliberately.
 */
export interface RepoReach {
  unreachable(repos: readonly RepoRef[]): Promise<readonly UnreachableRepo[]>;
}

/**
 * Every repo a credential can reach, `owner/name`, as the forge spells them.
 *
 * The other half of the same idea: `RepoReach` judges a name somebody typed, this one
 * stops them having to type it. `/brainstorm`'s `repo:` option is autocompleted from it,
 * which is the only version of this check a human never notices — a name that cannot be
 * reached is a name that was never offered.
 *
 * Empty is a legitimate answer and must not read as an error: a forge that cannot
 * enumerate (a Forgejo repository-scoped token cannot) returns what it knows, and an empty
 * catalogue simply means the box behaves as it always did and the door checks still bite.
 */
export interface RepoCatalog {
  reachable(): Promise<readonly string[]>;
}

/**
 * The reasons joined into one paragraph.
 *
 * Each reason already names its own repo, so this is a join and not a list: two
 * unreachable repos read as two sentences, which is what a Discord reply and a park
 * reason both want.
 */
export const unreachableSummary = (repos: readonly UnreachableRepo[]): string =>
  repos.map((entry) => entry.reason).join(" ");

/**
 * Everything a human might type differently for the same repo, collapsed.
 *
 * `-`, `_` and `.` are interchangeable in practice (`all-chat`, `all_chat`, `allchat`)
 * and case never survives being retyped, so a name that squashes to the same string is
 * the same name for the purpose of a suggestion.
 */
const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Levenshtein distance, bounded.
 *
 * Bounded because the only question asked of it is "is this within N edits", and an
 * unbounded distance over a 65-repo installation is 65 full matrices to answer it. Two
 * rows rather than a matrix for the same reason.
 */
const withinDistance = (a: string, b: string, limit: number): number | undefined => {
  if (Math.abs(a.length - b.length) > limit) return undefined;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    // Every entry in the row is already >= limit, so no completion of it can come back
    // under — stop rather than finish a matrix whose answer is known.
    if (Math.min(...current) > limit) return undefined;
    previous = current;
  }

  const total = previous[b.length] ?? Number.MAX_SAFE_INTEGER;
  return total <= limit ? total : undefined;
};

/**
 * How far off a name may be and still be offered as "did you mean".
 *
 * Scaled by length, capped at 3: one edit in `api` is a different repo, three in
 * `streamer-shield-bot` is a typo. A suggestion that is wrong costs a human one glance;
 * one that is absent costs them the settings page of an installation that was fine.
 */
const editBudget = (name: string): number => Math.max(1, Math.min(3, Math.floor(name.length / 4)));

/**
 * The reachable repo closest to what was asked for, when one is close enough.
 *
 * `candidates` are `owner/name` slugs exactly as the forge spells them, so a suggestion
 * can be copied straight back into the command that failed.
 *
 * Ranked rather than first-match, and the ranking is the part that matters:
 *
 *   1. the same slug once squashed — `acme/AllChat` for `acme/all-chat`
 *   2. the same NAME once squashed, under a different owner — `caesar/all-chat` for
 *      `caesarakalaeii/all-chat`, because an owner shorthand is as common as a typo and
 *      refusing without the suggestion sends the human to an installation page that was
 *      never the problem
 *   3. a name within `editBudget` edits — `widgot` for `widget`
 *
 * An exact match yields undefined: an exact match is not unreachable, and suggesting a
 * repo the caller already named would read as nonsense.
 */
const closest = (
  wanted: { readonly slug?: string; readonly name: string },
  candidates: readonly string[],
): string | undefined => {
  const wantedSlug = wanted.slug === undefined ? undefined : squash(wanted.slug);
  const wantedName = squash(wanted.name);
  const budget = editBudget(wanted.name);

  let best: { readonly slug: string; readonly score: number } | undefined;
  for (const candidate of candidates) {
    const name = candidate.slice(candidate.indexOf("/") + 1);
    // What "exact" means depends on what was asked. A mint request carries bare names
    // (§9.1), so there the name alone identifies the repo; a slug identifies it including
    // the owner.
    const exact =
      wanted.slug === undefined
        ? name.toLowerCase() === wanted.name.toLowerCase()
        : candidate === wanted.slug;
    if (exact) return undefined;

    const squashedName = squash(name);
    const score =
      wantedSlug !== undefined && squash(candidate) === wantedSlug
        ? 0
        : squashedName === wantedName
          ? 1
          : distanceScore(wanted.name, name, budget);

    if (score === undefined) continue;
    // Strictly better only, so a tie keeps the forge's own ordering rather than whichever
    // was scanned last.
    if (best === undefined || score < best.score) best = { slug: candidate, score };
  }

  return best?.slug;
};

const distanceScore = (wanted: string, candidate: string, budget: number): number | undefined => {
  const edits = withinDistance(wanted.toLowerCase(), candidate.toLowerCase(), budget);
  return edits === undefined ? undefined : 2 + edits;
};

/** `closest` for a repo reference — the door checks, where the owner is known. */
export const nearestSlug = (repo: RepoRef, candidates: readonly string[]): string | undefined =>
  closest({ slug: repoSlug(repo), name: repo.name }, candidates);

/**
 * `closest` for a bare repo name — what a mint 422 has to work with.
 *
 * `POST /app/installations/{id}/access_tokens` takes `repositories` as NAMES, so when it
 * refuses, the owner is not part of what it refused. Matching on the name is therefore not
 * a shortcut here; it is all the request contained.
 */
export const nearestName = (name: string, candidates: readonly string[]): string | undefined =>
  closest({ name }, candidates);

/**
 * Discord's ceiling on an autocomplete response. Exceeding it is a 400 for the WHOLE
 * response, which the client renders as no suggestions at all.
 */
const MAX_CHOICES = 25;

/**
 * The repos worth suggesting for what has been typed so far, best first.
 *
 * Forgiving in exactly the way the incident was. Ranked:
 *
 *   1. the slug starts with the query — the ordinary case, `caesarakalaeii/all` narrowing
 *   2. the query appears in it — `chat` finding `all-chat` without the owner
 *   3. the SQUASHED query appears in the squashed slug — this is the one that matters:
 *      `allchat` finds `all-chat` while it is still being typed, so the name that caused
 *      a parked task is never a name that can be committed to
 *   4. a name within `editBudget` edits — `all-chta` for `all-chat`
 *
 * An empty query lists the catalogue rather than nothing: an empty suggestion box is
 * indistinguishable from a bot that has stopped working, and the first thing typed into
 * `repo:` is an owner that every candidate shares anyway.
 *
 * Ties keep the forge's own ordering, so the list does not reshuffle between keystrokes.
 */
export const rankRepos = (
  query: string,
  candidates: readonly string[],
  limit = MAX_CHOICES,
): readonly string[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return candidates.slice(0, limit);

  const wanted = trimmed.toLowerCase();
  const squashed = squash(trimmed);

  const scored: { readonly slug: string; readonly score: number; readonly at: number }[] = [];
  candidates.forEach((candidate, at) => {
    const slug = candidate.toLowerCase();
    const name = candidate.slice(candidate.indexOf("/") + 1);
    const score = slug.startsWith(wanted)
      ? 0
      : slug.includes(wanted)
        ? 1
        : squashed.length > 0 && squash(candidate).includes(squashed)
          ? 2
          : withinDistance(wanted, name.toLowerCase(), editBudget(trimmed)) === undefined
            ? undefined
            : 3;
    if (score !== undefined) scored.push({ slug: candidate, score, at });
  });

  return scored
    .sort((a, b) => (a.score === b.score ? a.at - b.at : a.score - b.score))
    .slice(0, limit)
    .map((entry) => entry.slug);
};
