/**
 * The supervisor's failure path, driven over a REAL git remote so the lease
 * compare-and-swap is the genuine article rather than a stub that always agrees.
 *
 * That matters here more than usual: the bug this pins was invisible precisely because
 * the losing step was a CAS against a ref that had already been deleted.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import { asRunnerId, asTaskId, type TaskState } from "../domain/task.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { NullNotifier } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import { LeaseManager } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { Supervisor, type ProgressProbe, type SessionRunner, type Verifier } from "./loop.ts";

const TASK = asTaskId("SMOKE-1");

const root = await mkdtemp(join(tmpdir(), "caterpillar-loop-"));
const origin = join(root, "origin.git");
const statePath = join(root, "state");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = new Git(root);
await setup.run("init", "--bare", "--initial-branch=main", origin);
await setup.run("clone", origin, statePath);

const stateGit = new Git(statePath);
// Locally, never from the operator's global config — a machine runner would otherwise
// author the audit trail as whoever happens to be logged in.
await stateGit.run("config", "user.name", "caterpillar");
await stateGit.run("config", "user.email", "caterpillar@example.invalid");
await stateGit.run("symbolic-ref", "HEAD", "refs/heads/main");

await mkdir(join(statePath, "tasks", TASK), { recursive: true });
await writeFile(
  join(statePath, "tasks", TASK, "spec.md"),
  [
    "---",
    "workspace: test",
    "repos:",
    "  - github.com/acme/widget",
    "acceptance:",
    '  - "true"',
    "---",
    "",
    "Prove the pipeline runs.",
    "",
  ].join("\n"),
);

const seed: TaskState = {
  id: TASK,
  status: "ready",
  phase: "implementing",
  requires: [],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
};
await writeFile(
  join(statePath, "tasks", TASK, "state.json"),
  `${JSON.stringify(seed, null, 2)}\n`,
);
await stateGit.run("add", "-A");
await stateGit.run("commit", "-m", "seed");
await stateGit.run("push", "origin", "HEAD:main");

const config: RunnerConfig = {
  runnerId: "test-runner",
  capabilities: ["linux"],
  stateRepo: { url: origin, branch: "main", path: statePath },
  paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks") },
  // A heartbeat long enough never to fire: this test is about the failure path, and a
  // renewal landing mid-park would muddy which CAS was under test.
  lease: { heartbeatSeconds: 3600, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: { maxSessionsPerTask: 20, noProgressLimit: 3 },
  log: { level: "info" },
  llm: {
    auth: "proxy",
    baseUrl: "http://localhost",
    modelId: "test",
    providerId: "test",
    contextWindow: 100_000,
    maxTokens: 4096,
  },
  workspaces: new Map(),
  pollSeconds: 1,
  secretsDir: join(root, "secrets"),
};

/** What the state repo's REMOTE says — the only evidence a push actually landed. */
const pushedState = async (): Promise<TaskState | undefined> => {
  const result = await new Git(origin).tryRun("show", `main:tasks/${TASK}/state.json`);
  if (result.code !== 0) return undefined;
  return JSON.parse(result.stdout) as TaskState;
};

test("a task whose session throws is parked on the REMOTE, not just locally", async () => {
  // The bug: `workTask` released the lease in its `finally`, and only then did the
  // caller try to park. `park` -> `push` -> `assertHeld` therefore CAS'd against a
  // lease ref that had just been deleted, threw LeaseLostError, and `parkFailed`
  // swallowed it. The supervisor logged "lease is no longer held by this runner" and
  // the task stayed `ready` on the remote — so the very next poll re-claimed it and
  // failed again, forever.
  //
  // Asserted against the REMOTE deliberately. `park` writes state.json locally BEFORE
  // pushing, so the working tree says "parked" either way — a test reading the
  // checkout passes with the bug still in place, and the next `pull` would reset it
  // back anyway.
  const runner: SessionRunner = {
    run: () => Promise.reject(new Error("mirror clone failed: Repository not found")),
  };
  const verifier: Verifier = {
    verify: () => Promise.resolve({ passed: false, detail: "unused" }),
  };
  const progress: ProgressProbe = {
    probe: () =>
      Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
  };

  const supervisor = new Supervisor({
    config,
    store: new StateStore(statePath, stateGit),
    leases: new LeaseManager({
      git: stateGit,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner,
    verifier,
    progress,
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
  });

  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  let parked: TaskState | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pushedState();
    if (state?.status === "parked") {
      parked = state;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await running.catch(() => undefined);

  assert.ok(
    parked !== undefined,
    "a failing task must reach `parked` on the remote, or it is re-claimed every poll",
  );
});
