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
import { repoSlug, type RepoRef, type TaskSpec } from "../domain/task.ts";
import type { UnreachableRepo } from "./reach.ts";
import {
  assertInScope,
  assertWorkspaceScope,
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

export interface ForgejoOptions {
  readonly apiBase: string;
  /** Account the tokens belong to — used as the git username. */
  readonly username: string;
  /**
   * Tokens covering every repo under an owner, keyed by owner.
   *
   * This is the normal unit for Codeberg: an ecosystem like Acme is worked
   * as one workspace plus sibling clones, so essentially no task touches a single repo
   * and a per-repo token would have to be assembled per task anyway.
   */
  readonly tokensByOwner: ReadonlyMap<string, string>;
  /**
   * Optional narrower per-repo tokens, keyed `owner/name`. Checked BEFORE the
   * owner-wide token, so a sensitive repo can carry a tighter credential without
   * changing how the rest are reached.
   */
  readonly tokensByRepo?: ReadonlyMap<string, string>;
  /** Injected transport. Absent means the global `fetch`; only tests pass one. */
  readonly fetch?: FetchLike;
}

/** As in `github-app.ts`, and declared here for the same reason: no transport import. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MissingRepoTokenError extends Error {
  constructor(slug: string, owner: string) {
    super(
      `no Forgejo token configured for ${slug} — add a per-repo entry, or an ` +
        `owner-wide token for '${owner}', to the workspace secret`,
    );
    this.name = "MissingRepoTokenError";
  }
}

export class ForgejoApiError extends Error {
  readonly status: number;
  readonly route: string;

  constructor(status: number, route: string, body: string) {
    const hint =
      status === 403 || status === 401
        ? " — a repository-scoped token only reaches read/write:repository and " +
          "read/write:issue; check the token's scopes and its repository list"
        : "";
    super(`Forgejo ${route} failed with ${status}: ${body.slice(0, 400)}${hint}`);
    this.status = status;
    this.route = route;
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

/** Gitea's `PullReview`. `body` is the prose a reviewer wrote about the change as a whole. */
interface PullReviewResponse {
  readonly id: number;
  readonly body?: string;
  readonly user?: { readonly login?: string } | null;
  readonly submitted_at?: string;
  readonly html_url?: string;
}

/**
 * Gitea's `PullReviewComment`.
 *
 * `resolver` is the account that closed the thread — its presence IS the resolved flag, and
 * it is why this side needs no GraphQL where GitHub does. `position` goes null when the diff
 * hunk the comment was written against no longer exists, which is what GitHub calls outdated.
 */
interface PullReviewCommentResponse {
  readonly id: number;
  readonly body?: string;
  readonly path?: string | null;
  readonly position?: number | null;
  readonly resolver?: { readonly login?: string } | null;
  readonly user?: { readonly login?: string } | null;
  readonly created_at?: string;
  readonly html_url?: string;
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

/**
 * Enumeration bounds for `/user/repos`. 50 is Forgejo's usual `limit` ceiling, and 20 pages
 * is 1000 repos — past any account this runs against, and a cap rather than a loop.
 */
const REPO_PAGE_SIZE = 50;
const REPO_PAGES = 20;

/** The transport for one set of options: injected in tests, the global otherwise. */
const http = (options: ForgejoOptions): FetchLike =>
  options.fetch ?? ((input, init) => fetch(input, init));

/**
 * Resolve the token for a repo: a specific override first, then the owner-wide token.
 *
 * `assertWorkspaceScope` and `assertInScope` have both already run by the time the forge
 * calls this. The first is the security boundary: the workspace's configured host, which
 * the task did not choose. The second only narrows to what the task asked for, and the
 * task's `repos` list is attacker-influenceable text — it was treated as the boundary
 * once, and that is exactly how a Codeberg owner-wide token could be pointed at another
 * host.
 *
 * On Forgejo the token cannot be narrowed at use time (there is no mint step), so what
 * the token itself was created with is the last line rather than the first.
 *
 * Module-level rather than a method because the FACTORY asks the same question at the
 * door (`unreachable`): a repo with no token configured is a repo no session will reach,
 * and finding that out before one starts is the whole point.
 */
const tokenFor = (options: ForgejoOptions, repo: RepoRef): string => {
  const slug = repoSlug(repo);
  const specific = options.tokensByRepo?.get(slug);
  if (specific !== undefined) return specific;

  const byOwner = options.tokensByOwner.get(repo.owner);
  if (byOwner !== undefined) return byOwner;

  throw new MissingRepoTokenError(slug, repo.owner);
};

class ForgejoForge implements Forge {
  readonly kind = "forgejo";

  private readonly options: ForgejoOptions;
  private readonly allowed: readonly RepoRef[];
  private readonly scope: WorkspaceScope;

  constructor(options: ForgejoOptions, allowed: readonly RepoRef[], scope: WorkspaceScope) {
    this.options = options;
    this.allowed = allowed;
    this.scope = scope;
  }

  async credential(repo: RepoRef): Promise<GitCredential> {
    // Order matters, and it matters more here than on GitHub: a Forgejo token is
    // owner-wide and does not expire, so one served to the wrong host is a permanent
    // compromise rather than an hour's exposure.
    assertWorkspaceScope(repo, this.scope);
    assertInScope(repo, this.allowed);
    const token = tokenFor(this.options, repo);

    // No expiresAt: Forgejo tokens do not expire. Rotation is external.
    return { username: this.options.username, password: token };
  }

  /**
   * Open a pull request, or adopt the one already open for this branch.
   *
   * The same rule as the GitHub forge, and it has to be the same rule: `open_pr` is one
   * control-plane verb with one contract, and an agent that had to know which forge it was
   * talking to in order to know whether "already open" is a failure would be reasoning about
   * something the tool exists to hide.
   *
   * Forgejo answers a duplicate with **409**, not GitHub's 422 — and it is a `Conflict` for this
   * one reason rather than a family of validation errors, so there is no equivalent of the
   * narrowing the GitHub path needs. The lookup is still what decides: a conflict with no open
   * PR for that head rethrows.
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
      if (!(error instanceof ForgejoApiError) || error.status !== 409) throw error;

      const existing = await this.openPrFor(repo, request);
      if (existing === undefined) throw error;
      return existing;
    }
  }

  /** The open pull request for `head` against `base`, if there is one. Best-effort. */
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

  async checks(repo: RepoRef, ref: string): Promise<CheckStatus> {
    assertInScope(repo, this.allowed);

    const body = await this.api<CombinedStatusResponse>(
      repo,
      // `ref` may be a branch, tag or sha. There is no check-runs equivalent here.
      `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}/status`,
    );

    return summariseCombinedStatus(body);
  }

  /**
   * Every review comment on a pull request (DESIGN.md §7.3).
   *
   * Two levels, because Forgejo has two. A review carries a BODY — the prose about the
   * change as a whole, which is where "this is the wrong approach" gets written — and it
   * carries per-line comments, one request each. Reading only the second drops every
   * objection that is not about a particular line.
   *
   * Resolved comments are returned rather than filtered, as on GitHub: the caller states how
   * many of a review are already answered beside the ones that are not.
   */
  async listReviewComments(repo: RepoRef, pr: number): Promise<readonly ReviewComment[]> {
    assertInScope(repo, this.allowed);

    const base = `/repos/${repo.owner}/${repo.name}/pulls/${pr}`;
    const reviews =
      (await this.api<readonly PullReviewResponse[] | null>(repo, `${base}/reviews`)) ?? [];
    const comments: ReviewComment[] = [];

    for (const review of reviews) {
      // An APPROVED review with no prose is the ordinary way to approve. Quoted, it would
      // say a human had objected to nothing.
      if ((review.body ?? "").trim().length > 0) {
        comments.push({
          id: `review-${review.id}`,
          repo,
          pr,
          ...this.attribution(review.user),
          body: review.body ?? "",
          ...(review.html_url === undefined ? {} : { url: review.html_url }),
          createdAt: review.submitted_at ?? "",
          // A review body belongs to no thread, so there is nothing to resolve and no line
          // for it to drift off.
          resolved: false,
          outdated: false,
        });
      }

      const own =
        (await this.api<readonly PullReviewCommentResponse[] | null>(
          repo,
          `${base}/reviews/${review.id}/comments`,
        )) ?? [];

      for (const comment of own) {
        // Null `position` with the original still recorded is a comment whose hunk has gone.
        // The line is dropped with it: `src/index.ts:null` points a session at nothing.
        const outdated = comment.position == null;
        comments.push({
          id: String(comment.id),
          repo,
          pr,
          ...this.attribution(comment.user),
          body: comment.body ?? "",
          ...(comment.path == null ? {} : { path: comment.path }),
          ...(comment.position == null ? {} : { line: comment.position }),
          ...(comment.html_url === undefined ? {} : { url: comment.html_url }),
          createdAt: comment.created_at ?? "",
          resolved: comment.resolver != null,
          outdated,
        });
      }
    }

    return comments;
  }

  /**
   * Who wrote it, and whether that is us.
   *
   * There is no bot flag on Forgejo — the fleet is an ordinary account — so the only thing
   * that distinguishes our own comment from a human's is that it belongs to the account the
   * tokens were issued for. Case-insensitive, because Forgejo resolves logins that way and
   * an exclusion one letter can be walked around is not an exclusion (`isSameRepo`).
   */
  private attribution(
    user: { readonly login?: string } | null | undefined,
  ): { readonly author: string; readonly fromFleet: boolean } {
    // A deleted account leaves no login, and the comment still says what it said.
    const login = user?.login ?? "(unknown)";
    return {
      author: login,
      fromFleet: login.toLowerCase() === this.options.username.toLowerCase(),
    };
  }

  /**
   * Approve a pull request (DESIGN.md §12.1).
   *
   * Forgejo spells the event `APPROVED` where GitHub spells it `APPROVE`. The same
   * caveat applies on both: this is only ever called through a reviewer identity, and
   * a token belonging to the PR's author cannot approve it.
   */
  async approve(repo: RepoRef, pr: number, body: string): Promise<void> {
    assertInScope(repo, this.allowed);

    await this.api<unknown>(repo, `/repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "APPROVED", body }),
    });
  }

  /** Merge a pull request. `Do` is capitalised in Forgejo's API; that is not a typo. */
  async merge(repo: RepoRef, pr: number, options: MergeOptions = {}): Promise<void> {
    assertInScope(repo, this.allowed);

    await this.api<unknown>(repo, `/repos/${repo.owner}/${repo.name}/pulls/${pr}/merge`, {
      method: "POST",
      body: JSON.stringify({
        Do: options.method ?? "squash",
        ...(options.title === undefined ? {} : { MergeTitleField: options.title }),
      }),
    });
  }

  async revoke(): Promise<void> {
    // Nothing to revoke — these tokens are long-lived and externally rotated.
  }

  private async api<T>(repo: RepoRef, route: string, init: RequestInit = {}): Promise<T> {
    const response = await http(this.options)(`${this.options.apiBase}${route}`, {
      ...init,
      headers: {
        // Gitea/Forgejo's own scheme. Header only — never argv.
        authorization: `token ${tokenFor(this.options, repo)}`,
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
  private readonly options: ForgejoOptions;
  private readonly scope: WorkspaceScope;

  constructor(options: ForgejoOptions, scope: WorkspaceScope) {
    this.options = options;
    this.scope = scope;
  }

  async forTask(spec: TaskSpec): Promise<Forge> {
    for (const repo of spec.repos) assertWorkspaceScope(repo, this.scope);
    return new ForgejoForge(this.options, spec.repos, this.scope);
  }

  /**
   * Every repo these tokens can reach, for the `/brainstorm repo:` autocomplete.
   *
   * `GET /user/repos` is the enumeration Forgejo has — repos the token's account owns or
   * collaborates on — narrowed to the owners this workspace actually holds a token for, so
   * the box cannot offer a repo `tokenFor` would then refuse.
   *
   * A repository-scoped token is not permitted to list, and answers 403. That is not an
   * error worth propagating into a suggestion box: the configured per-repo slugs are what
   * it can still name for certain, and an empty catalogue leaves the box exactly as it was
   * before it had one. The door checks bite either way.
   */
  async reachable(): Promise<readonly string[]> {
    const configured = [...(this.options.tokensByRepo?.keys() ?? [])];
    const token = [...this.options.tokensByOwner.values()][0];
    if (token === undefined) return configured;

    const owned: string[] = [];
    for (let page = 1; page <= REPO_PAGES; page += 1) {
      const route = `/user/repos?limit=${REPO_PAGE_SIZE}&page=${page}`;
      const response = await http(this.options)(`${this.options.apiBase}${route}`, {
        headers: { authorization: `token ${token}`, accept: "application/json" },
      });
      if (!response.ok) return configured;

      const body = (await response.json()) as readonly { readonly full_name?: string }[] | null;
      const slugs = (body ?? []).flatMap((repo) =>
        repo.full_name === undefined ? [] : [repo.full_name],
      );
      // Only owners a token covers. A bot account can be a collaborator on repos this
      // workspace holds no credential for, and suggesting one is offering work that cannot
      // be cloned.
      owned.push(...slugs.filter((slug) => this.options.tokensByOwner.has(slug.split("/")[0] ?? "")));
      if (slugs.length < REPO_PAGE_SIZE) break;
    }

    return [...new Set([...configured, ...owned])];
  }

  /**
   * Which of these repos this workspace's tokens cannot reach, and why (DESIGN.md §9.1.1).
   *
   * Three questions, cheapest first, because the first two need no request at all:
   *
   *   - the CONFIGURED bound (`assertWorkspaceScope`) — another forge's host, or the
   *     supervisor's own state repo
   *   - whether a token covers it. There is no mint here, so a missing token is not a
   *     refusal that arrives later: it is one that arrives never, as a clone prompting for
   *     a username in a shell with prompts disabled
   *   - whether the repo exists. `GET /repos/{owner}/{name}` answers 404 both for a repo
   *     that is not there and for one this token may not see, which is the same conflation
   *     GitHub's 422 makes and is reported the same way
   *
   * Throws when Forgejo cannot be asked, per `RepoReach`: every caller fails open, and a
   * 500 is not evidence that a repo was deleted.
   */
  async unreachable(repos: readonly RepoRef[]): Promise<readonly UnreachableRepo[]> {
    const failures: UnreachableRepo[] = [];

    for (const repo of repos) {
      try {
        assertWorkspaceScope(repo, this.scope);
        tokenFor(this.options, repo);
      } catch (error) {
        failures.push({ repo, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      const slug = repoSlug(repo);
      const route = `/repos/${repo.owner}/${repo.name}`;
      const response = await http(this.options)(`${this.options.apiBase}${route}`, {
        headers: {
          authorization: `token ${tokenFor(this.options, repo)}`,
          accept: "application/json",
        },
      });

      if (response.ok) continue;
      if (response.status !== 404) {
        throw new ForgejoApiError(response.status, route, await response.text());
      }

      // No installation to enumerate, so no candidate list and no near miss: Forgejo's
      // equivalent would be listing every repo under the owner, which a repository-scoped
      // token is not allowed to do. The name is still named, which is what was missing.
      failures.push({
        repo,
        reason:
          `\`${slug}\` is not there — ${this.options.apiBase} answers 404 for it, so either ` +
          `it does not exist or this workspace's token may not see it. Check the spelling ` +
          `and the token's repository list.`,
      });
    }

    return failures;
  }
}
