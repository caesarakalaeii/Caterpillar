/**
 * What the supervisor remembers about the last intake pass (DESIGN.md §14, §18).
 *
 * Driven over a REAL state repo with a real `refs/intake/<bucket>` claim, because the
 * fact this exists to record — that three runners in four legitimately skip every
 * interval — only happens when the compare-and-swap is genuine. A stubbed lease manager
 * would agree with everyone and the "another runner served this interval" branch would
 * never be reached.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { RunnerConfig } from "../config/types.ts";
import { asRunnerId } from "../domain/task.ts";
import type { IntakePass } from "../intake/ingest.ts";
import { IntakeStatus } from "../intake/status.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { NullNotifier } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import { LeaseManager } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { DEFAULT_USAGE_CONFIG } from "../workspace/usage.ts";
import { DEFAULT_REAP_CONFIG } from "../workspace/worktree.ts";
import { Supervisor, type Intake, type ProgressProbe, type SessionRunner, type Verifier } from "./loop.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** An empty state repo with a real remote: nothing to claim, so the loop only ingests. */
const stateRepo = async (): Promise<{ root: string; statePath: string; origin: string }> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-intake-pass-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const statePath = join(root, "state");

  const setup = new Git(root);
  await setup.run("init", "--bare", "--initial-branch=main", origin);
  await setup.run("clone", origin, statePath);

  const git = new Git(statePath);
  await git.run("config", "user.name", "caterpillar");
  await git.run("config", "user.email", "caterpillar@example.invalid");
  await git.run("symbolic-ref", "HEAD", "refs/heads/main");
  await git.run("commit", "--quiet", "--allow-empty", "-m", "seed");
  await git.run("push", "--quiet", "origin", "HEAD:main");

  return { root, statePath, origin };
};

const configFor = (root: string, statePath: string, origin: string, runnerId: string): RunnerConfig => ({
  runnerId,
  capabilities: ["linux"],
  identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  toolchain: DEFAULT_TOOLCHAIN_CONFIG,
  stateRepo: { url: origin, branch: "main", path: statePath },
  paths: { mirrors: join(root, "mirrors"), tasks: join(root, "tasks"), root },
  workspace: { reap: DEFAULT_REAP_CONFIG },
  usage: DEFAULT_USAGE_CONFIG,
  lease: { heartbeatSeconds: 3600, staleAfterSeconds: 300 },
  handoff: { thresholdFraction: 0.7 },
  limits: {
    maxSessionsPerTask: 20,
    noProgressLimit: 3,
    maxReviewRounds: 3,
    maxSessionSeconds: 3600,
    commandTimeoutSeconds: 900,
    sabotageMaxCommands: 40,
    sabotageMinFreeGb: 5,
    ciSettleSeconds: 1200,
    ciPollSeconds: 30,
  },
  log: { level: "info" },
  intake: { intervalSeconds: 300 },
  llm: {
    auth: "proxy",
    baseUrl: "http://localhost",
    modelId: "test",
    providerId: "test",
    contextWindow: 100_000,
    maxTokens: 4096,
    cooldown: { initialSeconds: 30, maxSeconds: 60 },
  },
  workspaces: new Map(),
  pollSeconds: 1,
  // The default, stated. Every existing test describes a one-task-at-a-time runner and
  // must keep describing one — see DESIGN.md §6.4.
  concurrency: 1,
  housekeepingSeconds: 1,
  secretsDir: join(root, "secrets"),
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
    enabled: false,
    port: 8080,
    logCapacity: 500,
    refreshSeconds: 10,
    requireForwardedUser: false,
    forwardedUserHeader: "remote-user",
  },
});

const IDLE_RUNNER: SessionRunner = { run: () => Promise.reject(new Error("nothing to run")) };
const IDLE_VERIFIER: Verifier = {
  verify: () => Promise.resolve({ passed: false, detail: "unused" }),
};
const IDLE_PROGRESS: ProgressProbe = {
  probe: () =>
    Promise.resolve({ committed: false, acceptanceImproved: false, stepCompleted: false }),
};

