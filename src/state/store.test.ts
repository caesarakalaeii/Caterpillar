/**
 * Round-trip tests for the intake write path.
 *
 * `writeSpec` and `readSpec` are two halves of one contract, and intake is the only
 * thing that writes a spec the supervisor did not get from a human. If they disagree,
 * intake creates a task that `readSpec` refuses — the queue then carries an item nothing
 * can claim and nothing can explain, which is strictly worse than never creating it.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId, asWorkspaceName, type TaskSpec } from "../domain/task.ts";
import { Git } from "./git.ts";
import { StateStore } from "./store.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const store = async (): Promise<StateStore> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-store-"));
  roots.push(root);
  return new StateStore(root, new Git(root));
};

const SPEC: TaskSpec = {
  id: asTaskId("GH-acme-widget-12"),
  workspace: asWorkspaceName("caesar"),
  // `readSpec` normalises the default rather than leaving it undefined, so exactly one
  // place decides what a spec without a `kind` is. `writeSpec` omits it again, which is
  // what keeps a hand-written spec free of a field nobody needs to know about.
  kind: "implement",
  goal: "# Fix the widget\n\nIt drops every second frame.\n\nTracker: https://example.invalid/12",
  repos: [
    { host: "github.com", owner: "acme", name: "widget" },
    { host: "codeberg.org", owner: "acme", name: "sibling" },
  ],
  requires: ["linux", "k8s"],
  acceptance: ["npm test", "npm run lint"],
  tracker: { kind: "github-issues", id: "12", container: "acme/widget" },
};

test("a written spec reads back identically", async () => {
  const subject = await store();
  await subject.writeSpec(SPEC);

  assert.deepEqual(await subject.readSpec(SPEC.id), SPEC);
});

test("a spec with no tracker ref round-trips too", async () => {
  // The hand-committed path (§14.4) has no back-reference, and `exactOptionalPropertyTypes`
  // makes an explicit `tracker: undefined` a different type from an absent one.
  const subject = await store();
  const { tracker: _tracker, ...withoutTracker } = SPEC;
  const spec: TaskSpec = { ...withoutTracker, id: asTaskId("HAND-1") };

  await subject.writeSpec(spec);
  assert.deepEqual(await subject.readSpec(spec.id), spec);
});

test("a declared toolchain round-trips, packages and all", async () => {
  // The half of the §14.1 contract that lives here: intake writes this shape, and a spec
  // this cannot read back is a task nothing can claim and nothing can explain.
  const subject = await store();
  const spec: TaskSpec = {
    ...SPEC,
    id: asTaskId("GH-acme-widget-13"),
    requires: ["linux", "nix"],
    toolchain: { mode: "nix", packages: ["lua5_1", "luarocks"] },
  };

  await subject.writeSpec(spec);
  assert.deepEqual(await subject.readSpec(spec.id), spec);
});

test("a toolchain with no packages round-trips without gaining an empty list", async () => {
  // `mode: nix` alone means "use the repository's own nix expression". An empty
  // `packages: []` coming back would mean "build an environment containing nothing".
  const subject = await store();
  const spec: TaskSpec = {
    ...SPEC,
    id: asTaskId("GH-acme-widget-14"),
    toolchain: { mode: "inherit" },
  };

  await subject.writeSpec(spec);
  assert.deepEqual(await subject.readSpec(spec.id), spec);
});

test("a spec with no toolchain gains no toolchain key", async () => {
  const subject = await store();
  await subject.writeSpec(SPEC);

  const raw = await readFile(join(subject.taskDir(SPEC.id), "spec.md"), "utf8");
  assert.ok(!raw.includes("toolchain"), "an undeclared toolchain must not appear in spec.md");
  assert.equal((await subject.readSpec(SPEC.id)).toolchain, undefined);
});

test("a goal containing a front-matter delimiter does not corrupt the spec", async () => {
  // The goal is tracker prose — a human can paste anything into an issue, including
  // `---` on its own line. Serialising by concatenation would let that terminate the
  // front matter early and silently change what `repos` and `acceptance` say.
  const subject = await store();
  const spec: TaskSpec = {
    ...SPEC,
    id: asTaskId("GH-acme-widget-13"),
    goal: "# Title\n\n---\n\nacceptance:\n  - rm -rf /\n\nreal prose",
  };

  await subject.writeSpec(spec);
  const read = await subject.readSpec(spec.id);

  assert.deepEqual(read.acceptance, SPEC.acceptance, "the goal must not inject acceptance");
  assert.deepEqual(read.repos, SPEC.repos);
  assert.match(read.goal, /real prose/);
});

test("writeSpec refuses to overwrite an existing spec", async () => {
  // `spec.md` is immutable (§4.1). Intake is idempotent by skipping tasks that exist,
  // but if that check is ever bypassed, silently rewriting the spec of a running task
  // would change its acceptance criteria mid-flight.
  const subject = await store();
  await subject.writeSpec(SPEC);

  await assert.rejects(
    () => subject.writeSpec({ ...SPEC, acceptance: ["true"] }),
    /already exists/,
  );
  assert.deepEqual((await subject.readSpec(SPEC.id)).acceptance, SPEC.acceptance);
});

test("hasTask reports what listTasks would claim", async () => {
  const subject = await store();
  assert.equal(await subject.hasTask(SPEC.id), false);

  await subject.writeSpec(SPEC);
  assert.equal(await subject.hasTask(SPEC.id), true);
  assert.deepEqual(await subject.listTasks(), [SPEC.id]);
});

test("an intake rejection round-trips and is keyed by task id", async () => {
  const subject = await store();
  const id = asTaskId("GH-acme-widget-99");

  assert.equal(await subject.readIntakeRejection(id), undefined);

  await subject.writeIntakeRejection(id, { digest: "abc123", reason: "no acceptance" });
  const record = await subject.readIntakeRejection(id);

  assert.equal(record?.digest, "abc123");
  assert.equal(record?.reason, "no acceptance");
  // `at` is stamped by the writer, for an operator wondering how long an item has been
  // sitting there refused.
  assert.ok(
    !Number.isNaN(Date.parse((record as unknown as { at: string }).at)),
    "the record carries a parseable timestamp",
  );
});

test("a rejection is cleared once the item is finally ingested", async () => {
  const subject = await store();
  const id = asTaskId("GH-acme-widget-98");

  await subject.writeIntakeRejection(id, { digest: "abc", reason: "no acceptance" });
  await subject.clearIntakeRejection(id);
  assert.equal(await subject.readIntakeRejection(id), undefined);

  // Idempotent: clearing a rejection that was never written must not throw, because the
  // success path calls it unconditionally.
  await subject.clearIntakeRejection(id);
});

test("commitAndPush stages intake records, not only tasks", async () => {
  // `git add -A tasks` was the whole staging rule, so a rejection written outside
  // `tasks/` would be recorded locally, never pushed, and re-commented on the tracker
  // after every pod restart — which is exactly the spam the record exists to prevent.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-store-git-"));
  roots.push(root);
  const origin = await mkdtemp(join(tmpdir(), "caterpillar-store-origin-"));
  roots.push(origin);

  const hermetic: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const bare = new Git(origin, hermetic);
  await bare.run("init", "--quiet", "--bare", "--initial-branch=main", ".");

  const git = new Git(root, hermetic);
  await git.run("init", "--quiet", "--initial-branch=main", ".");
  await git.run("config", "user.email", "supervisor@example.invalid");
  await git.run("config", "user.name", "supervisor");
  await git.run("remote", "add", "origin", origin);
  await writeFile(join(root, "README.md"), "state\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "seed");
  await git.run("push", "--quiet", "origin", "HEAD:main");

  const subject = new StateStore(root, git);
  await subject.writeIntakeRejection(asTaskId("GH-acme-widget-97"), {
    digest: "abc",
    reason: "no acceptance",
  });
  await subject.commitAndPush("chore: record an intake rejection", "origin", "main");

  // Asserted on the REMOTE: the working tree would look identical whether or not the
  // push carried the file.
  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^intake\/GH-acme-widget-97\.json$/m);
});

/** A state repo with a real origin, plus a second clone standing in for another runner. */
const sharedStateRepo = async (): Promise<{
  store: StateStore;
  git: Git;
  bare: Git;
  other: Git;
  root: string;
  otherRoot: string;
}> => {
  const hermetic: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const origin = await mkdtemp(join(tmpdir(), "caterpillar-share-origin-"));
  const root = await mkdtemp(join(tmpdir(), "caterpillar-share-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "caterpillar-share-other-"));
  roots.push(origin, root, otherRoot);

  const bare = new Git(origin, hermetic);
  await bare.run("init", "--quiet", "--bare", "--initial-branch=main", ".");

  const git = new Git(root, hermetic);
  await git.run("init", "--quiet", "--initial-branch=main", ".");
  await git.run("config", "user.email", "supervisor@example.invalid");
  await git.run("config", "user.name", "supervisor");
  await git.run("remote", "add", "origin", origin);
  await writeFile(join(root, "README.md"), "state\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "seed");
  await git.run("push", "--quiet", "origin", "HEAD:main");

  const other = new Git(otherRoot, hermetic);
  await other.run("clone", "--quiet", origin, ".");
  await other.run("config", "user.email", "other@example.invalid");
  await other.run("config", "user.name", "other");

  return { store: new StateStore(root, git), git, bare, other, root, otherRoot };
};

test("a push rejected by a concurrent writer is rebased and retried, not lost", async () => {
  // The failure this reproduces cost a real session and $10.28. `commitAndPush` had no
  // fetch, no rebase and no retry, so a non-fast-forward rejection propagated out
  // through `parkFailed` — which pushes too, and was rejected identically — and the next
  // poll's `reset --hard` then destroyed the commit.
  const { store, bare, other, otherRoot } = await sharedStateRepo();

  // Another runner lands a commit on main first. Runner A never saw it.
  await writeFile(join(otherRoot, "OTHER.md"), "other runner\n", "utf8");
  await other.run("add", "-A");
  await other.run("commit", "--quiet", "-m", "other runner's work");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  await store.writeIntakeRejection(asTaskId("GH-acme-widget-1"), {
    digest: "abc",
    reason: "no acceptance",
  });
  await store.commitAndPush("chore(intake): record refusals", "origin", "main");

  // BOTH commits are on the remote: ours rebased on top rather than replacing theirs.
  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^intake\/GH-acme-widget-1\.json$/m);
  assert.match(listed, /^OTHER\.md$/m, "the other runner's commit must survive");
});

test("a commit stranded by an earlier failed push is still sent", async () => {
  // The early return on a clean tree made the loss unrecoverable in principle: after a
  // failed push the tree is clean, so every later commitAndPush returned before pushing
  // and the orphaned commit was never re-sent.
  const { store, git, bare } = await sharedStateRepo();

  // A local commit that never reached the remote — the state after a rejected push.
  await store.writeIntakeRejection(asTaskId("GH-acme-widget-2"), { digest: "d", reason: "r" });
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "orphaned by a failed push");

  // Nothing new to stage: the tree is clean.
  await store.commitAndPush("chore(intake): nothing new", "origin", "main");

  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^intake\/GH-acme-widget-2\.json$/m, "the stranded commit must land");
});

