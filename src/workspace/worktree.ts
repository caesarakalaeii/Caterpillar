/**
 * Repo mirrors and per-task worktrees. See DESIGN.md §2 (Workspace) and §9.2.
 *
 * One bare mirror per repo on the PVC, fetched incrementally; one worktree per task.
 * Session starts cost a fetch rather than a clone, tasks stay isolated, and a
 * corrupted worktree is discardable without touching the mirror.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export class WorktreeManager {
  constructor(private readonly options: WorktreeOptions) {}

  /** A Git bound to a worktree, for callers that need to inspect or commit there. */
  gitAt(path: string): Git {
    return this.options.git.at(path);
  }

  /** Ensure a bare mirror exists and is current. */
  async syncMirror(repo: RepoRef): Promise<string> {
    const path = mirrorPath(this.options.mirrorsDir, repo);

    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
      await this.options.git.run("clone", "--mirror", cloneUrl(repo), path);
      await this.configure(path);
      return path;
    }

    const mirror = this.options.git.at(path);
    await mirror.run("fetch", "--prune", "origin");
    return path;
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
    const mirror = await this.syncMirror(repo);
    const branch = `agent/${task}`;

    if (existsSync(path)) {
      await this.configure(path);
      return;
    }

    await mkdir(join(path, ".."), { recursive: true });
    const git = this.options.git.at(mirror);

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
   * Must use `--git-common-dir`, NOT `--git-dir`: in a linked worktree the latter
   * returns the worktree-private directory, but git only reads `info/exclude` from the
   * common directory, so writing there has no effect at all.
   *
   * Consequence: the pattern applies to every worktree of this mirror, not just this
   * task's. That is what we want here — `repos/` should never be committable in any
   * checkout of a workspace repo.
   */
  private async excludeLocally(worktree: string, pattern: string): Promise<void> {
    const git = this.options.git.at(worktree);
    const commonDir = await git.run("rev-parse", "--git-common-dir");
    const resolved = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
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
    await this.options.git.at(mirror).tryRun("worktree", "remove", "--force", path);
  }

  /**
   * Point this checkout at the credential helper.
   *
   * `credential.useHttpPath` is REQUIRED: without it git omits `path` from the
   * credential request, every repo on a host looks identical to the helper, and
   * per-repo token selection silently degrades to "first token wins".
   */
  private async configure(path: string): Promise<void> {
    const git = this.options.git.at(path);
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
