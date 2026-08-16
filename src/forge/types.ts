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

export interface MergeOptions {
  /** Defaults to `squash`, which is how every change in these repos has landed. */
  readonly method?: "merge" | "squash" | "rebase";
  readonly title?: string;
}

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
   * Submit an APPROVING review on a pull request.
   *
   * Only ever called through a REVIEWER identity, never the one that opened the PR.
   * GitHub refuses to let an author approve their own pull request, which is precisely
   * what makes branch protection a real gate rather than a formality (DESIGN.md §9.1) —
   * so an approval from the authoring App would be rejected, and one that succeeded
   * would mean the gate had been removed.
   */
  approve(repo: RepoRef, pr: number, body: string): Promise<void>;

  /**
   * Merge a pull request.
   *
   * Authorised by the same `pull_requests: write` that opens one — there is no separate
   * merge scope on either forge. What stops an unreviewed merge is branch protection,
   * not the token (DESIGN.md §9.1).
   */
  merge(repo: RepoRef, pr: number, options?: MergeOptions): Promise<void>;

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

/**
 * The bound the CONFIGURATION puts on the repos a task may name.
 *
 * `spec.repos` is not a security boundary and never was: it is free text out of an
 * issue body, a Discord message, or a plan the previous agent wrote. Checking a
 * credential request against it — which is what `assertInScope` alone does — compares
 * an attacker-chosen value with an attacker-chosen list. This is the check that is
 * anchored to something the operator wrote: the workspace's own forge host, and the
 * state repo that no task may ever reach (DESIGN.md §9.3).
 */
export interface WorkspaceScope {
  /** `forge.host` of the workspace profile. A repo anywhere else is refused. */
  readonly host: string;
  /**
   * The supervisor's state repo, when it is known. Optional only because a local
   * development checkout may have a URL we cannot parse into a ref; in the cluster it
   * is always present.
   */
  readonly stateRepo?: RepoRef;
}

export class RepoOffWorkspaceError extends Error {
  constructor(repo: RepoRef, host: string) {
    super(
      `repo ${repo.host}/${repo.owner}/${repo.name} is not on '${host}', the forge this ` +
        `workspace holds a credential for. A task may only name repos on its own forge — ` +
        `a foreign host would be cloned with the credential helper attached, which is how ` +
        `a token reaches a server the operator never configured`,
    );
    this.name = "RepoOffWorkspaceError";
  }
}

export class StateRepoOutOfScopeError extends Error {
  constructor(repo: RepoRef) {
    super(
      `repo ${repo.host}/${repo.owner}/${repo.name} is the supervisor's own state repo — ` +
        `no task credential may reach it (DESIGN.md §9.3). The audit trail cannot be ` +
        `writable by the thing being audited`,
    );
    this.name = "StateRepoOutOfScopeError";
  }
}

/**
 * Compare two refs the way the forges resolve them.
 *
 * Case-INSENSITIVE, deliberately: DNS is case-insensitive, and GitHub resolves
 * `Caterpillar-State` and `caterpillar-state` to the same repository. An exclusion
 * that `===` can be walked around by changing one letter is not an exclusion.
 */
export const isSameRepo = (a: RepoRef, b: RepoRef): boolean =>
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

/**
 * Guard against the configured bound. Throws unless `repo` is one this workspace's
 * credential is allowed to reach at all — regardless of what the task declared.
 */
export const assertWorkspaceScope = (repo: RepoRef, scope: WorkspaceScope): void => {
  if (repo.host.toLowerCase() !== scope.host.toLowerCase()) {
    throw new RepoOffWorkspaceError(repo, scope.host);
  }
  if (scope.stateRepo !== undefined && isSameRepo(repo, scope.stateRepo)) {
    throw new StateRepoOutOfScopeError(repo);
  }
};
