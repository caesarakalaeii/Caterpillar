/**
 * The hang detector and the output ceiling (DESIGN.md §6.4).
 *
 * Every timeout test here runs a REAL command that really does not return. That is
 * deliberate: the bug they cover was invisible to every unit test in the suite because
 * pi's default is to wait forever, and waiting forever looks exactly like working.
 *
 * The output tests run real commands too, for the same reason: what the model sees comes
 * from the STREAMING callbacks, not from the returned `stdout`, and a test that only
 * inspected the return value would pass while the window still filled up.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogFields } from "../obs/log.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { outputCeiling } from "./budget.ts";
import { BoundedExecutionEnv } from "./exec.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Recorded {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recorder = (): { logger: typeof SILENT_LOGGER; lines: Recorded[] } => {
  const lines: Recorded[] = [];
  // The level is not asserted on anywhere here — what matters is that the EVENT was
  // emitted with its fields — so all four levels share one sink.
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    lines,
  };
};

const env = async (
  timeoutSeconds: number,
  logger = SILENT_LOGGER,
  output = outputCeiling({}),
): Promise<{ subject: BoundedExecutionEnv; overflowDir: string }> => {
  const cwd = await mkdtemp(join(tmpdir(), "caterpillar-exec-"));
  roots.push(cwd);
  const overflowDir = join(cwd, ".caterpillar", "output");
  return {
    subject: new BoundedExecutionEnv({
      cwd,
      timeoutSeconds,
      logger,
      task: "TASK-1",
      output,
      overflowDir,
    }),
    overflowDir,
  };
};

/**
 * What the MODEL sees, which is not what `exec` returns.
 *
 * pi's bash tool reads the streaming callbacks and ignores `result.value.stdout`, so this
 * is the only channel the ceiling has to hold — see `exec.ts` for why the bound is applied
 * there rather than to the return value alone.
 */
const streamed = async (
  subject: BoundedExecutionEnv,
  command: string,
): Promise<string> => {
  let seen = "";
  await subject.exec(command, {
    onStdout: (chunk) => {
      seen += chunk;
    },
    onStderr: (chunk) => {
      seen += chunk;
    },
  });
  return seen;
};

test("a command that never returns is cut off instead of hanging forever", async () => {
  // THE REGRESSION. `sleep 60` stands in for the `npm test` whose subprocess never
  // exited and held a task's lease for 2h42m. The model asked for no timeout, which is
  // the common case and the one pi documents as "no timeout".
  const { subject } = await env(1);

  const started = Date.now();
  const result = await subject.exec("sleep 60");
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false, "a command past the ceiling must not succeed");
  assert.ok(elapsed < 15_000, `expected the ceiling to fire, took ${elapsed}ms`);
});

