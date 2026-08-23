/**
 * The output ceiling (DESIGN.md §6.4, README invariant 12).
 *
 * Invariant 12 bounds how LONG a command may run. These pin the other half: how much it
 * may return. One wide `grep` can spend a large share of the window the handoff machinery
 * (§6.1) exists to protect, and when it does the session hands off early with a journal
 * that cannot say why.
 *
 * Everything here is pure. The file the overflow goes to is written by `exec.ts`; this
 * module only decides what to keep and what to say about the rest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  boundOutput,
  outputCeiling,
} from "./budget.ts";

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");

test("output inside the ceiling is passed through byte for byte", () => {
  const text = lines(10);
  const bounded = boundOutput(text, outputCeiling({}));

  assert.equal(bounded.text, text);
  assert.equal(bounded.elided, false);
  assert.equal(bounded.droppedLines, 0);
});

test("output over the line ceiling keeps the head AND the tail", () => {
  // THE REGRESSION THIS EXISTS FOR. A test runner puts the failure summary last, so
  // head-only truncation throws away the one part of a failing run that says what broke.
  // A compiler puts the first error first, so tail-only throws that away instead.
  const bounded = boundOutput(lines(4_000), outputCeiling({ maxLines: 100 }));

  assert.match(bounded.text, /^line 1$/m, "the first line must survive");
  assert.match(bounded.text, /^line 4000$/m, "the LAST line must survive");
  assert.equal(bounded.elided, true);
});

test("what was dropped is declared in the output, not left to be inferred", () => {
  const bounded = boundOutput(lines(40_112), outputCeiling({ maxLines: 1_284 }));

  assert.match(
    bounded.text,
    /1,284 of 40,112 lines shown/,
    `the elision must state its own size, got: ${bounded.text.slice(0, 400)}`,
  );
  assert.match(bounded.text, /head and tail/, "it must say WHICH lines were kept");
});

test("the kept lines are never more than the ceiling allows", () => {
  const bounded = boundOutput(lines(5_000), outputCeiling({ maxLines: 50 }));

  const kept = bounded.text.split("\n").filter((line) => !line.startsWith("["));
  assert.ok(kept.length <= 50, `kept ${kept.length} lines against a ceiling of 50`);
  assert.equal(bounded.droppedLines, 5_000 - kept.length);
});

test("a byte ceiling bites even when the line count is small", () => {
  // One `cat` of a minified lockfile is a handful of very long lines. A line ceiling
  // alone lets it through whole, which is the case that costs the most context.
  const fat = `${"x".repeat(50_000)}\n${"y".repeat(50_000)}\n${"z".repeat(50_000)}`;
  const bounded = boundOutput(fat, outputCeiling({ maxLines: 1_000, maxBytes: 4_000 }));

  assert.ok(
    Buffer.byteLength(bounded.text, "utf8") <= 4_000 + 400,
    `bounded output was ${Buffer.byteLength(bounded.text, "utf8")} bytes`,
  );
  assert.equal(bounded.elided, true);
});

test("a line longer than the whole byte ceiling is cut, and says so", () => {
  // Neither head nor tail can be a whole line here, so the guarantee "never a partial
  // line" has to give way. It gives way LOUDLY: a truncated line that looks complete is
  // how a model comes to believe a file ends where it does not.
  const bounded = boundOutput("x".repeat(20_000), outputCeiling({ maxBytes: 1_000 }));

  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 1_400);
  assert.match(bounded.text, /bytes shown/);
});

test("the overflow file is named in the output when there is one", () => {
  // The information is not destroyed, only kept out of the window. A session that needs
  // the middle of a 40k-line run has to be told where to read it in slices.
  const bounded = boundOutput(lines(4_000), outputCeiling({ maxLines: 10 }), {
    overflowPath: ".caterpillar/output/abc123.log",
  });

  assert.match(bounded.text, /\.caterpillar\/output\/abc123\.log/);
});

test("an unbounded ceiling from config is clamped down to the built-in one", () => {
  // Invariant 12's rule: a ceiling a model — or a config it can edit in its own worktree
  // — may raise is not a ceiling. Same shape as limits.commandTimeoutSeconds.
  const ceiling = outputCeiling({ maxLines: 10_000_000, maxBytes: 10_000_000_000 });

  assert.equal(ceiling.maxLines, MAX_OUTPUT_LINES);
  assert.equal(ceiling.maxBytes, MAX_OUTPUT_BYTES);
});

test("an absent ceiling defaults rather than meaning unbounded", () => {
  const ceiling = outputCeiling({});

  assert.equal(ceiling.maxLines, MAX_OUTPUT_LINES);
  assert.equal(ceiling.maxBytes, MAX_OUTPUT_BYTES);
});

test("a lower ceiling from config is honoured", () => {
  const ceiling = outputCeiling({ maxLines: 200, maxBytes: 8_000 });

  assert.equal(ceiling.maxLines, 200);
  assert.equal(ceiling.maxBytes, 8_000);
});

test("a nonsense ceiling falls back to the default instead of disabling the bound", () => {
  // Zero, negative and fractional all reach here from a hand-edited config. None of them
  // may become "no limit" — that is the state this module exists to make impossible.
  for (const maxLines of [0, -1, 1.5, Number.NaN]) {
    assert.equal(outputCeiling({ maxLines }).maxLines, MAX_OUTPUT_LINES, `maxLines=${maxLines}`);
  }
  for (const maxBytes of [0, -1, 2.5, Number.NaN]) {
    assert.equal(outputCeiling({ maxBytes }).maxBytes, MAX_OUTPUT_BYTES, `maxBytes=${maxBytes}`);
  }
});

test("empty output is not decorated with an elision", () => {
  const bounded = boundOutput("", outputCeiling({}));

  assert.equal(bounded.text, "");
  assert.equal(bounded.elided, false);
});
