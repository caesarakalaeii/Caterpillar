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
  readonly args: readonly string[];
  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    this.args = args;
    this.result = result;
    this.name = "GitError";
  }
}

/**
 * Applied to every invocation.
 *
 * Commit signing is forced OFF because the supervisor commits as a bot identity that
 * has no signing key. A machine runner (DESIGN.md §3) inherits the operator's global
 * git config, and `commit.gpgsign = true` there — the default once anyone sets up SSH
 * signing — makes every state and lease commit fail with an error that names the
 * signing agent rather than anything in this system.
 */
const GLOBAL_ARGS: readonly string[] = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

const run = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...GLOBAL_ARGS, ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });

/**
 * Supplies credential environment for a single git invocation, resolved per call so a
 * short-lived token can be re-minted rather than captured at construction.
 */
export type GitEnvProvider = () => Promise<NodeJS.ProcessEnv>;

export class Git {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Bound to ONE repo's credential. Deliberately not inherited — see `at`. */
  private readonly envProvider: GitEnvProvider | undefined;

  constructor(cwd: string, env: NodeJS.ProcessEnv = process.env, envProvider?: GitEnvProvider) {
    this.cwd = cwd;
    this.env = env;
    this.envProvider = envProvider;
  }

  /**
   * Run git in a different directory, sharing environment.
   *
   * The credential provider is deliberately DROPPED. It carries an `http.extraHeader`
   * for one specific remote, and git sends that header on every HTTP request it makes:
   * inherited into a task worktree, a state-repo GitHub token would be sent to
   * Codeberg on the next push.
   */
  at(cwd: string): Git {
    return new Git(cwd, this.env);
  }

  /**
   * The same directory and environment, with the credential provider DROPPED.
   *
   * For callers that keep the directory but must not keep the credential — notably the
   * workspace mirrors, whose clone runs in the supervisor's own cwd. `at()` already
   * drops the provider, so anything that changes directory is safe; this covers the
   * case that does not, which is precisely where it went wrong: the state repo's Git
   * was handed to `WorktreeManager` verbatim, so `git clone` of a TASK repo went out
   * carrying the state repo's `http.extraHeader`. GitHub answers a valid-but-
   * unauthorised token with `Repository not found` and never issues the 401 that would
   * make git consult the credential helper, so the correct token was never even asked
   * for. Against Codeberg the same bug sends a GitHub token to another host outright.
   */
  withoutCredentials(): Git {
    return new Git(this.cwd, this.env);
  }

  /** Run git with extra environment (e.g. a scoped credential helper). */
  withEnv(extra: NodeJS.ProcessEnv): Git {
    return new Git(this.cwd, { ...this.env, ...extra });
  }

  /** Throws GitError on non-zero exit. */
  async run(...args: readonly string[]): Promise<string> {
    const result = await run(this.cwd, args, await this.resolveEnv());
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout.trim();
  }

  /** Never throws — for probes where failure is a legitimate answer. */
  async tryRun(...args: readonly string[]): Promise<GitResult> {
    return run(this.cwd, args, await this.resolveEnv());
  }

  private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
    // Never prompt. Without a credential git blocks on a terminal read, and on a
    // machine runner that has one, a supervisor waiting forever on a username is
    // indistinguishable from a hung task. Overridable by an explicit provider.
    const base: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", ...this.env };
    if (this.envProvider === undefined) return base;
    return { ...base, ...(await this.envProvider()) };
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
