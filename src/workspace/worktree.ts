/**
 * Repo mirrors and per-task worktrees. See DESIGN.md §2 (Workspace) and §9.2.
 *
 * One bare mirror per repo on the PVC, fetched incrementally; one worktree per task.
 * Session starts cost a fetch rather than a clone, tasks stay isolated, and a
 * corrupted worktree is discardable without touching the mirror.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Git } from "../state/git.ts";
import type { CommitIdentity, WorktreeReapConfig } from "../config/types.ts";
import { asTaskId, type RepoRef, type TaskId } from "../domain/task.ts";

/**
 * Defaults for worktree reaping, and the reasoning behind each number.
 *
 * The interval matches `DEFAULT_TOOLCHAIN_CONFIG.gcIntervalHours` deliberately: both
 * sweeps are janitorial, both only ever run on an idle poll, and an operator reading the
 * two lines in the web view should not have to wonder why they disagree.
 *
 * The keep-age does NOT match `gcKeepDays`. A store path is shared by every task that
 * resolved the same environment, so keeping it two weeks is cheap and re-fetching it is
 * expensive; a worktree belongs to exactly one task, and a task whose directory has not
 * been touched in three days is either finished (in which case the targeted removal
 * failed to run, which is what the sweep exists for) or so far from resuming that a fresh
 * clone costs less than the disk. Three days also comfortably outlives a weekend, which
 * is the realistic gap between a task parking for a human on Friday and being answered.
 */
export const DEFAULT_REAP_CONFIG: WorktreeReapConfig = {
  intervalHours: 24,
  keepHours: 72,
};

/** What one reap actually removed. Reported by the caller as a log line and a metric. */
export interface ReapResult {
  /** Task directories removed — not repos. One task with four repos counts once. */
  readonly worktrees: number;
  /**
   * Bytes reclaimed, measured BEFORE the removal by walking the tree.
   *
   * Apparent size (`stat.size` summed over regular files), not blocks on disk: the number
   * exists to tell an operator whether reaping is worth anything, and a walk that also
   * asked about sparseness and hard links would cost more than the removal it precedes.
   * It is an estimate and the log line says so by naming it `approxBytes`.
   */
  readonly bytes: number;
  /** Task ids removed, for the log line. Bounded by what one sweep found. */
  readonly tasks: readonly TaskId[];
}

const EMPTY_REAP: ReapResult = { worktrees: 0, bytes: 0, tasks: [] };

/** Where a task's repos landed. `root` is the agent's working directory. */
export interface TaskCheckout {
  readonly root: string;
  /** Sibling repos, keyed `owner/name`, checked out under `root/repos/<name>`. */
  readonly siblings: ReadonlyMap<string, string>;
}

export interface WorktreeOptions {
  readonly git: Git;
  readonly mirrorsDir: string;
  readonly tasksDir: string;
  /** Path to the credential helper executable. */
  readonly helperPath: string;
  /** Unix socket the helper talks to. */
  readonly socketPath: string;
  readonly identity: CommitIdentity;
  /**
   * When finished worktrees are thrown away. Optional, defaulting to
   * `DEFAULT_REAP_CONFIG`, because every caller that only creates worktrees — the
   * verifier, the progress probe, the digest's mirror reader — has no opinion about it
   * and should not have to hold one.
   */
  readonly reap?: WorktreeReapConfig;
}

const mirrorPath = (mirrorsDir: string, repo: RepoRef): string =>
  join(mirrorsDir, repo.host, repo.owner, `${repo.name}.git`);

const cloneUrl = (repo: RepoRef): string =>
  `https://${repo.host}/${repo.owner}/${repo.name}.git`;

