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
 *
 * `approve` and `merge` exist here for the REVIEWER identity (§12.1) — a second App,
 * installed on the same repos, that is not the author of the PR and can therefore
 * satisfy that branch protection. The authoring App still never calls either: it has
 * the permission, GitHub would refuse the approval, and the gate stays real.
 */
import { createSign } from "node:crypto";
import { repoSlug, type RepoRef, type TaskSpec } from "../domain/task.ts";
import { nearestName, nearestSlug, type UnreachableRepo } from "./reach.ts";
import {
  assertInScope,
  assertWorkspaceScope,
  type CheckConclusion,
  type CheckStatus,
  type Forge,
  type ForgeFactory,
  type GitCredential,
  type MergeOptions,
  type PrRequest,
  type PrResult,
  type ReviewComment,
  type WorkspaceScope,
} from "./types.ts";

/**
 * Check-run pagination. 100 is GitHub's maximum page size; 10 pages is 1000 runs, far
 * past any real matrix, and the ceiling exists so a pathological ref cannot spin here.
 * Hitting it leaves the list short of `total_count`, which `summarise` reports as
 * pending rather than folding into a verdict.
 */
const CHECK_RUN_PAGE_SIZE = 100;
const CHECK_RUN_PAGES = 10;

/**
 * Review-thread pagination. 100 is GitHub's maximum page size for a GraphQL connection and
 * 10 pages is 1000 threads — past any pull request a session could act on. As with the
 * check-run cap this is a ceiling rather than a loop, so a pathological pull request cannot
 * spin here; unlike that one, hitting it drops the tail rather than reporting truncation,
 * because a partial list of comments is still guidance while a partial list of checks is not
 * a verdict.
 */
const REVIEW_THREAD_PAGE_SIZE = 100;
const REVIEW_THREAD_PAGES = 10;
/** Comments per thread. A conversation longer than this has stopped being a review. */
const THREAD_COMMENTS = 50;
/**
 * Review bodies read per request, newest last.
 *
 * Unpaginated on purpose, unlike the threads: a review body is the prose about the change as
 * a whole, a pull request accumulates one per submitted review, and the ones worth reading
 * are the recent ones. Fifty is more submitted reviews than any pull request a session is
 * still working on has.
 */
const REVIEW_BODIES = 50;

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
 * Permissions for the REVIEWER App's token (DESIGN.md §12.1).
 *
 * `contents: write` is here because merging writes the base branch, and GitHub counts
 * a merge as a content write as well as a pull-request one. It is not here so the
 * reviewer can push: it never checks anything out, and its only two calls are
 * `approve` and `merge`.
 */
const REVIEWER_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
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

/**
 * All it takes to ask an installation what it can see. `metadata: read` is granted to
 * every GitHub App and reaches no content — this token exists to list repositories and
 * nothing else, so it asks for nothing else.
 */
const METADATA_PERMISSIONS = { metadata: "read" } as const;

/**
 * How long an installation's repository list is trusted.
 *
 * The list changes when a human edits an App installation, which is minutes-scale work,
 * and the reason not to re-read it per question is the same budget §14.2 rations: one
 * installation has 5000 requests an hour across every endpoint, shared by the whole fleet.
 * Five minutes makes the door checks free in the steady state while still noticing an
 * installation that was fixed a moment ago.
 */
const INSTALLATION_REPOS_TTL_MS = 5 * 60 * 1000;
/** 100 is GitHub's maximum page size; 50 pages is 5000 repos, far past any account. */
const REPO_PAGE_SIZE = 100;
const REPO_PAGES = 50;

export interface InstallationTokenRequest {
  /** Omit for an installation-wide token; supply names to scope it narrower. */
  readonly repositories?: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
}

/**
 * The one seam the tests need. Declared here rather than imported from `notify/http.ts`
 * so a forge does not depend on the Discord transport for a type alias.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppOptions {
  readonly appId: string;
  readonly installationId: string;
  /** PEM contents. Read from the mounted SOPS secret; never logged. */
  readonly privateKeyPem: string;
  readonly apiBase: string;
  /**
   * Permissions minted per task. Defaults to `TASK_PERMISSIONS`; the reviewer identity
   * asks for a different, smaller set (§12.1). Always narrower than the App itself.
   */
  readonly permissions?: Readonly<Record<string, string>>;
  /** Injected transport. Absent means the global `fetch`; only tests pass one. */
  readonly fetch?: FetchLike;
}

