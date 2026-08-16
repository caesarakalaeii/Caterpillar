/**
 * What the fleet did in one window, read out of the state repo's history. See DESIGN.md §19.
 *
 * Collected from GIT, not from the current `state.json`. A snapshot cannot answer the
 * question a digest asks: a task that ran four sessions today and one that has not moved
 * since Tuesday are indistinguishable in it, and every number it carries is a lifetime
 * total rather than a day's. So every figure here is a DELTA between the commit at the
 * window's start and the commit at its end — which also makes a catch-up digest correct,
 * because "the end of the window" is a commit rather than "now".
 *
 * Nothing here reaches the network and nothing here writes. The state checkout is already
 * up to date when this runs: the poll loop pulls before anything else.
 *
 * Tolerant by construction. A malformed `spec.md` costs a title, a missing `state.json`
 * costs one task, and neither fails the day — the digest exists to report a fleet that
 * includes broken tasks, and one that refused to render because of one is a digest that
 * goes missing exactly when it is most worth reading.
 */
import { parse as parseYaml } from "yaml";
import {
  asTaskId,
  goalHeadline,
  parseRepoRef,
  type RepoRef,
  type TaskId,
  type TaskPhase,
  type TaskState,
  type TaskStatus,
} from "../domain/task.ts";
import type { Git } from "../state/git.ts";
import type { DigestWindow } from "./day.ts";

/** Work that landed in one repo, as this runner's own mirror records it. */
export interface RepoChange {
  /** `owner/name`. */
  readonly repo: string;
  /** Commit subjects on the task branch, oldest first. */
  readonly commits: readonly string[];
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  /** Paths touched, bounded — enough to see the shape of the change. */
  readonly files: readonly string[];
}

/**
 * Reads the code a task actually produced.
 *
 * A separate interface because it is the one part of a digest that is NOT in the state
 * repo: it comes from a bare mirror on the runner's own disk, so a runner that never
 * worked a task cannot see its diff. `collectDay` therefore treats its absence as normal
 * and the digest declares it, rather than printing a zero that reads as "nothing changed".
 */
export interface ChangeReader {
  read(task: TaskId, repos: readonly RepoRef[]): Promise<readonly RepoChange[]>;
}

/** One task, as the window moved it. */
export interface TaskChange {
  readonly id: TaskId;
  /** The spec's first heading, or the id when there is no readable spec. */
  readonly title: string;
  /** Status at the window's start. Absent means the task was created inside it. */
  readonly from?: TaskStatus;
  readonly to: TaskStatus;
  readonly phase: TaskPhase;
  /** Sessions run inside the window — never the task's lifetime total. */
  readonly sessions: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly prUrl?: string;
  /** True when the pull request appeared inside the window. */
  readonly prOpened: boolean;
  readonly questionsAsked: number;
  readonly answersGiven: number;
  readonly verdicts: number;
  readonly noProgressStreak: number;
  /** Journal appended inside the window, bounded. The agent's own account of the day. */
  readonly journal?: string;
  /** Code this task produced, when this runner holds the mirror to prove it. */
  readonly changes: readonly RepoChange[];
  /** Set when the diff could not be read — names the repos, never pretends they were empty. */
  readonly changesUnavailable?: readonly string[];
}

/** A task still wanting something at the window's end, whether or not it moved. */
export interface OpenTask {
  readonly id: TaskId;
  readonly title: string;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  /** `updatedAt` as it stood at the cutoff — how long it has been like this. */
  readonly since: string;
  readonly prUrl?: string;
}

export interface DigestTotals {
  readonly sessions: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tasksTouched: number;
  /** Tasks that ENDED the window in each status, counted only where they moved. */
  readonly reached: Readonly<Partial<Record<TaskStatus, number>>>;
}

