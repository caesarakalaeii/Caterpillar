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

/**
 * Permissions for the GitHub Issues tracker's own token (DESIGN.md §9.5).
 *
 * Deliberately NOT `contents`: the tracker reads and annotates issues and must not be
 * able to touch code, and it is minted installation-wide (no `repositories`) because
 * intake enumerates every repo the App is installed on rather than one task's scope.
 */
const TRACKER_PERMISSIONS = {
  issues: "write",
  metadata: "read",
} as const;

export interface InstallationTokenRequest {
  /** Omit for an installation-wide token; supply names to scope it narrower. */
  readonly repositories?: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
}

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
  readonly status: number;
  readonly route: string;

  constructor(status: number, route: string, body: string) {
    super(`GitHub ${route} failed with ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.route = route;
    this.name = "GitHubApiError";
  }
}

class GitHubAppForge implements Forge {
  readonly kind = "github";
  private cached: GitCredential | undefined;

  private readonly options: GitHubAppOptions;
  private readonly allowed: readonly RepoRef[];

  constructor(options: GitHubAppOptions, allowed: readonly RepoRef[]) {
    this.options = options;
    this.allowed = allowed;
  }

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
    return mintInstallationToken(this.options, {
      // Scope to exactly the repos the task declared — narrower than the App.
      repositories: this.allowed.map((repo) => repo.name),
      permissions: TASK_PERMISSIONS,
    });
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
 * Exchange an App JWT for an installation access token.
 *
 * Shared by the forge and the Issues tracker so there is exactly one place that knows
 * how a token is minted. The result is write-only to callers: hand it to a credential
 * helper or an Authorization header, never log it, never put it on argv (DESIGN.md §9.2).
 *
 * A 422 here almost always means the App is not installed on the repositories asked
 * for — the message says so, because the raw GitHub body does not.
 */
export const mintInstallationToken = async (
  options: GitHubAppOptions,
  request: InstallationTokenRequest,
): Promise<GitCredential> => {
  const jwt = signAppJwt(options.appId, options.privateKeyPem);
  const route = `/app/installations/${options.installationId}/access_tokens`;

  const response = await fetch(`${options.apiBase}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Omitted entirely when installation-wide: sending `repositories: []` would
      // scope the token to NO repositories rather than all of them.
      ...(request.repositories === undefined ? {} : { repositories: request.repositories }),
      permissions: request.permissions,
    }),
  });

  if (response.status === 422) {
    throw new GitHubApiError(
      422,
      route,
      "the App is not installed on one of the requested repositories, or was granted " +
        "none of the requested permissions — check the installation, not the key",
    );
  }
  if (!response.ok) {
    throw new GitHubApiError(response.status, route, await response.text());
  }

  const body = (await response.json()) as InstallationTokenResponse;
  return {
    username: "x-access-token",
    password: body.token,
    expiresAt: Date.parse(body.expires_at),
  };
};

/**
 * A re-minting installation token supplier.
 *
 * Installation tokens last an hour, and the supervisor outlives that by design, so
 * anything holding one long-term has to renew rather than cache forever.
 */
export class InstallationTokenSource {
  private cached: GitCredential | undefined;

  private readonly options: GitHubAppOptions;
  private readonly permissions: Readonly<Record<string, string>>;

  constructor(options: GitHubAppOptions, permissions: Readonly<Record<string, string>>) {
    this.options = options;
    this.permissions = permissions;
  }

  async token(): Promise<string> {
    const cached = this.cached;
    if (cached?.expiresAt !== undefined && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
      return cached.password;
    }

    const minted = await mintInstallationToken(this.options, {
      permissions: this.permissions,
    });
    this.cached = minted;
    return minted.password;
  }
}

/** Installation-wide token source for the Issues tracker. */
export const trackerTokenSource = (options: GitHubAppOptions): InstallationTokenSource =>
  new InstallationTokenSource(options, TRACKER_PERMISSIONS);

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

  /**
   * `combined.state` is only meaningful when something actually posted a status.
   *
   * GitHub answers /status with `state: "pending"` for a ref carrying NO statuses at
   * all, and an Actions-only repo never gets one — its entire CI signal is check-runs.
   * Reading that default as a real verdict made the §12 gate unsatisfiable there: a
   * green PR was rejected as "CI has not finished" on every claim, forever. Legacy
   * commit statuses are the minority case now, so this is the common path, not an edge.
   */
  const hasStatuses = combined.total_count > 0;
  const hasSignal = runs.check_runs.length > 0 || hasStatuses;
  if (!hasSignal) {
    return { conclusion: "none", summary: "no checks or statuses reported for this ref" };
  }

  if (failedRuns.length > 0 || (hasStatuses && combined.state === "failure")) {
    const names = failedRuns.map((r) => r.name).join(", ");
    return {
      conclusion: "failure",
      summary: names.length > 0 ? `failing: ${names}` : "combined status is failure",
    };
  }

  const statusPending = hasStatuses && combined.state === "pending";
  if (pendingRuns.length > 0 || statusPending) {
    // Named separately, because "0 check(s) still running" as the reason a task was
    // rejected reads as a contradiction and points at the wrong endpoint entirely.
    const waiting = [
      ...(pendingRuns.length > 0 ? [`${pendingRuns.length} check(s) still running`] : []),
      ...(statusPending ? ["commit status is pending"] : []),
    ];
    return { conclusion: "pending", summary: waiting.join("; ") };
  }

  const conclusion: CheckConclusion = "success";
  const passed = runs.check_runs.length + combined.total_count;
  return { conclusion, summary: `${passed} check(s)/status(es) passed` };
};

export class GitHubAppForgeFactory implements ForgeFactory {
  private readonly options: GitHubAppOptions;

  constructor(options: GitHubAppOptions) {
    this.options = options;
  }

  async forTask(spec: TaskSpec): Promise<Forge> {
    return new GitHubAppForge(this.options, spec.repos);
  }
}
