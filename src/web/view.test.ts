import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import { asRunnerId, asTaskId, asWorkspaceName, type TaskSpec, type TaskState } from "../domain/task.ts";
import { LiveSession } from "../obs/live.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import { fleet, runnerExport, taskDetail } from "./view.ts";

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
  workspace: asWorkspaceName("caesar"),
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
  },
  stateRepo: {
    url: "https://github.com/acme/state.git",
    branch: "main",
    path: "/work/state",
    secretRef: "caterpillar-github-app",
  },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks" },
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
      asWorkspaceName("caesar"),
      {
        name: asWorkspaceName("caesar"),
        forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
        tracker: { kind: "github-issues", apiBase: "https://api.github.com", ingestLabel: "agent" },
        secretRef: "caterpillar-github-app",
      },
    ],
  ]),
  pollSeconds: 30,
  secretsDir: "/etc/caterpillar/secrets",
  digest: { enabled: false, hour: 18, timeZone: "Europe/Berlin", summarise: true },
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
  assert.equal(view.live?.task, "TASK-1");

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
