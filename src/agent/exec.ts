/**
 * The agent's shell, with a hang detector and an output ceiling on it. See DESIGN.md §6.4.
 *
 * pi's `ShellExecOptions.timeout` is documented as *"Defaults to no timeout"*, and the
 * bash tool passes through whatever the model asked for. So the MODEL decides whether a
 * command may block forever — and models routinely omit it, because in an interactive
 * harness a human is watching and can hit ctrl-C. Nobody is watching here.
 *
 * This is not hypothetical. A review council reviewer ran `npm test` in a task worktree,
 * one test subprocess never exited, and the reviewer sat in that tool call for **two hours
 * and forty-two minutes** — holding the task's lease, renewing it on schedule, answering
 * `/healthz` with 200 the whole time. At the time everything in the supervisor was one
 * loop, so the chat drain and intake stopped with it too; housekeeping has since been split
 * onto its own timer (§6.4), which contains that half of the damage but not this one — the
 * task itself is still wedged. From outside it was indistinguishable from careful work.
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
 *
 * ## The same argument for how much a command may RETURN
 *
 * The ceiling above bounds how long a command runs. Nothing bounded how much it hands
 * back, and the two failures do not look alike: a 40,000-line `grep` succeeds in a second
 * and quietly spends a large share of the context window that §6.1's handoff threshold
 * exists to protect. The session then hands off early, with a journal that can only say it
 * ran out of room.
 *
 * `budget.ts` decides what to keep. This file decides where the bound is applied, and that
 * is the subtle part: **pi's bash tool reads the streaming `onStdout`/`onStderr` callbacks
 * and ignores the `stdout` this method returns.** Bounding the return value alone would
 * leave the model's own view unbounded. So the caller's callbacks are withheld for the
 * duration of the command, the whole output is accumulated here, and one bounded chunk is
 * handed over just before `exec` resolves.
 *
 * Three consequences, all accepted deliberately:
 *
 *   - pi's own truncation becomes a no-op, because what reaches it is already inside its
 *     limits. That is the point: its ceiling was a constant no config could lower, it kept
 *     the tail alone, and it spilled the rest to a `tmpdir` file outside the worktree that
 *     is reaped on a schedule of its own.
 *   - The overflow goes to the task's scratch directory instead, so the agent can read it
 *     in slices and it dies with the task rather than outliving it.
 *   - Progress updates arrive when the command ends rather than while it runs. Nothing here
 *     consumes them — the live view (§18) renders settled messages — and the alternative is
 *     streaming unbounded output into the window, which is the bug.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionError, Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import type { Logger } from "../obs/log.ts";
import { boundOutput, willElide, type OutputCeiling } from "./budget.ts";

export interface BoundedExecutionEnvOptions {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
  /** Ceiling AND default for one command, in seconds. */
  readonly timeoutSeconds: number;
  /**
   * Ceiling AND default on what ONE command may return.
   *
   * Required rather than optional, for the reason `SessionOptions.timeoutSeconds` is: a
   * new call site has to decide, instead of inheriting a default that turns out to mean
   * "no limit". `outputCeiling({})` is the answer for a caller with no opinion.
   */
  readonly output: OutputCeiling;
  /**
   * Directory the overflow of a bounded command is written to.
   *
   * The task's `.caterpillar` scratch directory in practice — beside the checkout rather
   * than inside it, so a spill is never committable, and reaped with the task directory
   * rather than accumulating on the work volume.
   */
  readonly overflowDir: string;
  readonly logger: Logger;
  /** Task this shell belongs to, for the log line. */
  readonly task: string;
}

export class BoundedExecutionEnv extends NodeExecutionEnv {
  private readonly timeoutSeconds: number;
  private readonly output: OutputCeiling;
  private readonly overflowDir: string;
  private readonly logger: Logger;
  private readonly task: string;

