/**
 * Independent completion verification. See DESIGN.md §12.
 *
 * Runs in the SUPERVISOR, never in the agent. Both gates must pass:
 *   1. every acceptance command in spec.md exits 0
 *   2. a PR is open and CI is green
 *
 * The agent cannot influence this: it does not choose the commands, does not run
 * them, and does not report the result. `done` only triggers this check.
 */
import { execFile } from "node:child_process";
import { repoSlug, taskPullRequests, type RepoRef, type TaskSpec, type TaskState } from "../domain/task.ts";
import type { Forge, ForgeFactory } from "../forge/types.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import {
  TASK_SHELL_ARGS,
  type ResolvedEnv,
  type ToolchainResolver,
} from "../workspace/toolchain.ts";
import type { WorkspaceBindings } from "../agent/runner.ts";

export interface VerificationResult {
  readonly passed: boolean;
  readonly detail: string;
  readonly prUrl?: string;
}

export interface CommandResult {
  readonly command: string;
  readonly code: number;
  readonly output: string;
}

/** Timeout per acceptance command. A hung test must not wedge the supervisor. */
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

const runCommand = (
  command: string,
  cwd: string,
  toolchain: ResolvedEnv,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      toolchain.shell,
      [...TASK_SHELL_ARGS, command],
      { cwd, env: toolchain.env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ command, code, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });

export interface AcceptanceVerifierOptions {
  readonly worktrees: WorktreeManager;
  readonly bindings: WorkspaceBindings;
  /**
   * The same resolver the agent's session used. The gate has to run in the environment
   * the agent was given, or it grades work against a shell the agent never saw
   * (see `workspace/toolchain.ts`).
   */
  readonly toolchain: ToolchainResolver;
}

export class AcceptanceVerifier {
  private readonly options: AcceptanceVerifierOptions;

  constructor(options: AcceptanceVerifierOptions) {
    this.options = options;
  }

  async verify(spec: TaskSpec, state: TaskState): Promise<VerificationResult> {
    const repo = spec.repos[0];
    if (repo === undefined) {
      return { passed: false, detail: "task declares no repos" };
    }

    const acceptance = await this.runAcceptance(spec, repo);
    if (!acceptance.passed) return acceptance;

    return this.checkCi(spec, state);
  }

  /** Gate 1 — the declared commands, run by us in the task's worktree. */
  private async runAcceptance(spec: TaskSpec, repo: RepoRef): Promise<VerificationResult> {
    const worktree = await this.options.worktrees.ensureWorktree(repo, spec.id);
    const toolchain = await this.options.toolchain.resolve(spec, worktree);
    const failures: CommandResult[] = [];

    for (const command of spec.acceptance) {
      const result = await runCommand(command, worktree, toolchain);
      if (result.code !== 0) failures.push(result);
    }

    if (failures.length === 0) {
      return { passed: true, detail: `${spec.acceptance.length} acceptance command(s) passed` };
    }

    const detail = failures
      .map((f) => `\`${f.command}\` exited ${f.code}:\n\n\`\`\`\n${f.output.slice(-2000)}\n\`\`\``)
      .join("\n\n");
    return { passed: false, detail: `Acceptance criteria failed.\n\n${detail}` };
  }

  /**
   * Gate 2 — a PR exists and CI is green, in EVERY repo the task opened one in.
   *
   * Every repo, not the primary one, and the difference is the whole point of this pass. A task
   * may span several repos (§9.4.1) and this checked `repos[0]` alone — so a two-repo task
   * whose sibling PR was red, or whose sibling PR did not exist at all, passed the gate on the
   * strength of the primary. The work is one change; half of it being green is not it passing.
   *
   * `repo` is no longer a parameter: taking one invited exactly the assumption this removes.
   */
  private async checkCi(spec: TaskSpec, state: TaskState): Promise<VerificationResult> {
    const prs = taskPullRequests(spec.repos, state);
    if (prs.length === 0) {
      return {
        passed: false,
        detail: "no pull request has been opened — call open_pr before claiming done",
      };
    }

    const forgeFactory = this.options.bindings.forges.get(spec.workspace);
    if (forgeFactory === undefined) {
      return { passed: false, detail: `no forge configured for workspace '${spec.workspace}'` };
    }

    // The primary's, for the ONE url every caller displays. `prs` carries the rest.
    const prUrl = (state.pr ?? prs[0])?.url;

    const forge: Forge = await forgeFactory.forTask(spec);
    try {
      const notes: string[] = [];
      for (const pr of prs) {
        const status = await forge.checks(pr.repo, `agent/${spec.id}`);
        const where = prs.length === 1 ? "" : `${repoSlug(pr.repo)}: `;

        switch (status.conclusion) {
          case "success":
            notes.push(`${where}${status.summary}`);
            break;
          // Returned on the FIRST failure rather than collected: the detail is what the next
          // session is told to fix, and a red suite in one repo is a full session's work
          // whether or not the other is also red.
          case "pending":
            return { passed: false, detail: `CI has not finished — ${where}${status.summary}` };
          case "failure":
            return { passed: false, detail: `CI is red — ${where}${status.summary}` };
          case "none":
            // No CI configured is not the same as CI passing, but failing here would
            // make the task unfinishable in a repo without CI. Accept with a warning
            // recorded in the journal so the gap is visible rather than silent.
            notes.push(`${where}NOTE: ${status.summary}`);
            break;
        }
      }

      const clean = notes.every((note) => !note.includes("NOTE:"));
      return {
        passed: true,
        detail: clean
          ? `acceptance passed; ${notes.join("; ")}`
          : `acceptance passed; ${notes.join("; ")} — completion rests on acceptance criteria alone where CI is absent`,
        ...(prUrl === undefined ? {} : { prUrl }),
      };
    } finally {
      await forge.revoke().catch(() => undefined);
    }
  }
}

export type { ForgeFactory };
