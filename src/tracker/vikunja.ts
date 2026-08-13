/**
 * Vikunja tracker for the `electric-boogaloo` workspace. See DESIGN.md §9.5.
 *
 * STUB — signatures settled, HTTP calls not implemented.
 *
 * Auth: personal API token, `Authorization: Bearer`. Token scopes are per ROUTE,
 * ticked at creation in Settings → API Tokens. Grant the agent token exactly:
 *   projects:read, tasks:read, tasks:update, comments:create,
 *   labels:read, tasksLabels:create
 * and deliberately NOT tasks:delete or anything admin.
 *
 * Known traps, both encoded below:
 *   - `GET /user` and `GET /tasks/all` are session/JWT-only and unreachable by ANY
 *     API token. Verify auth against /projects; aggregate tasks per project.
 *   - a 401 on an otherwise-valid call means a MISSING SCOPE, not a bad token.
 *     Surface it as TrackerScopeError so nothing retries its way into a loop.
 */
import type { TaskId, TrackerRef } from "../domain/task.ts";
import {
  type Tracker,
  type TrackerItem,
  TrackerScopeError,
  type TrackerTransition,
} from "./types.ts";

export interface VikunjaOptions {
  /** e.g. `https://tasks.eb.bims.sh/api/v1` */
  readonly apiBase: string;
  /** Resolved from the mounted SOPS secret. Header-only, never argv. */
  readonly token: string;
  /** Label marking an item as agent-eligible. */
  readonly ingestLabel: string;
}

/** Routes that no API token can reach — calling them is a bug, not a scope problem. */
const SESSION_ONLY_ROUTES = new Set(["user", "tasks/all"]);

export class VikunjaTracker implements Tracker {
  readonly kind = "vikunja";

  constructor(private readonly options: VikunjaOptions) {}

  /**
   * Auth probe. Uses /projects rather than /user, which is session-only.
   */
  async whoami(): Promise<number> {
    throw new Error("VikunjaTracker.whoami not implemented");
  }

  /**
   * Aggregates per project — `GET /tasks/all` is unreachable by API token, so
   * there is no global task listing available to us.
   */
  async listAgentItems(): Promise<readonly TrackerItem[]> {
    void this.options.ingestLabel;
    throw new Error("VikunjaTracker.listAgentItems not implemented");
  }

  async comment(ref: TrackerRef, text: string): Promise<void> {
    void ref;
    void text;
    // PUT {apiBase}/tasks/{id}/comments  — requires comments:create
    throw new Error("VikunjaTracker.comment not implemented");
  }

  async transition(
    ref: TrackerRef,
    transition: TrackerTransition,
    task: TaskId,
  ): Promise<void> {
    void ref;
    void task;
    switch (transition.kind) {
      case "claimed":
      case "question":
      case "parked":
      case "completed":
        throw new Error("VikunjaTracker.transition not implemented");
    }
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
