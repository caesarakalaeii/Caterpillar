/**
 * Did the fix work? The closing edge of alert-driven remediation (DESIGN.md §20).
 *
 * A remediation task diagnoses a firing alert, opens a pull request, the council reads it,
 * and it merges. Up to here nothing checks whether the ALERT stopped — and the task id
 * being `ALERT-<fingerprint>` means a re-fire after an ineffective fix is deduped against
 * the task that already exists, so it may not become work again at all. The loop could
 * close on a patch that changed nothing, with a human noticing the alert weeks later.
 *
 * Pure: no IO, no clock of its own, no network. The observation is performed by the
 * SUPERVISOR (invariant 13) and handed in as `evidence`; everything decidable from that
 * evidence is decided here, which is what makes the property worth having — that a clear
 * requires positive proof — assertable in a unit test rather than in a cluster.
 *
 * ## What counts as evidence
 *
 * Alertmanager tells this fleet about an alert by delivering it: a firing alert is
 * re-delivered on `repeat_interval` for as long as it fires, and a webhook receiver with
 * `send_resolved` (its default) also gets one delivery when it stops. `queue.ts` stamps
 * both onto `alerts/refusals/<fingerprint>.json`, so the record is the ledger of what
 * Alertmanager has said about this fingerprint and this module reads it.
 *
 * **Silence is not a clear.** It is the one inference this module refuses to make, and the
 * reason it refuses is that "no delivery since the merge" is also what a stopped
 * Alertmanager, a route someone edited, a rotated webhook token and a receiver that was
 * never enabled look like. Every one of those is indistinguishable from a fix that worked,
 * and a fleet that reports them alike has reintroduced the silent success this exists to
 * remove. So silence past the deadline is `unverifiable` — recorded, notified, and never
 * counted as a success.
 */

/**
 * How long a fix gets to take effect before a verdict is due.
 *
 * Ten minutes because it has to clear two intervals and a scrape: Prometheus evaluates on
 * the order of a minute, an alert rule usually carries a `for:` of a few minutes, and
 * Alertmanager then has its own group interval before it delivers the resolution. A window
 * under all three would report a working fix as still firing.
 */
export const DEFAULT_SETTLE_SECONDS = 600;

/**
 * The ceiling on a configured window. Six hours.
 *
 * A bound rather than a default, and the difference is the point: the task stays OPEN for
 * the window, so an unbounded one is a task nothing ever closes and an alert nothing ever
 * re-files. An alert that clears slowly and an alert that never clears have to be
 * distinguishable within a time an operator can name, which is what makes this a settle
 * window and not a wait-forever.
 */
export const MAX_SETTLE_SECONDS = 6 * 60 * 60;

/**
 * A window an operator asked for, reduced to one this will actually honour.
 *
 * Absent, zero and negative all mean the default rather than "no wait": zero would decide
 * every task on the first pass after the merge, before Alertmanager has had a chance to
 * say anything, which makes every fix unverifiable. `policy.ts` rejects a non-integer and
 * a negative outright, so this clamp is the second line rather than the first — the
 * supervisor's own configuration reaches it too.
 */
export const settleWindowSeconds = (configured: number | undefined): number => {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SETTLE_SECONDS;
  }
  return Math.min(Math.floor(configured), MAX_SETTLE_SECONDS);
};

/**
 * What the supervisor managed to observe about one fingerprint.
 *
 * Two shapes rather than optional fields, because "the record says nothing was delivered"
 * and "the record could not be read" are different facts with different consequences and
 * an optional field would let a caller conflate them. `unavailable` carries the operator's
 * sentence — Loki unreachable, the allowlist changed, the record would not parse — and it
 * can only ever produce `unverifiable`.
 */
