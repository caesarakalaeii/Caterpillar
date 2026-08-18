/**
 * How much of the work volume this runner has actually used, by category.
 *
 * The complaint this exists to answer was "the scaling mechanisms use so much disk
 * space", and nothing in the supervisor could say where the disk went. Metrics knew about
 * tokens, sessions and leases; the web view knew about tasks and configuration; the
 * volume that a fleet of four fills with mirrors, worktrees and a nix store was measured
 * by nobody. A disk that runs out with no series to point at is an outage explained after
 * the fact by whoever happens to run `df` — which is what the next section is for.
 *
 * Four numbers, and they are deliberately different KINDS of number:
 *
 *   `fs`        what the filesystem holding the work root says about itself: total and
 *               free. Cheap — one `statfs` — and the only figure that includes what
 *               ANOTHER process on the same volume is using.
 *   `mirrors`   the bare clones under `paths.mirrors`, per repo. Grows with the number of
 *               repos the fleet has ever touched and never shrinks on its own.
 *   `tasks`     the per-task worktrees under `paths.tasks`, per task. This is the one
 *               that surprises people: a checked-out `node_modules` is hundreds of
 *               megabytes and there is one per task, kept after the session ends so the
 *               next session can resume into it.
 *   `nix`       the store the `ToolchainResolver` builds environments into. Collected on
 *               its own schedule (`toolchain.maybeCollectGarbage`), so the interesting
 *               question about it is whether the collection is keeping up.
 *
 * READ ONLY, without exception. Nothing in this file opens a file for writing, unlinks,
 * renames or moves anything, and nothing it calls does either — it stats and it reads
 * directory entries. A measurement that could delete is a measurement nobody dares run
 * hourly.
 *
 * APPARENT size, not allocated. Every byte here is `Stats.size`, the length of the file,
 * and NOT `blocks * 512`. The two differ in both directions and the difference is worth
 * knowing before reading a graph: a sparse file or one stored inline reports more apparent
 * than allocated bytes, while a directory full of small files costs more allocated than
 * apparent (a 10-byte file still occupies a block). Apparent size is what `du --apparent-size`
 * shows and what a human means by "this checkout is 400 MB"; allocated size is what
 * actually fills the volume. Apparent wins here because these numbers exist to be
 * ATTRIBUTED — "which task is big" — while the "is the volume full" question is answered
 * exactly by `fs.freeBytes`, which is measured from the filesystem itself and needs no
 * summing at all. Reporting both would double the walk's bookkeeping to make two graphs
 * that move together.
 *
 * Hard links are counted once per path they appear under, which matters for exactly one
 * consumer: a nix store is full of them, so `nix` here is an upper bound on what
 * collecting the store would free. Deduplicating would mean holding every inode number
 * seen in a Set for the length of the walk, which on a store with a million paths is a
 * memory cost paid on every pass to sharpen a number that is already only a hint.
 */
import { readdir, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageConfig } from "../config/types.ts";

/** One directory that was measured — a mirror repo, or a task's worktree. */
export interface UsageEntry {
  /** `owner/name` for a mirror, the task id for a task. Never an absolute path. */
  readonly name: string;
  readonly bytes: number;
}