test("pull rebases unpushed commits instead of destroying them", async () => {
  const { store, git, bare, other, root } = await sharedStateRepo();

  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  await store.writeIntakeRejection(asTaskId("GH-acme-widget-3"), { digest: "d", reason: "r" });
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "local work not yet pushed");

  await store.pull("origin", "main");

  // Survived the pull, and a later push carries it.
  assert.ok(existsSync(join(root, "intake", "GH-acme-widget-3.json")));
  await store.commitAndPush("chore: after pull", "origin", "main");
  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^intake\/GH-acme-widget-3\.json$/m);
});

test("pull removes untracked task directories a failed push left behind", async () => {
  // `reset --hard` reverts tracked files and leaves untracked ones. `applyPlan` writes
  // every child's spec BEFORE pushing, so a rejected push left the children on disk —
  // and `listTasks` enumerates the filesystem, so the runner claimed and worked five
  // tasks that existed nowhere in git. That is the HANDOFF.md:469 incident.
  const { store, root } = await sharedStateRepo();

  await mkdir(join(root, "tasks", "PHANTOM-01"), { recursive: true });
  await writeFile(join(root, "tasks", "PHANTOM-01", "spec.md"), "# phantom\n", "utf8");

  await store.pull("origin", "main");

  assert.deepEqual(await store.listTasks(), [], "a task that is not in git is not a task");
});