interface InstallationTokenResponse {
  readonly token: string;
  readonly expires_at: string;
}

interface InstallationReposResponse {
  /**
   * How many repositories the installation has, as opposed to how many this page carries.
   * Declared for the same reason `CheckRunsResponse.total_count` is: a page loop that
   * cannot tell truncation from completion produces a confident wrong answer.
   */
  readonly total_count?: number;
  readonly repositories?: readonly { readonly full_name: string }[];
}

interface PullRequestResponse {
  readonly number: number;
  readonly html_url: string;
}

interface CheckRunsResponse {
  /**
   * How many check-runs exist for the ref, as opposed to how many this page carries.
   *
   * Was not declared at all, which is what made the truncation undetectable: one
   * unpaginated request returns GitHub's default of 30, and `summarise` folded that
   * partial list into a verdict as if it were the whole story.
   */
  readonly total_count?: number;
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

/**
 * `pullRequest.reviewThreads`, the only place GitHub reports thread RESOLUTION.
 *
 * `author` is nullable: GitHub answers null for a deleted account, and `__typename`
 * distinguishes a `Bot` — the authoring App, the reviewer identity — from a human whose
 * objection is new information (DESIGN.md §7.3).
 */
interface ReviewThreadsResponse {
  readonly errors?: readonly { readonly message?: string }[];
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        /**
         * The prose each reviewer wrote about the change as a whole — a separate connection
         * from `reviewThreads`, which only carries what was written against a line.
         */
        readonly reviews?: {
          readonly nodes?: readonly {
            readonly id?: string;
            readonly author?: { readonly __typename?: string; readonly login?: string } | null;
            readonly body?: string;
            readonly url?: string;
            readonly submittedAt?: string;
          }[];
        };
        readonly reviewThreads?: {
          readonly pageInfo?: {
            readonly hasNextPage?: boolean;
            readonly endCursor?: string | null;
          };
          readonly nodes?: readonly {
            readonly isResolved?: boolean;
            readonly isOutdated?: boolean;
            readonly comments?: {
              readonly nodes?: readonly {
                readonly id?: string;
                readonly author?: { readonly __typename?: string; readonly login?: string } | null;
                readonly body?: string;
                readonly path?: string | null;
                readonly line?: number | null;
                readonly url?: string;
                readonly createdAt?: string;
              }[];
            };
          }[];
        };
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$threads:Int!,$comments:Int!,$reviews:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(last:$reviews){
        nodes{id author{__typename login} body url submittedAt}
      }
      reviewThreads(first:$threads,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          isResolved
          isOutdated
          comments(first:$comments){
            nodes{id author{__typename login} body path line url createdAt}
          }
        }
      }
    }
  }
}`;

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** The transport for one set of options: injected in tests, the global otherwise. */
const http = (options: GitHubAppOptions): FetchLike =>
  options.fetch ?? ((input, init) => fetch(input, init));

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
  private readonly scope: WorkspaceScope;

  constructor(options: GitHubAppOptions, allowed: readonly RepoRef[], scope: WorkspaceScope) {
    this.options = options;
    this.allowed = allowed;
    this.scope = scope;
  }

  async credential(repo: RepoRef): Promise<GitCredential> {
    // Both, in this order. `allowed` narrows to what the task asked for; `scope` is the
    // bound the task did not get to choose. The factory checked the same thing, but a
    // token is what leaves this method, so it is re-checked where it is minted.
    assertWorkspaceScope(repo, this.scope);
    assertInScope(repo, this.allowed);

    const cached = this.cached;
    if (cached?.expiresAt !== undefined && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
      return cached;
    }

    const minted = await this.mint();
    this.cached = minted;
    return minted;
  }

  /**
   * Open a pull request, or ADOPT the one that is already open for this branch.
   *
   * GitHub answers a second POST for the same head with a 422 whose body says
   * `A pull request already exists for <owner>:<head>`. That is a statement about the world
   * being the way the caller wanted, and treating it as a failure is what made a whole class of
   * situation unrecoverable from inside a session:
   *
   *   - A session opens a PR, hands off, and the next session opens one again from the journal.
   *   - A push succeeds and the state write that records the PR does not, so the task resumes
   *     believing it has no PR.
   *   - A human opened it by hand while the task was parked — which is exactly how
   *     `all-chat-extension#113` came to exist, and it left the task unable to record its own
   *     second PR ever again.
   *
   * In every one of those the branch, the base and the intent are identical, so the existing PR
   * is the one the caller is asking for. Finding it makes the call idempotent, which is what a
   * control-plane verb driven by a model needs to be — an agent that has to distinguish "already
   * done" from "failed" will sometimes get it wrong, and it costs a whole session when it does.
   *
   * Narrow on purpose. Only a 422, only when the branch actually has an open PR against the
   * requested base, and the lookup is by head+base rather than by title: a DIFFERENT 422 —
   * an invalid base, a head with no commits, a repo that refuses the fork — still throws, and
   * those are the ones the agent must see. The title and body are NOT applied to an adopted PR;
   * rewriting a description a human may have edited is not this call's business.
   */
  async openPr(repo: RepoRef, request: PrRequest): Promise<PrResult> {
    assertInScope(repo, this.allowed);

    try {
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
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;

      const existing = await this.openPrFor(repo, request);
      // The 422 was about something else — an unusable base, a head with no commits. The
      // agent has to see that one, and it is the original error rather than a summary of it.
      if (existing === undefined) throw error;
      return existing;
    }
  }

  /**
   * The open pull request for `head` against `base`, if there is one.
   *
   * `head` is qualified with the owner because that is what the list endpoint's filter wants,
   * and an unqualified branch name silently matches nothing. A request that already qualified
   * it — `owner:branch`, which is what a cross-fork PR needs — is passed through untouched.
   */
  private async openPrFor(repo: RepoRef, request: PrRequest): Promise<PrResult | undefined> {
    const head = request.head.includes(":") ? request.head : `${repo.owner}:${request.head}`;
    const query = `head=${encodeURIComponent(head)}&base=${encodeURIComponent(request.base)}&state=open`;

    const found = await this.api<readonly PullRequestResponse[]>(
      repo,
      `/repos/${repo.owner}/${repo.name}/pulls?${query}`,
      { method: "GET" },
    ).catch(() => undefined);

    const pr = found?.[0];
    return pr === undefined ? undefined : { number: pr.number, url: pr.html_url };
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
      this.checkRuns(repo, ref),
      this.api<CombinedStatusResponse>(repo, `/repos/${repo.owner}/${repo.name}/commits/${ref}/status`),
    ]);

    return summarise(runs, combined);
  }

  /**
   * Every check-run for a ref, not the first page of them.
   *
   * This was one request with no `per_page` and no page loop, so it returned GitHub's
   * default of 30. A matrix build whose failing job landed on page 2 came back as
   * `{conclusion: "success"}`, passed the §12 CI gate, and was squash-merged red. The
   * tracker sibling in this repo has paginated properly since it was written; this was
   * an omission rather than a deliberate cap.
   */
  private async checkRuns(repo: RepoRef, ref: string): Promise<CheckRunsResponse> {
    const base = `/repos/${repo.owner}/${repo.name}/commits/${ref}/check-runs`;
    const runs: CheckRunsResponse["check_runs"][number][] = [];
    let total = 0;

    for (let page = 1; page <= CHECK_RUN_PAGES; page += 1) {
      const body = await this.api<CheckRunsResponse>(
        repo,
        `${base}?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
      );
      runs.push(...body.check_runs);
      total = body.total_count ?? runs.length;
      if (runs.length >= total || body.check_runs.length === 0) break;
    }

    return { total_count: total, check_runs: runs };
  }

  /**
   * Every review comment on a pull request (DESIGN.md §7.3).
   *
   * The one GraphQL call in this file, and it is GraphQL for a reason that is not
   * preference: REST's `pulls/{n}/comments` reports no resolution at all, and GitHub
   * exposes it nowhere but `pullRequest.reviewThreads`. Without the flag every comment a
   * human had already accepted would come back as an open instruction on every session.
   *
   * Resolved and outdated threads are returned rather than filtered: the caller states how
   * many of a review are already answered beside the ones that are not, and a list it had
   * pre-filtered could not say. Deciding what is quoted is `agent/review-guidance.ts`'s job.
   *
   * Two levels, as on Forgejo: a review's own BODY is where "this is the wrong approach" gets
   * written, and it lives on `reviews` rather than on `reviewThreads`. Reading only the
   * second drops every objection that is not about a particular line — and would make the
   * review a session sees depend on which forge its repo happens to be on.
   */
  async listReviewComments(repo: RepoRef, pr: number): Promise<readonly ReviewComment[]> {
    assertInScope(repo, this.allowed);

    const comments: ReviewComment[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < REVIEW_THREAD_PAGES; page += 1) {
      const body = await this.graphql<ReviewThreadsResponse>(repo, REVIEW_THREADS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        number: pr,
        threads: REVIEW_THREAD_PAGE_SIZE,
        comments: THREAD_COMMENTS,
        reviews: REVIEW_BODIES,
        ...(cursor === undefined ? {} : { cursor }),
      });

      // First page only: `reviews` is not paged with the threads, and asking again on page
      // two would return the same bodies and quote every one of them twice.
      if (page === 0) {
        for (const review of body.data?.repository?.pullRequest?.reviews?.nodes ?? []) {
          // An APPROVED review with no prose is the ordinary way to approve. Quoted, it
          // would say a human had objected to nothing.
          if ((review.body ?? "").trim().length === 0) continue;
          comments.push({
            id: review.id ?? "",
            repo,
            pr,
            author: review.author?.login ?? "(unknown)",
            fromFleet: review.author?.__typename === "Bot",
            body: review.body ?? "",
            ...(review.url === undefined ? {} : { url: review.url }),
            createdAt: review.submittedAt ?? "",
            // A review body belongs to no thread, so there is nothing to resolve and no line
            // for it to drift off.
            resolved: false,
            outdated: false,
          });
        }
      }

      const threads = body.data?.repository?.pullRequest?.reviewThreads;
      for (const thread of threads?.nodes ?? []) {
        for (const comment of thread.comments?.nodes ?? []) {
          comments.push({
            id: comment.id ?? "",
            repo,
            pr,
            // A deleted account leaves `author: null`, and the comment still says what it
            // said. Attributed to nobody rather than dropped.
            author: comment.author?.login ?? "(unknown)",
            fromFleet: comment.author?.__typename === "Bot",
            body: comment.body ?? "",
            // `null` for an outdated comment, and a `null` carried through as a number
            // renders as `src/index.ts:null` — a location that points at nothing.
            ...(comment.path == null ? {} : { path: comment.path }),
            ...(comment.line == null ? {} : { line: comment.line }),
            ...(comment.url === undefined ? {} : { url: comment.url }),
            createdAt: comment.createdAt ?? "",
            resolved: thread.isResolved === true,
            outdated: thread.isOutdated === true,
          });
        }
      }

      const next = threads?.pageInfo;
      if (next?.hasNextPage !== true || next.endCursor == null) break;
      cursor = next.endCursor;
    }

    return comments;
  }

  async approve(repo: RepoRef, pr: number, body: string): Promise<void> {
    assertInScope(repo, this.allowed);

    await this.api<unknown>(repo, `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "APPROVE", body }),
    });
  }

  async merge(repo: RepoRef, pr: number, options: MergeOptions = {}): Promise<void> {
    assertInScope(repo, this.allowed);

    await this.api<unknown>(repo, `/repos/${repo.owner}/${repo.name}/pulls/${pr}/merge`, {
      method: "PUT",
      body: JSON.stringify({
        merge_method: options.method ?? "squash",
        ...(options.title === undefined ? {} : { commit_title: options.title }),
      }),
    });
  }

  async revoke(): Promise<void> {
    const cached = this.cached;
    this.cached = undefined;
    if (cached === undefined) return;

    // Best-effort: an un-revoked token simply expires within the hour.
    await http(this.options)(`${this.options.apiBase}/installation/token`, {
      method: "DELETE",
      headers: this.headers(cached.password),
    }).catch(() => undefined);
  }

  /** Exchange the App JWT for an installation token scoped to this task's repos. */
  private async mint(): Promise<GitCredential> {
    return mintInstallationToken(this.options, {
      // Scope to exactly the repos the task declared — narrower than the App.
      repositories: this.allowed.map((repo) => repo.name),
      permissions: this.options.permissions ?? TASK_PERMISSIONS,
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

  /**
   * One GraphQL request, with GitHub's own error envelope turned into a throw.
   *
   * GraphQL answers 200 with an `errors` array for a query it refused — a permission it was
   * not granted, a pull request that is not there. Read as success that is an empty comment
   * list, which is indistinguishable from a pull request nobody has reviewed, and the caller
   * that logs and continues (invariant 6) would have nothing to log.
   *
   * The route is `${apiBase}/graphql`, which is right for github.com and wrong for GitHub
   * Enterprise — there REST is `/api/v3` and GraphQL is `/api/graphql`. Nothing in this
   * repo runs against Enterprise, and inventing a second configured base for a host nobody
   * has is a knob with no caller; if one appears, this is the line it changes.
   */
  private async graphql<T extends { readonly errors?: readonly { readonly message?: string }[] }>(
    repo: RepoRef,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const body = await this.api<T>(repo, "/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });

    const errors = body.errors ?? [];
    if (errors.length > 0) {
      throw new GitHubApiError(
        200,
        "/graphql",
        errors.map((error) => error.message ?? "unknown GraphQL error").join("; "),
      );
    }
    return body;
  }

  private async api<T>(repo: RepoRef, route: string, init: RequestInit = {}): Promise<T> {
    const credential = await this.credential(repo);
    const response = await http(this.options)(`${this.options.apiBase}${route}`, {
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
 * What a 422 from the mint means, before anything is known about which repo caused it.
 *
 * GitHub's own body for this is `{"message": "Unprocessable Entity"}` with no detail at
 * all, so this sentence is the floor: it is what the operator gets when the installation
 * cannot be enumerated to say anything sharper.
 */
const NOT_INSTALLED =
  "the App is not installed on one of the requested repositories, or was granted none of " +
  "the requested permissions — check the installation, not the key";

/**
 * Turn a 422 into a sentence that names the repo.
 *
 * The mint request carries repository NAMES, and GitHub refuses the whole request without
 * saying which of them it could not serve — identically for a repo the App is not
 * installed on and for a repo that does not exist. So the installation is asked what it
 * CAN see and the difference is computed here, which is also the only way to offer the
 * near miss that resolves this most of the time — `allchat` for `all-chat` (`reach.ts`).
 *
 * Best-effort by construction. It costs two requests on a path that has already failed,
 * and it must never replace a diagnosis with a second failure: anything going wrong here
 * falls back to `NOT_INSTALLED`, which is what this said before it could say more. This is
 * the message the credential helper prints into a failing `git clone`, so it is the last
 * place a human is told anything at all.
 */
const explainUnprocessable = async (
  options: GitHubAppOptions,
  request: InstallationTokenRequest,
): Promise<string> => {
  const asked = request.repositories;
  if (asked === undefined || asked.length === 0) return NOT_INSTALLED;

  let installed: readonly string[];
  try {
    installed = await new InstallationRepositories(options).list();
  } catch {
    return NOT_INSTALLED;
  }

  const known = new Set(installed.map((slug) => slug.slice(slug.indexOf("/") + 1).toLowerCase()));
  const missing = asked.filter((name) => !known.has(name.toLowerCase()));
  // Every repo asked for IS installed, so the 422 was about the permissions instead — the
  // other half of what GitHub folds into this status code.
  if (missing.length === 0) {
    return (
      `the App is installed on ${asked.join(", ")} but was granted none of the requested ` +
      `permissions (${Object.keys(request.permissions).join(", ")}) — re-grant them on the ` +
      `installation and accept the request`
    );
  }

  return missing
    .map((name) => {
      const suggestion = nearestName(name, installed);
      return (
        `the App cannot see '${name}' — either it does not exist or the App is not ` +
        `installed on it` +
        (suggestion === undefined ? "" : `; did you mean '${suggestion}'?`)
      );
    })
    .join(" ");
};

/**
 * Exchange an App JWT for an installation access token.
 *
 * Shared by the forge and the Issues tracker so there is exactly one place that knows
 * how a token is minted. The result is write-only to callers: hand it to a credential
 * helper or an Authorization header, never log it, never put it on argv (DESIGN.md §9.2).
 *
 * A 422 here almost always means the App is not installed on the repositories asked
 * for — or that no such repository exists, which GitHub reports identically.
 * `explainUnprocessable` asks the installation which of the two it was, because the raw
 * GitHub body ("Unprocessable Entity") says neither.
 */
export const mintInstallationToken = async (
  options: GitHubAppOptions,
  request: InstallationTokenRequest,
): Promise<GitCredential> => {
  const jwt = signAppJwt(options.appId, options.privateKeyPem);
  const route = `/app/installations/${options.installationId}/access_tokens`;

  const response = await http(options)(`${options.apiBase}${route}`, {
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
    throw new GitHubApiError(422, route, await explainUnprocessable(options, request));
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

/**
 * The repositories an installation can see, cached for `INSTALLATION_REPOS_TTL_MS`.
 *
 * `GET /installation/repositories` is the only route that answers "can this App reach that
 * repo", and it answers it as a LIST — which is what makes a near miss offerable. One
 * instance per workspace, held by the forge factory, so the fleet's repeated door checks
 * cost one request every five minutes rather than one per question (§14.2's budget).
 *
 * Paginated, and a list it could not finish reading is an ERROR rather than a short list.
 * The same reasoning as the check-run cap in `summarise`: an incomplete list cannot answer
 * "is this repo absent" in either direction, and every caller here fails open on a throw —
 * so "cannot say" costs a clone that fails the way it used to, while a wrong "absent"
 * would refuse a `/brainstorm` or park a task over a page boundary.
 */
export class InstallationRepositories {
  private readonly options: GitHubAppOptions;
  private readonly tokens: InstallationTokenSource;
  private cached: { readonly slugs: readonly string[]; readonly atMs: number } | undefined;

  constructor(options: GitHubAppOptions) {
    this.options = options;
    this.tokens = new InstallationTokenSource(options, METADATA_PERMISSIONS);
  }

  /** `owner/name` exactly as GitHub spells it, so a suggestion is copy-pasteable. */
  async list(nowMs = Date.now()): Promise<readonly string[]> {
    const cached = this.cached;
    if (cached !== undefined && nowMs - cached.atMs < INSTALLATION_REPOS_TTL_MS) {
      return cached.slugs;
    }
    return this.refresh(nowMs);
  }

  /**
   * Read the list again, whatever the cache says.
   *
   * Exists because a MISS is not the same kind of answer as a hit. A repo installed a
   * minute ago is absent from a five-minute-old list, and refusing on that would tell a
   * human their brand-new repo does not exist — the one wrong answer this whole check is
   * meant to stop being given. So a hit is served from cache and a miss is confirmed
   * against GitHub, which is affordable precisely because misses are rare.
   */
  async refresh(nowMs = Date.now()): Promise<readonly string[]> {
    const token = await this.tokens.token();
    const slugs: string[] = [];
    let total = 0;

    for (let page = 1; page <= REPO_PAGES; page += 1) {
      const route = `/installation/repositories?per_page=${REPO_PAGE_SIZE}&page=${page}`;
      const response = await http(this.options)(`${this.options.apiBase}${route}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new GitHubApiError(response.status, route, await response.text());
      }

      const body = (await response.json()) as InstallationReposResponse;
      const repositories = body.repositories ?? [];
      slugs.push(...repositories.map((repo) => repo.full_name));
      total = body.total_count ?? slugs.length;
      if (slugs.length >= total || repositories.length === 0) break;
    }

    if (slugs.length < total) {
      throw new Error(
        `read only ${slugs.length} of the installation's ${total} repositories — refusing ` +
          `to judge what it can reach on a partial list`,
      );
    }

    this.cached = { slugs, atMs: nowMs };
    return slugs;
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
  // An incomplete list cannot produce a verdict in EITHER direction: the runs we did not
  // see could be failing, and calling it pending is the answer that costs a retry rather
  // than a red merge. Reported as pending rather than thrown so the gate reads it as
  // "not yet", which is what it is.
  const expected = runs.total_count ?? runs.check_runs.length;
  if (runs.check_runs.length < expected) {
    return {
      conclusion: "pending",
      summary:
        `only ${runs.check_runs.length} of ${expected} check-run(s) could be read — ` +
        `refusing to judge CI on a partial list`,
    };
  }

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
  private readonly scope: WorkspaceScope;
  private readonly installed: InstallationRepositories;

  constructor(options: GitHubAppOptions, scope: WorkspaceScope) {
    this.options = options;
    this.scope = scope;
    this.installed = new InstallationRepositories(options);
  }

  async forTask(spec: TaskSpec): Promise<Forge> {
    // Refuse the whole task rather than the individual request. A spec naming a repo
    // this workspace cannot reach is a spec that will fail somewhere later anyway, and
    // failing here names the offending repo while nothing has been cloned yet.
    for (const repo of spec.repos) assertWorkspaceScope(repo, this.scope);
    return new GitHubAppForge(this.options, spec.repos, this.scope);
  }

  /**
   * Every repo this installation can see, for the `/brainstorm repo:` autocomplete.
   *
   * The same cached listing `unreachable` judges against, deliberately: a box that offers a
   * repo the door would then refuse would be worse than no box at all.
   */
  async reachable(): Promise<readonly string[]> {
    return this.installed.list();
  }

  /**
   * Which of these repos this App cannot reach, and why (DESIGN.md §9.1.1).
   *
   * Both bounds in one answer, because both are things a human typing a repo name gets
   * wrong and neither used to be discovered before a session was underway:
   *
   *   - the CONFIGURED bound (`assertWorkspaceScope`) — another forge's host, or the
   *     supervisor's own state repo. Answered without a request, and answered first: "the
   *     App is not installed on it" would be true of a Codeberg repo and would send the
   *     operator to a settings page that was never the problem.
   *   - the INSTALLATION — whether the App can see the repo at all.
   *
   * Throws if the installation cannot be listed. That is the contract every caller relies
   * on (`RepoReach`): a 500 is not evidence that an App was uninstalled.
   */
  async unreachable(repos: readonly RepoRef[]): Promise<readonly UnreachableRepo[]> {
    const failures: UnreachableRepo[] = [];
    // Read on first need and then reused, so a list of repos costs at most one listing —
    // and a list of entirely off-host repos costs none.
    let installed: readonly string[] | undefined;
    // At most one re-read per call, however many repos miss: the second miss is judged
    // against the list the first one just refreshed.
    let confirmed = false;

    for (const repo of repos) {
      try {
        assertWorkspaceScope(repo, this.scope);
      } catch (error) {
        failures.push({ repo, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      installed ??= await this.installed.list();
      const slug = repoSlug(repo);
      const reachable = (candidates: readonly string[]): boolean =>
        candidates.some((candidate) => candidate.toLowerCase() === slug.toLowerCase());

      if (reachable(installed)) continue;
      // A miss against a cached list may be a stale list rather than a missing repo — see
      // `InstallationRepositories.refresh`. Confirmed before it becomes a refusal.
      if (!confirmed) {
        installed = await this.installed.refresh();
        confirmed = true;
        if (reachable(installed)) continue;
      }

      const suggestion = nearestSlug(repo, installed);
      failures.push({
        repo,
        reason:
          installed.length === 0
            ? `\`${slug}\` is unreachable: this workspace's GitHub App is installed on no ` +
              `repositories at all. Install it on the repos the fleet should work on.`
            : `\`${slug}\` is not one of the ${installed.length} repositories this ` +
              `workspace's GitHub App can see — either it does not exist or the App is not ` +
              `installed on it.` +
              (suggestion === undefined ? "" : ` Did you mean \`${suggestion}\`?`),
      });
    }

    return failures;
  }
}

/**
 * A factory for the reviewer identity (DESIGN.md §12.1).
 *
 * The same App machinery with a different key and a smaller permission set. It is a
 * separate GitHub App on purpose: an approving review only counts against branch
 * protection when it comes from someone other than the PR's author.
 */
export const reviewerForgeFactory = (
  options: Omit<GitHubAppOptions, "permissions">,
  scope: WorkspaceScope,
): ForgeFactory =>
  new GitHubAppForgeFactory({ ...options, permissions: REVIEWER_PERMISSIONS }, scope);