/** What the filesystem holding the work root says about itself. */
export interface FilesystemUsage {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

export interface WorkspaceUsage {
  /** ISO 8601, stamped when the walk STARTED — see `UsageMonitor.measure`. */
  readonly measuredAt: string;
  /** Wall clock the walk took. The thing to watch when tuning the deadline. */
  readonly durationMs: number;
  /**
   * True when the deadline stopped the walk before it had seen everything.
   *
   * A partial measurement is reported rather than discarded: an under-count with a flag
   * on it is still enough to see which task is growing, and throwing away twenty seconds
   * of work because the twenty-first was needed would leave the operator with nothing at
   * exactly the moment the volume is most full (a fuller volume means more to walk).
   */
  readonly partial: boolean;
  readonly fs: FilesystemUsage;
  /** Bytes under `paths.mirrors`, the sum of `mirrors`. */
  readonly mirrorBytes: number;
  /** Bytes under `paths.tasks`, the sum of `tasks`. */
  readonly taskBytes: number;
  /** Bytes under the nix store. 0 on a runner with no nix. */
  readonly nixBytes: number;
  /**
   * What the work root holds that is neither mirrors nor tasks — the state repo checkout,
   * the LLM credential file, whatever an operator left there. Present because its absence
   * is what makes a total misleading: a work root that is 90% full with `mirrors` and
   * `tasks` accounting for 20% of it is a fact somebody needs, and without this bucket it
   * looks like a measurement bug rather than a directory nobody thought about.
   */
  readonly otherBytes: number;
  /** Per-mirror, largest first. Capped — see `TOP_N`. */
  readonly mirrors: readonly UsageEntry[];
  /** Per-task, largest first. Capped — see `TOP_N`. */
  readonly tasks: readonly UsageEntry[];
}

export interface UsageOptions {
  /**
   * The filesystem `statfs` is asked about, and the root `otherBytes` is measured
   * relative to. Normally the parent both `mirrors` and `tasks` live under.
   */
  readonly workRoot: string;
  readonly mirrorsDir: string;
  readonly tasksDir: string;
  /**
   * The nix store, or undefined on a runner with no nix. `nixStoreDir` derives it.
   *
   * Usually NOT under `workRoot`: the image mounts a volume at `/nix` and the store lives
   * there, which is why it is a category of its own rather than part of `otherBytes`.
   */
  readonly nixStoreDir?: string | undefined;
  /**
   * Wall-clock ceiling on the whole measurement. Reaching it sets `partial`.
   *
   * A ceiling rather than a promise to be quick: the walk is proportional to inode count,
   * a worktree with `node_modules` is hundreds of thousands of inodes, and there is one
   * worktree per task. On a cold page cache this is minutes, and the supervisor's poll
   * loop is single-threaded — every millisecond spent here is a millisecond no task is
   * claimed in.
   */
  readonly deadlineMs?: number;
  /** Injectable for the tests, which must be able to make the deadline fire. */
  readonly now?: () => number;
}

/**
 * How many mirrors and how many tasks get a series of their own.
 *
 * A cap, because this feeds Prometheus labels and a label value that comes from a task id
 * is unbounded: the fleet creates tasks continuously, worktrees are kept after a session
 * ends, and nothing prunes them — so an uncapped per-task gauge grows one time series per
 * task the runner has EVER worked, forever, in a registry that has no expiry. That is the
 * standard way a small exporter takes a Prometheus down.
 *
 * The top N by size plus a remainder bucket loses nothing anyone asked for. The question
 * this breakdown answers is "what is eating the volume", and something in twelfth place by
 * size is by definition not the answer; the bucket keeps the sum honest so the categories
 * still add up.
 */
export const TOP_N = 10;

/** Default ceiling: generous enough to finish, short enough to be an interruption. */
export const DEFAULT_DEADLINE_MS = 120_000;

/**
 * Defaults for `usage` in the runner config.
 *
 * Here rather than inline in `config/load.ts` for the reason `DEFAULT_TOOLCHAIN_CONFIG`
 * gives: the numbers sit next to the code that has to live with them, so the deadline is
 * read next to the walk it bounds.
 *
 * ON by default, unlike the web view and the digest. Those two publish — to a shared
 * channel, to a shared repo — so a runner has to be told to do them. This one reads its
 * own disk, once an hour, and tells nobody but its own metrics endpoint; a runner that
 * had to be told would be a runner whose disk complaint is still unmeasurable by default,
 * which is the whole thing this is here to fix.
 */
export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  intervalHours: 1,
  deadlineSeconds: DEFAULT_DEADLINE_MS / 1000,
};

/**
 * The volume `mirrors` and `tasks` sit on, when nothing says.
 *
 * Their common parent, which in every shipped configuration is `/work` — the directory
 * the PVC is mounted at. Falls back to the tasks directory itself when the two share no
 * parent, which is a configuration nobody has but which must still produce a path rather
 * than a guess at `/`: measuring the root filesystem of a container would report the
 * image's free space as the work volume's, and be wrong in the reassuring direction.
 */
export const defaultWorkRoot = (mirrorsDir: string, tasksDir: string): string => {
  const parent = dirname(mirrorsDir);
  return parent === dirname(tasksDir) ? parent : tasksDir;
};

/**
 * Where nix keeps its store, as this process would find it.
 *
 * `NIX_STORE_DIR` is honoured because nix honours it, and `/nix/store` is the answer
 * everywhere it is not set — the image COPYs the store to exactly that path and the
 * cluster mounts a PVC over it (Dockerfile, "left exactly where nix expects it").
 *
 * Returns a path whether or not anything is there. A runner with no nix simply measures a
 * directory that does not exist, which `directoryBytes` reports as 0 — see the note there
 * on why a missing directory is not an error.
 */
export const nixStoreDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env["NIX_STORE_DIR"] ?? "/nix/store";

/**
 * Measure the work volume once. Never throws.
 *
 * Every failure mode is an under-count with the rest of the answer intact: a directory
 * that vanished mid-walk (a worktree removed under it), a permission denied, a filesystem
 * that will not answer `statfs`. This is observability, and observability that can fail a
 * poll is worse than no observability at all — see the call site in `supervisor/loop.ts`.
 */