const supervisorWith = (
  config: RunnerConfig,
  statePath: string,
  intake: Intake,
  intakeStatus: IntakeStatus,
): Supervisor => {
  const git = new Git(statePath);
  return new Supervisor({
    config,
    store: new StateStore(statePath, git),
    leases: new LeaseManager({
      git,
      remote: "origin",
      runner: asRunnerId(config.runnerId),
      staleAfterSeconds: config.lease.staleAfterSeconds,
    }),
    runner: IDLE_RUNNER,
    verifier: IDLE_VERIFIER,
    progress: IDLE_PROGRESS,
    notifier: new NullNotifier(),
    metrics: new AgentMetrics(),
    logger: SILENT_LOGGER,
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: join(config.paths.root, "tasks"),
      identity: config.identity,
    }),
    intake,
    intakeStatus,
  });
};

/** Run the loop until `done` says the test has what it came for, then stop it. */
const runUntil = async (supervisor: Supervisor, done: () => boolean): Promise<void> => {
  const controller = new AbortController();
  const running = supervisor.run(controller.signal);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !done()) await sleep(50);

  controller.abort();
  await running.catch(() => undefined);
};

const PASS: IntakePass = { seen: 3, created: 0, rejected: 1, failed: 0 };

test("the last intake pass is remembered where the web view can read it", async () => {
  // `IntakePass` was returned, logged once at info, and thrown away. `seen` is the field
  // that separates "nobody labelled anything" from "the tracker returned three items and
  // none became tasks", and it existed nowhere a human looks.
  const { root, statePath, origin } = await stateRepo();
  const status = new IntakeStatus();
  const config = configFor(root, statePath, origin, "caterpillar-1");

  await runUntil(
    supervisorWith(config, statePath, { ingest: () => Promise.resolve(PASS) }, status),
    () => status.current() !== undefined,
  );

  const recorded = status.current();
  assert.equal(recorded?.outcome, "ingested");
  assert.equal(recorded?.seen, 3);
  assert.equal(recorded?.rejected, 1);
  assert.equal(recorded?.runner, "caterpillar-1");
  assert.match(recorded?.ref ?? "", /^refs\/intake\/\d+$/);
  assert.ok(!Number.isNaN(Date.parse(recorded?.at ?? "")), "the pass is stamped with a time");
});

test("a runner that lost the interval's claim says so instead of reporting zeroes", async () => {
  // On a fleet of four, three runners skip every interval by design (`intakeRef`). A page
  // that showed them a pass of zero would report a working intake as a broken one, and one
  // that showed them nothing at all would say intake had never run.
  const { root, statePath, origin } = await stateRepo();

  const winner = new IntakeStatus();
  const first = configFor(root, statePath, origin, "caterpillar-1");
  await runUntil(
    supervisorWith(first, statePath, { ingest: () => Promise.resolve(PASS) }, winner),
    () => winner.current() !== undefined,
  );
  assert.equal(winner.current()?.outcome, "ingested");

  // A second checkout, standing in for a second replica in the same interval. The bucket
  // is wall-clock, so both compute the same ref and contend for one claim.
  const second = join(root, "state-2");
  await new Git(root).run("clone", origin, second);
  const secondGit = new Git(second);
  await secondGit.run("config", "user.name", "caterpillar");
  await secondGit.run("config", "user.email", "caterpillar@example.invalid");

  const loser = new IntakeStatus();
  let ingested = false;
  await runUntil(
    supervisorWith(
      configFor(root, second, origin, "caterpillar-2"),
      second,
      {
        ingest: () => {
          ingested = true;
          return Promise.resolve(PASS);
        },
      },
      loser,
    ),
    () => loser.current() !== undefined,
  );

  assert.equal(loser.current()?.outcome, "claimed-elsewhere");
  assert.equal(loser.current()?.seen, undefined, "no counts, because there was no pass");
  assert.equal(ingested, false, "the loser must not spend the fleet's request budget");
  assert.equal(loser.current()?.ref, winner.current()?.ref, "one bucket, one claim");
});

test("a pass that threw is recorded as a failure rather than as an empty tracker", async () => {
  const { root, statePath, origin } = await stateRepo();
  const status = new IntakeStatus();

  await runUntil(
    supervisorWith(
      configFor(root, statePath, origin, "caterpillar-1"),
      statePath,
      { ingest: () => Promise.reject(new Error("api.github.com is unreachable")) },
      status,
    ),
    () => status.current() !== undefined,
  );

  const recorded = status.current();
  assert.equal(recorded?.outcome, "failed");
  assert.match(recorded?.error ?? "", /unreachable/);
  // Absent rather than zero: a pass that threw part-way knows neither what it saw nor what
  // it would have refused, and zeroes would read as "the tracker had nothing to say".
  assert.equal(recorded?.seen, undefined);
});