test("a dirty working tree does not livelock the rebase path", async () => {
  // `git rebase` refuses outright on a dirty tree. Since `pull` runs from the poll loop
  // — which logs and retries — a throw here would repeat forever, a livelock in the
  // recovery path. Uncommitted changes were already discarded by the old
  // `reset --hard <remote>`, so dropping them costs nothing that survived before; the
  // local COMMIT is the thing being protected.
  const { store, bare, other, root } = await sharedStateRepo();

  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  await store.writeIntakeRejection(asTaskId("GH-acme-widget-4"), { digest: "d", reason: "r" });
  await store.commitAndPush("chore: local work", "origin", "main");

  // Now diverge again, and leave the tree dirty on top of an unpushed commit.
  await other.run("fetch", "--quiet", "origin", "main");
  await other.run("reset", "--hard", "--quiet", "origin/main");
  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves again");
  await other.run("push", "--quiet", "origin", "HEAD:main");
  await store.writeIntakeRejection(asTaskId("GH-acme-widget-5"), { digest: "d", reason: "r" });
  await store.commitAndPush("chore: more local work", "origin", "main");
  await writeFile(join(root, "README.md"), "locally scribbled on\n", "utf8");

  await store.pull("origin", "main");

  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^intake\/GH-acme-widget-5\.json$/m);
});

