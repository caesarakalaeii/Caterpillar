/**
 * GitHub Issues tracker for the `caesar` workspace. See DESIGN.md §9.5, §14.
 *
 * Auth: the workspace's existing GitHub App, minted installation-wide with
 * `issues: write` and `metadata: read` and nothing else — see `trackerTokenSource`.
 * There is no second secret to manage here, and deliberately no `contents`: the
 * tracker annotates issues and must not be able to reach code.
 *
 * Known traps, all encoded below:
 *   - `GET /repos/{o}/{r}/issues` RETURNS PULL REQUESTS TOO. Every PR is an issue in
 *     GitHub's data model, so an unfiltered intake would hand the agent its own open
 *     PRs as work. Items carrying `pull_request` are dropped.
 *   - an issue with no body has `body: null`, not `""` — the same shape trap Vikunja
 *     has with `labels`.
 *   - GitHub distinguishes what Vikunja conflates: 401 is a bad credential, 403 is a
 *     valid credential without the permission. Only 403 becomes TrackerScopeError.
 *   - `POST /issues/{n}/labels` SILENTLY CREATES a label that does not exist, with a
 *     random colour. That is exactly the "adapter invents tracker vocabulary" failure
 *     the Vikunja adapter refuses by having no `labels:create` scope, so this one
 *     refuses it in code instead: labels are checked against the repo first.
 *   - `DELETE /issues/{n}/labels/{name}` 404s when the label is not on the issue,
 *     which is a no-op here rather than an error.
 *   - the search API is deliberately NOT used. It is eventually consistent (a freshly
 *     labelled issue can take a minute to appear), separately rate-limited, and its
 *     legacy issue-search behaviour is on a deprecation path. Enumerating the
 *     installation's repos and listing each one's issues is slower and correct.
 *
 * Unlike Vikunja, comments are markdown — GitHub renders it natively, so nothing here
 * escapes prose into HTML.
 */
import type { TaskId, TrackerRef } from "../domain/task.ts";
import {
  type Tracker,
  type TrackerItem,
  TrackerScopeError,
  type TrackerTransition,
} from "./types.ts";

/** Injection seam for tests. Production uses the global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubIssuesOptions {
  /** e.g. `https://api.github.com` */
  readonly apiBase: string;
  /** Owner whose repos are in scope for this workspace. */
  readonly owner: string;
  /** Label marking an issue as agent-eligible. */
  readonly ingestLabel: string;
  /** Label applied while a runner holds the task. Default `agent-wip`. */
  readonly wipLabel?: string;
  /** Label applied when the task parks on a question. Default `needs-human`. */
  readonly needsHumanLabel?: string;
  /** Supplies the installation token; see forge/github-app.ts. */
  readonly token: () => Promise<string>;
  readonly fetch?: FetchLike;
}

const DEFAULT_WIP_LABEL = "agent-wip";
const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";

/** GitHub's maximum page size. Fewer round trips over a whole installation. */
const PAGE_SIZE = 100;

interface GitHubRepo {
  readonly name: string;
  readonly owner?: { readonly login?: string };
  readonly archived?: boolean;
}

interface InstallationReposResponse {
  readonly repositories?: readonly GitHubRepo[];
}

interface GitHubLabel {
  readonly name: string;
}

interface GitHubIssue {
  readonly number: number;
  readonly title?: string;
  /** `null`, not `""`, on an issue with no body. */
  readonly body?: string | null;
  readonly html_url?: string;
  readonly state?: string;
  readonly labels?: readonly GitHubLabel[];
  /** Present only on pull requests. Its presence is the only reliable discriminator. */
  readonly pull_request?: unknown;
}

export class GitHubIssuesApiError extends Error {
  readonly status: number;
  readonly route: string;

  constructor(status: number, route: string, body: string) {
    super(`GitHub ${route} failed with ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.route = route;
    this.name = "GitHubIssuesApiError";
  }
}

/**
 * A label the transition wanted to apply does not exist on the repo.
 *
 * GitHub would happily create it — that is precisely why this exists. Inventing
 * tracker vocabulary from the agent side is worse than saying which labels exist,
 * and it is the same discipline the Vikunja adapter gets from a withheld scope.
 */
export class UnknownGitHubLabelError extends Error {
  constructor(name: string, repo: string, known: readonly string[]) {
    super(
      `no label named '${name}' on ${repo} — create it in the repo's Labels page. ` +
        `Known labels: ${known.length > 0 ? known.join(", ") : "(none)"}`,
    );
    this.name = "UnknownGitHubLabelError";
  }
}

export class GitHubIssuesTracker implements Tracker {
  readonly kind = "github-issues";

