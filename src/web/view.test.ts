import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import { asRunnerId, asTaskId, asWorkspaceName, type TaskSpec, type TaskState } from "../domain/task.ts";
import { LiveSession } from "../obs/live.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";
import { diskView, fleet, intakeView, runnerExport, taskDetail } from "./view.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const store = async (): Promise<StateStore> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-view-"));
  roots.push(root);
  return new StateStore(root, new Git(root));
};

const spec = (id: string, goal: string): TaskSpec => ({
  id: asTaskId(id),
  workspace: asWorkspaceName("primary"),
  kind: "implement",
  goal,
  repos: [{ host: "github.com", owner: "acme", name: "widget" }],
  requires: ["linux"],
  acceptance: ["npm test"],
});

const state = (id: string, over: Partial<TaskState> = {}): TaskState => ({
  id: asTaskId(id),
  status: "ready",
  phase: "implementing",
  requires: ["linux"],
  sessions: 2,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 100, outputTokens: 20, costUsd: 1.5 },
  progress: { lastProgressSession: 2, noProgressStreak: 0 },
  createdAt: "2026-08-16T08:00:00.000Z",
  updatedAt: "2026-08-16T09:00:00.000Z",
  ...over,
});

const CONFIG: RunnerConfig = {
  runnerId: "pod-7f3a",
  capabilities: ["linux", "nix"],
  identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  toolchain: {
    nixpkgs: "github:NixOS/nixpkgs/abc",
    timeoutSeconds: 900,
    gcIntervalHours: 24,
    gcKeepDays: 7,
    substituters: [],
    trustedPublicKeys: [],
    minFreeGb: 5,
    maxFreeGb: 20,
  },
  stateRepo: {
    url: "https://github.com/acme/state.git",
    branch: "main",
    path: "/work/state",
    secretRef: "caterpillar-github-app",
  },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks", root: "/work" },
  workspace: { reap: { intervalHours: 24, keepHours: 72 } },
  usage: { intervalHours: 1, deadlineSeconds: 120 },
  lease: { heartbeatSeconds: 60, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: { maxSessionsPerTask: 20, noProgressLimit: 3, maxReviewRounds: 3, maxSessionSeconds: 14_400, commandTimeoutSeconds: 900 },
  log: { level: "info" },
  intake: { intervalSeconds: 300 },
  llm: {
    auth: "subscription",
    baseUrl: "http://llm-proxy",
    modelId: "claude-opus-5",
    providerId: "anthropic",
    contextWindow: 200_000,
    maxTokens: 32_000,
    cooldown: { initialSeconds: 60, maxSeconds: 3600 },
    credentialsPath: "/work/llm/credentials.json",
  },
  workspaces: new Map([
    [
      asWorkspaceName("primary"),
      {
        name: asWorkspaceName("primary"),
        forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
        tracker: { kind: "github-issues", apiBase: "https://api.github.com", ingestLabel: "agent" },
        secretRef: "caterpillar-github-app",
      },
    ],
  ]),
  pollSeconds: 30,
  // The default, stated. Every existing test describes a one-task-at-a-time runner and
  // must keep describing one — see DESIGN.md §6.4.
  concurrency: 1,
  housekeepingSeconds: 30,
  secretsDir: "/etc/caterpillar/secrets",
  digest: { enabled: false, hour: 18, timeZone: "Europe/Berlin", summarise: true },
  cluster: {
    enabled: false,
    namespaces: [],
    lokiUrl: "http://loki.invalid",
    kubeApiUrl: "https://kube.invalid",
    maxLogLines: 2000,
  },
  remediation: { enabled: false, port: 8081 },
  redis: {
    enabled: false,
    url: "redis://localhost:6379",
    commandTimeoutMs: 1000,
    keyPrefix: "caterpillar:",
  },
  bot: { mode: "in-process" as const, port: 9091 },
  web: {
    enabled: true,
    port: 8080,
    logCapacity: 500,
    refreshSeconds: 10,
    requireForwardedUser: false,
    forwardedUserHeader: "remote-user",
  },
};

test("the runner export never carries a path to a credential", async () => {
  // The export exists to answer "how is this runner configured". Config carries no
  // secrets by design, but the fields POINTING at secrets are the ones most likely to
  // grow a token later, so they are left out by construction rather than by review.
  const exported = runnerExport(CONFIG);
  const serialised = JSON.stringify(exported);

  for (const forbidden of ["secretRef", "secretsDir", "credentialsPath"]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not be exported`);
  }
  assert.ok(!serialised.includes("/etc/caterpillar/secrets"), "the secrets directory must not leak");
  assert.ok(!serialised.includes("credentials.json"), "the LLM credential path must not leak");
});

test("the runner export carries what an operator actually needs", async () => {
  const exported = runnerExport(CONFIG);

  assert.equal(exported.runnerId, "pod-7f3a");
  assert.deepEqual(exported.capabilities, ["linux", "nix"]);
  assert.equal(exported.llm.modelId, "claude-opus-5");
  assert.equal(exported.llm.auth, "subscription");
  assert.equal(exported.limits.maxSessionsPerTask, 20);
  assert.equal(exported.toolchain.nixpkgs, "github:NixOS/nixpkgs/abc");
  // Exported for the same reason the store's gc numbers are: an operator looking at a full
  // volume needs both halves of the janitor without knowing which one they are after.
  //
  // The field is optional on the TYPE so the viewer can render a runner of the previous
  // vintage (`view.ts`), which makes this assertion the one that pins the other half: an
  // export taken from a live config here always carries it.
  assert.notEqual(exported.workspace, undefined, "a local export always states its reaping");
  assert.equal(exported.workspace?.reap.intervalHours, 24);
  assert.equal(exported.workspace?.reap.keepHours, 72);
  assert.equal(exported.stateRepo.branch, "main");
  assert.deepEqual(exported.workspaces[0]?.forge, {
    kind: "github",
    host: "github.com",
    owner: "acme",
    apiBase: "https://api.github.com",
  });
  assert.equal(exported.workspaces[0]?.tracker?.kind, "github-issues");
});

test("the fleet says which runner holds which task", async () => {
  const subject = await store();
  await subject.writeSpec(spec("TASK-1", "# Fix the widget\n\nIt drops frames."));
  await subject.writeState(
    state("TASK-1", {
      status: "running",
      owner: { runner: asRunnerId("pod-7f3a"), leaseOid: "abc", since: "2026-08-16T09:00:00.000Z" },
    }),
  );
  await subject.writeSpec(spec("TASK-2", "# Something else"));
  await subject.writeState(state("TASK-2", { status: "ready" }));

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });

  assert.deepEqual(
    view.tasks.map((task) => task.id),
    ["TASK-1", "TASK-2"],
  );
  assert.equal(view.tasks[0]?.owner?.runner, "pod-7f3a");
  assert.equal(view.tasks[0]?.title, "Fix the widget", "the heading is the task's name");
  assert.deepEqual(view.counts["running"], 1);
  assert.deepEqual(view.counts["ready"], 1);

  assert.deepEqual(
    view.runners.map((runner) => ({ id: runner.id, self: runner.self, tasks: runner.tasks })),
    [{ id: "pod-7f3a", self: true, tasks: ["TASK-1"] }],
  );
});

test("a runner that owns a task but is not this one still appears", async () => {
  // The state repo is the fleet's only shared surface. A workstation runner holding a
  // task must be visible from the pod's UI, or "where is this running" has no answer.
  const subject = await store();
  await subject.writeSpec(spec("TASK-9", "# On the workstation"));
  await subject.writeState(
    state("TASK-9", {
      status: "running",
      owner: { runner: asRunnerId("workstation"), leaseOid: "def", since: "2026-08-16T09:30:00.000Z" },
    }),
  );

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });

  assert.deepEqual(
    view.runners.map((runner) => `${runner.id}:${runner.self}`),
    ["pod-7f3a:true", "workstation:false"],
    "this runner is always listed, even holding nothing",
  );
});

test("a task whose spec will not parse is still listed", async () => {
  // state.json is the control record and spec.md is prose. A task that cannot be read
  // is exactly the one an operator needs to see, so a broken spec costs the title only.
  const subject = await store();
  await subject.writeState(state("TASK-BROKEN", { status: "parked" }));

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });

  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0]?.id, "TASK-BROKEN");
  assert.equal(view.tasks[0]?.title, "TASK-BROKEN", "with no readable spec, the id is the title");
});

test("the live session is attached to the task it belongs to", async () => {
  const subject = await store();
  await subject.writeSpec(spec("TASK-1", "# Live"));
  await subject.writeState(state("TASK-1", { status: "running" }));

  const live = new LiveSession();
  live.begin({
    task: asTaskId("TASK-1"),
    session: 3,
    model: "claude-opus-5",
    startedAt: "2026-08-16T10:00:00.000Z",
  });
  live.record({ role: "user", content: "go", timestamp: 0 });

  const view = await fleet({ store: subject, live, runnerId: "pod-7f3a" });
  // A LIST since the fleet grew past one replica: a single runner answering for itself
  // reports at most one entry, and the aggregating viewer unions them across replicas.
  assert.deepEqual(
    view.live.map((entry) => `${entry.runner}:${entry.task}`),
    ["pod-7f3a:TASK-1"],
  );

  const detail = await taskDetail(subject, asTaskId("TASK-1"), live);
  assert.equal(detail?.live?.entries.length, 1, "the in-flight messages render like a stored one");
  assert.equal(detail?.live?.session, 3);
});

test("task detail gathers every document the state repo holds for a task", async () => {
  const subject = await store();
  const id = asTaskId("TASK-FULL");
  await subject.writeSpec(spec("TASK-FULL", "# Everything\n\nThe goal."));
  await subject.writeState(state("TASK-FULL", { status: "awaiting-human" }));
  await subject.appendJournal(id, 1, "did a thing");
  await subject.writeHandoff(id, "next: the other thing");
  await subject.writeQuestion(id, 1, "which one?");
  await subject.writeVerdict(id, 1, "changes requested");
  await subject.writeArtifact(id, "probe.txt", Buffer.from("result"));
  await subject.writeSessionTranscript(id, 1, JSON.stringify({ role: "user", content: "hi", timestamp: 0 }));

  const detail = await taskDetail(subject, id, new LiveSession());

  assert.equal(detail?.spec?.goal.startsWith("# Everything"), true);
  assert.equal(detail?.state.status, "awaiting-human");
  assert.match(detail?.journal ?? "", /did a thing/);
  assert.match(detail?.handoff ?? "", /the other thing/);
  assert.deepEqual(detail?.questions, [{ index: 1, question: "which one?" }]);
  assert.deepEqual(detail?.verdicts, [{ index: 1, body: "changes requested" }]);
  assert.deepEqual(detail?.artifacts, ["probe.txt"]);
  assert.deepEqual(detail?.sessions, [1]);
});

test("task detail renders a legacy journal.md alongside the shards that followed it", async () => {
  // The page has always shown the journal as ONE document, and it must keep doing so
  // across the format change: a task that started before the sharding has its history in
  // `journal.md` and its recent entries in `journal/`, and an operator reading the page
  // must see both without knowing either file exists.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-view-legacy-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root), undefined, "pod-7f3a");
  const id = asTaskId("TASK-LEGACY");

  await subject.writeSpec(spec("TASK-LEGACY", "# Legacy\n\nThe goal."));
  await subject.writeState(state("TASK-LEGACY", { status: "running" }));
  await writeFile(
    join(root, "tasks", id, "journal.md"),
    "\n## Session 1 — 2026-01-01T00:00:00.000Z\n\nthe old entry\n",
    "utf8",
  );
  await subject.appendJournal(id, 2, "the new entry");

  const detail = await taskDetail(subject, id, new LiveSession());
  assert.match(detail?.journal ?? "", /the old entry/);
  assert.match(detail?.journal ?? "", /the new entry/);
});

test("an unknown task is absent rather than an error", async () => {
  const subject = await store();
  assert.equal(await taskDetail(subject, asTaskId("TASK-NOPE"), new LiveSession()), undefined);
});

test("a finished task's owner is reported as history, not as a hold", async () => {
  // `owner` is stamped on every transition and never cleared (supervisor/loop.ts), so a
  // done task names the runner that worked it last. Counting it as held would show a
  // runner as busy forever.
  const subject = await store();
  await subject.writeSpec(spec("TASK-OLD", "# Finished"));
  await subject.writeState(
    state("TASK-OLD", {
      status: "done",
      owner: { runner: asRunnerId("workstation"), leaseOid: "abc", since: "2026-08-16T07:00:00.000Z" },
    }),
  );

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });

  assert.equal(view.tasks[0]?.owner?.runner, "workstation", "the record is still shown");
  assert.equal(view.tasks[0]?.held, false);
  assert.deepEqual(
    view.runners.map((runner) => runner.id),
    ["pod-7f3a"],
    "a runner is only listed as holding what it is actually running",
  );
});

/* --------------------------------------------------------------------- disk */

const USAGE: WorkspaceUsage = {
  measuredAt: "2026-08-18T09:00:00.000Z",
  durationMs: 4200,
  partial: false,
  fs: { totalBytes: 1000, freeBytes: 400 },
  mirrorBytes: 100,
  taskBytes: 300,
  nixBytes: 50,
  otherBytes: 25,
  mirrors: [{ name: "acme/widget", bytes: 100 }],
  tasks: [
    { name: "TASK-1", bytes: 250 },
    { name: "TASK-2", bytes: 50 },
  ],
};

test("the disk view orders the categories by size, because the question is who is biggest", async () => {
  const view = diskView(USAGE);

  assert.deepEqual(
    view.categories.map((category) => category.name),
    ["tasks", "mirrors", "nix", "other"],
  );
  assert.equal(view.categories[0]?.bytes, 300);
  // Of the volume's total, not of the categories: 300 of 1000.
  assert.equal(view.categories[0]?.fraction, 0.3);
});

test("used bytes come from statfs, not from summing what this runner can account for", async () => {
  // The categories add to 475 here and the filesystem says 600 are gone. The gap is
  // another process on the same volume, and it is exactly the thing a page that summed
  // the categories would hide while the disk filled.
  const view = diskView(USAGE);

  assert.equal(view.usedBytes, 600);
  assert.equal(view.freeBytes, 400);
  assert.equal(view.totalBytes, 1000);
});

test("a filesystem that would not answer gives zeroes rather than a negative used", async () => {
  const view = diskView({ ...USAGE, fs: { totalBytes: 0, freeBytes: 0 } });

  assert.equal(view.usedBytes, 0);
  for (const category of view.categories) {
    assert.equal(category.fraction, 0, "a share of nothing is 0, not NaN or Infinity");
  }
});

test("a partial measurement is carried through rather than dropped", async () => {
  // An under-count with a flag on it still names the task that is growing. Hiding it
  // would leave the operator with nothing at the moment the volume is most full.
  const view = diskView({ ...USAGE, partial: true });

  assert.equal(view.partial, true);
  assert.equal(view.measuredAt, "2026-08-18T09:00:00.000Z");
  assert.equal(view.durationMs, 4200);
});

test("the breakdowns are passed through in the order the walk capped them", async () => {
  const view = diskView(USAGE);

  assert.deepEqual(view.tasks, [
    { name: "TASK-1", bytes: 250 },
    { name: "TASK-2", bytes: 50 },
  ]);
  assert.deepEqual(view.mirrors, [{ name: "acme/widget", bytes: 100 }]);
});

test("the export says how often the disk numbers are refreshed", async () => {
  // Without the interval, an hourly measurement's staleness reads as a bug on the page.
  const exported = runnerExport(CONFIG);

  assert.equal(exported.usage.intervalHours, 1);
  assert.equal(exported.usage.deadlineSeconds, 120);
  assert.equal(exported.paths.root, "/work");
});

/* ------------------------------------------------------------------ intake */

test("the fleet carries the last intake pass, and says when there has not been one", async () => {
  // The line an operator reads first. `seen` is the field that separates "nobody labelled
  // anything" from "the tracker returned items and none became tasks", and until this
  // existed it was reachable only from one pod's stdout.
  const subject = await store();

  const none = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });
  assert.equal(none.intake, undefined, "no reader wired means no claim about intake");

  const view = await fleet({
    store: subject,
    live: new LiveSession(),
    runnerId: "pod-7f3a",
    intake: {
      current: () => ({
        at: "2026-08-18T09:00:00.000Z",
        ref: "refs/intake/5555",
        runner: "pod-7f3a",
        outcome: "ingested" as const,
        seen: 3,
        created: 0,
        rejected: 1,
        failed: 0,
      }),
    },
  });

  assert.equal(view.intake?.seen, 3);
  assert.equal(view.intake?.rejected, 1);
  assert.equal(view.intake?.runner, "pod-7f3a");
});

test("intakeView gathers the four things that explain a pickup that did not happen", async () => {
  const subject = await store();
  await subject.writeIntakeRejection(asTaskId("GH-acme-widget-724"), {
    digest: "d1",
    reason: "no `agent` block",
    url: "https://github.com/acme/widget/issues/724",
    title: "please fix the widget",
    workspace: "primary",
  });
  await subject.writeAlertRefusal("aa01", {
    fingerprint: "aa01",
    alertname: "CaterpillarContextOverrun",
    reason: "no policy entry",
  });
  await subject.writeAlertRefusal("aa02", {
    fingerprint: "aa02",
    alertname: "CaterpillarTaskThrashing",
    reason: "created",
    task: asTaskId("ALERT-aa02"),
  });

  const view = await intakeView({ store: subject, config: CONFIG });

  assert.equal(view.rejections.length, 1);
  assert.equal(view.rejections[0]?.task, "GH-acme-widget-724");
  assert.equal(view.rejections[0]?.url, "https://github.com/acme/widget/issues/724");
  // The ledger is every DECISION, not only the refusals: `queue.ts` writes one on the
  // success path too, which is what makes it a complete record of the alert path.
  assert.deepEqual(
    [...view.alerts].map((record) => record.reason).sort(),
    ["created", "no policy entry"],
  );
  assert.deepEqual(view.policy, []);
  assert.equal(view.policyMissing, true, "no alerts/policy.yaml at all, not an empty one");
  assert.equal(view.receiver.enabled, false);
});

test("a policy that will not parse is rendered as a message, not thrown at the page", async () => {
  // This is the page an operator opens to find out why an alert produced nothing, and a
  // typo in the policy file is the likeliest answer that a working supervisor cannot
  // otherwise tell them — the poll loop catches this error into a log nobody is reading.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-view-policy-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root));
  await mkdir(join(root, "alerts"), { recursive: true });
  await writeFile(
    join(root, "alerts", "policy.yaml"),
    "version: 1\nalerts:\n  - alertname: X\n    acceptence: []\n",
    "utf8",
  );

  const view = await intakeView({ store: subject, config: CONFIG });

  assert.match(view.policyError ?? "", /unknown key/);
  assert.equal(view.policyMissing, false, "a file that exists is not a missing one");
  assert.deepEqual(view.policy, []);
});

test("a task says which of the four intake paths produced it", async () => {
  const subject = await store();

  await subject.writeSpec({
    ...spec("GH-acme-widget-12", "# Fix it\n\nprose\n\nTracker item: https://github.com/acme/widget/issues/12"),
    tracker: { kind: "github-issues", id: "12", container: "acme/widget" },
  });
  await subject.writeState(state("GH-acme-widget-12"));

  await subject.writeSpec({ ...spec("HAND-1", "# Committed by hand") });
  await subject.writeState(state("HAND-1"));

  await subject.writeSpec({
    ...spec("BS-99", "# A brainstorm"),
    kind: "brainstorm",
  });
  await subject.writeState(state("BS-99"));

  await subject.writeSpec({
    ...spec("ALERT-bb01", "# Alert `X` is firing\n\n- Rule: https://prom.example.invalid/graph?g0=1"),
    kind: "remediation",
  });
  await subject.writeState(state("ALERT-bb01"));
  await subject.writeAlertRefusal("bb01", {
    fingerprint: "bb01",
    alertname: "CaterpillarContextOverrun",
    task: asTaskId("ALERT-bb01"),
    reason: "created",
  });

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });
  const origins = new Map(view.tasks.map((task) => [task.id, task.origin]));

  assert.equal(origins.get(asTaskId("GH-acme-widget-12"))?.kind, "tracker");
  assert.equal(
    origins.get(asTaskId("GH-acme-widget-12"))?.url,
    "https://github.com/acme/widget/issues/12",
    "the item's address is in the goal, because a TrackerRef does not carry one",
  );
  assert.equal(origins.get(asTaskId("HAND-1"))?.kind, "spec");
  assert.equal(origins.get(asTaskId("BS-99"))?.kind, "brainstorm");

  const alert = origins.get(asTaskId("ALERT-bb01"));
  assert.equal(alert?.kind, "alert");
  // Not recoverable from the id — a fingerprint is a hash — so it comes from the ledger.
  assert.equal(alert?.alertname, "CaterpillarContextOverrun");
  assert.equal(alert?.url, "https://prom.example.invalid/graph?g0=1");

  const detail = await taskDetail(subject, asTaskId("ALERT-bb01"), new LiveSession());
  assert.equal(detail?.origin?.alertname, "CaterpillarContextOverrun");
});

test("a tracker task whose goal lost its link still names its source", async () => {
  // The URL is recovered from the goal's prose, which an agent could have rewritten, and
  // for github-issues the ref alone is enough to rebuild it. A Vikunja ref is not: its web
  // address depends on the instance's frontend, and a guessed link that 404s is worse than
  // plain text.
  const subject = await store();
  await subject.writeSpec({
    ...spec("GH-acme-widget-13", "# No trailing link here"),
    tracker: { kind: "github-issues", id: "13", container: "acme/widget" },
  });
  await subject.writeState(state("GH-acme-widget-13"));
  await subject.writeSpec({
    ...spec("VK-7-42", "# From Vikunja"),
    tracker: { kind: "vikunja", id: "42", container: "7" },
  });
  await subject.writeState(state("VK-7-42"));

  const view = await fleet({ store: subject, live: new LiveSession(), runnerId: "pod-7f3a" });
  const origins = new Map(view.tasks.map((task) => [task.id, task.origin]));

  assert.equal(
    origins.get(asTaskId("GH-acme-widget-13"))?.url,
    "https://github.com/acme/widget/issues/13",
  );
  assert.equal(origins.get(asTaskId("VK-7-42"))?.kind, "tracker");
  assert.equal(origins.get(asTaskId("VK-7-42"))?.url, undefined);
  assert.match(origins.get(asTaskId("VK-7-42"))?.label ?? "", /vikunja/);
});
