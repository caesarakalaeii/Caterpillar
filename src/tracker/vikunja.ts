/**
 * Vikunja tracker for the `electric-boogaloo` workspace. See DESIGN.md §9.5.
 *
 * Auth: personal API token, `Authorization: Bearer`. Token scopes are per ROUTE,
 * ticked at creation in Settings → API Tokens. Grant the agent token exactly:
 *   projects:read, tasks:read, tasks:update, comments:create,
 *   labels:read, tasksLabels:create
 * and deliberately NOT tasks:delete or anything admin.
 *
 * Known traps, all encoded below:
 *   - `GET /user` and `GET /tasks/all` are session/JWT-only and unreachable by ANY
 *     API token. Verify auth against /projects; aggregate tasks per project.
 *   - a 401 on an otherwise-valid call means a MISSING SCOPE, not a bad token.
 *     Surface it as TrackerScopeError so nothing retries its way into a loop.
 *   - list routes are paginated and return a bare array, so "fewer than a full page"
 *     is the only end-of-list signal we rely on.
 *   - `labels` comes back as `null`, not `[]`, on a task with no labels.
 *   - label REMOVAL goes through the bulk endpoint, because `tasksLabels:delete` is
 *     deliberately not granted (see removeLabel).
 *   - descriptions and comments are HTML, not markdown — the editor is rich text, so
 *     a `**bold**` note renders as literal asterisks. Everything written here is
 *     escaped and wrapped in `<p>`; everything read back is stripped to text.
 *
 * Prior art: `../electric-boogaloo-workspace/scripts/vikunja.py`, whose routes were
 * proven against the live instance. Same discipline: token read in-process, sent as a
 * header, never on argv, never logged.
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

export interface VikunjaOptions {
  /** e.g. `https://tasks.eb.bims.sh/api/v1` */
  readonly apiBase: string;
  /** Resolved from the mounted SOPS secret. Header-only, never argv. */
  readonly token: string;
  /** Label marking an item as agent-eligible. */
  readonly ingestLabel: string;
  /** Label applied while a runner holds the task. Default `agent-wip`. */
  readonly wipLabel?: string;
  /** Label applied when the task parks on a question. Default `needs-human`. */
  readonly needsHumanLabel?: string;
  readonly fetch?: FetchLike;
}

/** Routes that no API token can reach — calling them is a bug, not a scope problem. */
const SESSION_ONLY_ROUTES = new Set(["user", "tasks/all"]);

const DEFAULT_WIP_LABEL = "agent-wip";
const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";

/** Vikunja's own default; also the page size the prior-art CLI paginates with. */
const PAGE_SIZE = 50;

interface VikunjaProject {
  readonly id: number;
  readonly title?: string;
  readonly is_archived?: boolean;
}

interface VikunjaLabel {
  readonly id: number;
  readonly title?: string;
}

interface VikunjaTask {
  readonly id: number;
  readonly title?: string;
  readonly description?: string;
  readonly done?: boolean;
  /** `null`, not `[]`, when the task carries no labels. */
  readonly labels?: readonly VikunjaLabel[] | null;
}

export class VikunjaApiError extends Error {
  readonly status: number;
  readonly route: string;

  constructor(status: number, route: string, body: string) {
    super(`Vikunja ${route} failed with ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.route = route;
    this.name = "VikunjaApiError";
  }
}

/**
 * A label the transition wanted to apply does not exist on the instance.
 *
 * Not auto-created: the agent token has no `labels:create` scope, and silently
 * inventing tracker vocabulary is worse than saying which labels exist.
 */
export class UnknownVikunjaLabelError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `no Vikunja label named '${name}' — create it in the UI. Known labels: ` +
        `${known.length > 0 ? known.join(", ") : "(none visible to this token)"}`,
    );
    this.name = "UnknownVikunjaLabelError";
  }
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
]);

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ESCAPES.get(char) ?? char);

/**
 * Render supervisor prose as the HTML Vikunja's editor expects.
 *
 * Exported for testing. Blank lines become paragraphs, single newlines `<br>`; bare
 * URLs become links so a PR link is clickable rather than a string in a paragraph.
 */
export const toCommentHtml = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${linkify(escapeHtml(block)).replaceAll("\n", "<br>")}</p>`)
    .join("");

/** Wraps already-escaped http(s) URLs in anchors. */
const linkify = (escaped: string): string =>
  escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&nbsp;", " "],
]);

/**
 * Best-effort HTML → text, for descriptions on their way into a spec.
 *
 * Exported for testing. Intake renders prose for an agent, so tag soup in the goal is
 * noise; this is deliberately not a parser — block tags become newlines and the rest
 * is dropped.
 */
