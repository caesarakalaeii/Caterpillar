/**
 * Context budgeting and the handoff trigger. See DESIGN.md §6.1.
 *
 * We want hard handoff, NOT compaction. pi will auto-compact at
 * `contextTokens > contextWindow - reserveTokens`, so the handoff threshold must sit
 * strictly below that point — otherwise pi silently summarises and the session keeps
 * running with lossy context, which is the failure mode this design exists to avoid.
 *
 * That invariant is asserted at construction rather than documented, and
 * `wouldCompact` exists so the supervisor can emit the leak metric if it ever fires.
 */
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";

export class HandoffThresholdError extends Error {
  constructor(thresholdTokens: number, compactionTokens: number) {
    super(
      `handoff threshold (${thresholdTokens} tokens) must be strictly below pi's ` +
        `compaction trigger (${compactionTokens} tokens), or compaction will fire ` +
        `before handoff and context will be summarised instead of handed off`,
    );
    this.name = "HandoffThresholdError";
  }
}

export interface ContextBudgetOptions {
  readonly contextWindow: number;
  /** Fraction of the window at which to hand off, e.g. 0.70. */
  readonly thresholdFraction: number;
  readonly compaction?: CompactionSettings;
}

export class ContextBudget {
  readonly thresholdTokens: number;
  readonly compactionTokens: number;
  private readonly contextWindow: number;
  private readonly compaction: CompactionSettings;

  constructor(options: ContextBudgetOptions) {
    if (options.thresholdFraction <= 0 || options.thresholdFraction >= 1) {
      throw new RangeError(
        `thresholdFraction must be in (0,1), got ${options.thresholdFraction}`,
      );
    }

    this.contextWindow = options.contextWindow;
    this.compaction = options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
    this.thresholdTokens = Math.floor(
      options.contextWindow * options.thresholdFraction,
    );
    this.compactionTokens = options.contextWindow - this.compaction.reserveTokens;

    if (this.thresholdTokens >= this.compactionTokens) {
      throw new HandoffThresholdError(this.thresholdTokens, this.compactionTokens);
    }
  }

  /** Current context size, using pi's own estimator so we agree with its accounting. */
  tokensUsed(messages: readonly AgentMessage[]): number {
    return estimateContextTokens([...messages]).tokens;
  }

  /** The handoff decision. Evaluated at turn boundaries via `shouldStopAfterTurn`. */
  shouldHandoff(messages: readonly AgentMessage[]): boolean {
    return this.tokensUsed(messages) >= this.thresholdTokens;
  }

  /**
   * True when context has passed the point the pi harness treats as unsafe.
   *
   * We use `pi-agent-core` directly rather than the coding-agent harness, so nothing
   * compacts automatically — this is not a "pi summarised behind our back" check.
   * It is an overrun alarm: past this point the next provider request risks a
   * context-length error, which means the handoff trigger fired too late
   * (DESIGN.md §6.1).
   */
  wouldCompact(messages: readonly AgentMessage[]): boolean {
    return shouldCompact(
      this.tokensUsed(messages),
      this.contextWindow,
      this.compaction,
    );
  }

  /** Fraction of the window in use, for metrics. */
  utilisation(messages: readonly AgentMessage[]): number {
    return this.tokensUsed(messages) / this.contextWindow;
  }
}
