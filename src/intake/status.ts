/**
 * What the last intake pass did, remembered for exactly as long as this process lives.
 * See DESIGN.md §14 and §18.
 *
 * `IntakePass` has always been returned by `Ingester.ingest`, logged once at info, and
 * then thrown away. `seen` is the field that separates "nobody labelled anything" from
 * "the tracker returned three items and none became tasks", and until this existed it was
 * reachable only by reading one pod's stdout.
 *
 * IN MEMORY, NOT IN GIT, and that is the same argument §18 makes for not writing a runner
 * registry: a record committed every interval is a commit per runner per interval,
 * forever, in a repo every runner clones and pulls constantly. A pass that MATTERED is
 * already durable — as a task under `tasks/`, or as a refusal record under `intake/` —
 * so what is lost on a restart is only the negative result, which the next pass restates
 * within one interval.
 *
 * The claim is recorded alongside the counts because "this runner skipped the pass" and
 * "this runner ran the pass and saw nothing" are different facts that look identical from
 * a count of zero. With four replicas contending for `refs/intake/<bucket>` (see
 * `intakeRef`), three of them legitimately have nothing to report per interval.
 */
import type { IntakePass } from "./ingest.ts";

/** One remembered pass. `outcome` says whether counts are even meaningful. */
export interface IntakeStatusView extends Partial<IntakePass> {
  /** When the pass finished, ISO 8601. */
  readonly at: string;
  /** The `refs/intake/<bucket>` ref this pass contended for. */
  readonly ref: string;
  /** The runner that recorded this, which is always the one serving the page. */
  readonly runner: string;
  readonly outcome: IntakeOutcome;
  /** Present when the pass threw — a tracker outage, or a push that would not apply. */
  readonly error?: string;
}

/**
 * Why a pass has the counts it has.
 *
 *   `ingested` — this runner won the bucket and completed a pass; counts are real.
 *   `claimed-elsewhere` — another replica won it. No counts, and that is not a failure.
 *   `failed` — the pass threw. `error` says what, and the counts are absent rather than
 *     zero, because zero here would read as "the tracker had nothing".
 */
export type IntakeOutcome = "ingested" | "claimed-elsewhere" | "failed";

export class IntakeStatus {
  private last: IntakeStatusView | undefined;

  /**
   * Record a pass. The clock is the caller's, like `LiveSessionStart.startedAt`: the
   * supervisor owns time in this codebase and a class that called `Date.now()` would be
   * one more thing a test has to work around.
   */
  record(view: IntakeStatusView): void {
    this.last = view;
  }

  /** The last pass this runner knows about, or nothing since boot. */
  current(): IntakeStatusView | undefined {
    return this.last;
  }
}
