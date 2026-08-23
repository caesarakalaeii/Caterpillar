/**
 * Independent completion verification. See DESIGN.md §12.
 *
 * Runs in the SUPERVISOR, never in the agent. Both gates must pass:
 *   1. every acceptance command in spec.md exits 0
 *   2. a PR is open and CI is green
 *
 * The agent cannot influence this: it does not choose the commands, does not run
 * them, and does not report the result. `done` only triggers this check.
 *
 * Gate 1 also COLLECTS. A command's exit code cannot say what a change renders, so a gate
 * that writes a screenshot, a trace or a report into `CATERPILLAR_EVIDENCE_DIR` has it
 * published as a task artifact (§17) whether the gate passed or failed. That is evidence for
 * a human and for the review council; it never decides the verdict. See `collectEvidence`.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isArtifactName } from "../state/store.ts";
import {
  repoSlug,
  taskPullRequests,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import type { CheckStatus, Forge, ForgeFactory } from "../forge/types.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { TASK_SHELL_ARGS, type ToolchainResolver } from "../workspace/toolchain.ts";
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

/**
 * One acceptance command.
 *
 * `env` is passed alongside the shell rather than taken from a `ResolvedEnv` because gate 1
 * adds one variable of its own to it — `CATERPILLAR_EVIDENCE_DIR`. The shell still comes
 * from the resolver, which is the half that must not drift from the agent's own
 * (`workspace/toolchain.ts`).
 */
