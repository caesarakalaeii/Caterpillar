/**
 * Runs the test suite and refuses to call a short run green.
 *
 *   node src/cli/run-tests.ts            # what `npm test` invokes
 *
 * `npm test` is an acceptance command (§12), so its exit code decides whether a task is
 * done. Two things were wrong with invoking `node --test` directly, and this file fixes
 * the second while ../testing/run-report.ts explains the first:
 *
 *   - `--test-force-exit` discarded the results of tests still reporting when the root
 *     test settled, so the run exited 0 with tests silently missing. It is no longer
 *     passed; see run-report.ts for why that is safe now and what replaced it.
 *   - even so, the count is checked, because a lost result must never read as a pass.
 *
 * This is argv, a child process and printing; the verdict logic lives in run-report.ts
 * so it is unit-testable without spawning anything.
 *
 * Extra arguments are passed through to `node --test`, so a single file still works:
 *   node src/cli/run-tests.ts src/supervisor/progress.test.ts
 * A run given an explicit file list is not the whole suite, so the expected-count floor
 * is skipped for it — only the whole-suite run can be checked against the total.
 */
import { spawn } from "node:child_process";
import { EXPECTED_TEST_COUNT, judgeRun } from "../testing/run-report.ts";

/**
 * The hang backstop. A test that stops making progress fails by name in three minutes
 * rather than holding CI open indefinitely, which is what this was raised for.
 */
const DEFAULT_TEST_TIMEOUT_MS = 180_000;

/**
 * The per-test timeout, overridable so this file's own tests can exercise the hang path
 * in seconds instead of sitting through three minutes of it. Not a knob for general use:
 * CI and developers both want the default.
 */
const testTimeoutMs = (): number => {
  const override = Number(process.env.CATERPILLAR_TEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TEST_TIMEOUT_MS;
};

/**
 * How long the whole run gets before this wrapper stops waiting for the runner.
 *
 * The runner's own --test-timeout is not enough, because on node 24 a file that leaks a
 * handle makes the runner report the timeout and then never exit; node 22's reaps it.
 * The suite takes about 150s, so twenty minutes is far above any healthy run and far
 * below the twenty-plus-minute stalls this exists to prevent.
 */
const DEFAULT_RUN_DEADLINE_MS = 20 * 60_000;

const runDeadlineMs = (): number => {
  const override = Number(process.env.CATERPILLAR_RUN_DEADLINE_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_RUN_DEADLINE_MS;
};

const DEFAULT_PATTERN = "src/**/*.test.ts";

const main = async (): Promise<number> => {
  const requested = process.argv.slice(2);
  const wholeSuite = requested.length === 0;
  const patterns = wholeSuite ? [DEFAULT_PATTERN] : requested;

  // NODE_TEST_CONTEXT is set by `node --test` in every process it spawns, and a runner
  // that sees it declines to run files at all: "run() is being called recursively within
  // a test file. skipping running files". Removing it lets this wrapper be exercised by
  // its own test suite, and costs nothing when it was not set.
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;

  // The reporter is pinned rather than left to the default, which varies: node 22 emits
  // TAP when stdout is a pipe, node 24+ emits `spec`. This wrapper always reads through a
  // pipe, so an unpinned reporter means the summary format depends on the node version —
  // and the CI matrix deliberately spans two of them.
  const child = spawn(
    process.execPath,
    ["--test", "--test-reporter=tap", `--test-timeout=${testTimeoutMs()}`, ...patterns],
    { stdio: ["inherit", "pipe", "inherit"], env },
  );

  // Streamed through rather than buffered silently: a developer watching a 145-second
  // run needs to see it progress, and the summary still has to be read at the end.
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    process.stdout.write(chunk);
  });

  // `exit` rather than `close`: `close` additionally waits for the child's stdio to reach
  // EOF, and a killed runner can leave a grandchild holding the pipe open, which would
  // defeat the deadline below. Everything the runner printed before exiting is already in
  // `output`, because a pipe delivers what was written to it.
  let timedOut = false;
  const code = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: the runner being unable to end is the case being handled,
      // so asking it politely is not a step worth waiting through.
      child.kill("SIGKILL");
    }, runDeadlineMs());

    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });

    child.on("exit", (status, signal) => {
      clearTimeout(deadline);
      // A signal death has no exit code. Report it as a failure rather than as 0 — except
      // when this wrapper sent the signal, where the deadline message below says more.
      if (status === null) {
        if (!timedOut) {
          process.stderr.write(
            `\nnode --test was killed by ${signal ?? "an unknown signal"}\n`,
          );
        }
        resolve(1);
        return;
      }
      resolve(status);
    });
  });

  if (timedOut) {
    process.stderr.write(
      `\nnpm test gave up after ${runDeadlineMs()}ms: the test runner did not exit. ` +
        "A test is holding the process open; the last test to start is the one to look at.\n",
    );
    return 1;
  }

  const verdict = judgeRun(output, wholeSuite ? { expected: EXPECTED_TEST_COUNT } : {});

  if (!verdict.ok) {
    process.stderr.write(`\nnpm test rejected this run: ${verdict.reason}\n`);
    if (code === 0) {
      process.stderr.write(
        "node --test exited 0 regardless, which is why this check exists. See " +
          "src/testing/run-report.ts.\n",
      );
    }
    return 1;
  }

  return code;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
