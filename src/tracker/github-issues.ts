/**
 * GitHub Issues tracker for the `caesar` workspace. See DESIGN.md §9.5, §14.
 *
 * STUB — signatures settled, HTTP calls not implemented.
 *
 * Reuses the workspace's Forge credential rather than holding its own token: the
 * GitHub App already grants `issues`/`pull_requests` where needed, so there is no
 * second secret to manage here.
 */
import type { TaskId, TrackerRef } from "../domain/task.ts";
import type { Tracker, TrackerItem, TrackerTransition } from "./types.ts";

export interface GitHubIssuesOptions {
  readonly apiBase: string;
  readonly owner: string;
  readonly ingestLabel: string;
  /** Supplies the installation token; see forge/github-app.ts. */
  readonly token: () => Promise<string>;
}

export class GitHubIssuesTracker implements Tracker {
  readonly kind = "github-issues";

  constructor(private readonly options: GitHubIssuesOptions) {}

  async listAgentItems(): Promise<readonly TrackerItem[]> {
    void this.options;
    // GET /search/issues?q=label:<ingestLabel>+state:open+org:<owner>
    throw new Error("GitHubIssuesTracker.listAgentItems not implemented");
  }

  async comment(ref: TrackerRef, text: string): Promise<void> {
    void ref;
    void text;
    throw new Error("GitHubIssuesTracker.comment not implemented");
  }

  async transition(
    ref: TrackerRef,
    transition: TrackerTransition,
    task: TaskId,
  ): Promise<void> {
    void ref;
    void transition;
    void task;
    throw new Error("GitHubIssuesTracker.transition not implemented");
  }
}
