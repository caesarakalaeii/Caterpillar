/**
 * The runner page's disk section, and the byte formatter under it.
 *
 * The templates elsewhere are covered through `html.test.ts` — escaping is a property of
 * the tagged template rather than of any one page. What is tested here is what the disk
 * section adds on top of that: names that come from a task id and therefore from a
 * tracker, which is untrusted input arriving on a page that also serves transcripts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "./html.ts";
import { bytes, runnerPage } from "./pages.ts";
import type { DiskView, RunnerExport } from "./view.ts";

const EXPORT: RunnerExport = {
  runnerId: "pod-7f3a",
  capabilities: ["linux", "nix"],
  pollSeconds: 30,
  lease: { heartbeatSeconds: 60, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: {
    maxSessionsPerTask: 20,
    noProgressLimit: 3,
    maxReviewRounds: 3,
    maxSessionSeconds: 14_400,
  },
  llm: {
    auth: "subscription",
    modelId: "claude-opus-5",
    providerId: "anthropic",
    contextWindow: 200_000,
    maxTokens: 32_000,
    cooldown: { initialSeconds: 60, maxSeconds: 3600 },
  },
  toolchain: {
    nixpkgs: "github:NixOS/nixpkgs/abc",
    timeoutSeconds: 900,
    gcIntervalHours: 24,
    gcKeepDays: 7,
  },
  stateRepo: { url: "https://github.com/acme/state.git", branch: "main", path: "/work/state" },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks", root: "/work" },
  usage: { intervalHours: 1, deadlineSeconds: 120 },
  intake: { intervalSeconds: 300 },
  log: { level: "info" },
  workspaces: [],
};

const DISK: DiskView = {
  measuredAt: "2026-08-18T09:00:00.000Z",
  durationMs: 4200,
  partial: false,
  totalBytes: 100 * 1024 * 1024 * 1024,
  freeBytes: 40 * 1024 * 1024 * 1024,
  usedBytes: 60 * 1024 * 1024 * 1024,
  categories: [
    { name: "tasks", bytes: 30 * 1024 * 1024 * 1024, fraction: 0.3 },
    { name: "nix", bytes: 20 * 1024 * 1024 * 1024, fraction: 0.2 },
    { name: "mirrors", bytes: 5 * 1024 * 1024 * 1024, fraction: 0.05 },
    { name: "other", bytes: 1024, fraction: 0 },
  ],
  mirrors: [{ name: "acme/widget", bytes: 5 * 1024 * 1024 * 1024 }],
  tasks: [{ name: "TASK-1", bytes: 30 * 1024 * 1024 * 1024 }],
};

test("bytes are rendered in binary units, the ones the PVC request is written in", async () => {
  // Binary because `df`, the PVC and every Kubernetes quantity in this repo mean `Gi`.
  // Decimal units would disagree with the manifest by 7% and send somebody chasing it.
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1024), "1 KiB");
  assert.equal(bytes(1536), "2 KiB", "below MiB there is no decimal to give");
  assert.equal(bytes(1024 * 1024), "1.0 MiB");
  assert.equal(bytes(1.5 * 1024 * 1024 * 1024), "1.5 GiB");
  assert.equal(bytes(3 * 1024 ** 4), "3.0 TiB");
});

test("a negative or nonsense size is 0 B rather than NaN on the page", async () => {
  assert.equal(bytes(-1), "0 B");
  assert.equal(bytes(Number.NaN), "0 B");
  assert.equal(bytes(Number.POSITIVE_INFINITY), "0 B");
});

test("the disk section reports the categories, the volume and when it was measured", async () => {
  const page = render(runnerPage(EXPORT, DISK));

  assert.match(page, /<h2>Disk<\/h2>/);
  assert.match(page, /60\.0 GiB/, "used");
  assert.match(page, /40\.0 GiB/, "free");
  assert.match(page, /30\.0 GiB/, "the tasks category");
  assert.match(page, /30\.0%/, "its share of the volume");
  assert.match(page, /TASK-1/, "the largest task is named");
  assert.match(page, /acme\/widget/, "the largest mirror is named");
  // The timestamp is as prominent as the bytes on purpose: this is measured hourly and
  // only while idle, so a figure read as live is the expensive mistake.
  assert.match(page, /2026-08-18T09:00:00\.000Z/);
});

test("a runner that has not measured yet says so rather than showing zeroes", async () => {
  // Zeroes would read as "the disk is empty". The measurement is idle-only, so a runner
  // busy since boot legitimately has nothing to report.
  const page = render(runnerPage(EXPORT, undefined));

  assert.match(page, /<h2>Disk<\/h2>/);
  assert.match(page, /Not measured yet/);
  assert.doesNotMatch(page, /0 B/);
});

test("a partial measurement is labelled as a floor, not presented as the answer", async () => {
  const page = render(runnerPage(EXPORT, { ...DISK, partial: true }));

  assert.match(page, /Partial/);
  assert.match(page, /120s deadline/);
});

test("a task id is escaped, because it arrives from a tracker nobody here controls", async () => {
  // The breakdown labels are task ids and mirror names. Both come from outside this
  // process, onto an origin that also serves every transcript the fleet has produced.
  const hostile = `<script>alert("x")</script>`;
  const page = render(
    runnerPage(EXPORT, {
      ...DISK,
      tasks: [{ name: hostile, bytes: 1 }],
      mirrors: [{ name: hostile, bytes: 1 }],
    }),
  );

  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("an empty breakdown is an explicit nothing rather than a headerless table", async () => {
  const page = render(runnerPage(EXPORT, { ...DISK, tasks: [], mirrors: [] }));

  assert.match(page, /No largest tasks measured\./);
  assert.match(page, /No largest mirrors measured\./);
});