test("a timeout LONGER than the ceiling is clamped, not honoured", async () => {
  // Without this the protection is advisory: a model that passes `timeout: 86400` for a
  // slow build reintroduces the hang, and it looks like the ceiling is working.
  const { subject } = await env(1);

  const started = Date.now();
  const result = await subject.exec("sleep 60", { timeout: 86_400 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.ok(elapsed < 15_000, `the model's 86400s must be clamped, took ${elapsed}ms`);
});

test("a timeout SHORTER than the ceiling is left alone", async () => {
  // The clamp is a maximum, not an override. A model that knows its command should take
  // two seconds is more informed than the runner's blanket ceiling, and taking that away
  // would make every quick command wait out the full 15 minutes before failing.
  const { subject } = await env(600);

  const started = Date.now();
  const result = await subject.exec("sleep 30", { timeout: 1 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.ok(elapsed < 15_000, `the model's own 1s must still apply, took ${elapsed}ms`);
});

test("a command that finishes well inside the ceiling is untouched", async () => {
  const { subject } = await env(60);
  const result = await subject.exec("echo hello");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value.stdout, /hello/);
    assert.equal(result.value.exitCode, 0);
  }
});

test("a command cut off for time is logged, so a hang is not mistaken for a failing test", async () => {
  // The operator-facing half. Without this line a bounded command and a genuinely broken
  // test suite are the same event, which is the state this was built to get out of.
  const { logger, lines } = recorder();
  const { subject } = await env(1, logger);

  await subject.exec("sleep 60");

  const timeout = lines.find((line) => line.event === "exec.timeout");
  assert.ok(timeout !== undefined, "a cut-off command must emit exec.timeout");
  assert.equal(timeout.fields?.["task"], "TASK-1");
  assert.equal(timeout.fields?.["limitSeconds"], 1);
});

test("the log never carries an unbounded command string", async () => {
  // A command is model-authored and can quote a private repository. It is the most useful
  // field when a runner keeps timing out, so it is truncated rather than dropped.
  const { logger, lines } = recorder();
  const { subject } = await env(1, logger);

  await subject.exec(`sleep 60 # ${"x".repeat(500)}`);

  const timeout = lines.find((line) => line.event === "exec.timeout");
  const command = String(timeout?.fields?.["command"] ?? "");
  assert.ok(command.length <= 201, `command was ${command.length} chars, expected truncation`);
  assert.match(command, /…$/);
});

test("a command that returns 40,000 lines shows the model a bounded view", async () => {
  // THE OTHER HALF OF INVARIANT 12. `seq 1 40000` stands in for one wide `grep` or one
  // verbose test log: it succeeds instantly and spends a large share of the window the
  // handoff threshold (§6.1) exists to protect.
  const { subject } = await env(60, SILENT_LOGGER, outputCeiling({ maxLines: 100 }));

  const seen = await streamed(subject, "seq 1 40000");

  assert.ok(seen.split("\n").length <= 110, `the model saw ${seen.split("\n").length} lines`);
  assert.match(seen, /of 40,000 lines shown/, "the elision must state its own size");
});

test("the tail of a bounded command survives, because a failing run ends with why", async () => {
  // A test runner prints its failure summary last. Head-only truncation is how a bounded
  // failure becomes indistinguishable from a pass.
  const { subject } = await env(60, SILENT_LOGGER, outputCeiling({ maxLines: 20 }));

  const seen = await streamed(subject, "seq 1 5000; echo 'FAILED 3 of 900 tests'");

  assert.match(seen, /FAILED 3 of 900 tests/, "the last line must reach the model");
  assert.match(seen, /^1$/m, "the first line must reach it too");
  // And the middle must NOT, or the bound did not happen at all and the two assertions
  // above are satisfied by the unbounded output they exist to prevent.
  assert.equal(/^2500$/m.test(seen), false, "the middle must be elided");
});

test("stderr is bounded as well, so a stack trace cannot bypass the ceiling", async () => {
  const { subject } = await env(60, SILENT_LOGGER, outputCeiling({ maxLines: 50 }));

  const seen = await streamed(subject, "seq 1 9000 >&2");

  assert.ok(seen.split("\n").length <= 60, `the model saw ${seen.split("\n").length} lines`);
  assert.match(seen, /of 9,000 lines shown/);
});

test("the overflow is written where the agent can read it in slices", async () => {
  // The information is kept out of the window, not destroyed. A session that needs the
  // middle of a long run has to be able to go and get it.
  const { subject, overflowDir } = await env(
    60,
    SILENT_LOGGER,
    outputCeiling({ maxLines: 30 }),
  );

  const seen = await streamed(subject, "seq 1 4000");

  const files = await readdir(overflowDir);
  assert.equal(files.length, 1, `expected one overflow file, got ${files.join(", ")}`);
  const name = files[0] ?? "";
  assert.match(seen, new RegExp(name.replace(/\./g, "\\.")), "the note must name the file");

  const whole = await readFile(join(overflowDir, name), "utf8");
  assert.match(whole, /^1$/m);
  assert.match(whole, /^4000$/m, "the file must hold what the window did not");
});

test("a command inside the ceiling writes no overflow file and no note", async () => {
  // The common case. A spill per `git status` would fill the work volume with logs
  // nothing will ever read.
  const { subject, overflowDir } = await env(60, SILENT_LOGGER, outputCeiling({ maxLines: 100 }));

  const seen = await streamed(subject, "echo hello");

  assert.equal(seen, "hello\n");
  await assert.rejects(() => readdir(overflowDir), /ENOENT/);
});

test("the returned stdout is bounded too, for the callers that read it", async () => {
  // `exec` returns the whole output as well as streaming it, and the acceptance gate and
  // the plan maintainer read the return value. Bounding one channel and not the other
  // would leave the ceiling depending on which caller you are.
  const { subject } = await env(60, SILENT_LOGGER, outputCeiling({ maxLines: 40 }));

  const result = await subject.exec("seq 1 8000");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(
      result.value.stdout.split("\n").length <= 50,
      `stdout had ${result.value.stdout.split("\n").length} lines`,
    );
    assert.match(result.value.stdout, /of 8,000 lines shown/);
  }
});

test("a bounded command is logged, so an operator can see the window being spent", async () => {
  const { logger, lines } = recorder();
  const { subject } = await env(60, logger, outputCeiling({ maxLines: 25 }));

  await streamed(subject, "seq 1 3000");

  const bounded = lines.find((line) => line.event === "exec.output-bounded");
  assert.ok(bounded !== undefined, "a bounded command must emit exec.output-bounded");
  assert.equal(bounded.fields?.["task"], "TASK-1");
  assert.equal(bounded.fields?.["totalLines"], 3_000);
});