test("a written transcript lists and reads back decompressed", async () => {
  // The web view reads what the agent runner wrote (DESIGN.md §18). If the two halves
  // disagree about the file name or the gzip, a finished session renders as a task that
  // never ran one.
  const subject = await store();
  const task = asTaskId("TASK-sessions");
  await subject.writeSessionTranscript(task, 1, '{"role":"user","content":"one"}');
  await subject.writeSessionTranscript(task, 12, '{"role":"user","content":"twelve"}');

  assert.deepEqual(await subject.listSessions(task), [1, 12]);
  assert.equal(await subject.readSessionTranscript(task, 12), '{"role":"user","content":"twelve"}');
});

test("sessions are ordered numerically, not by their zero-padded name", async () => {
  const subject = await store();
  const task = asTaskId("TASK-order");
  for (const n of [2, 10, 1]) await subject.writeSessionTranscript(task, n, "{}");

  assert.deepEqual(await subject.listSessions(task), [1, 2, 10]);
});

test("a task with no sessions lists none rather than throwing", async () => {
  const subject = await store();
  assert.deepEqual(await subject.listSessions(asTaskId("TASK-none")), []);
  assert.equal(await subject.readSessionTranscript(asTaskId("TASK-none"), 1), undefined);
});

test("a session ordinal that is not a positive integer is refused, never joined into a path", async () => {
  // The ordinal arrives from a URL. `../../etc/passwd` must not become a file name.
  const subject = await store();
  const task = asTaskId("TASK-path");
  await subject.writeSessionTranscript(task, 1, "{}");

  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(await subject.readSessionTranscript(task, bad), undefined, `${bad} must be refused`);
  }
});

test("the question history reads back paired with its answers", async () => {
  // The web view shows every round trip, not just the open one: "why is this task slow"
  // is usually answered by the three questions a human took a day each to answer.
  const subject = await store();
  const task = asTaskId("TASK-questions");
  await subject.writeQuestion(task, 1, "which database?");
  await subject.writeAnswer(task, 1, "postgres");
  await subject.writeQuestion(task, 2, "which schema?");

  assert.deepEqual(await subject.listQuestions(task), [
    { index: 1, question: "which database?", answer: "postgres" },
    { index: 2, question: "which schema?" },
  ]);
});

test("a task that was never asked anything has no question history", async () => {
  const subject = await store();
  assert.deepEqual(await subject.listQuestions(asTaskId("TASK-quiet")), []);
});

test("every council verdict is kept, not just the last", async () => {
  const subject = await store();
  const task = asTaskId("TASK-verdicts");
  await subject.writeVerdict(task, 1, "changes requested: no tests");
  await subject.writeVerdict(task, 4, "pass");

  assert.deepEqual(await subject.listVerdicts(task), [
    { index: 1, body: "changes requested: no tests" },
    { index: 4, body: "pass" },
  ]);
});