  constructor(options: BoundedExecutionEnvOptions) {
    super({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
    });
    this.timeoutSeconds = options.timeoutSeconds;
    this.output = options.output;
    this.overflowDir = options.overflowDir;
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

    // Withheld from the caller until the command ends, then handed over bounded. See the
    // header: these callbacks, not the returned `stdout`, are what pi's bash tool reads.
    //
    // The whole output is held in memory, which is a second copy of what `NodeExecutionEnv`
    // is already accumulating for its return value — so a command that produces a gigabyte
    // costs twice what it did, having already been unbounded. Not fixed here because
    // trimming a rolling buffer while streaming the rest to disk is what pi's own capture
    // does and it is the reason its truncation is tail-only: the head is gone by the time
    // the command ends. Keeping the head is the point (a compiler's first error), and
    // `limits.commandTimeoutSeconds` bounds how long a runaway command has to produce
    // output at all.
    let captured = "";
    const started = Date.now();
    const result = await super.exec(command, {
      ...options,
      timeout: bounded,
      onStdout: (chunk) => {
        captured += chunk;
      },
      onStderr: (chunk) => {
        captured += chunk;
      },
    });
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

    // Both channels through one bound, because a stack trace on stderr spends the same
    // window as a log on stdout and the model reads them interleaved anyway.
    //
    // Emitted before the failure is returned: a `npm test` cut off for time still produced
    // the output that says how far it got, and withholding that from a failed command would
    // hide exactly what a session needs to decide what to do next.
    const view = await this.boundedView(captured);
    if (view.length > 0) options?.onStdout?.(view);

    if (!result.ok) return result;
    // The return value carries the same bounded view, so the ceiling does not depend on
    // which half of `ExecutionEnv`'s contract a caller uses. Every caller today reads the
    // callbacks — pi's four tools are the only ones — but the two channels carry the same
    // output, and leaving one of them unbounded would make the next caller the exception.
    //
    // `stderr` is emptied rather than bounded separately: `view` already holds both streams
    // interleaved, and a second copy would charge the same output to the window twice.
    return { ok: true, value: { ...result.value, stdout: view, stderr: "" } };
  }

  /**
   * The bounded view of one command's output, having first spilled the whole of it.
   *
   * The spill happens BEFORE the note is composed, because the note names the file: a note
   * pointing at a path that does not exist sends the session to read something that is not
   * there, which is worse than telling it plainly that the rest is gone.
   */
  private async boundedView(whole: string): Promise<string> {
    // The common case first, and it must cost nothing: no spill and no second pass over the
    // string. A spill per `git status` would fill the work volume with logs nothing will
    // ever read.
    if (!willElide(whole, this.output)) return whole;

    const overflowPath = await this.spill(whole);
    const bounded = boundOutput(whole, this.output, {
      ...(overflowPath === undefined ? {} : { overflowPath }),
    });

    // `info`, between `exec.bounded`'s `debug` and `exec.timeout`'s `warn`. Nothing has
    // gone wrong — the ceiling did its job — but unlike the timeout default this does not
    // fire on every command, only on the wide ones, so it is not the noise `exec.bounded`
    // would be at this level. And it is the line an operator wants when a task keeps
    // handing off early: it says where the window went.
    this.logger.info("exec.output-bounded", {
      task: this.task,
      totalLines: bounded.totalLines,
      droppedLines: bounded.droppedLines,
      // Absent, not null, when the spill failed — the same reason `exec.bounded` omits
      // `askedSeconds`: in a log query an absent field and a null one read alike.
      ...(overflowPath === undefined ? {} : { overflowPath }),
    });

    return bounded.text;
  }

  /**
   * Write one command's whole output where the agent can read it, or give up saying so.
   *
   * A failed write must NOT fail the command. The bounded view is still correct and still
   * useful, and a session losing its `grep` because the volume was full would be a worse
   * outcome than losing the overflow — `budget.ts` says out loud that the rest is gone when
   * no path comes back. Logged at `warn`, because a work volume that cannot take a few KB
   * is the operator's problem rather than the agent's.
   */
  private async spill(whole: string): Promise<string | undefined> {
    // A UUID rather than a counter: two shells can share one overflow directory — the
    // council runs five reviewers over one task — and a per-instance counter would have
    // them overwrite each other's logs.
    const path = join(this.overflowDir, `${randomUUID()}.log`);
    try {
      await mkdir(this.overflowDir, { recursive: true });
      await writeFile(path, whole, "utf8");
      return path;
    } catch (error) {
      this.logger.warn("exec.output-spill-failed", {
        task: this.task,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
