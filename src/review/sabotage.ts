/**
 * What the sabotage reviewer needs that the other four do not: somewhere to write, and a
 * ceiling on how much it may run. See DESIGN.md §12.1 for the council itself.
 *
 * The four existing lenses share the task's worktree safely because none of them can
 * write — their tool surface is `read`, `bash`, `submit_verdict`. The sabotage lens
 * deliberately breaks the changed source and then runs the acceptance commands, to find
 * out empirically whether the tests notice. So it cannot share that worktree: the other
 * four are reading it concurrently, and a reviewer that finds a tracked file replaced by
 * `throw new Error("sabotaged")` will report on THAT rather than on the change.
 *
 * Hence a private copy. Two things about it are load-bearing and neither is obvious:
 *
 *   - it lives BESIDE the checkout, under `<taskDir>/.caterpillar/`, because a copy inside
 *     the checkout would show up in the original's `git status` as an untracked directory
 *     — nothing adds it to `.gitignore` or `info/exclude` — which is exactly what the
 *     other four must not see;
 *   - it is made into a git checkout by rewriting pointer files, never by
 *     `git worktree add`, because registering it would write into a mirror that other
 *     tasks fetch from and would leave a record behind for `git worktree prune` to find.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ExecutionError } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import type { Logger } from "../obs/log.ts";
import { BoundedExecutionEnv, type BoundedExecutionEnvOptions } from "../agent/exec.ts";
import { assertInside } from "../workspace/worktree.ts";

export interface PrepareOptions {
  /** `<tasksDir>/<task>/<repo.name>` — the worktree the other four reviewers read. */
  readonly checkoutRoot: string;
  /** `<tasksDir>/<task>`, the PARENT of `checkoutRoot`. Asserted, not trusted. */
  readonly taskDir: string;
  /** Refuse the copy below this much free space. 0 means no floor. */
  readonly minFreeGb: number;
  readonly logger: Logger;
  readonly task: string;
  readonly signal?: AbortSignal;
}