export const measureUsage = async (options: UsageOptions): Promise<WorkspaceUsage> => {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const budget: Budget = { deadline, now, expired: false };

  const fs = await filesystemUsage(options.workRoot);

  const mirrors = await entryBytes(options.mirrorsDir, await mirrorLeaves(options.mirrorsDir, "", budget), mirrorName, budget);
  const tasks = await entryBytes(options.tasksDir, await taskLeaves(options.tasksDir, budget), (name) => name, budget);
  const nixBytes =
    options.nixStoreDir === undefined ? 0 : await directoryBytes(options.nixStoreDir, budget);

  const mirrorBytes = total(mirrors);
  const taskBytes = total(tasks);
  const rootBytes = await directoryBytes(options.workRoot, budget, [
    options.mirrorsDir,
    options.tasksDir,
  ]);

  return {
    measuredAt: new Date(started).toISOString(),
    durationMs: Math.max(0, now() - started),
    partial: budget.expired,
    fs,
    mirrorBytes,
    taskBytes,
    nixBytes,
    // Clamped at 0: the two walks are not simultaneous, so a worktree created between them
    // can make the parts exceed the whole. A negative "other" reads as a bug in the
    // measurement rather than as the race it is.
    otherBytes: Math.max(0, rootBytes),
    mirrors: largest(mirrors),
    tasks: largest(tasks),
  };
};

/**
 * The top N entries by size, with everything below them summed into one.
 *
 * The remainder is named `other` for the same reason the category is: a breakdown whose
 * parts do not add up to its total is a breakdown people stop trusting. Omitted entirely
 * when nothing was truncated, so a fleet with three mirrors does not grow an empty row.
 */
export const largest = (entries: readonly UsageEntry[], limit = TOP_N): readonly UsageEntry[] => {
  const sorted = [...entries].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit);
  const rest = total(sorted.slice(limit));
  return rest === 0 ? head : [...head, { name: OTHER, bytes: rest }];
};

/** The remainder bucket's name, shared by the metric labels and the web view. */
export const OTHER = "other";

const total = (entries: readonly UsageEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.bytes, 0);

/** The deadline, carried through the walk so one expiry stops all of it. */
interface Budget {
  readonly deadline: number;
  readonly now: () => number;
  expired: boolean;
}

const expired = (budget: Budget): boolean => {
  if (budget.expired) return true;
  if (budget.now() < budget.deadline) return false;
  budget.expired = true;
  return true;
};

/**
 * Total and free bytes of the filesystem holding `path`.
 *
 * `bavail` rather than `bfree` for free space: `bfree` counts the blocks reserved for
 * root, which a supervisor running as `node` can never have. Reporting them would make
 * the graph say there are gigabytes left at the moment writes start failing.
 *
 * Zeroes when the path does not exist or the call fails, which is the same convention the
 * walk uses — a filesystem that cannot be measured must not take a poll with it.
 */
