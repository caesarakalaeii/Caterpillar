/**
 * The hang detector (DESIGN.md §6.4).
 *
 * Every test here runs a REAL command that really does not return. That is deliberate: the
 * bug this covers was invisible to every unit test in the suite because pi's default is to
 * wait forever, and waiting forever looks exactly like working.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogFields } from "../obs/log.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
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
): Promise<BoundedExecutionEnv> => {
  const cwd = await mkdtemp(join(tmpdir(), "caterpillar-exec-"));
  roots.push(cwd);
  return new BoundedExecutionEnv({ cwd, timeoutSeconds, logger, task: "TASK-1" });
};

test("a command that never returns is cut off instead of hanging forever", async () => {
  // THE REGRESSION. `sleep 60` stands in for the `npm test` whose subprocess never
  // exited and held a task's lease for 2h42m. The model asked for no timeout, which is
  // the common case and the one pi documents as "no timeout".
  const subject = await env(1);

  const started = Date.now();
  const result = await subject.exec("sleep 60");
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false, "a command past the ceiling must not succeed");
  assert.ok(elapsed < 15_000, `expected the ceiling to fire, took ${elapsed}ms`);
});

test("a timeout LONGER than the ceiling is clamped, not honoured", async () => {
  // Without this the protection is advisory: a model that passes `timeout: 86400` for a
  // slow build reintroduces the hang, and it looks like the ceiling is working.
  const subject = await env(1);

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
  const subject = await env(600);

  const started = Date.now();
  const result = await subject.exec("sleep 30", { timeout: 1 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.ok(elapsed < 15_000, `the model's own 1s must still apply, took ${elapsed}ms`);
});

test("a command that finishes well inside the ceiling is untouched", async () => {
  const subject = await env(60);
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
  const subject = await env(1, logger);

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
  const subject = await env(1, logger);

  await subject.exec(`sleep 60 # ${"x".repeat(500)}`);

  const timeout = lines.find((line) => line.event === "exec.timeout");
  const command = String(timeout?.fields?.["command"] ?? "");
  assert.ok(command.length <= 201, `command was ${command.length} chars, expected truncation`);
  assert.match(command, /…$/);
});
