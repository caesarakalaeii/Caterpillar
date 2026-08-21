import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeRun } from "./run-report.ts";

/**
 * The summary a green `node --test` run prints. `tests` and the TAP plan agree, so
 * every test that registered also reported.
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
 * A real truncated run, copied from a local reproduction. The plan says 1414 and the
 * summary says 1425: the harness counted eleven tests it never emitted a result for,
 * because --test-force-exit tore the process down while a file was still reporting.
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

test("a run whose plan matches its test count is accepted", () => {
  const verdict = judgeRun(COMPLETE, { expected: 1431 });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, undefined);
});

test("a run that reported fewer results than it counted is rejected", () => {
  const verdict = judgeRun(TRUNCATED, { expected: 1431 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /1414/);
  assert.match(verdict.reason ?? "", /1425/);
});

test("a run that lost whole files is rejected even though nothing failed", () => {
  // The defect this exists for: `fail 0` with tests missing. Counting failures alone
  // cannot see it, so the check must compare what ran against what was expected.
  const verdict = judgeRun(TRUNCATED, { expected: 1431 });

  assert.equal(verdict.ok, false);
});

test("a run with fewer tests than expected is rejected, not silently accepted", () => {
  // A file that fails to LOAD registers nothing at all, so both the plan and the count
  // shrink together and the internal consistency check above cannot catch it. The
  // expected floor is what does.
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
  assert.match(verdict.reason ?? "", /1431/);
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
