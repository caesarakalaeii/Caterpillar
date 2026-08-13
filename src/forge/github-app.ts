/**
 * GitHub App forge. See DESIGN.md §9.1.
 *
 * Mint flow:
 *   1. sign a JWT with the App private key (RS256, exp <= 10 minutes)
 *   2. POST /app/installations/{id}/access_tokens with `repositories` and
 *      `permissions` — scoped NARROWER than the App itself, per task
 *   3. the token lasts 1 hour; re-mint on demand rather than caching past expiry
 *
 * IMPORTANT: `pull_requests: write` also permits MERGING. GitHub has no separate
 * merge scope, so "open PRs but never merge" cannot be enforced by the token. It is
 * enforced by branch protection on the default branch requiring an approving review,
 * which the App cannot supply for its own PR. See DESIGN.md §9.1.
 */
import { createSign } from "node:crypto";
import type { RepoRef, TaskSpec } from "../domain/task.ts";
import {
  assertInScope,
  type CheckConclusion,
  type CheckStatus,
  type Forge,
  type ForgeFactory,
  type GitCredential,
  type PrRequest,
  type PrResult,
} from "./types.ts";

/** Re-mint this long before expiry so a slow push never straddles the boundary. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;
/** GitHub rejects a JWT with exp more than 10 minutes out; stay inside it. */
const JWT_TTL_SECONDS = 9 * 60;

/** The only permissions this App ever requests. No admin, no workflows. */
const TASK_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  metadata: "read",
} as const;

export interface GitHubAppOptions {
  readonly appId: string;
  readonly installationId: string;
  /** PEM contents. Read from the mounted SOPS secret; never logged. */
  readonly privateKeyPem: string;
  readonly apiBase: string;
}

interface InstallationTokenResponse {
  readonly token: string;
  readonly expires_at: string;
}

interface PullRequestResponse {
  readonly number: number;
  readonly html_url: string;
}

interface CheckRunsResponse {
  readonly check_runs: readonly {
    readonly status: string;
    readonly conclusion: string | null;
    readonly name: string;
  }[];
}

interface CombinedStatusResponse {
  readonly state: string;
  readonly total_count: number;
}

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * Sign a GitHub App JWT.
 *
 * `iss` is the App ID; GitHub also accepts the client id. `iat` is backdated 30s to
 * tolerate clock skew between us and GitHub, which otherwise rejects the token.
 */
export const signAppJwt = (appId: string, privateKeyPem: string, now = Date.now()): string => {
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + JWT_TTL_SECONDS, iss: appId }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");

  return `${header}.${payload}.${signature}`;
};

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    body: string,
  ) {
    super(`GitHub ${route} failed with ${status}: ${body.slice(0, 400)}`);
    this.name = "GitHubApiError";
  }
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

    const minted = await this.mint();
    this.cached = minted;
    return minted;
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

  /**
   * CI state for a ref — the second §12 gate.
   *
   * Queries check-runs AND the legacy combined status: GitHub Actions reports via
   * check-runs, while many external CI services still only post statuses. Consulting
   * one alone silently reports "no CI" for half the ecosystem.
   */
  async checks(repo: RepoRef, ref: string): Promise<CheckStatus> {
    assertInScope(repo, this.allowed);

    const [runs, combined] = await Promise.all([
      this.api<CheckRunsResponse>(repo, `/repos/${repo.owner}/${repo.name}/commits/${ref}/check-runs`),
      this.api<CombinedStatusResponse>(repo, `/repos/${repo.owner}/${repo.name}/commits/${ref}/status`),
    ]);

    return summarise(runs, combined);
  }

  async revoke(): Promise<void> {
    const cached = this.cached;
    this.cached = undefined;
    if (cached === undefined) return;

    // Best-effort: an un-revoked token simply expires within the hour.
    await fetch(`${this.options.apiBase}/installation/token`, {
      method: "DELETE",
      headers: this.headers(cached.password),
    }).catch(() => undefined);
  }

  /** Exchange the App JWT for an installation token scoped to this task's repos. */
  private async mint(): Promise<GitCredential> {
    const jwt = signAppJwt(this.options.appId, this.options.privateKeyPem);
    const route = `/app/installations/${this.options.installationId}/access_tokens`;

    const response = await fetch(`${this.options.apiBase}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Scope to exactly the repos the task declared — narrower than the App.
        repositories: this.allowed.map((repo) => repo.name),
        permissions: TASK_PERMISSIONS,
      }),
    });

    if (!response.ok) {
      throw new GitHubApiError(response.status, route, await response.text());
    }

    const body = (await response.json()) as InstallationTokenResponse;
    return {
      username: "x-access-token",
      password: body.token,
      expiresAt: Date.parse(body.expires_at),
    };
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
  }

  private async api<T>(repo: RepoRef, route: string, init: RequestInit = {}): Promise<T> {
    const credential = await this.credential(repo);
    const response = await fetch(`${this.options.apiBase}${route}`, {
      ...init,
      headers: this.headers(credential.password),
    });

    if (!response.ok) {
      throw new GitHubApiError(response.status, route, await response.text());
    }
    return (await response.json()) as T;
  }
}

/**
 * Fold check-runs and combined status into one verdict.
 *
 * Exported for testing: the precedence rules (any failure wins, any incomplete run
 * means pending, no signal at all means "none") are easy to get subtly wrong and
 * would let a red build pass the §12 gate.
 */
export const summarise = (
  runs: CheckRunsResponse,
  combined: CombinedStatusResponse,
): CheckStatus => {
  const failedRuns = runs.check_runs.filter(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(run.conclusion),
  );
  const pendingRuns = runs.check_runs.filter((run) => run.status !== "completed");

  const hasSignal = runs.check_runs.length > 0 || combined.total_count > 0;
  if (!hasSignal) {
    return { conclusion: "none", summary: "no checks or statuses reported for this ref" };
  }

  if (failedRuns.length > 0 || combined.state === "failure") {
    const names = failedRuns.map((r) => r.name).join(", ");
    return {
      conclusion: "failure",
      summary: names.length > 0 ? `failing: ${names}` : "combined status is failure",
    };
  }

  if (pendingRuns.length > 0 || combined.state === "pending") {
    return { conclusion: "pending", summary: `${pendingRuns.length} check(s) still running` };
  }

  const conclusion: CheckConclusion = "success";
  return { conclusion, summary: `${runs.check_runs.length} check(s) passed` };
};

export class GitHubAppForgeFactory implements ForgeFactory {
  constructor(private readonly options: GitHubAppOptions) {}

  async forTask(spec: TaskSpec): Promise<Forge> {
    return new GitHubAppForge(this.options, spec.repos);
  }
}