/**
 * Everything the mirror refresh always wants, and the branches it must never write.
 *
 * `clone --mirror` configures `+refs/*:refs/*`, so a plain `fetch --prune` tries to write
 * every remote ref onto the identically-named local ref — including `refs/heads/agent/<task>`
 * once a task has pushed its branch. That local head is checked out in the task's worktree,
 * which persists on the PVC after the session ends, so git refuses the whole fetch:
 *
 *   fatal: refusing to fetch into branch 'refs/heads/agent/<task>' checked out at ...
 *
 * One task pushing therefore broke `syncMirror` for every LATER task on that repo,
 * permanently — the second task on a repo parked two seconds after being claimed, which
 * reads as a scheduler fault rather than a git one.
 *
 * `^refs/heads/agent/*` is the standing half of the answer, and it is about ownership
 * rather than about the refusal: the mirror exists to supply upstream history to create
 * worktrees from, and it never needs to fetch back a branch it pushed itself. Excluding
 * those refs from the refspec also excludes them from `--prune`, so an agent branch whose
 * remote counterpart a merge deleted survives instead of being pruned out from under a
 * worktree that may still be resumed. The rest of the answer is `checkedOutBranches`.
 *
 * Passed per invocation rather than written into the mirror's config, because `configure`
 * runs only on first clone and every mirror already on a PVC would keep the old refspec.
 */
const MIRROR_REFSPECS: readonly string[] = ["+refs/*:refs/*", "^refs/heads/agent/*"];

export class WorktreeManager {
  /**
   * Workspace git, with the supervisor's own credential stripped off.
   *
   * Enforced here rather than trusted to the caller, because the caller that got it
   * wrong passed the obvious thing: `index.ts` builds one `Git` for the state repo and
   * handed the same object over. Task repos authenticate through the credential
   * service and nothing else (DESIGN.md §9.2/§9.3); the state repo's token must never
   * ride along, both because it cannot see task repos and because on a Codeberg
   * workspace it would send a GitHub token to another host.
   */
  private readonly git: Git;

  private readonly options: WorktreeOptions;

  constructor(options: WorktreeOptions) {
    this.options = options;
    this.git = options.git.withoutCredentials();
  }

  /** A Git bound to a worktree, for callers that need to inspect or commit there. */
  gitAt(path: string): Git {
    return this.git.at(path);
  }

  /**
   * A Git bound to this repo's mirror AS IT ALREADY IS, or nothing when there is none.
   *
   * Deliberately does not clone or fetch, which is what separates it from `syncMirror`:
   * the caller is the daily digest (DESIGN.md §19), which reads history that is already on
   * disk and must be able to run without a credential, without the network, and without
   * making a runner's report the reason a repo gets cloned. A runner that never worked a
   * task has no mirror for it, and the answer to that is "this runner cannot say" rather
   * than a fetch nobody asked for.
   */
  localMirror(repo: RepoRef): Git | undefined {
    const path = mirrorPath(this.options.mirrorsDir, repo);
    // The same existence test `syncMirror` uses: a directory left behind by a failed clone
    // is not a mirror, and reading one answers every question with a git error.
    return existsSync(join(path, "HEAD")) ? this.git.at(path) : undefined;
  }

  /**
   * Ensure a bare mirror exists and is current.
   *
   * The existence test is for `HEAD` inside the mirror, NOT for the directory. A
   * failed clone can leave the directory behind, and treating that as "mirror exists"
   * sends every later call down the fetch path, where it fails forever with
   * "not a git repository" — a message that describes the symptom and hides the cause.
   * A partial mirror is discarded and re-cloned instead.
   */
  async syncMirror(repo: RepoRef): Promise<string> {
    const path = mirrorPath(this.options.mirrorsDir, repo);

    if (!existsSync(join(path, "HEAD"))) {
      // Leave no half-built mirror behind on failure, so a retry is a clean clone
      // rather than a permanently poisoned path.
      await rm(path, { recursive: true, force: true });
      // Only the PARENT is created: `git clone` makes the target itself, and
      // pre-creating it is what allowed the poisoned-directory state above.
      await mkdir(join(path, ".."), { recursive: true });

      try {
        // The credential helper is passed to the CLONE itself, not merely configured
        // afterwards. A private repo cannot be cloned anonymously, and the post-clone
        // `configure` is far too late — git has already failed with
        // "could not read Username". The token still never touches argv: `-c` carries
        // the helper's path, and the helper resolves the credential over the socket.
        await this.git.run(
          ...this.credentialArgs(),
          "clone",
          "--mirror",
          cloneUrl(repo),
          path,
        );
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }

      await this.configure(path);
      return path;
    }

    const mirror = this.git.at(path);
    await mirror.run("fetch", "--prune", "origin", ...(await this.refspecs(mirror)));
    return path;
  }