export const stripHtml = (html: string): string =>
  html
    // Code blocks become FENCES, not bare text. TipTap stores a code block as
    // `<pre><code>…</code></pre>`, where the ``` markers exist only in the rendering —
    // so stripping tags alone would silently delete them. Intake's `agent` block is a
    // fenced block (§14.1), which would make every Vikunja item written with the
    // editor's code-block button unparseable while looking correct in the UI.
    .replace(/<pre[^>]*>\s*(?:<code[^>]*>)?/gi, "\n```\n")
    .replace(/(?:<\/code>)?\s*<\/pre>/gi, "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[#a-z0-9]+;/gi, (entity) => ENTITIES.get(entity.toLowerCase()) ?? entity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export class VikunjaTracker implements Tracker {
  readonly kind = "vikunja";

  private readonly http: FetchLike;
  /** Lazily-loaded title → id index, shared by every label operation. */
  private labels?: Promise<ReadonlyMap<string, number>>;

  private readonly options: VikunjaOptions;

  constructor(options: VikunjaOptions) {
    this.options = options;
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Auth probe, returning the number of real projects the token can see.
   *
   * Uses /projects rather than /user, which is session-only. A token with no
   * `projects:read` scope surfaces as TrackerScopeError, not as "bad token".
   */
  async whoami(): Promise<number> {
    const projects = await this.listAll<VikunjaProject>("projects", "projects:read");
    // Pseudo-projects (Favorites) have negative ids and are not real containers.
    return projects.filter((project) => project.id > 0).length;
  }

  /**
   * Aggregates per project — `GET /tasks/all` is unreachable by API token, so
   * there is no global task listing available to us.
   *
   * Label matching is client-side: the tasks come back with their labels attached,
   * and Vikunja's `filter` grammar for labels has moved between versions, so the
   * robust filter is the one we apply ourselves.
   */
  async listAgentItems(): Promise<readonly TrackerItem[]> {
    const wanted = this.options.ingestLabel.toLowerCase();
    const projects = (await this.listAll<VikunjaProject>("projects", "projects:read"))
      .filter((project) => project.id > 0 && project.is_archived !== true);

    const items: TrackerItem[] = [];
    for (const project of projects) {
      // Sequential on purpose: a handful of projects, and intake is not latency
      // sensitive enough to justify hammering the instance in parallel.
      const tasks = await this.listAll<VikunjaTask>(
        `projects/${project.id}/tasks?filter=${encodeURIComponent("done = false")}`,
        "tasks:read",
      );

      for (const task of tasks) {
        if (task.done === true) continue;
        const labels = task.labels ?? [];
        if (!labels.some((label) => (label.title ?? "").toLowerCase() === wanted)) continue;

        items.push({
          ref: { kind: "vikunja", id: String(task.id), container: String(project.id) },
          title: task.title ?? `task ${task.id}`,
          body: stripHtml(task.description ?? ""),
          url: this.webUrl(task.id),
          // Always trusted, and this is a statement about the deployment rather than a
          // shortcut: a Vikunja instance has no arm's-length contributor: writing to a
          // project at all requires an account someone provisioned, and the agent's
          // token only sees projects that account was granted. There is no equivalent of
          // a stranger opening an issue on a public repo. If that ever stops being true
          // — a public or self-registration instance — this is the line to change.
          authorTrusted: true,
        });
      }
    }
    return items;
  }

  /**
   * Label titles visible to this token, for diagnostics.
   *
   * Exists because a missing label only surfaces mid-transition otherwise — the
   * verify CLI checks up front that the lifecycle labels actually exist.
   */
  async labelNames(): Promise<readonly string[]> {
    return [...(await this.labelIndex()).keys()];
  }

  async comment(ref: TrackerRef, text: string): Promise<void> {
    await this.call<unknown>(
      "PUT",
      `tasks/${this.taskId(ref)}/comments`,
      "comments:create",
      { comment: toCommentHtml(text) },
    );
  }

  /**
   * Mirror a lifecycle change. Supervisor-only — see tracker/types.ts for why there
   * is no agent-reachable path to `completed`.
   *
   * The comment is always written before the label or `done` flag: if a scope is
   * missing, the human reading the item still learns what happened rather than
   * seeing a silent state change.
   */
  async transition(
    ref: TrackerRef,
    transition: TrackerTransition,
    task: TaskId,
  ): Promise<void> {
    const id = this.taskId(ref);

    switch (transition.kind) {
      case "claimed":
        await this.comment(ref, `Picked up by ${transition.runner} as ${task}.`);
        await this.addLabel(id, this.wipLabel);
        // A claim is the only way out of `awaiting-human`, so reaching here means the
        // question was answered. needs-human is how a human FILTERS for items wanting
        // them; leaving it set fills that list with work already back in progress.
        await this.removeLabel(id, this.needsHumanLabel);
        return;

      case "question":
        await this.comment(
          ref,
          `${task} is waiting on a human:\n\n${transition.question}`,
        );
        // Keeps agent-wip: the task is still owned, just blocked.
        await this.addLabel(id, this.needsHumanLabel);
        return;

      case "parked":
        await this.comment(ref, `${task} parked: ${transition.reason}`);
        await this.removeLabel(id, this.wipLabel);
        return;

      case "completed":
        await this.comment(
          ref,
          `${task} is done — acceptance criteria and CI verified by the supervisor.\n\n` +
            transition.prUrl,
        );
        await this.removeLabel(id, this.wipLabel);
        // A done task is waiting on nobody, whatever it asked along the way.
        await this.removeLabel(id, this.needsHumanLabel);
        // Last, so a failure here leaves an item that is visibly finished in prose
        // and can be closed by hand. `done` is only ever reached from here — §12.
        await this.call<unknown>("POST", `tasks/${id}`, "tasks:update", { done: true });
        return;
    }
  }

  private get wipLabel(): string {
    return this.options.wipLabel ?? DEFAULT_WIP_LABEL;
  }

  private get needsHumanLabel(): string {
    return this.options.needsHumanLabel ?? DEFAULT_NEEDS_HUMAN_LABEL;
  }

  /** Web URL of a task, derived from the API base (`…/api/v1` → origin). */
  private webUrl(id: number): string {
    return `${new URL(this.options.apiBase).origin}/tasks/${id}`;
  }

  /** Tracker ids are strings in the domain; Vikunja's are numeric. */
  private taskId(ref: TrackerRef): number {
    const id = Number.parseInt(ref.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`'${ref.id}' is not a Vikunja task id`);
    }
    return id;
  }

  private async addLabel(task: number, name: string): Promise<void> {
    const index = await this.labelIndex();
    const id = index.get(name.toLowerCase());
    if (id === undefined) {
      throw new UnknownVikunjaLabelError(name, [...index.keys()]);
    }
    await this.call<unknown>("PUT", `tasks/${task}/labels`, "tasksLabels:create", {
      label_id: id,
    });
  }

  /**
   * Remove a label by re-sending the surviving set through the bulk endpoint.
   *
   * The obvious `DELETE /tasks/{id}/labels/{label}` needs `tasksLabels:delete`, which
   * the agent token intentionally does not have — the token must not be able to strip
   * labels a human put there deliberately. Bulk replace goes through the tasks-labels
   * update route instead. An unknown label is a no-op: there is nothing to remove.
   */
  private async removeLabel(task: number, name: string): Promise<void> {
    const index = await this.labelIndex();
    const id = index.get(name.toLowerCase());
    if (id === undefined) return;

    const current = await this.call<VikunjaTask>("GET", `tasks/${task}`, "tasks:read");
    const labels = current.labels ?? [];
    if (!labels.some((label) => label.id === id)) return;

    await this.call<unknown>(
      "POST",
      `tasks/${task}/labels/bulk`,
      "tasksLabels:update bulk",
      { labels: labels.filter((label) => label.id !== id).map((label) => ({ id: label.id })) },
    );
  }

  /** Title → id, lower-cased. Loaded once per process; labels change rarely. */
  private labelIndex(): Promise<ReadonlyMap<string, number>> {
    this.labels ??= this.listAll<VikunjaLabel>("labels", "labels:read").then(
      (labels) => new Map(labels.map((label) => [(label.title ?? "").toLowerCase(), label.id])),
    );
    return this.labels;
  }

  /**
   * GET a paginated list route to exhaustion.
   *
   * Vikunja answers list routes with a bare JSON array, so a short page is the
   * end-of-list signal — matching the prior-art CLI, which was proven against this
   * instance.
   */
  private async listAll<T>(path: string, scope: string): Promise<readonly T[]> {
    const separator = path.includes("?") ? "&" : "?";
    const items: T[] = [];

    for (let page = 1; ; page += 1) {
      const chunk = await this.call<readonly T[] | null>(
        "GET",
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        scope,
      );
      if (chunk === null || !Array.isArray(chunk) || chunk.length === 0) break;

      items.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
    }
    return items;
  }

  /**
   * One API call. The token is a header, never a query parameter — it must not reach
   * a request log, and error bodies are truncated so a chatty 500 cannot smuggle one
   * back out either.
   */
  private async call<T>(
    method: string,
    path: string,
    requiredScope: string,
    body?: unknown,
  ): Promise<T> {
    const route = path.split("?")[0] ?? path;
    this.assertReachable(route);

    const response = await this.http(`${this.options.apiBase}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401) {
      // NOT a bad token. Vikunja answers "this token lacks the scope for this route"
      // with the same 401 as a genuinely invalid one, and retrying never fixes it.
      throw this.scopeError(route, requiredScope);
    }
    if (!response.ok) {
      throw new VikunjaApiError(response.status, route, await response.text());
    }

    const text = await response.text();
    // Some routes (bulk label update among them) answer 200 with an empty body.
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }

  /**
   * Guard for implementations: refuse to call routes that API tokens cannot reach,
   * rather than emitting a confusing 401.
   */
  protected assertReachable(route: string): void {
    if (SESSION_ONLY_ROUTES.has(route)) {
      throw new Error(
        `route '${route}' is session/JWT-only and unreachable by any Vikunja API ` +
          `token — use /projects for auth checks and per-project task listing instead`,
      );
    }
  }

  /** Maps a 401 to a scope error so callers stop treating it as an auth failure. */
  protected scopeError(route: string, requiredScope: string): TrackerScopeError {
    return new TrackerScopeError(route, requiredScope);
  }
}
