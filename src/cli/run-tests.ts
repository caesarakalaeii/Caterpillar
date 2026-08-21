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

  const child = spawn(
    process.execPath,
    ["--test", `--test-timeout=${testTimeoutMs()}`, ...patterns],
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

  // `close` rather than `exit`, so the last of the child's output is in hand before the
  // summary is judged. The runner closes its children's stdio itself, so a test that
  // leaks a handle still reaches --test-timeout and is reported; only a test that leaves
  // a grandchild holding stdout open outlasts this, and it outlasts `exit` too.
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      // A signal death has no exit code. Report it as a failure rather than as 0.
      if (status === null) {
        process.stderr.write(`\nnode --test was killed by ${signal ?? "an unknown signal"}\n`);
        resolve(1);
        return;
      }
      resolve(status);
    });
  });

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