  /**
   * The refspecs for one refresh: the standing set, plus an exclusion per branch a
   * worktree currently holds.
   *
   * `^refs/heads/agent/*` alone assumed the agent stays on the branch we created for it.
   * Nothing holds it there — the session drives git through its bash tool, and the PR tool
   * takes whatever `head` it is handed — so an agent that renamed its work re-created the
   * original failure under a name the exclusion could not match:
   *
   *   fatal: refusing to fetch into branch 'refs/heads/ci/govulncheck-go-1.25.13'
   *          checked out at '/work/tasks/<other task>/<repo>'
   *
   * Same shape, same blast radius: two later tasks on that repo parked seconds after being
   * claimed, naming a branch neither had ever touched. So the exclusion is derived from the
   * worktrees rather than from a naming convention the agent never agreed to.
   */
  private async refspecs(mirror: Git): Promise<readonly string[]> {
    const held = await this.checkedOutBranches(mirror);
    return [...new Set([...MIRROR_REFSPECS, ...held.map((ref) => `^${ref}`)])];
  }

  /**
   * Every branch a worktree of this mirror has checked out, as full ref names.
   *
   * `worktree list` is deliberately the source: it and the fetch's refusal both read
   * git's own worktree list, so this cannot disagree with the check it exists to satisfy
   * — including about worktrees whose directory has since been deleted, which still hold
   * their branch until they are pruned. Porcelain emits `branch <fullref>` for a worktree
   * on a branch, `detached` for one that is not, and neither for the bare mirror itself;
   * only a branch a worktree HOLDS can refuse a fetch, so the other two contribute nothing.
   *
   * The cost is that such a branch stops tracking upstream until its worktree goes away.
   * For `agent/<task>` that is the point. For the default branch — an agent that ran
   * `git checkout main` in its worktree — it means later tasks fork from a mirror that is
   * behind, which they resolve on their own PR. A stale base beats a repo whose every
   * later task parks.
   */
  private async checkedOutBranches(mirror: Git): Promise<readonly string[]> {
    const listed = await mirror.run("worktree", "list", "--porcelain");
    return listed
      .split("\n")
      .filter((line) => line.startsWith("branch "))
      .map((line) => line.slice("branch ".length).trim())
      .filter((ref) => ref.length > 0);
  }

  /**
   * `-c` overrides that route authentication through the credential service.
   *
   * Needed for any git invocation that runs BEFORE a repo exists to hold config —
   * currently the mirror clone. Everything afterwards reads the same settings from the
   * repo config that `configure` writes.
   */
  private credentialArgs(): readonly string[] {
    return [
      "-c",
      `credential.helper=!${this.options.helperPath} --socket ${this.options.socketPath}`,
      "-c",
      "credential.useHttpPath=true",
    ];
  }

  /**
   * Create (or reuse) the worktree for a task, on branch `agent/<task>`.
   *
   * The branch is created from the mirror's default branch on first use and reused
   * afterwards, so a handoff resumes exactly where the previous session stopped.
   */
  async ensureWorktree(repo: RepoRef, task: TaskId): Promise<string> {
    const path = join(this.options.tasksDir, task, repo.name);
    await this.addWorktreeAt(repo, task, path);
    return path;
  }

  /** Create or reuse a worktree for `repo` at an explicit path. */
  private async addWorktreeAt(repo: RepoRef, task: TaskId, path: string): Promise<void> {
    const branch = `agent/${task}`;

    // An existing worktree is checked out already, and fetching the mirror would not
    // move it — so the mirror is deliberately NOT touched here. That is not just an
    // optimisation: `ensureWorktree` is also called by the progress probe and the
    // verifier, which run AFTER the session and therefore after `clearActive()`. With
    // no active task the credential service refuses to answer (by design, §9.2), so on
    // a private repo an unnecessary fetch fails and takes the whole post-session path
    // down with it — verification never runs and the task cannot complete.
    if (existsSync(path)) {
      await this.configure(path);
      return;
    }

    const mirror = await this.syncMirror(repo);
    await mkdir(join(path, ".."), { recursive: true });
    const git = this.git.at(mirror);

    const exists = await git.revParse(`refs/heads/${branch}`);
    if (exists === undefined) {
      const head = await git.run("symbolic-ref", "--short", "HEAD");
      await git.run("worktree", "add", "-b", branch, path, head);
    } else {
      await git.run("worktree", "add", path, branch);
    }

    await this.configure(path);
  }

