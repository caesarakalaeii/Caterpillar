import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUNNER = fileURLToPath(new URL("./run-tests.ts", import.meta.url));

/**
 * How long the wrapper gets before this test calls it hung.
 *
 * Comfortably above HANG_TIMEOUT_MS below, so a leaked-handle run has time to reach its
 * own timeout and be reported. Anything less measures the timeout, not a hang.
 */
const WRAPPER_BUDGET_MS = 60_000;

/**
 * The per-test timeout the leak case runs under, injected so the test does not have to
 * sit through the wrapper's real three-minute one. Long enough that a loaded machine
 * does not trip it for an unrelated reason.
 */
const HANG_TIMEOUT_MS = 5_000;

interface Run {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * Runs the wrapper over one test file and waits for it to exit.
 *
 * The wrapper is spawned with its stdout piped, which is the case that matters: a pipe
 * only reaches EOF when every writer closes it, so a child that leaks a handle keeps it
 * open after the runner has finished reporting. That is how the wrapper first hung.
 */
const runWrapper = async (file: string, timeoutMs?: number): Promise<Run> => {
  const child = spawn(process.execPath, [RUNNER, file], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined
      ? {}
      : { env: { ...process.env, CATERPILLAR_TEST_TIMEOUT_MS: String(timeoutMs) } }),
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));

  return await new Promise<Run>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, output, timedOut: true });
    }, WRAPPER_BUDGET_MS);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut: false });
    });
  });
};

test("a test that leaks a handle fails the run instead of hanging the wrapper", async () => {
  // The regression this guards: waiting for the child's stdio to close, rather than for
  // the child to exit, means a leaked handle in ANY test file wedges `npm test` forever
  // — the twenty-minute silent CI hang that --test-force-exit was originally added for.
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-run-tests-"));
  const file = join(dir, "leaks.test.ts");
  await writeFile(
    file,
    'import { test } from "node:test";\n' +
      'test("leaves an interval running after it returns", () => {\n' +
      "  setInterval(() => {}, 1000);\n" +
      "});\n",
  );

  try {
    const run = await runWrapper(file, HANG_TIMEOUT_MS);

    assert.equal(run.timedOut, false, "the wrapper must exit rather than hang");
    assert.notEqual(run.code, 0, "a hung test must not be reported as a pass");
    assert.match(run.output, /cancelled/, run.output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a clean single file passes through the wrapper with exit 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-run-tests-"));
  const file = join(dir, "clean.test.ts");
  await writeFile(
    file,
    'import { test } from "node:test";\ntest("passes", () => {});\n',
  );

  try {
    const run = await runWrapper(file);

    assert.equal(run.timedOut, false);
    assert.equal(run.code, 0, run.output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing single file makes the wrapper exit non-zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-run-tests-"));
  const file = join(dir, "fails.test.ts");
  await writeFile(
    file,
    'import assert from "node:assert/strict";\n' +
      'import { test } from "node:test";\n' +
      'test("fails on purpose", () => assert.equal(1, 2));\n',
  );

  try {
    const run = await runWrapper(file);

    assert.equal(run.timedOut, false);
    assert.notEqual(run.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
