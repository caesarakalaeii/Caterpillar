import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECTED_TEST_COUNT, judgeRun } from "./run-report.ts";

/**
 * The summary a green `node --test` run of this suite prints, verbatim. The TAP plan
 * (1420) is smaller than the test count (1431) even here: nested subtests count toward
 * `tests` but only top-level ones enter the root plan. Nothing is wrong with this run.
 */
const COMPLETE = `
ok 1418 - commitsSince is empty when the branch has added nothing
1..1420
# tests 1431
# suites 3
# pass 1431
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

/**
 * A real truncated run, copied from a local reproduction: --test-force-exit tore the
 * process down while src/cluster/preflight.test.ts was still reporting, dropping its
 * last six results from the middle of the stream. Nothing failed and the exit code was 0.
 */
const TRUNCATED = `
ok 1406 - the sweep prunes the mirrors of what it removed
1..1414
# tests 1425
# suites 3
# pass 1425
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

test("a complete run is accepted", () => {
  const verdict = judgeRun(COMPLETE, { expected: 1431 });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, undefined);
});

test("a run that lost results is rejected even though nothing failed", () => {
  // The defect this exists for: `fail 0`, exit 0, and six tests that never ran.
  // Counting failures cannot see it; comparing what ran against what exists can.
  const verdict = judgeRun(TRUNCATED, { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /1425/);
  assert.match(verdict.reason ?? "", /1431/);
});

test("a run missing a whole file's worth of tests is rejected", () => {
  // A file that fails to LOAD registers nothing at all, so the count simply comes in
  // low with no other trace. Same check, much larger shortfall.
  const shrunk = `
1..1200
# tests 1200
# pass 1200
# fail 0
# cancelled 0
`;

  const verdict = judgeRun(shrunk, { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /1200/);
});

test("a failing test is still rejected", () => {
  const failed = `
1..1431
# tests 1431
# pass 1430
# fail 1
# cancelled 0
`;

  const verdict = judgeRun(failed, { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /fail/);
});

test("a cancelled test is rejected, because a timed-out hang cancels rather than fails", () => {
  // --test-timeout reports a hung test as `cancelled 1` with `fail 0`. Treating only
  // `fail` as the verdict would let the hang this backstop exists for pass.
  const cancelled = `
1..1431
# tests 1431
# pass 1430
# fail 0
# cancelled 1
`;

  const verdict = judgeRun(cancelled, { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /cancelled/);
});

test("more tests than expected is accepted, so adding a test does not fail the run", () => {
  const grown = `
1..1440
# tests 1440
# pass 1440
# fail 0
# cancelled 0
`;

  const verdict = judgeRun(grown, { expected: 1431 });

  assert.equal(verdict.ok, true);
});

test("output with no summary at all is rejected rather than read as zero failures", () => {
  const verdict = judgeRun("Killed\n", { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /summary/);
});

test("the spec reporter's summary is read too, not just TAP's", () => {
  // node 24+ defaults to the spec reporter when stdout is not a TTY, and it marks the
  // summary with `ℹ` instead of `#`. Reading only the TAP form made every run on those
  // versions look like it had printed no summary at all — which is how the whole suite
  // was rejected on the CI leg that runs a newer node, while node 22 stayed green.
  const spec = `
ℹ tests 1444
ℹ suites 3
ℹ pass 1444
ℹ fail 0
ℹ cancelled 0
`;

  const verdict = judgeRun(spec, { expected: 1444 });

  assert.equal(verdict.ok, true, verdict.reason);
});

test("a failure reported by the spec reporter is still rejected", () => {
  const spec = `
ℹ tests 1444
ℹ pass 1443
ℹ fail 1
ℹ cancelled 0
`;

  assert.equal(judgeRun(spec, { expected: 1444 }).ok, false);
});

test("a single-file run is judged without a count floor", () => {
  // `node src/cli/run-tests.ts src/one.test.ts` is not the whole suite, so the total is
  // meaningless for it. Failures and cancellations must still be caught.
  const oneFile = `
1..7
# tests 7
# pass 7
# fail 0
# cancelled 0
`;

  assert.equal(judgeRun(oneFile, {}).ok, true);
});

test("a single-file run with a failure is still rejected", () => {
  const oneFile = `
1..7
# tests 7
# pass 6
# fail 1
# cancelled 0
`;

  assert.equal(judgeRun(oneFile, {}).ok, false);
});

test("the expected count is not below what the suite has, so the floor can bite", () => {
  // If this drops to 0 or goes stale downwards the check silently stops working. It is
  // a constant precisely so a reviewer sees it move when tests are added.
  assert.ok(EXPECTED_TEST_COUNT >= 1446);
});
