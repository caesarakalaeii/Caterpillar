/**
 * The environment every spawned process gets. See DESIGN.md §8.1.
 *
 * A runner is missing toolchains a repo needs — lua here, go there — and until now there
 * was no way to say so. `requires` could not express it (a capability is a fact about a
 * machine, not something a machine can install for itself, §8), and nothing in the
 * supervisor ever SET an environment: all four spawn sites took the inherited one, so the
 * only lever was the base image, which every runner then pays for.
 *
 * This module is that lever. It answers one question — "what environment should this
 * task's commands run in" — and every process the supervisor starts on a task's behalf
 * takes its answer:
 *
 *   agent bash        src/agent/runner.ts
 *   review council    src/review/council.ts
 *   plan maintainer   src/plan/maintain.ts
 *   acceptance gate   src/supervisor/verifier.ts
 *
 * ALL FOUR, from one function, is the point. They used to disagree: the agent got pi's
 * fallback `sh -c` with the supervisor's environment while the verifier got a LOGIN bash
 * that sourced `/etc/profile` and `~/.profile`. A toolchain reachable from a shell profile
 * was therefore visible to the gate and invisible to the agent that had to make it pass —
 * the agent would see `lua: not found`, fix nothing, and watch a gate it could not
 * reproduce. One resolver, one shell, one environment, or the gate is not a gate.
 *
 * Resolution happens ONCE per session, not once per command. A command wrapper would put
 * quoting between the model and its own shell, and would re-pay the resolve on every
 * `bash` call the agent makes.
 */
import { execFile } from "node:child_process";
import type { TaskSpec } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";

/**
 * How a task's environment is produced.
 *
 * `inherit` — the supervisor's own environment, which is what every task got before this
 * existed and what every task without a declaration still gets.
 */
export type ToolchainMode = "inherit";

export interface ResolvedEnv {
  /**
   * Passed verbatim to `NodeExecutionEnv({ shellEnv })` and `execFile({ env })`.
   *
   * The two consume it differently and the difference is load-bearing: `execFile`
   * REPLACES the environment, while pi's `getShellEnv` OVERLAYS — `{...process.env,
   * ...shellEnv}`. They agree only because this map is always built up from the
   * supervisor's own environment rather than assembled from nothing. A future mode that
   * returns a bare env would silently be additive for the agent and exact for the
   * acceptance gate, which is the divergence this module exists to prevent.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * ABSOLUTE path to the shell, not a name to look up. pi resolves `shellPath` with a
   * filesystem check and rejects anything it cannot stat, and handing `execFile` a bare
   * name would let the two sides find different binaries through different PATHs — which
   * is the divergence this module exists to close.
   */
  readonly shell: string;
  /**
   * Where it came from, in words — "inherited", "flake.nix devShell". Named in the
   * prompt so the agent knows what it has, and in the journal so a red gate can be read
   * back to an environment months later.
   */
  readonly source: string;
}

/**
 * A toolchain that was declared and could not be produced.
 *
 * Thrown, never swallowed. A task whose environment failed to materialise must PARK with
 * this message rather than fall through to the inherited one: falling through hands the
 * agent a shell missing the exact tool the task is about, and it spends a session (and a
 * few dollars) discovering that by hand.
 *
 * Declared as a field and assigned in the constructor rather than as a parameter
 * property — a parameter property emits runtime code and fails to LOAD under node's
 * type-stripping (DESIGN.md §16).
 */
export class ToolchainError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "ToolchainError";
    this.source = source;
  }
}

export interface ToolchainResolverOptions {
  readonly logger: Logger;
  /**
   * The environment to inherit from. Injectable so a test does not have to mutate
   * `process.env`, which leaks across node's in-process test runner.
   */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export class ToolchainResolver {
  private readonly logger: Logger;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /** Memoised: the shell does not move while the process runs, and every task asks. */
  private shell: Promise<string> | undefined;

  constructor(options: ToolchainResolverOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  /**
   * The environment for one task's commands.
   *
   * `worktree` is unused by `inherit` and is the repo checkout every later mode reads its
   * declaration from — it is in the signature now so adding one does not touch four call
   * sites again.
   */
  async resolve(spec: TaskSpec, worktree: string): Promise<ResolvedEnv> {
    void worktree;
    const resolved: ResolvedEnv = {
      env: { ...this.baseEnv },
      shell: await this.taskShell(),
      source: "inherited",
    };
    this.logger.debug("toolchain.resolved", {
      task: spec.id,
      source: resolved.source,
      shell: resolved.shell,
    });
    return resolved;
  }

  private taskShell(): Promise<string> {
    this.shell ??= findBash(this.baseEnv).then((found) => {
      if (found === undefined) {
        // Falling back to `sh` is what pi does, and it is the wrong answer here: the
        // acceptance gate has always been bash, so a repo whose acceptance command uses a
        // heredoc or a process substitution would pass for the agent and fail at the gate
        // for reasons neither could see.
        throw new ToolchainError(
          "shell",
          "no bash on PATH. The agent's shell and the acceptance gate's must be the " +
            "same interpreter; install bash on this runner.",
        );
      }
      this.logger.debug("toolchain.shell", { shell: found });
      return found;
    });
    return this.shell;
  }
}

/**
 * NOT a login shell.
 *
 * `bash -lc` sources `/etc/profile`, which on alpine ASSIGNS `PATH` outright rather than
 * appending to it. Any environment handed in would be silently overwritten between
 * `execFile` and the command — the resolver would work, the logs would say so, and the
 * command would still not find its toolchain.
 */
export const TASK_SHELL_ARGS: readonly string[] = ["-c"];

/**
 * Bash, as an absolute path, found through the environment the task will actually run in.
 *
 * Asked rather than assumed: `/bin/bash` does not exist on NixOS — bash lives under
 * `/run/current-system/sw/bin` — and NixOS is one of the two hosts this runs on. An
 * absolute path is what comes back because pi stats `shellPath` and refuses a bare name
 * (see `ResolvedEnv.shell`).
 *
 * Asked through `/bin/sh`, which is the one FHS path every target keeps, with `command -v`
 * rather than `which` — `which` is a separate package that alpine does not install.
 */
const findBash = (env: NodeJS.ProcessEnv): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "command -v bash"], { env }, (error, stdout) => {
      const path = stdout.split("\n")[0]?.trim();
      resolve(error !== null || path === undefined || path.length === 0 ? undefined : path);
    });
  });