  /**
   * The commit the task branch forked from, or undefined when it cannot be resolved.
   *
   * This is the baseline for "did this session commit?" on a FIRST session, where no
   * head from a previous session has been recorded yet. Resolved entirely LOCALLY and
   * deliberately so: the progress probe runs after the session, hence after
   * `clearActive()`, where the credential service refuses to answer by design (§9.2)
   * and anything touching the network fails.
   *
   * A mirror's `HEAD` is a symbolic ref to its default branch, and a linked worktree
   * shares the mirror's refs, so the fork point is a plain local `merge-base`.
   */
  async branchPoint(worktree: string): Promise<string | undefined> {
    const base = await this.defaultBranch(worktree);
    if (base === undefined) return undefined;

    const forkPoint = await this.git.at(worktree).tryRun("merge-base", "HEAD", base);
    return forkPoint.code === 0 ? forkPoint.stdout.trim() : undefined;
  }

  /**
   * The name of the branch a task's work forks from — the mirror's default.
   *
   * A mirror's `HEAD` is a symbolic ref to its default branch, and a linked worktree
   * shares the mirror's refs, so this is a local lookup with no network.
   */
  async defaultBranch(worktree: string): Promise<string | undefined> {
    const mirror = this.git.at(await this.commonDir(worktree));
    const base = await mirror.tryRun("symbolic-ref", "--short", "HEAD");
    return base.code === 0 ? base.stdout.trim() : undefined;
  }

  /**
   * Does `ref` carry `path`? Answered from the shared object store, never the worktree's
   * checked-out files, so it can ask about a branch this worktree is not on.
   */
  async hasFileOn(worktree: string, ref: string, path: string): Promise<boolean> {
    const result = await this.git.at(worktree).tryRun("cat-file", "-e", `${ref}:${path}`);
    return result.code === 0;
  }

  /**
   * The repository's common directory, absolute.
   *
   * Must be `--git-common-dir`, NOT `--git-dir`: in a linked worktree the latter
   * returns the worktree-private directory, which holds neither the shared refs nor
   * `info/exclude`.
   */
  private async commonDir(worktree: string): Promise<string> {
    const dir = await this.git.at(worktree).run("rev-parse", "--git-common-dir");
    return dir.startsWith("/") ? dir : join(worktree, dir);
  }

  /**
   * Materialise every repo a task declares, in the workspace-plus-clones layout.
   *
   * `repos[0]` is the WORKSPACE repo and becomes the agent's working directory. The
   * rest are checked out beneath it as `repos/<name>`, matching how these ecosystems
   * are actually worked — one workspace repo with siblings cloned inside it, so a task
   * spanning several repos sees them where its own docs say they are.
   *
   * The nested checkouts are added to the workspace's `.git/info/exclude` rather than
   * relying on its `.gitignore`: exclude is local-only, so the agent cannot
   * accidentally commit a sibling repo even in a repo that has not thought to ignore
   * the directory.
   */
  async ensureTaskCheckout(
    repos: readonly RepoRef[],
    task: TaskId,
  ): Promise<TaskCheckout> {
    const workspace = repos[0];
    if (workspace === undefined) throw new Error(`task ${task} declares no repos`);

    const root = await this.ensureWorktree(workspace, task);
    const siblings = new Map<string, string>();

    for (const repo of repos.slice(1)) {
      const path = join(root, "repos", repo.name);
      await this.addWorktreeAt(repo, task, path);
      siblings.set(`${repo.owner}/${repo.name}`, path);
    }

    if (siblings.size > 0) await this.excludeLocally(root, "repos/");

    return { root, siblings };
  }

