import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLogger, SILENT_LOGGER, type LogLevel } from "./log.ts";

const capture = (
  level?: LogLevel,
): { readonly lines: string[]; readonly logger: JsonLogger } => {
  const lines: string[] = [];
  return {
    lines,
    logger: new JsonLogger({
      write: (line) => lines.push(line),
      ...(level !== undefined ? { level } : {}),
    }),
  };
};

test("each record is one self-contained JSON line", async () => {
  // Loki ingests container stdout line by line: a record split across lines arrives as
  // unrelated fragments, and a record without a trailing newline merges into the next.
  const { lines, logger } = capture();
  logger.info("session.start", { task: "T-1", session: 2 });

  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.ok(line.endsWith("\n"), "every record must terminate with a newline");
  assert.equal(line.trimEnd().includes("\n"), false, "a record must not span lines");

  const record: unknown = JSON.parse(line);
  assert.deepEqual(record, {
    ts: (record as { ts: string }).ts,
    level: "info",
    event: "session.start",
    task: "T-1",
    session: 2,
  });
  assert.ok(
    !Number.isNaN(Date.parse((record as { ts: string }).ts)),
    "ts must be a parseable timestamp",
  );
});

test("records below the configured level are dropped", async () => {
  const { lines, logger } = capture("info");
  logger.debug("poll.idle");
  assert.deepEqual(lines, [], "debug must not survive at level info");

  logger.warn("lease.lost");
  logger.error("task.failed");
  assert.equal(lines.length, 2);
});

test("debug level lets everything through", async () => {
  const { lines, logger } = capture("debug");
  logger.debug("poll.idle");
  assert.equal(lines.length, 1);
});

test("undefined fields are omitted rather than serialised as null", async () => {
  // Call sites pass optional context straight through (`error: outcome.error`), and a
  // wall of `"error": null` makes a Loki query for the field useless.
  const { lines, logger } = capture();
  logger.info("session.end", { task: "T-1", error: undefined });

  const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal("error" in record, false);
  assert.equal(record.task, "T-1");
});

test("reserved keys cannot be overwritten by caller fields", async () => {
  // Otherwise a field named `level` silently rewrites the severity a query filters on.
  const { lines, logger } = capture();
  logger.error("task.failed", { level: "debug", event: "something-else", ts: "1999" });

  const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(record.level, "error");
  assert.equal(record.event, "task.failed");
  assert.notEqual(record.ts, "1999");
});

test("the silent logger emits nothing at any level", async () => {
  // Used by tests and by any caller that must not write to the process's own streams.
  assert.doesNotThrow(() => {
    SILENT_LOGGER.debug("a");
    SILENT_LOGGER.info("b");
    SILENT_LOGGER.warn("c");
    SILENT_LOGGER.error("d", { task: "T-1" });
  });
});
