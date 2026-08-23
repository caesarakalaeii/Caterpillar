import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./budget.ts";
import { ContextBudget, HandoffThresholdError } from "./limits.ts";

test("handoff threshold must sit below the compaction point", () => {
  // 0.99 of a 200k window leaves less headroom than reserveTokens, so handoff would
  // never win the race. This is the DESIGN.md §6.1 invariant, enforced at construction.
  assert.throws(
    () => new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.99 }),
    HandoffThresholdError,
  );
});

test("a sane threshold is accepted and sits below the compaction point", () => {
  const budget = new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 });
  assert.equal(budget.thresholdTokens, 140_000);
  assert.equal(budget.compactionTokens, 200_000 - DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  assert.ok(budget.thresholdTokens < budget.compactionTokens);
});

test("threshold fraction must be a proper fraction", () => {
  assert.throws(
    () => new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0 }),
    RangeError,
  );
  assert.throws(
    () => new ContextBudget({ contextWindow: 200_000, thresholdFraction: 1 }),
    RangeError,
  );
});

test("a small window with a large reserve cannot be satisfied", () => {
  // reserveTokens defaults to 16384; a 20k window at 0.7 leaves the threshold above
  // the compaction point, which must be rejected rather than silently misbehaving.
  assert.throws(
    () => new ContextBudget({ contextWindow: 20_000, thresholdFraction: 0.7 }),
    HandoffThresholdError,
  );
});

test("handoff fires once the estimate crosses the threshold", () => {
  const budget = new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 });

  assert.equal(budget.shouldHandoff([]), false);

  // An assistant message carries provider-reported usage, which the estimator trusts
  // over character counting. Note the total must include cache reads/writes —
  // omitting them would undercount a cached context badly.
  const heavy = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "done" }],
    api: "anthropic-messages" as const,
    provider: "test",
    model: "test-model",
    usage: {
      input: 100_000,
      output: 1_000,
      cacheRead: 40_000,
      cacheWrite: 0,
      totalTokens: 141_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 1,
  };

  assert.ok(budget.tokensUsed([heavy]) >= 141_000);
  assert.equal(budget.shouldHandoff([heavy]), true);
  assert.equal(budget.wouldCompact([heavy]), false);
});

/**
 * The output ceiling measured in the SAME accounting as the handoff threshold
 * (DESIGN.md §6.1 and §6.4).
 *
 * A fixed line count says nothing about what it costs. 2,000 lines is a rounding error in
 * a 1M window and a third of a 32k one, and the session still has to do its work in
 * whatever is left — the same argument `journalBudgetChars` makes about journal history,
 * and the reason it is made here rather than in `budget.ts`: this is the class that knows
 * how big the window is and what a token is worth in it.
 */
test("the output ceiling is a share of the window, not a fixed number of lines", () => {
  const small = new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 });
  const large = new ContextBudget({ contextWindow: 1_000_000, thresholdFraction: 0.7 });

  assert.ok(
    large.outputCeiling().maxBytes > small.outputCeiling().maxBytes,
    "a bigger window must allow a bigger single tool result",
  );
});

test("one command can never spend the whole handoff budget", () => {
  // The failure this exists to prevent: one `grep` that on its own crosses the threshold,
  // so the session hands off having done nothing and cannot say why.
  const budget = new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 });
  const ceiling = budget.outputCeiling();

  assert.ok(
    ceiling.maxBytes < budget.thresholdTokens,
    `one tool result may take ${ceiling.maxBytes} bytes of a ${budget.thresholdTokens}-token budget`,
  );
});

test("a configured ceiling is honoured when it is lower than the window's share", () => {
  // The operator's number wins downwards. Upwards it does not: a window cannot afford
  // more than its share whatever the config says.
  const budget = new ContextBudget({ contextWindow: 1_000_000, thresholdFraction: 0.7 });

  const tight = budget.outputCeiling({ maxLines: 50, maxBytes: 4_000 });
  assert.equal(tight.maxLines, 50);
  assert.equal(tight.maxBytes, 4_000);
});

test("the window's share caps a generous configured ceiling on a small window", () => {
  const budget = new ContextBudget({ contextWindow: 60_000, thresholdFraction: 0.5 });

  const ceiling = budget.outputCeiling({ maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
  assert.ok(
    ceiling.maxBytes < MAX_OUTPUT_BYTES,
    `a 60k window allowed ${ceiling.maxBytes} bytes per command`,
  );
});
