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
import type { CheckStatus, Forge, ForgeFactory } from "../forge/types.ts";
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
  /**
   * True when the gate reached no verdict because CI has not finished — as distinct
   * from a verdict of "no".
   *
   * These are not the same event and treating them alike is what parked BS-...-07: a
   * pending run was journalled as a rejected completion claim, the task went back to
   * `ready`, and a fresh session was spent on a task whose only blocker was a CI queue.
   * That session had nothing to do, committed nothing, and was scored no-progress
   * — correctly, by §11.1's definition. Three of them parked finished work.
   *
   * A caller that cannot wait may treat this as `passed: false` and lose nothing; a
   * caller that can should wait instead of burning a session.
   */
  readonly pending?: boolean;
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
  /**
   * How long to wait for a pending CI run before giving up and reporting it, and how
   * often to re-ask. Omitted means do not wait at all, which is the old behaviour and
   * what the unit tests want.
   */
  readonly ci?: CiWaitOptions;
}

export interface CiWaitOptions {
  readonly settleMs: number;
  readonly pollMs: number;
  /** Injected so the wait is testable without spending the wall clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

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
    const note = missingInstallNote(spec.acceptance, failures);
    return { passed: false, detail: `Acceptance criteria failed.\n\n${detail}${note}` };
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
        const status = await this.awaitChecks(forge, pr.repo, spec);
        const where = prs.length === 1 ? "" : `${repoSlug(pr.repo)}: `;

        switch (status.conclusion) {
          case "success":
            notes.push(`${where}${status.summary}`);
            break;
          // Returned on the FIRST failure rather than collected: the detail is what the next
          // session is told to fix, and a red suite in one repo is a full session's work
          // whether or not the other is also red.
          case "pending":
            return {
              passed: false,
              pending: true,
              detail: `CI has not finished — ${where}${status.summary}`,
            };
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

  /**
   * Ask the forge for CI, and keep asking while it says "still running".
   *
   * The wait belongs HERE rather than in the loop because a pending run is a property
   * of the gate, not of the agent: gate 1 has already passed, the branch is not going
   * to change while nobody is working on it, and the only thing separating this task
   * from a verdict is time. Returning "not passed" and letting the supervisor start
   * another session spends a session to do nothing but sleep, and §11.1 then scores
   * that session honestly and parks the task — which is exactly what happened to
   * BS-...-07 with a green branch and an open PR.
   *
   * Bounded by `settleMs`: a check that never settles is reported pending, the claim is
   * rejected as before, and an agent gets told. Waiting forever would trade a spurious
   * park for a wedged runner.
   *
   * The budget is per repo, not per gate, because `checkCi` calls this once for each repo
   * the task opened a PR in (§9.4.1). A two-repo task can therefore wait up to twice
   * `settleMs` in the worst case. That is deliberate: the repos' CI runs are independent,
   * and a shared budget would let a slow first repo spend the whole allowance and report
   * the second as pending without ever having asked it twice.
   */
  private async awaitChecks(forge: Forge, repo: RepoRef, spec: TaskSpec): Promise<CheckStatus> {
    const ci = this.options.ci;
    const ref = `agent/${spec.id}`;
    let status = await forge.checks(repo, ref);
    if (ci === undefined || ci.settleMs <= 0) return status;

    const now = ci.now ?? Date.now;
    const sleep = ci.sleep ?? realSleep;
    const deadline = now() + ci.settleMs;

    while (status.conclusion === "pending" && now() < deadline) {
      // Never overshoot the deadline: with a long poll interval and a short budget the
      // wait would otherwise last the interval rather than the budget.
      const remaining = deadline - now();
      await sleep(Math.min(ci.pollMs, remaining));
      status = await forge.checks(repo, ref);
    }

    return status;
  }
}

export type { ForgeFactory };

/**
 * A hint appended when a failure looks like a missing toolchain rather than broken code.
 *
 * An acceptance list that runs a build or test step but never installs dependencies is
 * not reproducible: it grades whatever `node_modules` (or equivalent) the last session
 * happened to leave in the worktree, which persists across sessions by design. It passes
 * while some earlier session's install is still lying there and fails once anything
 * clears it — on the same commit, with nothing in the repo having changed.
 *
 * `BS-...-07` died of exactly this. Its list was `npm run check` and `npm test` with no
 * install step, and `npm run check` exited 127 with `tsc: command not found`. Four
 * consecutive sessions read that as a code defect and went looking for one, because the
 * gate reported the exit code and nothing else; `GH-...-60` ran the same commands on the
 * same repo in the same image that morning and passed, because its list begins
 * `npm ci --ignore-scripts`. The difference was never visible from the failure text.
 *
 * This only annotates \u2014 it never changes the verdict. A 127 is still a failure, because
 * a command that cannot run has not passed. The point is to aim the next session at the
 * acceptance list instead of at the source, and the note is deliberately conditional on
 * both signals (an exit code that means "not found", and a list with no install step) so
 * that a genuine 127 from a repo that does install stays unannotated.
 */
const missingInstallNote = (acceptance: readonly string[], failures: CommandResult[]): string => {
  // 127 is the shell's "command not found"; npm reports the same through its wrapper.
  const notFound = failures.some(
    (f) => f.code === 127 || /: (command )?not found/i.test(f.output),
  );
  if (!notFound) return "";
  if (acceptance.some(installsDependencies)) return "";

  return (
    "\n\nNOTE: a command was not found, and no acceptance command installs dependencies " +
    "(`npm ci`, `npm install`, `pnpm install`, `yarn install`, `bundle install`, " +
    "`pip install`, `go mod download`, `cargo fetch`, or a `nix`/`make` step that does " +
    "it). The list is then graded against whatever a previous session left in the " +
    "worktree, so it can pass once and fail later on an unchanged commit. Before " +
    "treating this as a code defect, check whether the acceptance criteria are missing " +
    "their install step \u2014 that is a change to the task's spec, not to the repository."
  );
};

/** Does this command populate the dependency tree the later commands need? */
const installsDependencies = (command: string): boolean =>
  /\b(npm|pnpm|yarn)\s+(ci|install|i)\b/.test(command) ||
  /\bbundle\s+install\b/.test(command) ||
  /\bpip3?\s+install\b/.test(command) ||
  /\bgo\s+mod\s+(download|tidy)\b/.test(command) ||
  /\bcargo\s+(fetch|build)\b/.test(command) ||
  /\bnix\s+(build|develop|shell)\b/.test(command) ||
  /\bmake\s+(deps|install|setup|bootstrap)\b/.test(command);
