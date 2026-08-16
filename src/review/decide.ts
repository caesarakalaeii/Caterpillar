/**
 * Turning three opinions into one decision. See DESIGN.md §12.1.
 *
 * Pure, and separated from everything that runs a reviewer, because this is the rule the
 * whole council exists to apply and it must be readable in one screen and testable
 * without a model.
 *
 * The rule: ANY reviewer raising a BLOCKING objection sends the work back. Not a
 * majority. A council votes on preferences; a defect is not a preference, and two
 * reviewers who did not look at the thing a third one found are not evidence against it.
 * The cost is borne on the other side — a blocking objection is expensive, so the lenses
 * are told at length when not to raise one (`lenses.ts`).
 *
 * An abstention is never an approval. A reviewer whose session errored or ran out of
 * context has not agreed to anything, and the verdict says so rather than quietly
 * counting it as a pass.
 */

export type Decision = "pass" | "changes";

export interface Finding {
  /** Where, as the reviewer described it — `file:line` where it could tell. */
  readonly where: string;
  readonly what: string;
}

/** One reviewer's answer. `abstained` is set when the reviewer never returned one. */
export interface ReviewerVerdict {
  readonly lens: string;
  readonly title: string;
  readonly decision: Decision;
  readonly blocking: boolean;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly abstained?: boolean;
}

export interface CouncilVerdict {
  readonly decision: Decision;
  /** Reviewers that voted to send it back, in lens order. */
  readonly blockers: readonly ReviewerVerdict[];
  /** Reviewers that could not review at all. Never counted as approval. */
  readonly abstentions: readonly ReviewerVerdict[];
  readonly verdicts: readonly ReviewerVerdict[];
}

export const decide = (verdicts: readonly ReviewerVerdict[]): CouncilVerdict => {
  const abstentions = verdicts.filter((v) => v.abstained === true);
  const blockers = verdicts.filter((v) => v.abstained !== true && v.decision === "changes" && v.blocking);

  return {
    // An empty council is not unanimous approval. It means nothing reviewed this, which
    // is the one outcome that must never merge silently — and a council where every
    // reviewer abstained is the same council, convened. That second half was missing:
    // abstentions are excluded from `blockers` by design, so three of them left zero
    // blocking objections and read as a pass. During a provider outage that is every
    // reviewer, which made "the model is unreachable" a way to merge an unread change.
    decision:
      blockers.length > 0 || verdicts.length === abstentions.length ? "changes" : "pass",
    blockers,
    abstentions,
    verdicts,
  };
};

/**
 * The verdict as it is written to `reviews/NNN-verdict.md` and appended to the journal.
 *
 * The journal is what the next implementation session actually reads, so this is the
 * document that has to make a rejected change actionable without the agent going looking
 * for anything.
 */
export const renderVerdict = (verdict: CouncilVerdict): string => {
  const lines: string[] = [
    verdict.decision === "pass"
      ? "**Review council: PASS** — no blocking objections."
      : `**Review council: CHANGES REQUESTED** — ${verdict.blockers.length} blocking objection(s).`,
    "",
  ];

  for (const reviewer of verdict.verdicts) {
    const verdictLabel =
      reviewer.abstained === true
        ? "ABSTAINED"
        : reviewer.decision === "pass"
          ? "pass"
          : reviewer.blocking
            ? "CHANGES (blocking)"
            : "changes (non-blocking)";

    lines.push(`### ${reviewer.title} — ${verdictLabel}`, "", reviewer.summary.trim(), "");
    for (const finding of reviewer.findings) {
      lines.push(`- \`${finding.where}\` — ${finding.what}`);
    }
    if (reviewer.findings.length > 0) lines.push("");
  }

  if (verdict.abstentions.length > 0) {
    lines.push(
      `_${verdict.abstentions.length} reviewer(s) could not complete a review. An ` +
        `abstention is not an approval._`,
      "",
    );
  }

  return lines.join("\n").trim();
};

/** One-line form for Discord and the log. */
export const summariseVerdict = (verdict: CouncilVerdict): string =>
  verdict.decision === "pass"
    ? `passed ${verdict.verdicts.length} lens(es)`
    : `blocked by ${verdict.blockers.map((b) => b.lens).join(", ")}`;
