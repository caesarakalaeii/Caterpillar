/**
 * The agent's shell, with a hang detector on it. See DESIGN.md §6.4.
 *
 * pi's `ShellExecOptions.timeout` is documented as *"Defaults to no timeout"*, and the
 * bash tool passes through whatever the model asked for. So the MODEL decides whether a
 * command may block forever — and models routinely omit it, because in an interactive
 * harness a human is watching and can hit ctrl-C. Nobody is watching here.
 *
 * This is not hypothetical. A review council reviewer ran `npm test` in a task worktree,
 * one test subprocess never exited, and the reviewer sat in that tool call for **two hours
 * and forty-two minutes** — holding the task's lease, renewing it on schedule, answering
 * `/healthz` with 200 the whole time. Everything in the supervisor is single-threaded, so
 * the poll loop, the chat drain and intake stopped with it. From outside it was
 * indistinguishable from a runner doing careful work.
 *
 * The acceptance gate never had this problem: `verifier.ts` has always passed a 15-minute
 * `timeout` to `execFile`. That asymmetry was the whole bug — the gate could not wedge and
 * the agent that had to satisfy it could.
 *
 * So the ceiling moves out of the model's hands:
 *
 *   - **No timeout becomes the default timeout.** The common case, and the one that wedged.
 *   - **A timeout longer than the ceiling is CLAMPED.** Without this the fix is advisory:
 *     a model that has learned to pass `timeout: 86400` for a slow build reintroduces the
 *     hang, and it would look like the protection was working.
 *
 * A clamp rather than a refusal because the model is not doing anything wrong by asking —
 * it cannot know what this runner will tolerate, and an error it has to interpret costs a
 * turn to discover something the harness can simply decide.
 */
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionError, Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import type { Logger } from "../obs/log.ts";

export interface BoundedExecutionEnvOptions {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
  /** Ceiling AND default for one command, in seconds. */
  readonly timeoutSeconds: number;
  readonly logger: Logger;
  /** Task this shell belongs to, for the log line. */
  readonly task: string;
}

export class BoundedExecutionEnv extends NodeExecutionEnv {
  private readonly timeoutSeconds: number;
  private readonly logger: Logger;
  private readonly task: string;

  constructor(options: BoundedExecutionEnvOptions) {
    super({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
    });
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = options.logger;
    this.task = options.task;
  }

  override async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const asked = options?.timeout;
    const bounded = asked === undefined ? this.timeoutSeconds : Math.min(asked, this.timeoutSeconds);

    if (asked === undefined || asked > this.timeoutSeconds) {
      // `debug`, not `warn`. On a healthy runner every command the model does not
      // time-bound takes this path, so at `info` it would be the noisiest line the
      // supervisor emits — and it says nothing has gone wrong, only that a ceiling was
      // supplied. The line that matters is `exec.timeout` below.
      this.logger.debug("exec.bounded", {
        task: this.task,
        // Omitted rather than null when the model asked for nothing: "the field is absent"
        // and "the field is null" read the same in a log query, and absent is the truth.
        ...(asked === undefined ? {} : { askedSeconds: asked }),
        appliedSeconds: bounded,
      });
    }

    const started = Date.now();
    const result = await super.exec(command, { ...options, timeout: bounded });
    const elapsed = Math.round((Date.now() - started) / 1000);

    // Within a second of the ceiling and failed: almost certainly the timeout firing
    // rather than the command deciding to fail. Logged at `warn` because it is the
    // signature of the hang this class exists to bound, and because the model is about to
    // be told its command failed without being told why — the operator should be able to
    // see the difference between a broken test and a wedged one.
    if (!result.ok && elapsed >= bounded - 1) {
      this.logger.warn("exec.timeout", {
        task: this.task,
        elapsedSeconds: elapsed,
        limitSeconds: bounded,
        // The command is model-authored and can quote a repository, but it is also the
        // single most useful field when a runner keeps timing out. Truncated, never
        // omitted.
        command: command.length > 200 ? `${command.slice(0, 200)}…` : command,
      });
    }

    return result;
  }
}