  private readonly http: FetchLike;
  /** Per-repo lower-cased label name sets, loaded once each. */
  private readonly labels = new Map<string, Promise<ReadonlySet<string>>>();

  private readonly options: GitHubIssuesOptions;

  constructor(options: GitHubIssuesOptions) {
    this.options = options;
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Repos this installation can see, for diagnostics and intake.
   *
   * Archived repos are dropped: an issue there cannot receive a PR, so offering one
   * as work would produce a task that can never satisfy its acceptance gate.
   */
  async repos(): Promise<readonly string[]> {
    const pages = await this.paginate<InstallationReposResponse>(
      "installation/repositories",
      "issues",
    );

    return pages
      .flatMap((page) => page.repositories ?? [])
      .filter(
        (repo) =>
          repo.archived !== true &&
          (repo.owner?.login ?? "").toLowerCase() === this.options.owner.toLowerCase(),
      )
      .map((repo) => `${this.options.owner}/${repo.name}`);
  }

  /**
   * Open, agent-labelled issues across the installation.
   *
   * Filtering happens server-side via `?labels=`, but PR exclusion cannot: the issues
   * route has no "issues only" switch, so pull requests are dropped here by shape.
   */
  async listAgentItems(): Promise<readonly TrackerItem[]> {
    const items: TrackerItem[] = [];

    for (const slug of await this.repos()) {
      // Sequential on purpose: intake is not latency sensitive, and a burst across
      // every repo in an installation is the fastest way to meet a secondary rate limit.
      const pages = await this.paginate<readonly GitHubIssue[]>(
        `repos/${slug}/issues?state=open&labels=${encodeURIComponent(this.options.ingestLabel)}`,
        "issues",
      );

      for (const issue of pages.flat()) {
        if (issue.pull_request !== undefined) continue;

        items.push({
          ref: { kind: "github-issues", id: String(issue.number), container: slug },
          title: issue.title ?? `issue ${issue.number}`,
          body: issue.body ?? "",
          url: issue.html_url ?? `https://github.com/${slug}/issues/${issue.number}`,
        });
      }
    }
    return items;
  }

  /** Label names on a repo, for the verify CLI's up-front check. */
  async labelNames(slug: string): Promise<readonly string[]> {
    return [...(await this.labelIndex(slug))];
  }

  async comment(ref: TrackerRef, text: string): Promise<void> {
    const { slug, number } = this.locate(ref);
    // Markdown, verbatim — no HTML round trip, unlike Vikunja.
    await this.call<unknown>("POST", `repos/${slug}/issues/${number}/comments`, "issues", {
      body: text,
    });
  }

  /**
   * Mirror a lifecycle change. Supervisor-only — see tracker/types.ts for why there
   * is no agent-reachable path to `completed`.
   *
   * The comment is always written before the label or state change: if a permission is
   * missing, the human reading the issue still learns what happened rather than seeing
   * a silent state change.
   */
  async transition(
    ref: TrackerRef,
    transition: TrackerTransition,
    task: TaskId,
  ): Promise<void> {
    const { slug, number } = this.locate(ref);

    switch (transition.kind) {
      case "claimed":
        await this.comment(ref, `Picked up by ${transition.runner} as ${task}.`);
        await this.addLabel(slug, number, this.wipLabel);
        // A claim is the only way out of `awaiting-human`, so reaching here means the
        // question was answered. Left behind, the label keeps advertising for help
        // nobody needs and whoever filters on it finds work already back in progress.
        await this.removeLabel(slug, number, this.needsHumanLabel);
        return;

      case "question":
        await this.comment(ref, `${task} is waiting on a human:\n\n${transition.question}`);
        // Keeps agent-wip: the task is still owned, just blocked.
        await this.addLabel(slug, number, this.needsHumanLabel);
        return;

      case "parked":
        await this.comment(ref, `${task} parked: ${transition.reason}`);
        await this.removeLabel(slug, number, this.wipLabel);
        return;

      case "completed":
        await this.comment(
          ref,
          `${task} is done — acceptance criteria and CI verified by the supervisor.\n\n` +
            transition.prUrl,
        );
        await this.removeLabel(slug, number, this.wipLabel);
        // A done task is waiting on nobody, whatever it asked along the way.
        await this.removeLabel(slug, number, this.needsHumanLabel);
        // Last, so a failure here leaves an issue that is visibly finished in prose and
        // can be closed by hand. Closed is only ever reached from here — §12.
        await this.call<unknown>("PATCH", `repos/${slug}/issues/${number}`, "issues", {
          state: "closed",
          state_reason: "completed",
        });
        return;
    }
  }

  private get wipLabel(): string {
    return this.options.wipLabel ?? DEFAULT_WIP_LABEL;
  }

  private get needsHumanLabel(): string {
    return this.options.needsHumanLabel ?? DEFAULT_NEEDS_HUMAN_LABEL;
  }

  /**
   * Resolve a ref to a repo slug and issue number.
   *
   * `container` is required: GitHub issue numbers are per repo, so a ref without one
   * is ambiguous rather than merely incomplete.
   */
  private locate(ref: TrackerRef): { readonly slug: string; readonly number: number } {
    const slug = ref.container;
    if (slug === undefined || !slug.includes("/")) {
      throw new Error(
        `tracker ref ${ref.id} has no 'owner/name' container — GitHub issue numbers ` +
          `are per repo, so the repo cannot be inferred`,
      );
    }

    const number = Number.parseInt(ref.id, 10);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`'${ref.id}' is not a GitHub issue number`);
    }
    return { slug, number };
  }

  /** Adds a label, refusing to conjure one GitHub would have created silently. */
  private async addLabel(slug: string, issue: number, name: string): Promise<void> {
    const known = await this.labelIndex(slug);
    if (!known.has(name.toLowerCase())) {
      throw new UnknownGitHubLabelError(name, slug, [...known]);
    }
    await this.call<unknown>("POST", `repos/${slug}/issues/${issue}/labels`, "issues", {
      labels: [name],
    });
  }

  /**
   * Removes a label. Absent label, or absent from this issue, is a no-op — GitHub
   * answers both with 404 and there is nothing to undo in either case.
   */
  private async removeLabel(slug: string, issue: number, name: string): Promise<void> {
    const known = await this.labelIndex(slug);
    if (!known.has(name.toLowerCase())) return;

    await this.call<unknown>(
      "DELETE",
      `repos/${slug}/issues/${issue}/labels/${encodeURIComponent(name)}`,
      "issues",
      undefined,
      // 404 means the issue does not carry the label. Nothing to do.
      [404],
    );
  }

  /** Lower-cased label names for a repo. Loaded once per repo; labels change rarely. */
  private labelIndex(slug: string): Promise<ReadonlySet<string>> {
    const cached = this.labels.get(slug);
    if (cached !== undefined) return cached;

    const loading = this.paginate<readonly GitHubLabel[]>(`repos/${slug}/labels`, "issues").then(
      (pages) => new Set(pages.flat().map((label) => label.name.toLowerCase())),
    );
    this.labels.set(slug, loading);
    return loading;
  }

  /**
   * GET a paginated route to exhaustion.
   *
   * Pages are returned raw rather than flattened because GitHub's list routes disagree
   * on shape — `/installation/repositories` answers with an object, everything else
   * with a bare array. A short page is the end-of-list signal; the `Link` header is
   * more precise but needs parsing for no gain at these sizes.
   */
  private async paginate<T>(path: string, permission: string): Promise<readonly T[]> {
    const separator = path.includes("?") ? "&" : "?";
    const pages: T[] = [];

    for (let page = 1; ; page += 1) {
      const chunk = await this.call<T>(
        "GET",
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        permission,
      );
      const size = this.pageSize(chunk);
      if (size === 0) break;

      pages.push(chunk);
      if (size < PAGE_SIZE) break;
    }
    return pages;
  }

  /** Item count of a page, across both list shapes GitHub uses. */
  private pageSize(chunk: unknown): number {
    if (Array.isArray(chunk)) return chunk.length;
    if (chunk !== null && typeof chunk === "object" && "repositories" in chunk) {
      const repos = (chunk as InstallationReposResponse).repositories;
      return repos?.length ?? 0;
    }
    return 0;
  }

  /**
   * One API call. The token is a header, never a query parameter — it must not reach a
   * request log, and error bodies are truncated so a chatty 500 cannot smuggle one back
   * out either.
   */
  private async call<T>(
    method: string,
    path: string,
    permission: string,
    body?: unknown,
    tolerate: readonly number[] = [],
  ): Promise<T> {
    const route = path.split("?")[0] ?? path;

    const response = await this.http(`${this.options.apiBase}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.options.token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (tolerate.includes(response.status)) return null as T;

    if (response.status === 403) {
      // NOT a bad token, and retrying never fixes it: the installation was granted
      // fewer permissions than this route needs. Unlike Vikunja, GitHub keeps this
      // distinct from 401, so the two are not conflated here either.
      throw new TrackerScopeError(route, permission);
    }
    if (!response.ok) {
      throw new GitHubIssuesApiError(response.status, route, await response.text());
    }

    const text = await response.text();
    // 204 No Content on some mutations (label delete among them).
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }
}
