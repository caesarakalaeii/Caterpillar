/**
 * Forgejo / Codeberg forge. See DESIGN.md §9.4.
 *
 * Unlike GitHub there is no installation-token equivalent, so tokens are pre-created
 * rather than minted:
 *
 *   - one repository-scoped token per repo, created in the UI with scopes
 *     `write:repository` + `write:issue` and NOTHING else
 *   - `write:repository` covers pull requests (the `repository` scope is documented
 *     as "repository files, pull requests, and releases")
 *   - tokens have NO expiry, so rotation is a scheduled chore, not a free property
 *
 * Creating tokens via the API requires basic auth, which would mean storing the
 * account password — strictly worse than storing a scoped token. Do not do it.
 *
 * Forgejo also has NO Checks API: Forgejo Actions and external CI both report through
 * commit statuses, so the combined-status endpoint is the only CI signal, and it has
 * states GitHub does not (`error`, `warning`).
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

export class ForgejoApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    body: string,
  ) {
    const hint =
      status === 403 || status === 401
        ? " — a repository-scoped token only reaches read/write:repository and " +
          "read/write:issue; check the token's scopes and its repository list"
        : "";
    super(`Forgejo ${route} failed with ${status}: ${body.slice(0, 400)}${hint}`);
    this.name = "ForgejoApiError";
  }
}

/** Gitea/Forgejo `CommitStatusState`. Note `error` and `warning`, absent on GitHub. */
type CommitStatusState = "pending" | "success" | "error" | "failure" | "warning";

interface CombinedStatusResponse {
  /** `""` when nothing has reported — verified against live Codeberg. */
  readonly state: CommitStatusState | "";
  readonly total_count?: number;
  /**
   * NOTE: Forgejo returns `null` here, not `[]`, when there are no statuses. Verified
   * against codeberg.org. Typing this as merely optional would be a lie that a
   * `.map()` eventually trips over.
   */
  readonly statuses?: readonly {
    readonly status: CommitStatusState;
    readonly context: string;
    readonly description: string;
  }[] | null;
}

interface PullRequestResponse {
  readonly number: number;
  readonly html_url: string;
}

/**
 * Fold a Forgejo combined status into a verdict.
 *
 * Exported for testing. `error` is a hard failure like `failure`; `warning` is
 * explicitly non-blocking in Forgejo, so it passes but says so. An empty status list
 * is `none`, never success — "nothing ran" must not satisfy the §12 gate.
 */
export const summariseCombinedStatus = (body: CombinedStatusResponse): CheckStatus => {
  const statuses = body.statuses ?? [];
  const total = body.total_count ?? statuses.length;

  if (total === 0) {
    return { conclusion: "none", summary: "no commit statuses reported for this ref" };
  }

  const failed = statuses.filter((s) => s.status === "failure" || s.status === "error");
  if (failed.length > 0 || body.state === "failure" || body.state === "error") {
    const names = failed.map((s) => s.context).join(", ");
    return {
      conclusion: "failure",
      summary: names.length > 0 ? `failing: ${names}` : `combined status is ${body.state}`,
    };
  }

  const pending = statuses.filter((s) => s.status === "pending");
  if (pending.length > 0 || body.state === "pending") {
    return { conclusion: "pending", summary: `${pending.length} status(es) still pending` };
  }

  const warnings = statuses.filter((s) => s.status === "warning");
  if (warnings.length > 0 || body.state === "warning") {
    // Non-blocking in Forgejo, so it passes — but surface it in the journal.
    return {
      conclusion: "success",
      summary: `${total} status(es) passed, ${warnings.length} with warnings`,
    };
  }

  return { conclusion: "success", summary: `${total} status(es) passed` };
};

class ForgejoForge implements Forge {
  readonly kind = "forgejo";

  constructor(
    private readonly options: ForgejoOptions,
    private readonly allowed: readonly RepoRef[],
  ) {}

  async credential(repo: RepoRef): Promise<GitCredential> {
    assertInScope(repo, this.allowed);
    const token = this.tokenFor(repo);

    // No expiresAt: Forgejo tokens do not expire. Rotation is external.
    return { username: this.options.username, password: token };
  }

  async openPr(repo: RepoRef, request: PrRequest): Promise<PrResult> {
    assertInScope(repo, this.allowed);

    const pr = await this.api<PullRequestResponse>(
      repo,
      `/repos/${repo.owner}/${repo.name}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: request.title,
          body: request.body,
          head: request.head,
          base: request.base,
        }),
      },
    );

    return { number: pr.number, url: pr.html_url };
  }

  async checks(repo: RepoRef, ref: string): Promise<CheckStatus> {
    assertInScope(repo, this.allowed);

    const body = await this.api<CombinedStatusResponse>(
      repo,
      // `ref` may be a branch, tag or sha. There is no check-runs equivalent here.
      `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}/status`,
    );

    return summariseCombinedStatus(body);
  }

  async revoke(): Promise<void> {
    // Nothing to revoke — these tokens are long-lived and externally rotated.
  }

  private tokenFor(repo: RepoRef): string {
    const slug = `${repo.owner}/${repo.name}`;
    const token = this.options.tokensByRepo.get(slug);
    if (token === undefined) throw new MissingRepoTokenError(slug);
    return token;
  }

  private async api<T>(repo: RepoRef, route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.options.apiBase}${route}`, {
      ...init,
      headers: {
        // Gitea/Forgejo's own scheme. Header only — never argv.
        authorization: `token ${this.tokenFor(repo)}`,
        accept: "application/json",
        "content-type": "application/json",
      },
    });

    if (!response.ok) {
      throw new ForgejoApiError(response.status, route, await response.text());
    }
    return (await response.json()) as T;
  }
}

export class ForgejoForgeFactory implements ForgeFactory {
  constructor(private readonly options: ForgejoOptions) {}

  async forTask(spec: TaskSpec): Promise<Forge> {
    return new ForgejoForge(this.options, spec.repos);
  }
}
