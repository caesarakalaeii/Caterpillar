import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
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
