/**
 * Judges a `node --test` run from its own summary. See DESIGN.md §11.1.
 *
 * `npm test` is an acceptance command (§12), so its exit code decides whether a task is
 * done. It was not trustworthy: `--test-force-exit` tore the process down as soon as the
 * root test settled, discarding results still in flight from other files. The numbering
 * closed over the gap, `fail` stayed 0, and the run exited 0. The suite reported 1425,
 * 1428, 1440 or its true 1441 tests run to run, losing the tail of
 * src/cluster/preflight.test.ts from the MIDDLE of the stream — tests that never
 * reported were indistinguishable from tests that passed.
 *
 * That flag is no longer passed. It was added as a backstop after a hung test held CI
 * open for twenty minutes, so removing it needed the hang to still be caught, and it is:
 * --test-timeout alone reports a leaked-handle test as `not ok` / `cancelled` and exits
 * 1. Verified on node 22 against three deliberately hanging files, including the original
 * incident's shape (a test that returns leaving an interval running). Force-exit was in
 * fact the weaker of the two — with stdout piped it reported that same file as a PASS
 * with exit 0, while without it the run correctly exits 1.
 *
 * Removing it also made the suite deterministic: the same count on six consecutive runs,
 * where before the count varied.
 *
 * Whether the runner ends at all after reporting a timeout is version-dependent: node 22
 * reaps the file's process, node 24 does not and waits forever. run-tests.ts therefore
 * keeps a deadline of its own rather than trusting either.
 *
 * The count is still checked here, because losing a result must never read as a pass
 * again: the summary's own `tests` count is held to EXPECTED_TEST_COUNT, which also
 * catches a file that fails to load and registers nothing.
 *
 * The TAP plan (`1..N`) is deliberately NOT compared against that count. They differ by
 * design — nested subtests count toward `tests` but only top-level ones appear in the
 * root plan, so a fully green run prints `1..1438` against `# tests 1449`. Using the
 * disagreement as a truncation signal would reject every green run.
 */

/** The parsed tail of a `node --test` run. Fields absent from the output stay absent. */
interface RunSummary {
  readonly tests?: number;
  readonly fail?: number;
  readonly cancelled?: number;
}

export interface RunVerdict {
  readonly ok: boolean;
  /** Why the run was rejected. Absent when `ok`. */
  readonly reason?: string;
}

export interface JudgeOptions {
  /**
   * The number of tests the suite is known to have. A run reporting fewer is rejected;
   * more is fine, because adding a test must not fail the run.
   *
   * Omitted when the run was given an explicit file list: a subset of the suite cannot
   * be compared against the whole suite's total, so only failures and cancellations are
   * checked for it.
   */
  readonly expected?: number;
}

/**
 * How many tests the whole suite has. The floor the whole-suite run is held to.
 *
 * Deliberately a hand-maintained constant rather than a high-water mark written to
 * disk: a self-updating floor silently ratchets down the first time a run truncates,
 * which is the exact failure it exists to catch. Raise it when you add tests — `npm
 * test` prints the number it saw, and a run below this refuses rather than passing.
 */
export const EXPECTED_TEST_COUNT = 1941;

/**
 * `# tests 1449` and friends. The count is the last such line, because a run over
 * several files prints one summary per file before the root summary.
 *
 * Both reporter prefixes are accepted: TAP marks summary lines with `#`, and the spec
 * reporter — node 24+'s default when stdout is not a TTY — uses `ℹ`. run-tests.ts pins
 * the reporter so only one of them should ever appear, but a parser that silently
 * matches nothing is how this went wrong the first time, so it reads either.
 */
const readCount = (output: string, field: string): number | undefined => {
  const matches = [...output.matchAll(new RegExp(`^[#\u2139] ${field} (\\d+)$`, "gm"))];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
};

const parse = (output: string): RunSummary => ({
  ...((tests) => (tests === undefined ? {} : { tests }))(readCount(output, "tests")),
  ...((fail) => (fail === undefined ? {} : { fail }))(readCount(output, "fail")),
  ...((cancelled) =>
    cancelled === undefined ? {} : { cancelled })(readCount(output, "cancelled")),
});

/**
 * Decides whether a run's output describes a complete, passing suite.
 *
 * Reasons are worded for whoever reads the CI log, since a rejection here looks like a
 * green suite everywhere else.
 */
export const judgeRun = (output: string, options: JudgeOptions): RunVerdict => {
  const summary = parse(output);

  // No summary means the process died before printing one — killed, OOM, a crash in the
  // harness. Reading that as "no failures" is how a dead run passes.
  if (summary.tests === undefined || summary.fail === undefined) {
    return {
      ok: false,
      reason: "no test summary in the output: the run did not finish printing its results",
    };
  }

  if (summary.fail > 0) {
    return { ok: false, reason: `${summary.fail} test(s) fail` };
  }

  // A test stopped by --test-timeout is reported as cancelled, not failed. That is the
  // hang the force-exit backstop exists for, so it must not read as a pass.
  if ((summary.cancelled ?? 0) > 0) {
    return { ok: false, reason: `${summary.cancelled} test(s) cancelled (timed out)` };
  }

  if (options.expected !== undefined && summary.tests < options.expected) {
    return {
      ok: false,
      reason:
        `only ${summary.tests} of ${options.expected} known tests ran: ` +
        `a test that did not run is not a test that passed`,
    };
  }

  return { ok: true };
};
