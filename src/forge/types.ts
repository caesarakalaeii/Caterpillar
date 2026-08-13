/**
 * Forge abstraction. See DESIGN.md §9.4.
 *
 * Two implementations exist (GitHub App, Forgejo/Codeberg). The agent never learns
 * which one it is running against, let alone the token: pushes go through a git
 * credential helper, and PR creation is a supervisor-implemented tool.
 *
 * Implementations MUST NOT return tokens to callers outside this module boundary,
 * and MUST NOT place them in process arguments. Session transcripts are committed
 * to git, so a token in argv becomes a token in git history (DESIGN.md §9.2).
 */
import type { RepoRef, TaskSpec } from "../domain/task.ts";

/** Credentials for one repo, shaped for git's credential helper protocol. */
export interface GitCredential {
  readonly username: string;
  readonly password: string;
  /** Epoch millis after which this credential must be re-minted. */
  readonly expiresAt?: number;
}

export interface PrRequest {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export interface PrResult {
  readonly number: number;
  readonly url: string;
}

export type CheckConclusion = "pending" | "success" | "failure" | "none";

export interface CheckStatus {
  readonly conclusion: CheckConclusion;
  /** Human-readable detail for the journal and Discord. */
  readonly summary: string;
}

/**
 * Everything the supervisor needs from a forge. One instance is bound to one
 * workspace profile and one task's repo scope.
 */
export interface Forge {
  readonly kind: string;

  /**
   * Mint (or return a cached) credential for `repo`.
   *
   * Callers must treat the result as write-only: hand it to the credential helper,
   * never log it, never persist it.
   */
  credential(repo: RepoRef): Promise<GitCredential>;

  openPr(repo: RepoRef, request: PrRequest): Promise<PrResult>;

  /** CI state for a ref — the second gate in DESIGN.md §12. */
  checks(repo: RepoRef, ref: string): Promise<CheckStatus>;

  /**
   * Release any cached credentials. Called when a task completes or parks, so a
   * token does not outlive the work it was minted for.
   */
  revoke(): Promise<void>;
}

/**
 * Builds a Forge scoped to exactly the repos a task declared.
 *
 * Scoping happens here, not at call sites: a Forge handed a repo outside
 * `spec.repos` must throw rather than mint (DESIGN.md §9.1).
 */
export interface ForgeFactory {
  forTask(spec: TaskSpec): Promise<Forge>;
}

export class RepoOutOfScopeError extends Error {
  constructor(repo: RepoRef, allowed: readonly RepoRef[]) {
    const allowedList = allowed.map((r) => `${r.owner}/${r.name}`).join(", ");
    super(
      `repo ${repo.owner}/${repo.name} is not in this task's scope (allowed: ${allowedList || "none"})`,
    );
    this.name = "RepoOutOfScopeError";
  }
}

/** Guard for implementations: throws unless `repo` was declared by the task. */
export const assertInScope = (repo: RepoRef, allowed: readonly RepoRef[]): void => {
  const ok = allowed.some(
    (r) => r.host === repo.host && r.owner === repo.owner && r.name === repo.name,
  );
  if (!ok) throw new RepoOutOfScopeError(repo, allowed);
};