const runCommand = (
  command: string,
  cwd: string,
  shell: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      shell,
      [...TASK_SHELL_ARGS, command],
      { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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
  /**
   * Where a gate may leave evidence, and where that evidence goes afterwards.
   *
   * Optional so a verifier can still be built without a state repo — which most of this
   * module's own tests do, and which is why `CATERPILLAR_EVIDENCE_DIR` is absent rather
   * than empty when this is omitted. A gate testing `-d "$CATERPILLAR_EVIDENCE_DIR"`
   * should get a truthful no.
   */
  readonly evidence?: EvidenceOptions;
}

/**
 * The artifact side of the state repo, and nothing else.
 *
 * `StateStore` satisfies this structurally. Narrow on purpose: the gate has no business
 * with the state repo's mutex, its git, or its journal, and a test of what the gate does
 * with a refusal should not need a clone to express it.
 */
export interface EvidenceStore {
  writeArtifact(task: TaskId, name: string, contents: Buffer): Promise<void>;
}

export interface EvidenceOptions {
  readonly store: EvidenceStore;
  /**
   * The directory this task's gate writes into. A function of the task because the
   * per-task scratch is where it belongs (see `runAcceptance`), and injected because a
   * test must be able to put it somewhere it can inspect.
   */
  readonly dir: (task: TaskId) => string;
}

/** The variable a gate reads to find out where to leave a screenshot, trace or report. */
export const EVIDENCE_DIR_VAR = "CATERPILLAR_EVIDENCE_DIR";

/**
 * Gate 1's verdict, plus the evidence note as its own field.
 *
 * The note is already inside `detail`, and it is repeated here because gate 2 REPLACES
 * `detail` on the passing path. Carrying it separately is what lets `verify` append it to
 * whichever detail the caller ends up reading, rather than only to the one nobody sees.
 */
interface AcceptanceResult extends VerificationResult {
  /** Empty when nothing was collected. Always a string, so a caller can concatenate it. */
  readonly evidence: string;
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

    // Gate 2's detail is what a passing claim reports, and gate 1's is thrown away — so
    // the evidence note has to be carried across, or a green UI gate would publish a
    // screenshot and mention it nowhere.
    const ci = await this.checkCi(spec, state);
    return { ...ci, detail: `${ci.detail}${acceptance.evidence}` };
  }

  /**
   * Gate 1 — the declared commands, run by us in the task's worktree.
   *
   * Evidence is collected AFTER every command has run and BEFORE the verdict is returned,
   * on both paths. A failed UI gate is exactly when the image matters most, so publishing
   * only on success would throw away the evidence in the one case it explains something.
   */
  private async runAcceptance(spec: TaskSpec, repo: RepoRef): Promise<AcceptanceResult> {
    const worktree = await this.options.worktrees.ensureWorktree(repo, spec.id);
    const toolchain = await this.options.toolchain.resolve(spec, worktree);
    const evidenceDir = await this.prepareEvidenceDir(spec);
    const env =
      evidenceDir === undefined
        ? toolchain.env
        : { ...toolchain.env, [EVIDENCE_DIR_VAR]: evidenceDir };
    const failures: CommandResult[] = [];

    for (const command of spec.acceptance) {
      const result = await runCommand(command, worktree, toolchain.shell, env);
      if (result.code !== 0) failures.push(result);
    }

    const evidence = await this.collectEvidence(spec, evidenceDir);

    if (failures.length === 0) {
      return {
        passed: true,
        detail: `${spec.acceptance.length} acceptance command(s) passed${evidence}`,
        evidence,
      };
    }

    const detail = failures
      .map((f) => `\`${f.command}\` exited ${f.code}:\n\n\`\`\`\n${f.output.slice(-2000)}\n\`\`\``)
      .join("\n\n");
    const note = missingInstallNote(spec.acceptance, failures);
    return {
      passed: false,
      detail: `Acceptance criteria failed.\n\n${detail}${note}${evidence}`,
      evidence,
    };
  }

  /**
   * An empty directory for this gate's output, or `undefined` when nothing collects.
   *
   * Emptied rather than merely created, and that is the load-bearing part. The directory
   * lives in the per-task scratch on the work volume, which survives between sessions by
   * design (§6.2) — so a screenshot from three sessions ago would otherwise be published
   * as evidence about a diff it predates, which is worse than no evidence at all.
   *
   * Outside the checkout, for the same reason `runner.ts` stages upstream artifacts
   * outside it: a file in the worktree is a file in `git status`, and the next session to
   * run `git add -A` commits a screenshot into the pull request.
   */
  private async prepareEvidenceDir(spec: TaskSpec): Promise<string | undefined> {
    const evidence = this.options.evidence;
    if (evidence === undefined) return undefined;

    const dir = evidence.dir(spec.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Publish whatever the gate left behind, and say what happened in words.
   *
   * Returns a suffix for the verdict's detail, so the journal and Discord carry it — this
   * is a §17 artifact either way, but a reader looking at a red gate should not have to
   * guess whether the missing screenshot was never written or was too big to keep.
   *
   * **Over the cap the bytes do not land, and the refusal is named.** The caps are the
   * design (§17): every runner clones the state repo and git keeps whatever reaches it
   * forever, and a 4 MB screenshot per failed session would be paid for by every machine
   * in the fleet in perpetuity. Truncating is not an option a reader could use — half a
   * PNG is not a smaller PNG — so the file is refused with its size and the limit beside
   * it, which is enough for a repo to lower its own resolution or write a JPEG instead.
   *
   * **It never changes the verdict.** Nothing in here returns `passed`. An image is
   * evidence for a human and for the council; the exit code is still the whole gate.
   */
  private async collectEvidence(
    spec: TaskSpec,
    dir: string | undefined,
  ): Promise<string> {
    const evidence = this.options.evidence;
    if (evidence === undefined || dir === undefined) return "";

    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.length === 0) return "";

    const published: string[] = [];
    const refused: string[] = [];

    for (const name of names.sort()) {
      if (!isArtifactName(name)) {
        refused.push(
          `\`${name}\` — not a usable artifact name (letters, digits, dot, dash, underscore)`,
        );
        continue;
      }

      const contents = await readFile(join(dir, name)).catch(() => undefined);
      if (contents === undefined) {
        // A directory, a dangling symlink, or a file the gate deleted between the readdir
        // and here. Reported rather than skipped: `playwright test` writes its output as a
        // TREE by default, and a repo that hits this needs to be told why its trace never
        // appeared, not left wondering.
        refused.push(`\`${name}\` — could not be read as a file`);
        continue;
      }

      try {
        await evidence.store.writeArtifact(spec.id, name, contents);
        published.push(`\`${name}\` (${contents.byteLength} bytes)`);
      } catch (error) {
        refused.push(`\`${name}\` — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const lines: string[] = [];
    if (published.length > 0) {
      lines.push(`Evidence published as artifacts: ${published.join(", ")}.`);
    }
    if (refused.length > 0) {
      lines.push(
        `Evidence NOT published:\n${refused.map((r) => `- ${r}`).join("\n")}\n` +
          `The caps on \`artifacts/\` are deliberate (DESIGN.md §17) — every runner clones ` +
          `the state repo and git keeps what lands there forever. Write a smaller file: ` +
          `a lower resolution, a JPEG rather than a PNG, one screenshot rather than a tree.`,
      );
    }

    return lines.length === 0 ? "" : `\n\n${lines.join("\n\n")}`;
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
 * This only annotates — it never changes the verdict. A 127 is still a failure, because
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
    "their install step — that is a change to the task's spec, not to the repository."
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
