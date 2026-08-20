/**
 * The test-first evidence a reviewer is handed.
 *
 * Two failure modes are asserted, and they pull in opposite directions. Too eager and a
 * docs-only change is reported as untested work, which teaches the lens to ignore this
 * block. Too lax and "wrote the code, bolted a test on at the end" reads identically to
 * red-green-refactor, which is the one thing the block exists to tell apart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPath, renderEvidence, testFirstEvidence, type Commit } from "./tdd.ts";

const commit = (oid: string, subject: string, files: readonly string[]): Commit => ({
  oid,
  subject,
  files,
});

test("a test file is recognised across the conventions each language uses", () => {
  // Not TypeScript's alone. A fleet works on whatever repo it is pointed at, and a
  // classifier that only knows `*.test.ts` reports every Go change as untested.
  for (const path of [
    "src/review/tdd.test.ts",
    "src/review/tdd.spec.js",
    "internal/server/handler_test.go",
    "tests/test_ingest.py",
    "spec/models/user_spec.rb",
    "src/test/java/com/example/FooTest.java",
    "__tests__/render.tsx",
    "pkg/api/testdata/golden.json",
  ]) {
    assert.equal(classifyPath(path), "test", path);
  }
});

test("documentation and lockfiles are neither test nor source", () => {
  // They must not count as source, or a README fix is flagged as untested; and they must
  // not count as a test, or a change that only touched docs looks covered.
  for (const path of ["README.md", "docs/runbook.adoc", "package-lock.json", "LICENSE"]) {
    assert.equal(classifyPath(path), "other", path);
  }
});

test("anything else is source", () => {
  for (const path of ["src/agent/prompt.ts", "cmd/main.go", "Dockerfile", "src/app.css"]) {
    assert.equal(classifyPath(path), "source", path);
  }
});

test("a test commit before the source commit reads as test-first", () => {
  const evidence = testFirstEvidence([
    commit("aaa1111", "test: cover the empty-repos case", ["src/intake/spec.test.ts"]),
    commit("bbb2222", "fix(intake): refuse a spec with no repos", ["src/intake/spec.ts"]),
  ]);

  assert.equal(evidence.touchesSource, true);
  assert.deepEqual(evidence.unpreceded, []);
});

test("source committed before any test is named, with the commit that did it", () => {
  // The whole point. Both series end in the same tree; only the order distinguishes
  // them, and the order is the only durable trace TDD leaves.
  const evidence = testFirstEvidence([
    commit("aaa1111", "fix(intake): refuse a spec with no repos", ["src/intake/spec.ts"]),
    commit("bbb2222", "test: cover the empty-repos case", ["src/intake/spec.test.ts"]),
  ]);

  assert.deepEqual(
    evidence.unpreceded.map((c) => c.oid),
    ["aaa1111"],
  );
});

test("a commit carrying its own test is test-first enough", () => {
  // Red-green-refactor squashed into one commit still shows the test and the code
  // arriving together, which is the property worth having. Demanding two commits would
  // be enforcing a git habit rather than a testing one.
  const evidence = testFirstEvidence([
    commit("aaa1111", "feat: add the thing", ["src/thing.ts", "src/thing.test.ts"]),
  ]);

  assert.deepEqual(evidence.unpreceded, []);
});

test("a later source commit is covered by an earlier test commit", () => {
  // Once a test exists in the series, subsequent source commits are the refactor half of
  // the loop. Flagging them would make every green-then-refactor cycle look like a
  // violation.
  const evidence = testFirstEvidence([
    commit("aaa1111", "test: pin the parser's error message", ["src/parse.test.ts"]),
    commit("bbb2222", "feat: parse it", ["src/parse.ts"]),
    commit("ccc3333", "refactor: extract the scanner", ["src/parse.ts", "src/scan.ts"]),
  ]);

  assert.deepEqual(evidence.unpreceded, []);
});

test("a change that never touches a test at all is reported as exactly that", () => {
  const evidence = testFirstEvidence([
    commit("aaa1111", "feat: add a flag", ["src/config/types.ts"]),
    commit("bbb2222", "docs: mention the flag", ["README.md"]),
  ]);

  assert.equal(evidence.touchesSource, true);
  assert.equal(evidence.touchesTest, false);
  assert.equal(evidence.unpreceded.length, 1);
});

test("a documentation-only change is not source and is not flagged", () => {
  // The carve-out that keeps the block credible. There is no failing test to write for a
  // typo in the README, and reporting one as a violation is how a lens learns to skip
  // this section.
  const evidence = testFirstEvidence([
    commit("aaa1111", "docs: fix a typo", ["README.md", "docs/runbook.adoc"]),
  ]);

  assert.equal(evidence.touchesSource, false);
  assert.deepEqual(evidence.unpreceded, []);
});

test("evidence renders the order, not a verdict", () => {
  // The supervisor states facts; the lens decides. If this block ever says "BLOCK" the
  // council has been replaced by a regex.
  const rendered = renderEvidence(
    testFirstEvidence([
      commit("aaa1111", "feat: add the thing", ["src/thing.ts"]),
      commit("bbb2222", "test: cover the thing", ["src/thing.test.ts"]),
    ]),
  );

  assert.match(rendered, /aaa1111/);
  assert.match(rendered, /add the thing/);
  assert.match(rendered, /source/);
  assert.doesNotMatch(rendered, /block/i);
});

test("no commits renders as a statement that there are none", () => {
  // Reachable: `branchPoint` can come back undefined, and a reviewer shown an empty
  // section would read it as "no source commits", which is a different claim.
  const rendered = renderEvidence(testFirstEvidence([]));

  assert.match(rendered, /could not be determined|no commits/i);
});