export interface DayDigest {
  /** `YYYY-MM-DD`, naming the local day the window ends on. */
  readonly date: string;
  readonly from: string;
  readonly to: string;
  readonly changed: readonly TaskChange[];
  readonly open: readonly OpenTask[];
  readonly totals: DigestTotals;
  /** True when nothing moved at all. A quiet day is still worth saying out loud. */
  readonly quiet: boolean;
  /**
   * Tasks whose records could not be read at all.
   *
   * Named rather than dropped. One malformed `state.json` must not cost the day — a digest
   * that throws is a digest that is retried and fails identically every poll — but a task
   * that vanishes from the report without explanation is exactly the one an operator needs
   * to know about.
   */
  readonly unreadable: readonly TaskId[];
}

export interface CollectOptions {
  /** Bound to the state repo checkout. Read-only use. */
  readonly git: Git;
  readonly window: DigestWindow;
  readonly changes?: ChangeReader;
}

/**
 * Journal kept per task, in code points.
 *
 * The journal is the richest evidence a digest has and the only unbounded one: a task that
 * parked twenty times in a retry storm can append hundreds of near-identical blocks
 * (DESIGN.md §4.1). The TAIL is kept rather than the head — the end of a day is what
 * explains where the task stands now.
 */
const JOURNAL_LIMIT = 4000;

export const collectDay = async (options: CollectOptions): Promise<DayDigest> => {
  const { git, window } = options;

  const from = await commitAt(git, window.start);
  const to = await commitAt(git, window.end);

  const empty: DayDigest = {
    date: window.date,
    from: window.start.toISOString(),
    to: window.end.toISOString(),
    changed: [],
    open: [],
    totals: {
      sessions: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      tasksTouched: 0,
      reached: {},
    },
    quiet: true,
    unreadable: [],
  };

  // Nothing had been committed by the window's end. A state repo younger than the digest
  // is the ordinary first-day case, not a failure.
  if (to === undefined) return empty;

  const present = await taskIdsAt(git, to);
  const exists = new Set<TaskId>(present);

  // Paths grouped by task. A task whose directory was touched but which no longer exists
  // at the window's end is skipped: nothing here can describe a task that is gone, and the
  // state repo does not delete them.
  const touched = new Map<TaskId, readonly string[]>();
  for (const path of await filesTouched(git, from, to)) {
    const id = taskOf(path);
    if (id === undefined || !exists.has(id)) continue;
    touched.set(id, [...(touched.get(id) ?? []), path]);
  }

  const changed: TaskChange[] = [];
  const open: OpenTask[] = [];
  const unreadable: TaskId[] = [];

  const collectOne = async (id: TaskId): Promise<void> => {
    const after = await readState(git, to, id);
    if (after === undefined) return;

    const spec = await blob(git, to, `tasks/${id}/spec.md`);
    const facts = specFacts(spec);
    const title = facts.title ?? id;

    if (isOpen(after.status)) {
      open.push({
        id,
        title,
        status: after.status,
        phase: after.phase,
        since: after.updatedAt,
        ...(after.pr === undefined ? {} : { prUrl: after.pr.url }),
      });
    }

    const paths = touched.get(id);
    if (paths === undefined) return;

    const before = from === undefined ? undefined : await readState(git, from, id);
    changed.push({
      id,
      title,
      ...(before === undefined ? {} : { from: before.status }),
      to: after.status,
      phase: after.phase,
      sessions: Math.max(after.sessions - (before?.sessions ?? 0), 0),
      costUsd: round(after.usage.costUsd - (before?.usage.costUsd ?? 0)),
      inputTokens: Math.max(after.usage.inputTokens - (before?.usage.inputTokens ?? 0), 0),
      outputTokens: Math.max(after.usage.outputTokens - (before?.usage.outputTokens ?? 0), 0),
      ...(after.pr === undefined ? {} : { prUrl: after.pr.url }),
      prOpened: after.pr !== undefined && before?.pr === undefined,
      questionsAsked: count(paths, /\/questions\/\d+-question\.md$/),
      answersGiven: count(paths, /\/questions\/\d+-answer\.md$/),
      verdicts: count(paths, /\/reviews\/\d+-verdict\.md$/),
      noProgressStreak: after.progress.noProgressStreak,
      ...(await journalOf(git, from, to, id)),
      ...(await changesOf(options.changes, id, facts.repos)),
    });
  };

  for (const id of present) {
    try {
      await collectOne(id);
    } catch {
      // A control record that parses but is not shaped like one — a hand-edited file, a
      // half-finished migration — costs this task and nothing else. Losing the day to it
      // would mean losing every day after it too: the collector is deterministic, so the
      // retry fails in exactly the same place, forever.
      unreadable.push(id);
    }
  }

  changed.sort(byInterest);
  open.sort(byUrgency);

  return {
    ...empty,
    changed,
    open,
    unreadable,
    totals: total(changed),
    quiet: changed.length === 0,
  };
};

