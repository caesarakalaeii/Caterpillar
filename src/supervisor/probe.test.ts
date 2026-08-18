/**
 * Regression tests for the progress probe's first-session blind spot.
 *
 * SMOKE-1 — the first task ever to run in-cluster — finished with
 * `noProgressStreak: 2` and `lastProgressSession: 0` despite having committed and
 * opened a PR. The probe proved a commit only by comparing against a head recorded at
 * the END of a previous session, so the very commit that starts the work could never
 * count. With `noProgressLimit: 3` that parks a productive task citing "no commit"
 * while a commit sits on the branch.
 *
 * Driven against real git, not a stub: the baseline is a fork point resolved out of the
 * mirror's own refs, and a stub that answers `merge-base` would prove nothing about
 * whether the layout actually yields one.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "../state/git.ts";
import {
  asTaskId,
  asWorkspaceName,
  EMPTY_USAGE,
  type ProgressRecord,
  type RepoRef,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import { WorktreeManager } from "../workspace/worktree.ts";
import { GitProgressProbe } from "./probe.ts";

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
const TASK = asTaskId("PROBE-1");
const roots: string[] = [];

/**
 * Git that cannot see the operator's global or system config.
 *
 * Without this the test silently borrows whatever the workstation has — identity,
 * `commit.gpgsign`, `url.<...>.insteadOf` — and passes or fails for reasons unrelated to
 * the code. That is not hypothetical: the first version of these tests committed without
 * setting an identity, passed here, and failed in CI with `Author identity unknown`,
 * because a runner has no global git config at all. Hermetic is the only honest default.
 */
const HERMETIC: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const spec: TaskSpec = {
  id: TASK,
  workspace: asWorkspaceName("test"),
  goal: "irrelevant to the probe",
  repos: [REPO],
  requires: ["linux"],
  acceptance: [],
};

const stateWith = (progress: ProgressRecord): TaskState => ({
  id: TASK,
  status: "running",
  phase: "implementing",
  requires: ["linux"],
  sessions: progress.lastProgressSession,
  limits: { maxSessions: 5 },
  usage: EMPTY_USAGE,
  progress,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
});

/**
 * A real mirror and a real linked worktree on `agent/<task>`, in the exact layout
 * `WorktreeManager` expects — built with raw git so the probe is the only code under
 * test. The upstream is a local path, so nothing touches the network.
 */
const fixture = async (): Promise<{ root: string; worktree: string; git: Git }> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-probe-"));
  roots.push(root);

  const origin = join(root, "origin.git");
  const mirror = join(root, "mirrors", REPO.host, REPO.owner, `${REPO.name}.git`);
  const worktree = join(root, "tasks", TASK, REPO.name);
  const plain = new Git(root, HERMETIC);

  await plain.run("init", "--quiet", "--bare", "--initial-branch=main", origin);

  // Seed one commit on the default branch, which becomes the branch point.
  const seed = join(root, "seed");
  await plain.run("clone", "--quiet", origin, seed);
  const seeded = plain.at(seed);
  await seeded.run("config", "user.email", "seed@example.invalid");
  await seeded.run("config", "user.name", "seed");
  await seeded.run("commit", "--quiet", "--allow-empty", "-m", "base");
  await seeded.run("push", "--quiet", "origin", "main");

  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--quiet", "--mirror", origin, mirror);
  await mkdir(join(worktree, ".."), { recursive: true });
  await plain
    .at(mirror)
    .run("worktree", "add", "--quiet", "-b", `agent/${TASK}`, worktree, "main");

  // The real worktree gets its identity from `WorktreeManager.configure`; this fixture
  // builds the layout with raw git, so it must supply one itself.
  const git = plain.at(worktree);
  await git.run("config", "user.email", "agent@example.invalid");
  await git.run("config", "user.name", "agent");

  return { root, worktree, git };
};

const probeFor = (root: string): GitProgressProbe =>
  new GitProgressProbe({
    worktrees: new WorktreeManager({
      git: new Git(root, HERMETIC),
      mirrorsDir: join(root, "mirrors"),
      tasksDir: join(root, "tasks"),
      helperPath: "/usr/local/bin/caterpillar-cred",
      socketDir: "/run/caterpillar/cred",
      identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
    }),
  });

const commit = async (git: Git, message: string): Promise<string> => {
  await git.run("commit", "--quiet", "--allow-empty", "-m", message);
  return git.run("rev-parse", "HEAD");
};

test("a commit made during the FIRST session counts as progress", async () => {
  // The SMOKE-1 bug. There is no `lastHeadOid` yet, so the old probe returned
  // committed:false and the task's first productive session was recorded as a stall.
  const { root, git } = await fixture();
  const head = await commit(git, "the work");

  const evidence = await probeFor(root).probe(
    spec,
    stateWith({ lastProgressSession: 0, noProgressStreak: 0 }),
  );

  assert.equal(evidence.committed, true, "a first-session commit must count as progress");
  assert.equal(evidence.headOid, head, "the observed head is carried as the next baseline");
});

test("the reported baseline is the fork point on a first session", async () => {
  // The probe reports what it compared against, so a "no progress" park can be told
  // apart from a probe that compared against the wrong commit. Reporting
  // `state.progress.lastHeadOid` instead would log `undefined` in precisely the case
  // that went wrong.
  const { root, git } = await fixture();
  const forkPoint = await git.run("rev-parse", "HEAD");
  await commit(git, "the work");

  const evidence = await probeFor(root).probe(
    spec,
    stateWith({ lastProgressSession: 0, noProgressStreak: 0 }),
  );

  assert.equal(evidence.baselineOid, forkPoint);
});

test("a FIRST session that commits nothing does not count as progress", async () => {
  // The other half of the fix, and the reason it cannot simply assume progress when no
  // baseline exists: a first session that achieved nothing must still be a stall, or
  // the thrash detector never fires on a task that fails from its very first session.
  const { root, git } = await fixture();
  const head = await git.run("rev-parse", "HEAD");

  const evidence = await probeFor(root).probe(
    spec,
    stateWith({ lastProgressSession: 0, noProgressStreak: 0 }),
  );

  assert.equal(evidence.committed, false, "no commit on the branch is not progress");
  assert.equal(evidence.headOid, head);
});

test("a later session is measured against the previous session's head", async () => {
  // Per-session semantics must survive the fix. Comparing against the fork point
  // forever would mean that once ANY commit exists every later session looks
  // productive, and an agent that commits once and then spins would never park.
  const { root, git } = await fixture();
  const first = await commit(git, "session one");

  const unchanged = await probeFor(root).probe(
    spec,
    stateWith({ lastProgressSession: 1, noProgressStreak: 0, lastHeadOid: first }),
  );
  assert.equal(
    unchanged.committed,
    false,
    "a session that adds no commit is a stall even though the branch has commits",
  );

  const second = await commit(git, "session two");
  const advanced = await probeFor(root).probe(
    spec,
    stateWith({ lastProgressSession: 1, noProgressStreak: 1, lastHeadOid: first }),
  );
  assert.equal(advanced.committed, true);
  assert.equal(advanced.headOid, second);
});