  /**
   * Append a pattern to the repository's local exclude file, idempotently.
   *
   * git only reads `info/exclude` from the common directory (see `commonDir`), so
   * writing anywhere else has no effect at all — the first attempt silently did nothing.
   *
   * Consequence: the pattern applies to every worktree of this mirror, not just this
   * task's. That is what we want here — `repos/` should never be committable in any
   * checkout of a workspace repo.
   */
  private async excludeLocally(worktree: string, pattern: string): Promise<void> {
    const resolved = await this.commonDir(worktree);
    const excludePath = join(resolved, "info", "exclude");

    await mkdir(join(resolved, "info"), { recursive: true });
    const current = existsSync(excludePath) ? await readFile(excludePath, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === pattern)) return;

    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(excludePath, `${current}${separator}${pattern}\n`);
  }

  /** Discard a task's worktree — used after completion or on corruption. */
  async removeWorktree(repo: RepoRef, task: TaskId): Promise<void> {
    const mirror = mirrorPath(this.options.mirrorsDir, repo);
    if (!existsSync(mirror)) return;
    const path = join(this.options.tasksDir, task, repo.name);
    await this.git.at(mirror).tryRun("worktree", "remove", "--force", path);
  }

  /**
   * Throw away everything one task left on this runner's disk.
   *
   * The targeted half of DESIGN.md §2's worktree reaping, called from the supervisor the
   * moment a task reaches a state it will not resume from IN PLACE — done, failed, or a
   * lease another runner has taken. Deliberately not called on handoff or on
   * `awaiting-human`: those sessions resume against this very checkout, and reaping there
   * would trade a few gigabytes for a re-clone and a re-install on every single handoff,
   * which is the opposite of the trade this is making.
   *
   * `removeWorktree` alone is not enough, and that is the part worth reading `checkout()`
   * for. It removes `<tasksDir>/<task>/<repo.name>` for the repos it is handed, but a
   * multi-repo task also has:
   *
   *   - `<root>/repos/<name>` for every sibling, each a linked worktree of its own mirror
   *     with its own administrative record — `<root>` being the FIRST repo's worktree, so
   *     removing that one takes the siblings' directories with it while leaving every
   *     sibling mirror still believing its worktree exists;
   *   - `<tasksDir>/<task>/.caterpillar`, where `ToolchainResolver.materialise` caches the
   *     resolved devShell environment;
   *   - the `<tasksDir>/<task>` directory itself, which git will never remove because git
   *     does not know it exists.
   *
   * So the order is: ask each mirror to remove its own worktrees (both layouts, because a
   * repo can be the workspace of one task and a sibling of another), then `rm -rf` the
   * task directory wholesale, then prune every mirror we touched. The final `rm` is what
   * makes this honest rather than best-effort: git's `worktree remove` refuses a
   * worktree with a submodule, an in-flight `.git/index.lock`, or anything else it finds
   * surprising, and a reap that leaves the biggest directory on the volume behind because
   * git had an opinion about it would fail silently and forever.
   *
   * Idempotent by construction and never throws: `removeWorktree` uses `tryRun`, `rm`
   * takes `force`, and `prune` is `tryRun`. Calling it twice does nothing the second
   * time, which matters because the supervisor's terminal paths overlap — `applyOutcome`
   * can return true from a branch that `parkFailed` also covers.
   */
  async removeTaskWorktrees(task: TaskId, repos: readonly RepoRef[]): Promise<ReapResult> {
    const root = this.taskDir(task);
    if (!existsSync(root)) return EMPTY_REAP;

    const bytes = await treeSize(root);
    const workspace = repos[0];

    for (const repo of repos) {
      const mirror = mirrorPath(this.options.mirrorsDir, repo);
      if (!existsSync(mirror)) continue;
      const git = this.git.at(mirror);

      // Both places `ensureTaskCheckout` can have put this repo. Passing a path that was
      // never a worktree of this mirror is not an error — git says "is not a working
      // tree" and `tryRun` swallows it — so asking about both is cheaper than working out
      // which one applies from a `repos` array whose order the caller chose.
      await git.tryRun("worktree", "remove", "--force", join(root, repo.name));
      if (workspace !== undefined && repo !== workspace) {
        await git.tryRun(
          "worktree",
          "remove",
          "--force",
          join(root, workspace.name, "repos", repo.name),
        );
      }
    }

    await this.removeTree(root);
    await this.pruneMirrors(repos);

    return { worktrees: 1, bytes, tasks: [task] };
  }

  /**
   * Sweep `tasksDir` for worktrees no live task claims — the safety net, not the plan.
   *
   * The targeted removal covers the case where the supervisor reaches a terminal path and
   * gets to act on it. It cannot cover the case this exists for: a pod killed mid-session,
   * a node evicted, a Keel roll landing between the merge and the removal. In every one of
   * those the task moves on — another replica claims it, works it in its OWN `tasksDir`,
   * finishes it — and the directory on this runner is orphaned with nothing that will ever
   * name it again. On a 20Gi ReadWriteOnce volume that is how the disk fills.
   *
   * Two guards, and the first one is the whole reason this takes a parameter it could have
   * inferred:
   *
   *   - **`live` is given, never derived.** Deleting the worktree of a task a session is
   *     working right now is the worst outcome this code can produce — the agent's
   *     uncommitted work, its index, and its resolved environment all go at once, mid-turn,
   *     and what it reports afterwards is a git error about a directory that vanished. The
   *     supervisor knows exactly which tasks it holds a lease for; this module would have
   *     to guess from mtimes and lock files, and a guess is not a safety property. So the
   *     caller states it.
   *   - **age.** `keepHours` measured from the task directory's mtime. It is what protects
   *     a task between sessions on THIS runner: parked awaiting a human, handed off and
   *     waiting to be re-claimed, or sitting behind a provider cooldown. Those are not live
   *     and must not be reaped for hours yet.
   *
   * Everything it finds that is not a directory it leaves alone, and a directory whose name
   * is not a task id it also leaves alone: `tasksDir` is the supervisor's, but it is on a
   * volume an operator can reach, and a sweep is not the place to be inventive about
   * unexpected files.
   */
  async reapStaleWorktrees(opts: {
    /** Tasks this runner is working, or otherwise refuses to have swept. */
    readonly live: ReadonlySet<TaskId>;
    /** Overrides the configured keep-age. Used by tests and by nothing else. */
    readonly keepHours?: number;
    /** Injected clock, for the same reason. */
    readonly now?: number;
  }): Promise<ReapResult> {
    const { tasksDir } = this.options;
    if (!existsSync(tasksDir)) return EMPTY_REAP;

    const keepHours = opts.keepHours ?? (this.options.reap ?? DEFAULT_REAP_CONFIG).keepHours;
    const cutoff = (opts.now ?? Date.now()) - keepHours * 60 * 60 * 1000;

    const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
    let worktrees = 0;
    let bytes = 0;
    const reaped: TaskId[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const task = asTaskId(entry.name);
      if (opts.live.has(task)) continue;

      const path = join(tasksDir, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.mtimeMs > cutoff) continue;

      bytes += await treeSize(path);
      await this.removeTree(path);
      worktrees += 1;
      reaped.push(task);
    }

    // AFTER the removals, and over every mirror rather than the ones a task named: the
    // sweep does not know which repos an orphaned directory held — the state repo that
    // could say is on another replica by now — so the only way to stop the administrative
    // records accumulating is to ask every mirror on the volume. `prune` on a mirror with
    // nothing to prune is a directory listing.
    if (worktrees > 0) await this.pruneAllMirrors();

    return { worktrees, bytes, tasks: reaped };
  }

  /** `<tasksDir>/<task>`, resolved. The only directory a reap is ever allowed to remove. */
  private taskDir(task: TaskId): string {
    return join(resolve(this.options.tasksDir), task);
  }

  /**
   * `rm -rf`, but only ever strictly inside `tasksDir`.
   *
   * The assertion is not decoration and it is not a test of this file's own arithmetic —
   * it is a test of the TASK ID, which is the one part of the path that comes from outside
   * this process. Task ids are read from directory names on a volume and from a state repo
   * that intake writes, and `join(tasksDir, "..")` resolves to the parent of every mirror
   * on the PVC. A single `..` reaching this function without the check would delete the
   * mirrors, the nix store's GC roots and the state checkout, on a timer, with a log line
   * that said it had reclaimed a lot of disk.
   *
   * `relative()` rather than a string prefix: `startsWith(tasksDir)` is true of
   * `/work/tasks-old`, which is exactly the sort of sibling an operator makes while
   * debugging the thing that filled the disk.
   */
  private async removeTree(path: string): Promise<void> {
    assertInside(resolve(this.options.tasksDir), path);
    await rm(path, { recursive: true, force: true });
  }

  /**
   * `git worktree prune` on each mirror a reap touched.
   *
   * Necessary because the removals above do not all go through git. `rm -rf` leaves the
   * mirror's `worktrees/<name>` administrative directory intact, and git keeps those
   * forever unless asked: they hold a lock file, a HEAD and a gitdir pointer per task, so
   * they leak inodes at exactly the rate tasks are created. Worse, an unpruned record
   * still HOLDS its branch as far as `worktree list --porcelain` is concerned — which is
   * what `checkedOutBranches` reads to build the fetch refspec, so a mirror that is never
   * pruned accumulates a permanent exclusion per finished task and slowly stops tracking
   * upstream at all.
   *
   * `tryRun`, like everything else here: a prune that fails costs some stale metadata, and
   * that is not a reason to fail a reap that already reclaimed the bytes.
   */
  private async pruneMirrors(repos: readonly RepoRef[]): Promise<void> {
    const seen = new Set<string>();
    for (const repo of repos) {
      const mirror = mirrorPath(this.options.mirrorsDir, repo);
      if (seen.has(mirror) || !existsSync(mirror)) continue;
      seen.add(mirror);
      await this.git.at(mirror).tryRun("worktree", "prune");
    }
  }

  /** Prune every mirror on this volume — the sweep's only option. See `reapStaleWorktrees`. */
  private async pruneAllMirrors(): Promise<void> {
    for (const mirror of await findMirrors(this.options.mirrorsDir)) {
      await this.git.at(mirror).tryRun("worktree", "prune");
    }
  }

  /**
   * Point this checkout at the credential helper, and make its pushes narrow.
   *
   * `credential.useHttpPath` is REQUIRED: without it git omits `path` from the
   * credential request, every repo on a host looks identical to the helper, and
   * per-repo token selection silently degrades to "first token wins".
   */
  private async configure(path: string): Promise<void> {
    const git = this.git.at(path);
    const helper = `!${this.options.helperPath} --socket ${this.options.socketPath}`;

    await this.disarmMirrorPush(git, path);

    // NOTE: `git config` inside a worktree writes to the repository's COMMON config,
    // shared by the mirror and every other worktree of it. That is fine — and wanted —
    // for the helper and identity, which are identical for every task on a repo.
    //
    // It is why we must NOT touch `remote.origin.url` here: doing so would rewrite the
    // mirror's fetch URL from a per-task code path. The mirror is cloned from the HTTPS
    // URL already, so pushes reach the credential helper without any rewriting.
    await git.run("config", "credential.helper", helper);
    await git.run("config", "credential.useHttpPath", "true");
    await git.run("config", "user.name", this.options.identity.name);
    await git.run("config", "user.email", this.options.identity.email);
    // Written into the repo config, not just passed to our own invocations: the agent
    // commits with its own `git` calls through the bash tool, and on a machine runner
    // those inherit the operator's global `commit.gpgsign`. The bot identity has no
    // signing key, and signing agent work with the operator's key would be a lie.
    await git.run("config", "commit.gpgsign", "false");
  }

  /**
   * Stop the agent's own `git push` from being a MIRROR push.
   *
   * `clone --mirror` writes `remote.origin.mirror = true`, and a linked worktree shares
   * the mirror's config — so a bare `git push` from a task worktree pushed every ref the
   * mirror held, force, including `main`. The mirror's `main` is only as fresh as its last
   * fetch, so when a sibling task had pushed in the meantime the agent silently rewound
   * shared history over a commit no clone on the box had ever seen:
   *
   *   + 6a889c2...b0b1f47 main -> main (forced update)
   *
   * It also blocked the safe incantation: `git push -u origin <branch>` fails outright with
   * "--mirror can't be combined with refspecs", so an agent that tries to be careful is
   * pushed back towards the bare `git push` that does the damage.
   *
   * Unsetting the flag is necessary but not sufficient — a bare `git push` would then fall
   * through to `push.default`, which on an unconfigured branch is a usage error, and on the
   * operator's own global config could be anything. `remote.origin.push = HEAD` pins it:
   * push the CURRENT branch to its own name upstream, and nothing else. An agent physically
   * cannot move a branch it is not standing on, whatever it types.
   *
   * Both live in the mirror's shared config, which is what we want: the rule is a property
   * of every task on the repo, not of one task. And because `configure` runs on every
   * worktree create AND reuse — unlike the fetch refspec, which is why THAT one is passed
   * per invocation — mirrors already on a PVC are healed the next time a task touches them.
   */
  private async disarmMirrorPush(git: Git, path: string): Promise<void> {
    // `--unset-all` exits 5 when the key is absent, which is the steady state after the
    // first call. Only a real failure should surface.
    const unset = await git.tryRun("config", "--unset-all", "remote.origin.mirror");
    if (unset.code !== 0 && unset.code !== 5) {
      throw new Error(`could not unset remote.origin.mirror in ${path}: ${unset.stderr}`);
    }
    await git.run("config", "remote.origin.push", "HEAD");
  }
}

