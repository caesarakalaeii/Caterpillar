/**
 * The journal is read into EVERY session's opening prompt, and it appends forever
 * (README invariant 5). SMOKE-1 finished with a 347KB one — 620 byte-identical park
 * entries from a retry storm — which every later session on that task would have paid
 * for in full, before doing any work.
 *
 * These pin the two halves of the answer: collapse repeats, then keep the newest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { journalBudgetChars, journalForPrompt } from "./journal.ts";

const entry = (session: number, body: string, at = "2026-08-13T10:00:00.000Z"): string =>
  `\n## Session ${session} — ${at}\n\n${body}\n`;

test("a journal inside the budget is passed through untouched", () => {
  const journal = entry(1, "did a thing") + entry(2, "did another");
  assert.equal(journalForPrompt(journal, 10_000), journal);
});

test("an oversized journal keeps the NEWEST entries and drops the oldest", () => {
  // Continuity comes from what just happened. The opposite truncation — keeping the
  // head — would hand every session the first hour of a week-old task.
  const journal = Array.from({ length: 50 }, (_, i) => entry(i + 1, `body ${i + 1}`.repeat(20))).join("");
  const result = journalForPrompt(journal, 2_000);

  assert.ok(result.length <= 2_000 + 200, `got ${result.length} chars`);
  assert.match(result, /Session 50/, "the most recent entry must survive");
  assert.equal(/Session 1 —/.test(result), false, "the oldest entry must be dropped");
});

test("truncation never leaves a fragment of an entry", () => {
  const journal = Array.from({ length: 30 }, (_, i) => entry(i + 1, `entry ${i} `.padEnd(500, "x"))).join("");
  const result = journalForPrompt(journal, 1_500);

  const body = result.slice(result.indexOf("## Session"));
  assert.match(body, /^## Session \d+ — /, "the kept region must start at a heading");
});

test("elided entries are declared, not silently dropped", () => {
  // A journal that has quietly lost its first 40 entries, with nothing saying so, is a
  // journal the agent will trust as complete and re-derive decisions from.
  const journal = Array.from({ length: 50 }, (_, i) => entry(i + 1, `entry ${i} `.padEnd(300, "y"))).join("");
  const result = journalForPrompt(journal, 1_200);

  assert.match(result, /elided/i);
  assert.match(result, /\d+ earlier entr/i, "say HOW MANY were dropped");
});

test("a run of identical entries collapses to one, with the repeat count", () => {
  // The SMOKE-1 pathology exactly: a retry storm writing the same park entry hundreds of
  // times. Truncation alone would fill the whole budget with copies of one sentence.
  const journal =
    entry(1, "started work") +
    Array.from({ length: 620 }, (_, i) =>
      entry(0, "**Parked:** lease lost", `2026-08-12T10:${String(i % 60).padStart(2, "0")}:00.000Z`),
    ).join("") +
    entry(2, "finished work");
  const result = journalForPrompt(journal, 100_000);

  assert.equal(result.split("**Parked:** lease lost").length - 1, 1, "one copy, not 620");
  assert.match(result, /620/, "the repeat count is the information worth keeping");
  assert.match(result, /started work/);
  assert.match(result, /finished work/, "collapsing must not cost the entries around it");
});

test("collapsing happens BEFORE the budget, so the budget buys distinct content", () => {
  // Order matters: budget-then-collapse would spend the whole allowance on duplicates
  // and drop the one entry that says what the task actually did.
  const journal =
    entry(1, "the decision that matters: use the fork point as the baseline") +
    Array.from({ length: 400 }, () => entry(0, "**Parked:** lease lost")).join("");
  const result = journalForPrompt(journal, 1_000);

  assert.match(result, /the decision that matters/);
});

test("repeats that are not consecutive are kept as separate events", () => {
  // Parking, working, then parking again for the same reason is real history — the
  // second one means something different from the first.
  const journal = entry(1, "**Parked:** no progress") + entry(2, "made a commit") + entry(3, "**Parked:** no progress");
  const result = journalForPrompt(journal, 10_000);

  assert.equal(result.split("**Parked:** no progress").length - 1, 2);
});

test("a journal with no headings at all is still bounded", () => {
  // Hand-written or hand-edited journals exist; an unparseable one must not become an
  // unbounded prompt.
  const journal = "z".repeat(50_000);
  const result = journalForPrompt(journal, 1_000);

  assert.ok(result.length <= 1_000 + 200, `got ${result.length} chars`);
  assert.match(result, /elided/i);
});

test("the budget shrinks with the context window rather than being fixed", () => {
  // 32k characters is ~8k tokens: a rounding error in a 1M window, a quarter of a small
  // one. The cap has to mean the same thing to both.
  assert.equal(journalBudgetChars(1_000_000), 32_000);
  assert.ok(journalBudgetChars(32_000) < 32_000, "a small window must get a smaller share");
  assert.ok(journalBudgetChars(32_000) > 0);
});
