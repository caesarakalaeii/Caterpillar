/**
 * Repo mirrors and per-task worktrees. See DESIGN.md §2 (Workspace) and §9.2.
 *
 * One bare mirror per repo on the PVC, fetched incrementally; one worktree per task.
 * Session starts cost a fetch rather than a clone, tasks stay isolated, and a
 * corrupted worktree is discardable without touching the mirror.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "../state/git.ts";
import type { RepoRef, TaskId } from "../domain/task.ts";

/** Where a task's repos landed. `root` is the agent's working directory. */
export interface TaskCheckout {
  readonly root: string;
  /** Sibling repos, keyed `owner/name`, checked out under `root/repos/<name>`. */
  readonly siblings: ReadonlyMap<string, string>;
}

/** Bot identity for commits the agent makes. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
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
}

const mirrorPath = (mirrorsDir: string, repo: RepoRef): string =>
  join(mirrorsDir, repo.host, repo.owner, `${repo.name}.git`);

const cloneUrl = (repo: RepoRef): string =>
  `https://${repo.host}/${repo.owner}/${repo.name}.git`;

/**
 * What a mirror refresh is allowed to touch: everything EXCEPT the branches this runner's
 * own worktrees have checked out.
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
 * A negative refspec is the surgical fix: the mirror exists to supply upstream history to
 * create worktrees from, and it never needs to fetch back the agent branches it pushed
 * itself. Excluding them from the refspec also excludes them from `--prune`, so a local
 * branch whose remote counterpart was deleted by a merge survives rather than being
 * yanked out from under a live worktree.
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
    await mirror.run("fetch", "--prune", "origin", ...MIRROR_REFSPECS);
    return path;
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
    const mirror = this.git.at(await this.commonDir(worktree));
    const base = await mirror.tryRun("symbolic-ref", "--short", "HEAD");
    if (base.code !== 0) return undefined;

    const forkPoint = await this.git
      .at(worktree)
      .tryRun("merge-base", "HEAD", base.stdout.trim());
    return forkPoint.code === 0 ? forkPoint.stdout.trim() : undefined;
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
   * Point this checkout at the credential helper.
   *
   * `credential.useHttpPath` is REQUIRED: without it git omits `path` from the
   * credential request, every repo on a host looks identical to the helper, and
   * per-repo token selection silently degrades to "first token wins".
   */
  private async configure(path: string): Promise<void> {
    const git = this.git.at(path);
    const helper = `!${this.options.helperPath} --socket ${this.options.socketPath}`;

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
}