/**
 * Refuse any path that is not strictly beneath `root`. Throws rather than returning false.
 *
 * A boolean would be a decision the caller could forget to act on, and the one caller is a
 * recursive delete. `relative()` is the test rather than `startsWith`, because a prefix
 * comparison says `/work/tasks-old` is inside `/work/tasks`; and `..` is rejected on its
 * own segment boundary rather than as a substring, so a task genuinely named `..foo` is
 * not refused for a resemblance.
 *
 * `root` itself is refused too — `relative()` answers `""` for it. A reap that emptied
 * `tasksDir` wholesale would take every live task's worktree with it, and there is no
 * caller that wants that: the sweep removes children, never the directory it enumerates.
 */
export const assertInside = (root: string, path: string): void => {
  const rel = relative(resolve(root), resolve(path));
  const escapes = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(`refusing to remove ${path}: it is not inside ${root}`);
  }
};

/**
 * Apparent size of everything under `path`, in bytes. Never throws.
 *
 * Walked with `withFileTypes` and no `stat` on directories, so the cost is one `readdir`
 * per directory plus one `lstat` per file — measurably less than the `rm -rf` that follows
 * it, which is the bar this had to clear to be worth reporting at all.
 *
 * Symlinks are counted as their own (tiny) size and never followed. `ensureTaskCheckout`
 * can leave a sibling repo as a link, and following one would count another task's
 * worktree — or, if a repo's own tree contains a link to `/`, walk the whole volume.
 *
 * Errors are swallowed per entry: a file removed by something else between the readdir and
 * the stat is normal, and a metric is not worth failing a reap over.
 */
