/**
 * Turning several opinions into one decision. See DESIGN.md §12.1.
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
    // abstentions are excluded from `blockers` by design, so a full set of them left zero
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

/**
 * One-line form for the log and a message header.
 *
 * The all-abstained case is spelled out rather than falling through the blocker list. It
 * reaches here — `decide` returns `changes` when every reviewer abstained, and by
 * construction that verdict has no blockers — and the join over an empty list produced
 * `blocked by` with nothing after it, in the one outcome where the reader most needs to be
 * told that no review happened at all.
 */
export const summariseVerdict = (verdict: CouncilVerdict): string =>
  verdict.decision === "pass"
    ? `passed ${verdict.verdicts.length} lens(es)`
    : verdict.blockers.length === 0
      ? `no reviewer completed a review (${verdict.abstentions.length} abstained)`
      : `blocked by ${verdict.blockers.map((b) => b.lens).join(", ")}`;

/** Findings quoted per blocking lens. The rest are in `reviews/NNN-verdict.md`. */
const FINDINGS_SHOWN = 3;

/**
 * WHY it was sent back, short enough for a chat message.
 *
 * `summariseVerdict` names the lenses that objected; this says what they objected TO, and
 * the difference is the whole reason this exists. A one-line summary is all Discord ever
 * showed, and `blocked by feasibility, decomposition` names two lenses and nothing a human
 * can act on — the reasons were in `reviews/NNN-verdict.md`, in a repo they would have to
 * clone to read. Someone watching a brainstorm get rejected three times in a row could see
 * that it happened and never once see why.
 *
 * The most actionable material comes FIRST, per blocker: its own summary, then its
 * findings. Callers fit this to Discord's limit (`notify/discord.ts`) and a truncated tail
 * costs the least there. `FINDINGS_SHOWN` bounds it before truncation gets involved, so
 * what survives is whole findings rather than a sentence cut mid-word, and the count of
 * what was dropped is stated rather than left to look like the end of the list.
 */
export const explainVerdict = (verdict: CouncilVerdict): string => {
  if (verdict.decision === "pass") {
    return `No blocking objections from ${verdict.verdicts.length} lens(es).`;
  }

  if (verdict.blockers.length === 0) {
    return (
      `No reviewer completed a review — ${verdict.abstentions.length} abstained, and an ` +
      `abstention is not an approval. Nobody has objected to anything in the work itself; ` +
      `it goes back as it is and is reviewed again.`
    );
  }

  const lines: string[] = [];
  for (const blocker of verdict.blockers) {
    lines.push(`**${blocker.title}** — ${blocker.summary.trim()}`);
    for (const finding of blocker.findings.slice(0, FINDINGS_SHOWN)) {
      lines.push(`- \`${finding.where}\` — ${finding.what}`);
    }
    const hidden = blocker.findings.length - FINDINGS_SHOWN;
    if (hidden > 0) lines.push(`- …and ${hidden} more, in the full verdict.`);
    lines.push("");
  }
  return lines.join("\n").trim();
};
