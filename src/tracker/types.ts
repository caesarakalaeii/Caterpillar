/**
 * Task tracker abstraction. See DESIGN.md §9.5.
 *
 * The tracker is a VIEW. The state repo is authoritative — if they disagree, git wins.
 *
 * Note what is absent: there is no `close()` the agent can reach. Lifecycle
 * transitions are driven by the supervisor after the §12 gates pass, because an
 * agent able to close its own tracker item would route around the verification it
 * is not allowed to perform.
 */
import type { TaskId, TrackerRef } from "../domain/task.ts";

/** An item discovered at intake, before it becomes a TaskSpec. */
export interface TrackerItem {
  readonly ref: TrackerRef;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

export type TrackerTransition =
  | { readonly kind: "claimed"; readonly runner: string }
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "parked"; readonly reason: string }
  | { readonly kind: "completed"; readonly prUrl: string };

export interface Tracker {
  readonly kind: string;

  /** Items labelled for agent pickup, for the intake path (DESIGN.md §14). */
  listAgentItems(): Promise<readonly TrackerItem[]>;

  /** Append a comment. The only tracker capability exposed to the agent. */
  comment(ref: TrackerRef, text: string): Promise<void>;

  /**
   * Mirror a lifecycle change. Supervisor-only.
   *
   * Handoffs deliberately have no transition — a multi-hour task would otherwise
   * become twenty comments of noise.
   */
  transition(ref: TrackerRef, transition: TrackerTransition, task: TaskId): Promise<void>;
}

/**
 * Distinguishes "this token lacks the scope for this route" from "this token is
 * invalid". Vikunja answers both with 401, and conflating them sends callers off
 * debugging a token that is fine (DESIGN.md §9.5).
 */
export class TrackerScopeError extends Error {
  readonly route: string;
  readonly requiredScope: string;

  constructor(route: string, requiredScope: string) {
    super(
      `tracker rejected ${route} — the API token almost certainly lacks the ` +
        `'${requiredScope}' scope. Re-grant it in the UI; do not retry, and do not ` +
        `debug the token itself.`,
    );
    this.route = route;
    this.requiredScope = requiredScope;
    this.name = "TrackerScopeError";
  }
}