const treeSize = async (path: string): Promise<number> => {
  let total = 0;
  const pending = [path];

  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      const info = await stat(child).catch(() => undefined);
      total += info?.isFile() === true ? info.size : 0;
    }
  }

  return total;
};

/**
 * Every bare mirror under `mirrorsDir`, by its `HEAD` file.
 *
 * The layout is `<mirrorsDir>/<host>/<owner>/<name>.git`, three levels deep and fixed by
 * `mirrorPath`, so this walks to that depth rather than recursing without bound — a mirror
 * contains an objects tree with thousands of directories in it, and a naive recursive walk
 * looking for `HEAD` would descend into all of them.
 *
 * `HEAD` rather than the `.git` suffix, for the same reason `syncMirror` tests for it: a
 * directory left behind by a failed clone has the name and none of the contents, and
 * running `worktree prune` inside one produces an error about a missing repository.
 */
const findMirrors = async (mirrorsDir: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const hosts = await readdir(mirrorsDir, { withFileTypes: true }).catch(() => []);

  for (const host of hosts.filter((entry) => entry.isDirectory())) {
    const owners = await readdir(join(mirrorsDir, host.name), { withFileTypes: true }).catch(
      () => [],
    );
    for (const owner of owners.filter((entry) => entry.isDirectory())) {
      const repos = await readdir(join(mirrorsDir, host.name, owner.name), {
        withFileTypes: true,
      }).catch(() => []);
      for (const repo of repos.filter((entry) => entry.isDirectory())) {
        const path = join(mirrorsDir, host.name, owner.name, repo.name);
        if (existsSync(join(path, "HEAD"))) found.push(path);
      }
    }
  }

  return found;
};