export type AlertEvidence =
  | {
      readonly kind: "observed";
      /** When Alertmanager last delivered this fingerprint as firing, if ever. */
      readonly lastFiringAt?: string;
      /** When Alertmanager last delivered it as resolved, if ever. */
      readonly resolvedAt?: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The four things a re-verification can conclude.
 *
 * `waiting` is a non-verdict and is why the type has four members rather than three: the
 * settle window has not run out and no evidence has settled the question, so the task is
 * held rather than decided. A caller that collapsed it into `still-firing` would park every
 * task whose alert takes one more scrape to catch up, which is most of them.
 */
export type ReverifyVerdict =
  | { readonly kind: "cleared"; readonly elapsedMs: number }
  | { readonly kind: "still-firing"; readonly lastFiringAt: string }
  | { readonly kind: "waiting"; readonly remainingMs: number }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface ReverifyRequest {
  /** When the pull request merged. The instant every other timestamp is compared to. */
  readonly mergedAt: string;
  readonly evidence: AlertEvidence;
  readonly settleSeconds: number;
  /** Injected, so the whole decision is testable without spending the wall clock. */
  readonly now: number;
}

/**
 * An ISO instant, or undefined for anything that is not one.
 *
 * A timestamp here comes out of a JSON record in the state repo, which a human can edit
 * and which older writers may not have stamped at all. `Date.parse` answers garbage with
 * NaN, and NaN loses every comparison in both directions — so an unguarded implementation
 * would silently treat a corrupt `resolvedAt` as "before the merge" and carry on, which is
 * how a broken record becomes a wrong verdict rather than a reported one.
 */
const instant = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Decide whether the merged fix cleared the alert.
 *
 * The order of the checks is the design, so it is worth reading as a sequence:
 *
 *   1. evidence we could not gather answers nothing, whatever the clock says;
 *   2. a resolved delivery at or after the merge is the ONLY clear, and it is reported the
 *      moment it is seen rather than at the end of the window;
 *   3. a firing delivery at or after the merge, once the window has run out, is a failure;
 *   4. still inside the window is no verdict yet;
 *   5. past the window with nothing delivered either way is unverifiable — see the module
 *      comment for why that is not a clear.
 */
export const reverifyAlert = (request: ReverifyRequest): ReverifyVerdict => {
  const { evidence, now } = request;

  if (evidence.kind === "unavailable") {
    return { kind: "unverifiable", reason: evidence.reason };
  }

  const mergedAt = instant(request.mergedAt);
  if (mergedAt === undefined) {
    return {
      kind: "unverifiable",
      reason:
        `the recorded merge timestamp '${request.mergedAt}' is not a date, so there is ` +
        `no instant to compare Alertmanager's deliveries against`,
    };
  }

  const resolvedAt = instant(evidence.resolvedAt);
  if (resolvedAt !== undefined && resolvedAt >= mergedAt) {
    return { kind: "cleared", elapsedMs: resolvedAt - mergedAt };
  }

  const firingAt = instant(evidence.lastFiringAt);
  const deadline = mergedAt + settleWindowSeconds(request.settleSeconds) * 1000;

  if (now < deadline) return { kind: "waiting", remainingMs: deadline - now };

  if (firingAt !== undefined && firingAt >= mergedAt) {
    // `lastFiringAt` rather than `evidence.lastFiringAt`: the former is known to parse,
    // and a verdict that quoted a timestamp it could not read would be reporting garbage
    // to the human it is asking to look at the alert.
    return { kind: "still-firing", lastFiringAt: new Date(firingAt).toISOString() };
  }

  return {
    kind: "unverifiable",
    reason:
      `nothing has been delivered for this alert since the fix merged, so it cannot be ` +
      `told from here whether it stopped: Alertmanager may be quiet because the alert ` +
      `cleared, or because it is not reaching this receiver`,
  };
};

/** `240000` → `4m`. A digest line is read at a glance. */
const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * One line, for the journal, the digest (§19) and Discord.
 *
 * ONE rendering for all three, for the reason `digest/render.ts` records: a verdict that
 * says different things in different places is one nobody can quote. The four sentences
 * are deliberately unalike — a silent success and a silent failure looking the same is the
 * defect this whole feature is about, so they must not read the same either.
 */
export const describeVerdict = (verdict: ReverifyVerdict): string => {
  switch (verdict.kind) {
    case "cleared":
      return `fix merged, alert cleared after ${duration(verdict.elapsedMs)}`;
    case "still-firing":
      return `fix merged, alert still firing (last delivered ${verdict.lastFiringAt})`;
    case "waiting":
      return `fix merged, waiting ${duration(verdict.remainingMs)} more for the alert to clear`;
    case "unverifiable":
      return `fix merged, but it could not be re-verified: ${verdict.reason}`;
  }
};
