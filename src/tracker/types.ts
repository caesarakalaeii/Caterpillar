/**
 * Task tracker abstraction. See DESIGN.md §9.5.
 *
 * The tracker is a VIEW. The state repo is authoritative — if they disagree, git wins.
 *
 * Note what is absent: there is no `close()` the agent can reach. Lifecycle
 * transitions are driven by the supervisor after the §12 gates pass, because an
 * agent able to close its own tracker item would route around the verification it
 * is not allowed to perform.
 *
 * `create` is supervisor-driven for the same reason, and files under
 * DEFAULT_CANDIDATE_LABEL — deliberately NOT the label `listAgentItems` picks up. A
 * filed item is a REPORT awaiting a human's judgement, not a task. If filing applied
 * the ingest label, the next intake pass would mint the report into a running task,
 * which could file another report: the loop amplifies itself and nobody authorised any
 * of it.
 */
import type { TaskId, TrackerRef } from "../domain/task.ts";

/** An item discovered at intake, before it becomes a TaskSpec. */
export interface TrackerItem {
  readonly ref: TrackerRef;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /**
   * Whether the item's AUTHOR is someone whose text may become a task.
   *
   * The label is applied by a maintainer, but the body is written — and can be edited
   * afterwards, forever — by the author. Since the `agent` block's `acceptance` list is
   * executed as shell in the supervisor's own process, "a maintainer labelled it" is not
   * on its own an authorisation to run the body.
   *
   * Each adapter decides this in its own terms, because trust means different things per
   * tracker: GitHub has arm's-length contributors, a self-hosted Vikunja does not.
   */
  readonly authorTrusted: boolean;
}

/**
 * The label a newly filed item carries.
 *
 * A human promotes a candidate by relabelling it with the workspace's ingest label.
 * Keeping the two distinct is what stops filing from being the same act as tasking.
 */
export const DEFAULT_CANDIDATE_LABEL = "agent-candidate";

/** A new item to file. See `Tracker.create`. */
export interface TrackerCreateRequest {
  readonly title: string;
  /** Prose. Each adapter renders it in the markup its tracker expects. */
  readonly body: string;
  /** Where to file: a GitHub `owner/name` slug, a Vikunja project id. */
  readonly container: string;
  /** Labels to apply. Normally `[DEFAULT_CANDIDATE_LABEL]`. */
  readonly labels: readonly string[];
  /**
   * Called with the labels that did not exist on the target and were skipped, so the
   * omission reaches a log rather than being silently absorbed. Not called when every
   * label applied.
   */
  readonly onLabelsOmitted?: (labels: readonly string[]) => void;
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
   * File a new item, returning a ref that addresses it. Supervisor-only.
   *
   * A label that does not exist on the target is DROPPED, not created, and reported
   * through `request.onLabelsOmitted`. Neither adapter may invent tracker vocabulary:
   * GitHub's `POST /issues/{n}/labels` would silently create one with a random colour,
   * and the Vikunja token is deliberately denied `labels:create`. Dropping is also the
   * cheaper failure of the two available — a missing label is recoverable by hand,
   * whereas failing the whole create loses the report it was carrying.
   */
  create(request: TrackerCreateRequest): Promise<TrackerRef>;

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