/**
 * The last commit at or before `instant`.
 *
 * `--before` reads COMMITTER dates, which is what the supervisor stamps when it pushes, so
 * this is "the state repo as it stood at that moment". The state branch is rebased rather
 * than merged (`state/store.ts`), so its history is linear and `-1` is unambiguous.
 */
const commitAt = async (git: Git, instant: Date): Promise<string | undefined> => {
  const result = await git.tryRun("rev-list", "-1", `--before=${instant.toISOString()}`, "HEAD");
  const oid = result.stdout.trim();
  return result.code === 0 && oid !== "" ? oid : undefined;
};

/** File contents at a commit, or undefined when the path did not exist there. */
const blob = async (git: Git, commit: string, path: string): Promise<string | undefined> => {
  const result = await git.tryRun("show", `${commit}:${path}`);
  return result.code === 0 ? result.stdout : undefined;
};

const readState = async (
  git: Git,
  commit: string,
  id: TaskId,
): Promise<TaskState | undefined> => {
  const raw = await blob(git, commit, `tasks/${id}/state.json`);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as TaskState;
  } catch {
    // A half-written control record is one task the digest cannot describe, not a day it
    // cannot report.
    return undefined;
  }
};

/** Task directories present at a commit. */
const taskIdsAt = async (git: Git, commit: string): Promise<readonly TaskId[]> => {
  const result = await git.tryRun("ls-tree", "--name-only", `${commit}:tasks`);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((name) => name.trim().replace(/\/$/, ""))
    .filter((name) => name !== "")
    .map(asTaskId);
};

/**
 * Every path under `tasks/` the window touched.
 *
 * With no starting commit the window contains the repo's whole history, so everything
 * present counts as having appeared inside it.
 */
const filesTouched = async (
  git: Git,
  from: string | undefined,
  to: string,
): Promise<readonly string[]> => {
  const result =
    from === undefined
      ? await git.tryRun("ls-tree", "-r", "--name-only", to, "tasks/")
      : await git.tryRun("diff", "--name-only", from, to, "--", "tasks/");
  if (result.code !== 0) return [];
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
};

/** `tasks/<id>/...` → `<id>`. */
const taskOf = (path: string): TaskId | undefined => {
  const parts = path.split("/");
  return parts[0] === "tasks" && parts[1] !== undefined && parts[1] !== ""
    ? asTaskId(parts[1])
    : undefined;
};

const count = (paths: readonly string[], pattern: RegExp): number =>
  paths.filter((path) => pattern.test(path)).length;

/**
 * What the agent wrote in the journal inside the window.
 *
 * `journal.md` is append-only by design (DESIGN.md §4.1), so the window's entries are
 * exactly the suffix the earlier copy does not have — no parsing of session headings, and
 * nothing that breaks when their format changes. The prefix check is not a formality: if
 * the file ever stopped being append-only, taking a suffix blindly would attribute
 * rewritten history to today.
 */
