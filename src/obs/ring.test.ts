import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLogger } from "./log.ts";
import { LogRing } from "./ring.ts";

test("the ring keeps the newest records and forgets the oldest", async () => {
  const ring = new LogRing(3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(`{"ts":"t","level":"info","event":"e${n}"}\n`);

  assert.deepEqual(
    ring.records().map((record) => record.event),
    ["e5", "e4", "e3"],
  );
});

test("records come back newest first, because that is what an operator reads", async () => {
  const ring = new LogRing(10);
  ring.push(`{"ts":"1","level":"info","event":"first"}\n`);
  ring.push(`{"ts":"2","level":"info","event":"second"}\n`);

  assert.deepEqual(
    ring.records().map((record) => record.event),
    ["second", "first"],
  );
});

test("it is a sink for JsonLogger, so what it holds is exactly what stdout got", async () => {
  // The ring deliberately does NOT filter by level. It is wired as the logger's `write`,
  // which runs only for records that survived the configured threshold — so the ring and
  // the container's stdout can never disagree about what was emitted.
  const ring = new LogRing(10);
  const logger = new JsonLogger({ level: "info", write: (line) => ring.push(line) });

  logger.debug("poll.idle");
  logger.info("task.claimed", { task: "T-1" });
  logger.error("session.failed", { task: "T-1", error: "boom" });

  const records = ring.records();
  assert.deepEqual(
    records.map((record) => record.event),
    ["session.failed", "task.claimed"],
    "the dropped debug record must not reach the ring either",
  );
  assert.equal(records[0]?.level, "error");
  assert.deepEqual(records[1]?.fields, { task: "T-1" });
});

test("reserved keys are lifted out and everything else stays in fields", async () => {
  const ring = new LogRing(4);
  ring.push(`{"task":"T-1","session":3,"ok":true,"ts":"t","level":"warn","event":"task.parked"}\n`);

  const record = ring.records()[0];
  assert.equal(record?.event, "task.parked");
  assert.equal(record?.level, "warn");
  assert.equal(record?.ts, "t");
  assert.deepEqual(record?.fields, { task: "T-1", session: 3, ok: true });
});

test("a line that is not a log record is surfaced rather than swallowed", async () => {
  // Something writing to stdout past the logger would otherwise vanish from the view
  // that exists to explain what the process is doing.
  const ring = new LogRing(4);
  ring.push("Debugger attached.\n");

  const record = ring.records()[0];
  assert.equal(record?.event, "log.unparsed");
  assert.equal(record?.level, "info");
  assert.equal(record?.fields["line"], "Debugger attached.");
});

test("a capacity of zero disables the ring instead of throwing", async () => {
  const ring = new LogRing(0);
  ring.push(`{"ts":"t","level":"info","event":"e"}\n`);
  assert.deepEqual(ring.records(), []);
});
