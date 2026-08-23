/**
 * The exposition format, and what the work-volume gauges do with it.
 *
 * The registry was untested for as long as every label value in it was a task id or a
 * literal from `registry.ts`. `caterpillar_work_entry_bytes` changed that: its `name`
 * comes from a directory on the disk, which is to say from outside this process, and both
 * of the properties tested here — escaping, and clearing a world-derived label set — only
 * matter because of that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceUsage } from "../workspace/usage.ts";
import { AgentMetrics, Registry } from "./registry.ts";

const USAGE: WorkspaceUsage = {
  measuredAt: "2026-08-18T09:00:00.000Z",
  durationMs: 12,
  partial: false,
  fs: { totalBytes: 1000, freeBytes: 400 },
  mirrorBytes: 100,
  taskBytes: 300,
  nixBytes: 50,
  otherBytes: 25,
  mirrors: [{ name: "acme/widget", bytes: 100 }],
  tasks: [{ name: "TASK-1", bytes: 300 }],
};

test("a label value from the filesystem cannot forge a line of exposition", async () => {
  // `name` is a directory under `tasks/`, so it is whatever is on the disk rather than a
  // validated task id. A newline in it would end the sample line early and let the
  // exporter hand the scraper a metric of the directory's choosing.
  const registry = new Registry();
  const gauge = registry.gauge("caterpillar_test_bytes", "help");
  gauge.set({ name: 'evil"\nnode_cpu_seconds_total 999' }, 1);

  const rendered = registry.render();
  const samples = rendered
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));

  assert.equal(samples.length, 1, "one sample must render as exactly one line");
  assert.match(rendered, /caterpillar_test_bytes\{name="evil\\"\\nnode_cpu_seconds_total 999"\} 1/);
  assert.doesNotMatch(rendered, /^node_cpu_seconds_total/m, "the forged line must not exist");
});

test("a backslash is escaped before the quote, or the escapes escape each other", async () => {
  const registry = new Registry();
  registry.gauge("caterpillar_test_bytes", "help").set({ name: 'a\\"b' }, 1);

  assert.match(registry.render(), /name="a\\\\\\"b"/);
});

test("one measurement becomes every series a dashboard reads", async () => {
  const metrics = new AgentMetrics();
  metrics.recordUsage("pod-7f3a", USAGE);
  const rendered = metrics.render();

  assert.match(rendered, /caterpillar_work_fs_bytes\{runner="pod-7f3a",kind="total"\} 1000/);
  assert.match(rendered, /caterpillar_work_fs_bytes\{runner="pod-7f3a",kind="free"\} 400/);
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-7f3a",category="mirrors"\} 100/);
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-7f3a",category="tasks"\} 300/);
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-7f3a",category="nix"\} 50/);
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-7f3a",category="other"\} 25/);
  assert.match(rendered, /caterpillar_work_entry_bytes\{.*name="TASK-1"\} 300/);
  assert.match(rendered, /caterpillar_work_partial\{runner="pod-7f3a"\} 0/);
  // Seconds, not milliseconds: `Date.parse` gives ms and Prometheus timestamps are
  // seconds, so a factor of 1000 here is a reading 56 years in the future.
  assert.match(
    rendered,
    new RegExp(
      `caterpillar_work_measured_timestamp_seconds\\{runner="pod-7f3a"\\} ${
        Date.parse(USAGE.measuredAt) / 1000
      }`,
    ),
  );
});

test("a task that drops out of the top N stops reporting instead of freezing", async () => {
  // Nothing in this registry expires. Without the clear, a task that was large once would
  // keep reporting the size it had when it last made the cut, forever — and a graph of
  // "what is eating the volume" would name a worktree that no longer exists.
  const metrics = new AgentMetrics();
  metrics.recordUsage("pod-7f3a", USAGE);
  assert.match(metrics.render(), /name="TASK-1"/);

  metrics.recordUsage("pod-7f3a", {
    ...USAGE,
    tasks: [{ name: "TASK-2", bytes: 7 }],
    mirrors: [],
  });

  const rendered = metrics.render();
  assert.doesNotMatch(rendered, /name="TASK-1"/);
  assert.doesNotMatch(rendered, /name="acme\/widget"/);
  assert.match(rendered, /name="TASK-2".*\} 7/);
});

test("removing one label set leaves the others reporting", async () => {
  // `caterpillar_no_progress_streak{task=...}` has the same world-derived label set as the
  // work gauges, and the same absence of expiry: tasks end, and a task that parked or
  // finished never gets another `set`, so its last streak is immortal. That is an alerting
  // rule reading a sample nothing holds.
  //
  // `clear()` is the wrong tool for it — it would drop every OTHER task's live streak
  // along with the dead one, which at N slots is most of them.
  const registry = new Registry();
  const streak = registry.gauge("caterpillar_no_progress_streak", "consecutive stalls");
  streak.set({ task: "DONE-1" }, 2);
  streak.set({ task: "LIVE-1" }, 1);

  streak.remove({ task: "DONE-1" });

  const rendered = registry.render();
  assert.doesNotMatch(rendered, /task="DONE-1"/);
  assert.match(rendered, /caterpillar_no_progress_streak\{task="LIVE-1"\} 1/);
});

test("removing a label set that was never reported is not an error", async () => {
  // The caller is a status transition, which fires for tasks that never had a streak
  // published — a task done on its first session, or one parked before any session ran.
  // Making that a special case at every call site would be the wrong place for it.
  const registry = new Registry();
  const streak = registry.gauge("caterpillar_no_progress_streak", "consecutive stalls");

  streak.remove({ task: "NEVER-1" });

  assert.doesNotMatch(registry.render(), /task="NEVER-1"/);
});

test("a partial pass overwrites the bytes rather than leaving stale ones looking fresh", async () => {
  // An under-count is visible in `caterpillar_work_partial`. A previous value left in
  // place would be a number that looks current and is not, which is worse.
  const metrics = new AgentMetrics();
  metrics.recordUsage("pod-7f3a", USAGE);
  metrics.recordUsage("pod-7f3a", { ...USAGE, partial: true, taskBytes: 5 });

  const rendered = metrics.render();
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-7f3a",category="tasks"\} 5/);
  assert.match(rendered, /caterpillar_work_partial\{runner="pod-7f3a"\} 1/);
});

test("two runners keep their own series, because they have their own disks", async () => {
  const metrics = new AgentMetrics();
  metrics.recordUsage("pod-a", USAGE);
  metrics.recordUsage("pod-b", { ...USAGE, taskBytes: 900 });

  const rendered = metrics.render();
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-a",category="tasks"\} 300/);
  assert.match(rendered, /caterpillar_work_bytes\{runner="pod-b",category="tasks"\} 900/);
});

test("one attribution report becomes counters a dashboard can compute the share from", async () => {
  // The whole point of the metric: the digest's prose is not parseable, and an operator who
  // wants the trend on a graph must be able to get it without reading the paragraph.
  const metrics = new AgentMetrics();

  metrics.recordAttribution("pod-7f3a", {
    repos: [
      {
        repo: "acme/widget",
        fleet: { commits: 3, lines: 90 },
        human: { commits: 1, lines: 10 },
        fleetCommitShare: 0.75,
        fleetLineShare: 0.9,
      },
    ],
    total: {
      fleet: { commits: 3, lines: 90 },
      human: { commits: 1, lines: 10 },
      fleetCommitShare: 0.75,
      fleetLineShare: 0.9,
    },
    unavailable: [],
    measured: true,
  });

  const rendered = metrics.render();
  assert.match(
    rendered,
    /caterpillar_digest_authored_lines_total\{runner="pod-7f3a",repo="acme\/widget",author="fleet"\} 90/,
  );
  assert.match(
    rendered,
    /caterpillar_digest_authored_lines_total\{runner="pod-7f3a",repo="acme\/widget",author="human"\} 10/,
  );
  assert.match(
    rendered,
    /caterpillar_digest_authored_commits_total\{runner="pod-7f3a",repo="acme\/widget",author="fleet"\} 3/,
  );
  assert.match(
    rendered,
    /caterpillar_digest_authored_commits_total\{runner="pod-7f3a",repo="acme\/widget",author="human"\} 1/,
  );
});

test("a repo whose history could not be read is counted as unreadable, not as zero lines", async () => {
  // The §19 rule reaching the metrics. A repo reporting 0 fleet lines every day is
  // indistinguishable on a graph from one the fleet genuinely stopped working, and the
  // difference is whether anyone should go looking for a mirror.
  const metrics = new AgentMetrics();

  metrics.recordAttribution("pod-7f3a", {
    repos: [],
    total: { fleet: { commits: 0, lines: 0 }, human: { commits: 0, lines: 0 } },
    unavailable: ["acme/gadget"],
    measured: false,
  });

  const rendered = metrics.render();
  assert.match(
    rendered,
    /caterpillar_digest_authorship_unreadable_total\{runner="pod-7f3a",repo="acme\/gadget"\} 1/,
  );
  assert.doesNotMatch(
    rendered,
    /caterpillar_digest_authored_lines_total\{[^}]*repo="acme\/gadget"/,
    "an unreadable repo must not appear as a zero-line series",
  );
});

test("counters accumulate across days rather than restating one window", async () => {
  // A counter that went back to a single window's value would read to Prometheus as a
  // process restart, and every `rate()` over it would show a spike that did not happen.
  const metrics = new AgentMetrics();
  const day = {
    repos: [
      {
        repo: "acme/widget",
        fleet: { commits: 1, lines: 5 },
        human: { commits: 0, lines: 0 },
        fleetCommitShare: 1,
        fleetLineShare: 1,
      },
    ],
    total: {
      fleet: { commits: 1, lines: 5 },
      human: { commits: 0, lines: 0 },
      fleetCommitShare: 1,
      fleetLineShare: 1,
    },
    unavailable: [],
    measured: true,
  };

  metrics.recordAttribution("pod-7f3a", day);
  metrics.recordAttribution("pod-7f3a", day);

  assert.match(
    metrics.render(),
    /caterpillar_digest_authored_lines_total\{runner="pod-7f3a",repo="acme\/widget",author="fleet"\} 10/,
  );
});