const journalOf = async (
  git: Git,
  from: string | undefined,
  to: string,
  id: TaskId,
): Promise<{ journal?: string }> => {
  const after = await blob(git, to, `tasks/${id}/journal.md`);
  if (after === undefined) return {};

  const before = from === undefined ? undefined : await blob(git, from, `tasks/${id}/journal.md`);
  const added =
    before !== undefined && after.startsWith(before) ? after.slice(before.length) : after;

  const trimmed = added.trim();
  if (trimmed === "") return {};

  const points = [...trimmed];
  return {
    journal:
      points.length <= JOURNAL_LIMIT
        ? trimmed
        : `… (earlier entries omitted)\n${points.slice(-JOURNAL_LIMIT).join("")}`,
  };
};

const changesOf = async (
  reader: ChangeReader | undefined,
  id: TaskId,
  repos: readonly RepoRef[],
): Promise<{ changes: readonly RepoChange[]; changesUnavailable?: readonly string[] }> => {
  if (reader === undefined || repos.length === 0) return { changes: [] };

  const changes = await reader.read(id, repos).catch(() => []);
  const seen = new Set(changes.map((change) => change.repo));
  const missing = repos
    .map((repo) => `${repo.owner}/${repo.name}`)
    .filter((slug) => !seen.has(slug));

  return { changes, ...(missing.length === 0 ? {} : { changesUnavailable: missing }) };
};

/** Front matter facts, read leniently. A spec that will not parse costs a title. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const specFacts = (
  markdown: string | undefined,
): { readonly title?: string; readonly repos: readonly RepoRef[] } => {
  if (markdown === undefined) return { repos: [] };

  const match = FRONT_MATTER.exec(markdown);
  if (match === null) return { repos: [] };

  const title = goalHeadline(match[2] ?? "");

  let repos: readonly RepoRef[] = [];
  try {
    const meta = parseYaml(match[1] ?? "") as { readonly repos?: unknown } | null;
    const raw = Array.isArray(meta?.repos) ? meta.repos : [];
    repos = raw.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const parsed = parseRepoRef(entry);
      return parsed === undefined ? [] : [parsed];
    });
  } catch {
    /* a spec whose YAML will not parse still has a heading */
  }

  return { ...(title === undefined ? {} : { title }), repos };
};

/** Statuses that mean the task still wants something at the cutoff. */
const isOpen = (status: TaskStatus): boolean =>
  status === "awaiting-human" || status === "parked" || status === "running";

/** Terminal and human-blocking outcomes first — the lines an operator must not scroll past. */
const RANK: Readonly<Record<TaskStatus, number>> = {
  "awaiting-human": 0,
  done: 1,
  failed: 2,
  parked: 3,
  running: 4,
  ready: 5,
};

const byInterest = (a: TaskChange, b: TaskChange): number =>
  RANK[a.to] - RANK[b.to] || a.id.localeCompare(b.id);

/** Oldest first: a task that has been waiting three days outranks one waiting an hour. */
const byUrgency = (a: OpenTask, b: OpenTask): number =>
  RANK[a.status] - RANK[b.status] || a.since.localeCompare(b.since) || a.id.localeCompare(b.id);

const total = (changed: readonly TaskChange[]): DigestTotals => {
  const reached: Partial<Record<TaskStatus, number>> = {};
  for (const change of changed) reached[change.to] = (reached[change.to] ?? 0) + 1;

  return {
    sessions: changed.reduce((sum, change) => sum + change.sessions, 0),
    costUsd: round(changed.reduce((sum, change) => sum + change.costUsd, 0)),
    inputTokens: changed.reduce((sum, change) => sum + change.inputTokens, 0),
    outputTokens: changed.reduce((sum, change) => sum + change.outputTokens, 0),
    tasksTouched: changed.length,
    reached,
  };
};

/** Costs are subtracted, and binary floating point turns $3 into $2.9999999999999996. */
const round = (value: number): number => Math.max(Math.round(value * 10000) / 10000, 0);