const filesystemUsage = async (path: string): Promise<FilesystemUsage> => {
  try {
    const stats = await statfs(path);
    return {
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
};

/** `github.com/acme/widget.git` → `acme/widget`. The host is the same for every mirror. */
const mirrorName = (relative: string): string =>
  relative.split("/").slice(1).join("/").replace(/\.git$/, "");

/** Each named subtree of `parent`, measured on its own and labelled by `name`. */
const entryBytes = async (
  parent: string,
  leaves: readonly string[],
  name: (relative: string) => string,
  budget: Budget,
): Promise<readonly UsageEntry[]> => {
  const entries: UsageEntry[] = [];
  for (const relative of leaves) {
    entries.push({
      name: name(relative),
      bytes: await directoryBytes(join(parent, relative), budget),
    });
  }
  return entries;
};

/**
 * The mirrors under `parent`, relative to it.
 *
 * Mirrors nest three deep — `<host>/<owner>/<name>.git`, see `mirrorPath` in
 * `worktree.ts` — so the interesting unit is not a direct child. Found by descending
 * until a directory ends in `.git`, which is what a mirror IS on this volume, rather than
 * by counting to three: the depth is `worktree.ts`'s to change and a hard-coded 3 here
 * would silently report zero mirrors the day it did.
 */
const mirrorLeaves = async (
  parent: string,
  relative: string,
  budget: Budget,
): Promise<readonly string[]> => {
  if (expired(budget)) return [];

  const children = await readdir(join(parent, relative), { withFileTypes: true }).catch(() => []);
  const leaves: string[] = [];

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const path = relative === "" ? child.name : `${relative}/${child.name}`;
    if (child.name.endsWith(".git")) leaves.push(path);
    else leaves.push(...(await mirrorLeaves(parent, path, budget)));
  }
  return leaves;
};

/** The task worktrees under `parent`: one directory per task id, exactly one level down. */
const taskLeaves = async (parent: string, budget: Budget): Promise<readonly string[]> => {
  if (expired(budget)) return [];
  const children = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return children.filter((child) => child.isDirectory()).map((child) => child.name);
};

/**
 * Apparent bytes under `path`, excluding anything in `skip`.
 *
 * Iterative rather than recursive, with an explicit stack. A worktree can nest deeper than
 * anyone expects — `node_modules` inside `node_modules` — and a recursive walk on a
 * hostile tree is a stack overflow, which in this process is a crash rather than a bad
 * number.
 *
 * `lstat` semantics, via `withFileTypes` plus a non-following `stat` on files only:
 * symlinks are counted as the link and never followed. Following them would double-count
 * every store path a `dev-profile` GC root points at, and a symlink loop would make the
 * walk run until the deadline every single time.
 *
 * A missing directory is 0, not an error. `paths.mirrors` does not exist until the first
 * task clones something, `/nix/store` does not exist on a runner without nix, and both are
 * ordinary configurations rather than faults — reporting them as failures would put a
 * warning in the log of every healthy runner that has not worked a task yet.
 */
const directoryBytes = async (
  path: string,
  budget: Budget,
  skip: readonly string[] = [],
): Promise<number> => {
  const excluded = new Set(skip);
  const stack: string[] = [path];
  let bytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (expired(budget)) return bytes;

    const children = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const childPath = join(current, child.name);
      if (excluded.has(childPath)) continue;

      if (child.isDirectory()) {
        stack.push(childPath);
        continue;
      }
      // Symlinks, sockets, fifos and device nodes are all "not a regular file": each costs
      // a directory entry and no data of its own, so counting them as 0 is right and
      // stat-ing them is a syscall spent to learn that.
      if (!child.isFile()) continue;

      // Not `stat` on the Dirent: `Dirent` carries no size, so one `stat` per file is
      // unavoidable and IS the cost of this walk. `.catch` because a file the agent
      // deleted between the readdir and here is normal, not exceptional.
      const stats = await stat(childPath).catch(() => undefined);
      if (stats !== undefined) bytes += stats.size;
    }
  }
  return bytes;
};

/**
 * Runs the measurement on its own slow schedule, and remembers the last answer.
 *
 * The rate limit is `ToolchainResolver.maybeCollectGarbage`'s, deliberately down to the
 * detail that the FIRST call only starts the clock: a runner crash-looping every few
 * minutes would otherwise pay a full walk of the volume on every boot, which is the worst
 * possible moment to spend minutes of the poll loop on statistics.
 *
 * The last snapshot is held in memory and served to the web view. In memory rather than
 * committed to the state repo because it is a statement about THIS runner's volume: two
 * replicas have two different disks, and a shared file would have them overwrite each
 * other's answer with numbers that are not comparable.
 */
export class UsageMonitor {
  private readonly options: UsageOptions;
  private readonly intervalMs: number;
  /**
   * True when `intervalHours` is 0 or less, which turns the whole thing OFF.
   *
   * Off rather than "as often as possible", which is what a zero interval would
   * otherwise mean and is the one setting that could actually hurt: a walk on every idle
   * poll is a walk every `pollSeconds`, and the walk is the expensive thing here. An
   * operator reaching for 0 is asking for less, never for more.
   */
  private readonly disabled: boolean;
  /** 0 until the first idle poll — see `maybeMeasure`. */
  private lastMeasuredAt = 0;
  private snapshot: WorkspaceUsage | undefined;
  private readonly now: () => number;

  constructor(options: UsageOptions & { readonly intervalHours: number }) {
    this.options = options;
    this.disabled = !(options.intervalHours > 0);
    this.intervalMs = Math.max(0, options.intervalHours) * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** The last measurement, or undefined before the first one has completed. */
  current(): WorkspaceUsage | undefined {
    return this.snapshot;
  }

  /**
   * Measure, if it is time. Returns the fresh snapshot, or undefined when it was not.
   *
   * Called ONLY from the supervisor's idle branch, next to the store collection and for
   * the same reason: this walk competes for the same single thread and the same page cache
   * as whatever a session is doing, and there is always another idle poll. Running it
   * mid-session would slow the session down to answer a question nobody is asking at that
   * moment.
   */
  async maybeMeasure(): Promise<WorkspaceUsage | undefined> {
    if (this.disabled) return undefined;
    const now = this.now();
    if (this.lastMeasuredAt === 0) {
      this.lastMeasuredAt = now;
      return undefined;
    }
    if (now < this.lastMeasuredAt + this.intervalMs) return undefined;
    // Stamped BEFORE the walk, like intake's: a walk that somehow throws must still wait
    // out the interval rather than be retried on the next poll.
    this.lastMeasuredAt = now;

    const measured = await measureUsage(this.options);
    this.snapshot = measured;
    return measured;
  }
}
