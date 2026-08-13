/**
 * Thin, typed wrapper around the git CLI.
 *
 * Deliberately a process wrapper rather than a library: the lease protocol
 * (DESIGN.md §5) depends on `--force-with-lease` semantics that only the real git
 * implements faithfully, and getting that subtly wrong would break mutual exclusion.
 *
 * Credentials are NEVER passed as arguments. `credential.helper` is configured to
 * an external helper so tokens stay out of argv (DESIGN.md §9.2).
 */
import { execFile } from "node:child_process";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    this.name = "GitError";
  }
}

const run = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });

export class Git {
  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Run git in a different directory, sharing environment. */
  at(cwd: string): Git {
    return new Git(cwd, this.env);
  }

  /** Run git with extra environment (e.g. a scoped credential helper). */
  withEnv(extra: NodeJS.ProcessEnv): Git {
    return new Git(this.cwd, { ...this.env, ...extra });
  }

  /** Throws GitError on non-zero exit. */
  async run(...args: readonly string[]): Promise<string> {
    const result = await run(this.cwd, args, this.env);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout.trim();
  }

  /** Never throws — for probes where failure is a legitimate answer. */
  async tryRun(...args: readonly string[]): Promise<GitResult> {
    return run(this.cwd, args, this.env);
  }

  async revParse(ref: string): Promise<string | undefined> {
    const result = await this.tryRun("rev-parse", "--verify", "--quiet", ref);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** Object id of a remote ref, or undefined when it does not exist. */
  async lsRemote(remote: string, ref: string): Promise<string | undefined> {
    const out = await this.run("ls-remote", remote, ref);
    const line = out.split("\n").find((l) => l.trim().length > 0);
    return line?.split(/\s+/)[0];
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const out = await this.run("status", "--porcelain");
    return out.length > 0;
  }

  /** Commit timestamp as epoch seconds. */
  async commitTime(oid: string): Promise<number> {
    const out = await this.run("show", "-s", "--format=%ct", oid);
    return Number.parseInt(out, 10);
  }
}
