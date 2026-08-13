/**
 * Forgejo / Codeberg forge. See DESIGN.md §9.4.
 *
 * STUB — signatures settled, HTTP calls not implemented.
 *
 * Unlike GitHub there is no installation-token equivalent, so tokens are
 * pre-created rather than minted:
 *
 *   - one repository-scoped token per repo, created in the UI with scopes
 *     `write:repository` + `write:issue` and NOTHING else
 *   - `write:repository` covers pull requests (the `repository` scope is documented
 *     as "repository files, pull requests, and releases")
 *   - tokens have NO expiry, so rotation is a scheduled chore, not a free property
 *
 * Creating tokens via the API requires basic auth, which would mean storing the
 * account password — strictly worse than storing a scoped token. Do not do it.
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

export interface ForgejoOptions {
  readonly apiBase: string;
  /** Account the tokens belong to — used as the git username. */
  readonly username: string;
  /**
   * Repo-scoped tokens keyed by `owner/name`. Resolved from the mounted SOPS
   * secret. A repo without an entry is unusable by design: no fallback to a
   * broader token, ever.
   */
  readonly tokensByRepo: ReadonlyMap<string, string>;
}

export class MissingRepoTokenError extends Error {
  constructor(slug: string) {
    super(
      `no repository-scoped Forgejo token configured for ${slug} — create one with ` +
        `write:repository + write:issue limited to that repo, then add it to the secret`,
    );
    this.name = "MissingRepoTokenError";
  }
}

class ForgejoForge implements Forge {
  readonly kind = "forgejo";

  constructor(
    private readonly options: ForgejoOptions,
    private readonly allowed: readonly RepoRef[],
  ) {}

  async credential(repo: RepoRef): Promise<GitCredential> {
    assertInScope(repo, this.allowed);
    const slug = `${repo.owner}/${repo.name}`;
    const token = this.options.tokensByRepo.get(slug);
    if (token === undefined) throw new MissingRepoTokenError(slug);

    // No expiresAt: Forgejo tokens do not expire. Rotation is external.
    return { username: this.options.username, password: token };
  }

  async openPr(repo: RepoRef, request: PrRequest): Promise<PrResult> {
    assertInScope(repo, this.allowed);
    void request;
    // POST {apiBase}/repos/{owner}/{repo}/pulls  — Authorization: token <t>
    throw new Error("ForgejoForge.openPr not implemented");
  }

  async checks(repo: RepoRef, ref: string): Promise<CheckStatus> {
    assertInScope(repo, this.allowed);
    void ref;
    // GET {apiBase}/repos/{owner}/{repo}/commits/{ref}/status
    throw new Error("ForgejoForge.checks not implemented");
  }

  async revoke(): Promise<void> {
    // Nothing to revoke — these tokens are long-lived and externally rotated.
  }
}

export class ForgejoForgeFactory implements ForgeFactory {
  constructor(private readonly options: ForgejoOptions) {}

  async forTask(spec: TaskSpec): Promise<Forge> {
    return new ForgejoForge(this.options, spec.repos);
  }
}
