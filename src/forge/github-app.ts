/**
 * GitHub App forge. See DESIGN.md §9.1.
 *
 * STUB — signatures and the security-relevant flow are settled; the HTTP calls are not
 * implemented yet.
 *
 * Mint flow:
 *   1. sign a JWT with the App private key (max 10 minute expiry)
 *   2. POST /app/installations/{id}/access_tokens with
 *        { repositories: [...spec.repos], permissions: { contents: "write",
 *          pull_requests: "write" } }
 *      — scoped NARROWER than the App itself, per task
 *   3. token is valid 1 hour; re-mint on demand rather than caching past expiry
 *
 * No merge permission, no admin, no workflow scope.
 */
import type { RepoRef, TaskSpec } from "../domain/task.ts";
import {
  assertInScope,
  type CheckStatus,
  type Forge,
  type ForgeFactory,
  type GitCredential,
  type PrRequest,
  type PrResult,
} from "./types.ts";

/** Re-mint this long before expiry so a long push never straddles the boundary. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;

export interface GitHubAppOptions {
  readonly appId: string;
  readonly installationId: string;
  /** PEM contents. Read from the mounted SOPS secret; never logged. */
  readonly privateKeyPem: string;
  readonly apiBase: string;
}

class GitHubAppForge implements Forge {
  readonly kind = "github";
  private cached: GitCredential | undefined;

  constructor(
    private readonly options: GitHubAppOptions,
    private readonly allowed: readonly RepoRef[],
  ) {}

  async credential(repo: RepoRef): Promise<GitCredential> {
    assertInScope(repo, this.allowed);

    const cached = this.cached;
    if (cached?.expiresAt !== undefined && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
      return cached;
    }
    return this.mint();
  }

  async openPr(repo: RepoRef, request: PrRequest): Promise<PrResult> {
    assertInScope(repo, this.allowed);
    void request;
    throw new Error("GitHubAppForge.openPr not implemented");
  }

  async checks(repo: RepoRef, ref: string): Promise<CheckStatus> {
    assertInScope(repo, this.allowed);
    void ref;
    throw new Error("GitHubAppForge.checks not implemented");
  }

  async revoke(): Promise<void> {
    // DELETE /installation/token invalidates the current installation token.
    this.cached = undefined;
  }

  /**
   * TODO: sign the JWT (RS256, iss=appId, exp<=10min) and exchange it for an
   * installation token scoped to `this.allowed`. `username` is the literal
   * `x-access-token`; the token is the password.
   */
  private async mint(): Promise<GitCredential> {
    void this.options;
    throw new Error("GitHubAppForge.mint not implemented");
  }
}

export class GitHubAppForgeFactory implements ForgeFactory {
  constructor(private readonly options: GitHubAppOptions) {}

  async forTask(spec: TaskSpec): Promise<Forge> {
    return new GitHubAppForge(this.options, spec.repos);
  }
}