export type PrepareResult =
  | {
      readonly ok: true;
      /** The copy's root. A working git checkout the reviewer may write in. */
      readonly path: string;
      readonly cleanup: () => Promise<void>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Where the copy goes, relative to the task directory.
 *
 * `ToolchainResolver.materialise` already writes `<tasksDir>/<task>/.caterpillar`, and
 * `removeTaskWorktrees` reaps the whole `<tasksDir>/<task>` directory naming that path as
 * one of the things it has to take with it. So this location is already understood by the
 * reaper and needs nothing added to it.
 */
const COPY_SEGMENTS = [".caterpillar", "sabotage"] as const;

/**
 * The copy's administrative git directory, inside the copy.
 *
 * Not `.git` — that stays a FILE pointing here, which is the shape a linked worktree
 * already has, so git needs no persuading. The copy's own `git status` reports this
 * directory as untracked; that is visible only to the sabotage reviewer, whose whole job
 * is editing files in here, and hiding it would mean either writing to the mirror's shared
 * `info/exclude` (which the other four worktrees read) or inventing a `core.excludesFile`
 * that a later reader would have to work out the purpose of.
 */
const COPY_GIT_DIR = ".caterpillar-git";

/** `cp -a` of one checkout. Long, because a cold page cache on a big worktree is slow. */
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

const GIB = 1024 ** 3;

/**
 * Make a private, writable copy of a task's checkout. Never throws for an expected refusal.
 *
 * `{ ok: false }` covers the two things that legitimately go wrong — no disk, and a `cp`
 * that failed — because the caller's answer to both is the same: run the council without
 * this lens. The only exception it raises is for `taskDir` not being the checkout's parent,
 * which is a programmer error: a copy under the wrong parent is never reaped, so it would
 * leak a whole worktree per review round, silently.
 */
export const prepareSabotageCopy = async (options: PrepareOptions): Promise<PrepareResult> => {
  const { checkoutRoot, taskDir, logger, task } = options;

  if (resolve(dirname(checkoutRoot)) !== resolve(taskDir)) {
    throw new Error(
      `refusing to prepare a sabotage copy: ${taskDir} is not the parent of ${checkoutRoot}`,
    );
  }

  const destination = join(taskDir, ...COPY_SEGMENTS);
  const parent = dirname(destination);

  const refuse = (reason: string): PrepareResult => {
    logger.warn("sabotage.refused", { task, reason });
    return { ok: false, reason };
  };

  const started = Date.now();

  if (options.minFreeGb > 0) {
    // The floor comes from the caller and is deliberately NOT `config.toolchain.minFreeGb`:
    // that is the nix store's GC threshold, written into `nix.conf` as `min-free`, where 0
    // is a documented off switch. Reusing it would silently disable this check on every
    // runner that has store collection turned off.
    // `statfs` needs a path that EXISTS, and `.caterpillar` may not yet — a task whose
    // toolchain resolved to the inherited environment never creates it. The task directory
    // is on the same filesystem and always there, so it answers the same question.
    const free = await freeBytes(existsSync(parent) ? parent : taskDir);
    const floor = options.minFreeGb * GIB;
    if (free < floor) {
      return refuse(
        `not enough disk for a sabotage copy: ${free} bytes free, ${floor} required`,
      );
    }
  }

  // A previous round's copy, or one a crash left behind. Removed before the new one is
  // built rather than after, so a stale copy never survives a failure below.
  await removeCopy(destination, taskDir);
  await mkdir(parent, { recursive: true });

  // Copy to a temporary sibling and rename, for two reasons that both come down to `cp`'s
  // limits: GNU `cp` has no `--exclude` (and rsync is in neither flake.nix nor the
  // Dockerfile), so copying `checkoutRoot` straight to a destination beneath it would
  // recurse into its own output; and a copy interrupted halfway leaves a directory that
  // looks exactly like a finished one. `rename` is atomic within the filesystem, so the
  // destination either does not exist or is complete.
  const staging = join(parent, `sabotage.${process.pid}.${Date.now()}`);
  const copied = await copyTree(checkoutRoot, staging, options.signal);
  if (copied !== undefined) {
    await rm(staging, { recursive: true, force: true });
    return refuse(`could not copy ${checkoutRoot}: ${copied}`);
  }

  // Written against the FINAL path while the files are still in staging: every pointer git
  // reads is absolute, so rewriting them to `staging` would leave a checkout that stops
  // being a repository the moment it is renamed into place.
  const linked = await relinkGitDir(checkoutRoot, staging, destination);
  if (linked !== undefined) {
    await rm(staging, { recursive: true, force: true });
    return refuse(linked);
  }

  await rename(staging, destination);

  logger.info("sabotage.copied", {
    task,
    path: destination,
    elapsedMs: Date.now() - started,
  });

  return {
    ok: true,
    path: destination,
    cleanup: () => removeCopy(destination, taskDir),
  };
};

/**
 * Free bytes on the filesystem holding `path`, or 0 when it cannot be measured.
 *
 * `bavail * bsize`, the idiom `workspace/usage.ts` uses: `bavail` excludes the blocks
 * reserved for root, which this process can never have, so `bfree` would claim there is
 * room at the moment writes start failing. An unmeasurable filesystem reads as full, which
 * is the safe direction — refusing one review lens costs less than filling the volume.
 */
const freeBytes = async (path: string): Promise<number> => {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
};

/**
 * `cp -a --reflink=auto <source>/. <destination>/`. Returns a reason on failure.
 *
 * `--reflink=auto` makes this nearly free on a copy-on-write filesystem (btrfs, XFS with
 * reflinks, overlayfs on either) and falls back to a real copy everywhere else, so it is
 * never wrong to ask for.
 *
 * `<source>/.` rather than `<source>`: the latter would create `<destination>/<basename>`.
 */
const copyTree = async (
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> =>
  new Promise((settle) => {
    execFile(
      "cp",
      ["-a", "--reflink=auto", `${source}/.`, `${destination}/`],
      {
        timeout: COPY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          settle(undefined);
          return;
        }
        settle(stderr.trim() === "" ? error.message : stderr.trim());
      },
    );
  });

/**
 * Turn a copied worktree into a git checkout of its own, without touching the mirror.
 *
 * A linked worktree's `.git` is a FILE reading `gitdir: <mirror>/worktrees/<name>`, and
 * that administrative directory holds the index, HEAD, and two pointer files: `gitdir`
 * (back to the worktree's `.git`) and `commondir` (to the mirror's common directory,
 * usually the relative `../..`). The copy inherits the `.git` file verbatim, so it and the
 * original both claim the same admin directory — which means the copy's index writes land
 * in the original's, and `git checkout -- .` in the copy would rewrite the original's HEAD.
 *
 * So the admin directory is copied INTO the copy and its pointers rewritten: `gitdir` to
 * the copy's `.git`, `commondir` made absolute so it still resolves to the mirror from its
 * new location, and the copy's `.git` to the copied admin directory. The mirror is only
 * ever READ. `git worktree add` would have been shorter and writes a record into a mirror
 * that other tasks fetch from and that `git worktree prune` would later have opinions about.
 *
 * Returns a reason on failure: an original whose `.git` is a directory rather than a
 * pointer file is not a linked worktree, and a council can run without this lens.
 */
const relinkGitDir = async (
  original: string,
  /** Where the files are now. Everything is written here. */
  staging: string,
  /** Where they will be once renamed. Every pointer is written to name THIS. */
  finalPath: string,
): Promise<string | undefined> => {
  const pointer = await readFile(join(staging, ".git"), "utf8").catch(() => undefined);
  const adminDir = pointer?.trim().startsWith("gitdir:") === true
    ? pointer.trim().slice("gitdir:".length).trim()
    : undefined;
  if (adminDir === undefined) {
    return `${original} is not a linked worktree: its .git is not a gitdir pointer`;
  }

  const absoluteAdmin = isAbsolute(adminDir) ? adminDir : resolve(original, adminDir);
  const commonDir = await readFile(join(absoluteAdmin, "commondir"), "utf8").catch(
    () => undefined,
  );
  if (commonDir === undefined) {
    return `${absoluteAdmin} has no commondir: it is not a worktree administrative directory`;
  }

  const failed = await copyTree(absoluteAdmin, join(staging, COPY_GIT_DIR), undefined);
  if (failed !== undefined) return `could not copy ${absoluteAdmin}: ${failed}`;

  const admin = join(finalPath, COPY_GIT_DIR);
  await writeFile(join(staging, ".git"), `gitdir: ${admin}\n`);
  await writeFile(join(staging, COPY_GIT_DIR, "gitdir"), `${join(finalPath, ".git")}\n`);
  // Absolute, because the relative `../..` git writes is relative to the admin directory's
  // old home inside the mirror and would point at the task directory from here.
  await writeFile(
    join(staging, COPY_GIT_DIR, "commondir"),
    `${resolve(absoluteAdmin, commonDir.trim())}\n`,
  );

  return undefined;
};

/**
 * `rm -rf` the copy, idempotently, and only ever inside `taskDir`. Never throws.
 *
 * The containment assertion is `removeTree`'s in `workspace/worktree.ts`, for the same
 * reason: this is the one function here that deletes, its path is assembled from arguments
 * a caller supplies, and the sibling of the directory it targets is the checkout the whole
 * council is reviewing.
 */
const removeCopy = async (destination: string, taskDir: string): Promise<void> => {
  assertInside(resolve(taskDir), destination);
  await rm(destination, { recursive: true, force: true }).catch(() => undefined);
};

export interface SabotageExecutionEnvOptions extends BoundedExecutionEnvOptions {
  /** Commands this reviewer may run in total. Exceeding it fails the command. */
  readonly maxCommands: number;
}

/**
 * The sabotage reviewer's shell: the inherited per-command timeout, plus a budget.
 *
 * The timeout bounds one command; nothing bounded how MANY, and this is the one lens whose
 * loop is naturally unbounded — break a file, run the suite, restore it, break the next
 * one. On a repo with a slow suite that is the session ceiling spent on a review, and the
 * council's other four wait for it.
 *
 * Exhausting the budget FAILS the command rather than throwing, because a thrown error
 * from a tool aborts the session and loses the verdict the reviewer had already formed.
 * The message tells it to submit what it has, which is the outcome we want from a reviewer
 * that has run out of room: a partial finding beats an abstention.
 */
export class SabotageExecutionEnv extends BoundedExecutionEnv {
  private readonly maxCommands: number;
  private readonly budgetLogger: Logger;
  private readonly budgetTask: string;
  private count = 0;
  private warned = false;

  constructor(options: SabotageExecutionEnvOptions) {
    super(options);
    this.maxCommands = options.maxCommands;
    this.budgetLogger = options.logger;
    this.budgetTask = options.task;
  }

  /** Commands actually run. Never counts one the budget refused. */
  get used(): number {
    return this.count;
  }

  override async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<
    Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  > {
    if (this.count >= this.maxCommands) {
      if (!this.warned) {
        this.warned = true;
        this.budgetLogger.warn("sabotage.budget", {
          task: this.budgetTask,
          maxCommands: this.maxCommands,
        });
      }
      // The same failed shape `NodeExecutionEnv` returns for a command it would not run,
      // so nothing downstream has to know this reviewer has a budget at all.
      return {
        ok: false,
        error: new ExecutionError(
          "unknown",
          `command budget exhausted: this review may run ${this.maxCommands} commands and has run them all. ` +
            `Submit your verdict with what you already have.`,
        ),
      };
    }

    this.count += 1;
    return super.exec(command, options);
  }
}
