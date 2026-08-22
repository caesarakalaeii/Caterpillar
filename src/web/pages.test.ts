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
import { bytes, fleetPage, intakePage, runnerPage } from "./pages.ts";
import type { DiskView, FleetView, IntakeView, RunnerExport } from "./view.ts";
import { asTaskId, asWorkspaceName } from "../domain/task.ts";

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
  workspace: { reap: { intervalHours: 24, keepHours: 72 } },
  usage: { intervalHours: 1, deadlineSeconds: 120 },
  intake: { intervalSeconds: 300 },
  remediation: { enabled: false, port: 8081 },
  cluster: { enabled: false, namespaces: [], maxLogLines: 500 },
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

/* ------------------------------------------------------------------ intake */

const INTAKE: IntakeView = {
  rejections: [],
  alerts: [],
  policy: [],
  policyMissing: true,
  receiver: { enabled: false, port: 8081, clusterEnabled: false, namespaces: [] },
};

test("the intake page escapes an alert annotation that tries to be markup", async () => {
  // An alertname and a refusal reason arrive from a Prometheus rule's template and from a
  // tracker item anyone with an account can edit. This page is a new front door to both,
  // and it inherits §18's rule verbatim: escaping is the default, `raw` is the exception,
  // and there is no sanitiser anywhere near it.
  const hostile = "```\n<script>alert('pwned')</script>\n```";
  const page = render(
    intakePage({
      ...INTAKE,
      alerts: [
        {
          fingerprint: "aa01",
          alertname: `<script>alert("name")</script>`,
          reason: hostile,
          at: "2026-08-18T06:50:29.000Z",
        },
      ],
      rejections: [
        {
          task: asTaskId("GH-acme-widget-724"),
          digest: "d1",
          reason: hostile,
          title: `<img src=x onerror="alert(1)">`,
          url: "javascript:alert(1)",
          workspace: "primary",
          at: "2026-08-18T06:50:29.000Z",
        },
      ],
    }),
  );

  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /onerror="alert/);
  assert.match(page, /&lt;script&gt;alert\(&#39;pwned&#39;\)&lt;\/script&gt;/);
  // The fence is quoted text like any other: nothing here renders markdown (§18), so the
  // backticks are characters rather than an element.
  assert.match(page, /```/);
  // A `javascript:` url is script on the origin that serves every transcript, so `safeUrl`
  // drops the link and the row keeps its text.
  assert.doesNotMatch(page, /href="javascript:/);
  assert.match(page, /GH-acme-widget-724/);
});

test("a missing alert policy is a sentence with a fix in it, not an empty table", async () => {
  // "The alert fired and nobody had listed it" is the refusal an operator is least likely
  // to guess, and an empty table reads as "nothing has happened".
  const page = render(intakePage(INTAKE));

  assert.match(page, /no <code>alerts\/policy\.yaml<\/code>/);
  assert.match(page, /refused-no-policy/);
  assert.match(page, /remediation-runbook\.md/);
});

test("an empty policy file and a missing one are different sentences", async () => {
  const page = render(intakePage({ ...INTAKE, policyMissing: false }));

  assert.match(page, /exists and lists no alerts/);
});

test("the intake page says whether anything is listening for an alert at all", async () => {
  const off = render(intakePage(INTAKE));
  assert.match(off, /<code>remediation\.enabled<\/code> is false/);

  const on = render(
    intakePage({
      ...INTAKE,
      receiver: { enabled: true, port: 8081, clusterEnabled: true, namespaces: ["caterpillar"] },
      policyMissing: false,
      policy: [
        {
          alertname: "CaterpillarContextOverrun",
          workspace: asWorkspaceName("primary"),
          repos: [{ host: "github.com", owner: "acme", name: "widget" }],
          acceptance: ["npm test"],
          requires: ["linux"],
          runbook: "https://example.invalid/runbook",
          maxOpenTasks: 2,
        },
      ],
    }),
  );

  assert.match(on, /listening<\/span> on port 8081/);
  assert.match(on, /CaterpillarContextOverrun/);
  assert.match(on, /href="https:\/\/example\.invalid\/runbook"/);
  assert.match(on, /github\.com\/acme\/widget/);
});

test("the fleet page carries one line saying when intake last ran", async () => {
  const base: FleetView = { tasks: [], counts: {}, runners: [], live: [] };

  assert.match(render(fleetPage(base)), /no pass on this runner yet/);

  const ran = render(
    fleetPage({
      ...base,
      intake: {
        at: "2026-08-18T09:00:00.000Z",
        ref: "refs/intake/5555",
        runner: "caterpillar-1",
        outcome: "ingested",
        seen: 3,
        created: 0,
        rejected: 1,
        failed: 0,
      },
    }),
  );
  assert.match(ran, /3 seen · 0 created ·\s+1 refused/);
  assert.match(ran, /by caterpillar-1/);

  // Three runners in four lose the claim every interval by design, and a page that showed
  // them nothing would report a working fleet as one where intake had never run.
  const skipped = render(
    fleetPage({
      ...base,
      intake: {
        at: "2026-08-18T09:00:00.000Z",
        ref: "refs/intake/5555",
        runner: "caterpillar-2",
        outcome: "claimed-elsewhere",
      },
    }),
  );
  assert.match(skipped, /another runner served this interval/);
});

test("the intake page shows a malformed schedule, and says which runner fires them", async () => {
  // A schedule that will not parse is refused when it is committed (§22) — and until this
  // page showed it, that refusal was a warn line in one pod's stdout. The other half is
  // the switch: a fleet where nothing has `schedule.enabled` fires nothing, and an empty
  // occurrence ledger is exactly what that looks like.
  const page = render(
    intakePage({
      ...INTAKE,
      scheduling: false,
      schedules: [],
      scheduleErrors: [
        {
          schedule: "deps-audit",
          message: "schedules/deps-audit.yaml is invalid: `acceptance` must list at least one command",
        },
      ],
      occurrences: [],
    }),
  );

  assert.match(page, /deps-audit/);
  assert.match(page, /must list at least one command/);
  assert.match(page, /<code>schedule\.enabled<\/code> is false/);
});

test("a skipped occurrence is shown with its reason, so a quiet schedule is legible", async () => {
  // The whole point of recording a skip: "the precheck said no" and "nothing is polling
  // this schedule" produce the same number of tasks, and only the ledger tells them apart.
  const page = render(
    intakePage({
      ...INTAKE,
      scheduling: true,
      schedules: [
        {
          id: "deps-audit",
          version: 1,
          trigger: { cron: "0 9 * * 1-5", timeZone: "Europe/Berlin" },
          workspace: asWorkspaceName("primary"),
          repos: [{ host: "github.com", owner: "acme", name: "widget" }],
          prompt: "audit the dependencies",
          acceptance: ["npm test"],
          requires: [],
          enabled: true,
          maxOpenTasks: 1,
        },
      ],
      occurrences: [
        {
          schedule: "deps-audit",
          occurrence: "2026-08-17T0700Z",
          outcome: "skipped",
          detail: "exit 1: <script>alert('x')</script>",
          at: "2026-08-17T07:00:04.000Z",
        },
      ],
    }),
  );

  assert.match(page, /0 9 \* \* 1-5/);
  assert.match(page, /Europe\/Berlin/);
  assert.match(page, /skipped/);
  assert.doesNotMatch(page, /<script>alert/, "a precheck's output is untrusted like any other");
});
