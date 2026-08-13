/**
 * Repo mirrors and per-task worktrees. See DESIGN.md §2 (Workspace) and §9.2.
 *
 * One bare mirror per repo on the PVC, fetched incrementally; one worktree per task.
 * Session starts cost a fetch rather than a clone, tasks stay isolated, and a
 * corrupted worktree is discardable without touching the mirror.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "../state/git.ts";
import type { RepoRef, TaskId } from "../domain/task.ts";

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

  /** Ensure a bare mirror exists and is current. */
  async syncMirror(repo: RepoRef): Promise<string> {
    const path = mirrorPath(this.options.mirrorsDir, repo);

    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
      await this.options.git.run("clone", "--mirror", cloneUrl(repo), path);
      await this.configure(path, repo);
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
    const mirror = await this.syncMirror(repo);
    const path = join(this.options.tasksDir, task, repo.name);
    const branch = `agent/${task}`;

    if (existsSync(path)) {
      await this.configure(path, repo);
      return path;
    }

    await mkdir(join(this.options.tasksDir, task), { recursive: true });
    const git = this.options.git.at(mirror);

    const exists = await git.revParse(`refs/heads/${branch}`);
    if (exists === undefined) {
      const head = await git.run("symbolic-ref", "--short", "HEAD");
      await git.run("worktree", "add", "-b", branch, path, head);
    } else {
      await git.run("worktree", "add", path, branch);
    }

    await this.configure(path, repo);
    return path;
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
  private async configure(path: string, repo: RepoRef): Promise<void> {
    const git = this.options.git.at(path);
    const helper = `!${this.options.helperPath} --socket ${this.options.socketPath}`;

    await git.run("config", "credential.helper", helper);
    await git.run("config", "credential.useHttpPath", "true");
    await git.run("config", "user.name", this.options.identity.name);
    await git.run("config", "user.email", this.options.identity.email);

    // Push over HTTPS so the credential helper is used; the mirror may have been
    // cloned from an SSH remote otherwise.
    await git.tryRun("remote", "set-url", "origin", cloneUrl(repo));
  }
}
