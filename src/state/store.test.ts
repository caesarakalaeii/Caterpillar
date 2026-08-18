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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  asTaskId,
  asWorkspaceName,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import { EMPTY_POLICY, lookupPolicy, PolicyParseError } from "../remediation/policy.ts";
import { Git } from "./git.ts";
import { type SalvagedCommits, StateStore } from "./store.ts";

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
  /** A store on the SECOND checkout, writing as a different runner. */
  otherStore: StateStore;
  /** Every salvage the first store reported, in order — what feeds the metric and log. */
  salvaged: SalvagedCommits[];
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

  // The hook is captured rather than discarded: it is the ONLY way a salvage becomes
  // visible — the runner recovers and carries on, so `caterpillar_salvaged_commits_total`
  // and the `state.salvaged` error line are all an operator ever sees (§4.3).
  const salvaged: SalvagedCommits[] = [];

  return {
    store: new StateStore(root, git, (event) => salvaged.push(event), "runner-a"),
    git,
    bare,
    other,
    otherStore: new StateStore(otherRoot, other, undefined, "runner-b"),
    salvaged,
    root,
    otherRoot,
  };
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

test("a `kind: remediation` spec round-trips through writeSpec and readSpec", async () => {
  // `writeSpec` omits `kind` when it is the default, and losing it here would silently
  // turn an alert-driven task back into an ordinary implementation task on the way in —
  // which means the wrong system prompt, and a session never told the cluster is
  // read-only evidence (DESIGN.md §20).
  const subject = await store();
  const spec: TaskSpec = {
    ...SPEC,
    id: asTaskId("ALERT-a1b2c3d4e5f60718"),
    kind: "remediation",
  };

  await subject.writeSpec(spec);
  assert.deepEqual(await subject.readSpec(spec.id), spec);
  // Not merely equal after a round trip: the field must actually be on disk, because
  // `readSpec` defaults an absent `kind` to `implement` and would answer the same.
  assert.match(
    await readFile(join(subject.taskDir(spec.id), "spec.md"), "utf8"),
    /^kind: remediation$/m,
  );
});

test("a remediation spec with no acceptance commands is refused", async () => {
  // The brainstorm exemption is NOT widened to remediation. An alert-driven task ends in
  // a pull request like any other, so §12 applies unchanged: with nothing the supervisor
  // can run, the task could be created and never closed.
  const subject = await store();
  const task = asTaskId("ALERT-deadbeef");
  await mkdir(join(subject.taskDir(task)), { recursive: true });
  await writeFile(
    join(subject.taskDir(task), "spec.md"),
    [
      "---",
      "workspace: caesar",
      "kind: remediation",
      "repos:",
      "  - github.com/acme/widget",
      "acceptance: []",
      "---",
      "",
      "# CaterpillarNoProgress is firing",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(subject.readSpec(task), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /acceptance/);
    assert.match(error.message, /at least one command/);
    return true;
  });

  // The same document as a brainstorm IS accepted, which is what proves the refusal above
  // is about the kind rather than about the shape of the front matter.
  const brainstorm = asTaskId("BS-1234-01");
  await mkdir(join(subject.taskDir(brainstorm)), { recursive: true });
  await writeFile(
    join(subject.taskDir(brainstorm), "spec.md"),
    ["---", "workspace: caesar", "kind: brainstorm", "repos:", "  - github.com/acme/widget", "---", "", "# an idea", ""].join("\n"),
    "utf8",
  );
  assert.deepEqual((await subject.readSpec(brainstorm)).acceptance, []);
});

test("readAlertPolicy on a state repo with no alerts/ returns an empty policy", async () => {
  // The poll loop calls this every cycle. Most state repos have never heard of alerts, so
  // a throw here would turn "this cluster has not opted in" into a supervisor logging a
  // failure every 30 seconds (DESIGN.md §20).
  const subject = await store();

  assert.deepEqual(await subject.readAlertPolicy(), EMPTY_POLICY);
});

test("readAlertPolicy parses an operator-authored policy, and still throws on a bad one", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-policy-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root));
  const path = join(root, "alerts", "policy.yaml");
  await mkdir(join(root, "alerts"), { recursive: true });
  await writeFile(
    path,
    [
      "version: 1",
      "alerts:",
      "  - alertname: CaterpillarNoProgress",
      "    workspace: caesar",
      "    repos:",
      "      - github.com/acme/widget",
      "    acceptance:",
      "      - npm test",
      "",
    ].join("\n"),
    "utf8",
  );

  const policy = await subject.readAlertPolicy();
  assert.equal(policy.entries.length, 1);
  assert.deepEqual(lookupPolicy(policy, "CaterpillarNoProgress")?.acceptance, ["npm test"]);

  // A file that exists and does not parse is an operator mistake and must stay visible —
  // the missing-file leniency above must not swallow it.
  await writeFile(path, "version: 9\nalerts: []\n", "utf8");
  await assert.rejects(subject.readAlertPolicy(), PolicyParseError);
});

test("an alert refusal record persists, carries its alertname, and clears", async () => {
  const subject = await store();
  const fingerprint = "a1b2c3d4e5f60718";

  assert.equal(await subject.readAlertRefusal(fingerprint), undefined);

  await subject.writeAlertRefusal(fingerprint, {
    fingerprint,
    alertname: "CaterpillarNoProgress",
    reason: "no policy entry",
  });
  const record = await subject.readAlertRefusal(fingerprint);

  assert.equal(record?.reason, "no policy entry");
  // The alertname is STORED, not derived: a fingerprint is a hash, so `maxOpenTasks`
  // could not otherwise tell which alert the task `ALERT-<fingerprint>` belongs to (§20).
  assert.equal(record?.alertname, "CaterpillarNoProgress");
  assert.ok(
    !Number.isNaN(Date.parse(record?.at ?? "")),
    "the record carries a parseable timestamp",
  );

  await subject.clearAlertRefusal(fingerprint);
  assert.equal(await subject.readAlertRefusal(fingerprint), undefined);
  // Idempotent, like `clearIntakeRejection`: the success path clears unconditionally.
  await subject.clearAlertRefusal(fingerprint);
});

test("a fingerprint that is not one is never joined into a path", async () => {
  // The fingerprint arrives in an HTTP body from outside the process and becomes a file
  // name. `..` is a legal directory name that resolves out of `alerts/`.
  const subject = await store();

  for (const bad of ["../../etc/passwd", "..", ".", "A1B2", "a1b2/c3"]) {
    await assert.rejects(
      subject.writeAlertRefusal(bad, { fingerprint: bad, alertname: "X", reason: "r" }),
      /not an alert fingerprint/,
      `'${bad}' must be refused`,
    );
    assert.equal(await subject.readAlertRefusal(bad), undefined);
  }
});

test("open tasks are counted per alertname using the one notion of terminal", async () => {
  // `maxOpenTasks` exists so an alert that keeps firing while a fix is in review does not
  // open a second task saying the same thing. It counts by joining `alerts/refusals/` to
  // `tasks/` rather than by parsing ids, because a fingerprint does not carry its name.
  const subject = await store();

  const record = async (
    fingerprint: string,
    alertname: string,
    status: TaskState["status"],
  ): Promise<void> => {
    const task = asTaskId(`ALERT-${fingerprint}`);
    await subject.writeAlertRefusal(fingerprint, { fingerprint, alertname, task, reason: "opened" });
    await subject.writeState({
      id: task,
      status,
      phase: "implementing",
      requires: [],
      sessions: 0,
      limits: { maxSessions: 20 },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      progress: { lastProgressSession: 0, noProgressStreak: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  await record("aa01", "CaterpillarNoProgress", "running");
  await record("aa02", "CaterpillarNoProgress", "ready");
  // `done`, `failed` and `parked` are all terminal (`isTerminal`), deliberately reusing
  // the supervisor's single definition rather than inventing a second one here. A parked
  // task is waiting on a human, and a fresh firing is exactly the nudge that should be
  // allowed to open a new task rather than be suppressed by one nobody is working on.
  await record("aa03", "CaterpillarNoProgress", "done");
  await record("aa04", "CaterpillarNoProgress", "parked");
  await record("aa05", "CaterpillarNoProgress", "failed");
  await record("bb01", "CaterpillarPodCrashLooping", "running");

  assert.equal(await subject.countOpenAlertTasks("CaterpillarNoProgress"), 2);
  assert.equal(await subject.countOpenAlertTasks("CaterpillarPodCrashLooping"), 1);
  assert.equal(await subject.countOpenAlertTasks("SomethingElse"), 0);

  // A record naming a task that no longer exists contributes nothing, so deleting a task
  // by hand frees its slot rather than wedging the alert forever.
  await subject.writeAlertRefusal("cc01", {
    fingerprint: "cc01",
    alertname: "CaterpillarNoProgress",
    task: asTaskId("ALERT-cc01"),
    reason: "opened",
  });
  assert.equal(await subject.countOpenAlertTasks("CaterpillarNoProgress"), 2);
});

test("commitAndPush stages alert records, and pull sweeps unpushed ones", async () => {
  // Two halves of one rule. Without `alerts` in the `git add` list a refusal is recorded
  // locally and never pushed — so Keel rolls the pod and the alert is re-notified, which
  // is the spam the record exists to prevent. Without it in the `git clean` list a
  // refusal whose commit never landed silences the alert on this runner while existing
  // nowhere in git, which no operator can see and no other runner agrees with (§20).
  const { store: subject, bare, other, root } = await sharedStateRepo();

  await subject.writeAlertRefusal("a1b2c3", {
    fingerprint: "a1b2c3",
    alertname: "CaterpillarNoProgress",
    reason: "no policy entry",
  });
  await subject.commitAndPush("chore(alerts): record a refusal", "origin", "main");

  // Asserted on the REMOTE: the working tree looks identical either way.
  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^alerts\/refusals\/a1b2c3\.json$/m);

  // Now force the reset path, with a refusal on disk that reached no commit. The other
  // clone has to catch up first, or its push is the one that gets rejected.
  await other.run("pull", "--quiet", "--ff-only", "origin", "main");
  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");
  await subject.writeAlertRefusal("ff9900", {
    fingerprint: "ff9900",
    alertname: "CaterpillarPodCrashLooping",
    reason: "no policy entry",
  });

  // The pull DECLINES, because that write has not been committed yet and the sweep cannot
  // tell it apart from a session's half-written state (see `pull`). It is not a weakening
  // of the rule below — it is the rule arriving one commit later.
  assert.equal(
    await subject.pull("origin", "main"),
    "skipped",
    "a pull must not sweep a write that has not reached a commit yet",
  );
  assert.ok(existsSync(join(root, "alerts", "refusals", "ff9900.json")));

  // Now the case the sweep is actually FOR: an untracked leftover that no write of this
  // store's produced, so nothing marked the tree dirty — an `applyPlan` whose push was
  // rejected and whose commit was then salvaged away, or a pod that died between the two.
  // Written past the store on purpose: going through `writeAlertRefusal` again would set
  // the flag and, correctly, defer the pull once more.
  await subject.commitAndPush("chore(alerts): record the second refusal", "origin", "main");
  await rm(join(root, "alerts", "refusals", "ff9900.json"));
  await subject.commitAndPush("chore(alerts): withdraw it again", "origin", "main");
  await writeFile(
    join(root, "alerts", "refusals", "ff9900.json"),
    '{"fingerprint":"ff9900","alertname":"CaterpillarPodCrashLooping","reason":"orphaned"}\n',
    "utf8",
  );

  assert.equal(await subject.pull("origin", "main"), "pulled");
  assert.equal(
    existsSync(join(root, "alerts", "refusals", "ff9900.json")),
    false,
    "an unpushed refusal must not outlive the branch it was written on",
  );
  // The pushed one is tracked, so the sweep leaves it alone.
  assert.ok(existsSync(join(root, "alerts", "refusals", "a1b2c3.json")));
});

test("a local commit that can never rebase is salvaged, not retried forever", async () => {
  // The failure this closes, observed on a four-replica fleet within minutes of it
  // existing. Two runners recorded the SAME task's session — one had its push refused
  // during a GitHub outage and kept the commit locally, another took the task over and
  // pushed its own — and `journal.md` is append-only, so the two appends conflict on the
  // same line and no rebase can ever apply.
  //
  // `pull` threw, `pollOnce` logged `poll.failed`, and thirty seconds later it tried the
  // identical rebase again. Two of the four runners sat in that loop indefinitely,
  // claiming nothing, draining no chat, healthy to every probe. A restart does not help:
  // the commit is on the volume.
  //
  // Resetting unconditionally is not the answer either — `pull` used to do exactly that
  // and it destroyed five tasks' worth of work (see the note on `pull`). So the commits
  // are moved aside to a ref and the runner carries on: nothing is lost, and a human has
  // something to look at.
  const { store, git, other, salvaged, root, otherRoot } = await sharedStateRepo();

  // Both writers append a different line to the same file. Append-only plus two authors
  // is precisely the shape that cannot merge.
  await writeFile(join(otherRoot, "journal.md"), "**Exit:** done-claimed — theirs\n", "utf8");
  await other.run("add", "-A");
  await other.run("commit", "--quiet", "-m", "theirs");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  await writeFile(join(root, "journal.md"), "**Exit:** error — ours\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "ours");
  const stranded = await git.run("rev-parse", "HEAD");

  // Must not throw: throwing is what wedged the runner.
  await store.pull("origin", "main");

  assert.equal(
    await git.run("rev-parse", "HEAD"),
    await git.run("rev-parse", "origin/main"),
    "the runner must end up on the remote, able to poll again",
  );
  assert.equal(
    (await git.tryRun("rev-parse", "--verify", `refs/salvaged/${stranded.slice(0, 12)}`)).stdout.trim(),
    stranded,
    "and the commit it could not merge must still exist somewhere",
  );

  // A silent salvage is the failure mode this hook exists to prevent: the runner recovers,
  // so without it an operator never learns the fleet disagreed about a task. This is the
  // path that increments `caterpillar_salvaged_commits_total` and logs `state.salvaged`.
  assert.equal(salvaged.length, 1, "the salvage must be reported, not swallowed");
  assert.equal(salvaged[0]?.commit, stranded);
  assert.equal(salvaged[0]?.ref, `refs/salvaged/${stranded.slice(0, 12)}`);
  assert.notEqual(salvaged[0]?.detail, "", "git's own account of the conflict is carried");
  // Not mid-rebase: a checkout left in one fails every later git call with a message
  // about the rebase rather than about the conflict.
  assert.equal((await git.tryRun("rev-parse", "--verify", "REBASE_HEAD")).code !== 0, true);
});

/*
 * The journal, sharded (DESIGN.md §4.1).
 *
 * These tests exist because of one incident: two runners recorded the same task, both
 * appended to a single `journal.md`, and the loser's commit could never be rebased on.
 * The shape of the file is the fix, so the shape of the file is what is asserted.
 */

test("each journal entry lands as its own file, and readJournal puts them back in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-journal-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root), undefined, "pod-7f3a");
  const task = asTaskId("JOURNAL-1");

  await subject.appendJournal(task, 1, "Started the widget.");
  await subject.appendJournal(task, 2, "Finished the widget.");
  await subject.appendJournal(task, 10, "Opened the PR.");

  const shards = (await readdir(join(root, "tasks", task, "journal"))).sort();
  assert.equal(shards.length, 3, "one file per entry — that is the whole point");
  assert.equal(
    existsSync(join(root, "tasks", task, "journal.md")),
    false,
    "and nothing is appended to the old single file",
  );
  for (const name of shards) {
    assert.match(
      name,
      /^\d{4}-\d{8}T\d{9}Z-pod-7f3a\.md$/,
      "the name must sort chronologically and carry the runner that wrote it",
    );
  }

  // Zero-padded to four digits, so session 10 sorts after session 2 rather than between
  // 1 and 2 — the mistake a three-digit or unpadded name makes on the longest task.
  const journal = (await subject.readJournal(task)) ?? "";
  assert.ok(
    journal.indexOf("Started") < journal.indexOf("Finished"),
    "entries concatenate oldest first",
  );
  assert.ok(journal.indexOf("Finished") < journal.indexOf("Opened the PR"), journal);
  assert.match(journal, /## Session 1 — /);
  assert.match(journal, /## Session 10 — /);
});

test("readJournal is undefined for a task that has never written one", async () => {
  const subject = await store();
  assert.equal(await subject.readJournal(asTaskId("JOURNAL-EMPTY")), undefined);
});

test("a legacy journal.md is read, prepended, and never touched", async () => {
  // Backward compatibility is mandatory: the live state repo has `journal.md` files
  // written before the sharding, and they are the audit trail for those tasks. Reading
  // them is required; rewriting them would put the unmergeable conflict straight back,
  // this time in the migration itself.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-journal-legacy-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root), undefined, "pod-7f3a");
  const task = asTaskId("JOURNAL-2");

  const legacy = "\n## Session 1 — 2026-01-01T00:00:00.000Z\n\nThe old world.\n";
  await mkdir(join(root, "tasks", task), { recursive: true });
  await writeFile(join(root, "tasks", task, "journal.md"), legacy, "utf8");

  await subject.appendJournal(task, 2, "The new world.");

  const journal = (await subject.readJournal(task)) ?? "";
  assert.match(journal, /The old world\./);
  assert.match(journal, /The new world\./);
  assert.ok(
    journal.indexOf("The old world") < journal.indexOf("The new world"),
    "legacy content comes first — it happened first",
  );
  assert.equal(
    await readFile(join(root, "tasks", task, "journal.md"), "utf8"),
    legacy,
    "the legacy file is read, not rewritten and not deleted",
  );
});

test("appendJournal never overwrites an entry, even twice in the same millisecond", async () => {
  // Append-only survives the format change. Two entries for one session written back to
  // back would otherwise collide on the timestamp and silently drop one from the audit
  // trail.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-journal-collide-"));
  roots.push(root);
  const subject = new StateStore(root, new Git(root), undefined, "pod-7f3a");
  const task = asTaskId("JOURNAL-3");

  await Promise.all([
    subject.appendJournal(task, 4, "first"),
    subject.appendJournal(task, 4, "second"),
    subject.appendJournal(task, 4, "third"),
  ]);

  assert.equal((await readdir(join(root, "tasks", task, "journal"))).length, 3);
  const journal = (await subject.readJournal(task)) ?? "";
  for (const body of ["first", "second", "third"]) assert.match(journal, new RegExp(body));
});

test("two runners recording the same task produce commits that rebase cleanly", async () => {
  // THE test. This is the incident that wedged two of a four-replica fleet: runner A's
  // push was refused during a forge outage and it kept its commit; runner B took the
  // task over and pushed its own journal entry. With one append-only `journal.md` the
  // two appends collided on the same line and no rebase could ever apply — `pull` threw,
  // `pollOnce` retried the identical rebase every thirty seconds, forever.
  //
  // Sharded, the two runners write different paths, so the histories commute exactly as
  // `commitAndPush` has always assumed they do. Constructed with two real checkouts of a
  // real bare repo, because the claim is about git's behaviour and not about ours.
  const { store, git, bare, otherStore, other, salvaged, root } = await sharedStateRepo();
  const task = asTaskId("SHARED-1");

  // Runner B gets there first and pushes.
  await otherStore.appendJournal(task, 3, "**Exit:** done-claimed — theirs");
  await otherStore.commitAndPush("chore(state): runner B records SHARED-1", "origin", "main");

  // Runner A wrote its entry without ever seeing B's, and its push was refused.
  await store.appendJournal(task, 3, "**Exit:** error — ours");
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "runner A records SHARED-1");
  const stranded = await git.run("rev-parse", "HEAD");

  // Must not throw, and must not salvage: there is nothing to conflict over any more.
  await store.pull("origin", "main");
  assert.equal(
    (await git.tryRun("rev-parse", "--verify", `refs/salvaged/${stranded.slice(0, 12)}`)).code !== 0,
    true,
    "a rebase that applies has nothing to set aside",
  );
  // The assertion the whole task reduces to: this is the exact scenario that used to
  // salvage, and `caterpillar_salvaged_commits_total` is fed by this hook. Zero here means
  // the journal conflict class is gone by construction rather than by better recovery.
  assert.deepEqual(salvaged, [], "the journal must no longer be able to force a salvage");

  await store.commitAndPush("chore(state): runner A pushes after rebase", "origin", "main");

  // Both entries are on the remote, in one journal, and each runner's name is on its own.
  const listed = await bare.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^tasks\/SHARED-1\/journal\/0003-.*-runner-a\.md$/m);
  assert.match(listed, /^tasks\/SHARED-1\/journal\/0003-.*-runner-b\.md$/m);

  const journal = (await store.readJournal(task)) ?? "";
  assert.match(journal, /done-claimed — theirs/);
  assert.match(journal, /error — ours/);

  // And the other runner sees the same thing once it pulls — one history, not two.
  await otherStore.pull("origin", "main");
  const theirs = (await otherStore.readJournal(task)) ?? "";
  assert.equal(theirs, journal, "both runners must agree on the journal");
  assert.ok(existsSync(join(root, "tasks", task, "journal")));
  await other.run("rev-parse", "HEAD");
});

test("a commit from either loop leaves nothing of the other's uncommitted", async () => {
  // Why clearing `dirty` on ANY commit is safe, now that two loops write this checkout
  // (DESIGN.md §6.4). The worry is the obvious one: housekeeping commits a `/resume` while
  // a session is halfway through writing its own task, `dirty` goes false on the strength
  // of housekeeping's commit, and a pull one tick later resets over the rest.
  //
  // It cannot happen, and the reason is a property of `stageCommitPush` rather than of the
  // flag: it stages `tasks`, `intake`, `digests` and `alerts` with `add -A`, which is the
  // WHOLE tree the supervisor ever writes. So a commit by either writer necessarily carries
  // the other's pending files too — the tree really is clean afterwards, and `dirty` is
  // telling the truth. The cost is attribution, not durability: one commit message
  // undersells its contents. Losing a task would be worse than an inaccurate subject line,
  // and this is the assertion that says which one we got.
  //
  // If `add -A` is ever narrowed to per-task pathspecs, this test fails and `dirty` must
  // become a counter rather than a boolean. That is the point of pinning it here.
  const { store: subject, git } = await sharedStateRepo();
  const session = asTaskId("MIXED-SESSION");
  const housekeeping = asTaskId("MIXED-HOUSEKEEPING");

  // The session's half: written, not yet committed. Exactly mid-`recordSession`.
  await subject.appendJournal(session, 1, "the session's uncommitted work");
  assert.equal(subject.hasUncommittedState, true);

  // Housekeeping writes something unrelated and commits it, as `applyChatRequests` does.
  await subject.writeHandoff(housekeeping, "a /resume served while the session ran");
  await subject.commitAndPush(`chore(${housekeeping}): resumed`, "origin", "main");

  // The flag is clear — and it is entitled to be, because the tree is.
  assert.equal(subject.hasUncommittedState, false);
  assert.equal(
    (await git.run("status", "--porcelain")).trim(),
    "",
    "`dirty` may only go false when the tree genuinely has nothing left in it",
  );

  // Which is to say the session's journal went along with housekeeping's commit, rather
  // than being left behind for a pull to sweep away.
  assert.match(
    await git.run("show", "--name-only", "--format=", "HEAD"),
    new RegExp(`tasks/${session}/journal/`),
    "the session's file must be IN the commit, not merely survive it",
  );

  // So the pull that follows is safe, and the session's work is on the remote.
  assert.equal(await subject.pull("origin", "main"), "pulled");
  assert.match((await subject.readJournal(session)) ?? "", /uncommitted work/);
});

test("a pull will not reset over state a session has written but not committed", async () => {
  // The incident `pull` records — five destroyed tasks — with a new way to reach it. Since
  // the supervisor split housekeeping onto its own timer (DESIGN.md §6.4), `pull` runs on a
  // clock that knows nothing about the session: it can land in the window between a
  // session's `writeState` and the `commitAndPush` that was going to persist it, and
  // `reset --hard` plus `clean -ffdq` over `tasks/` inside that window destroys the lot.
  //
  // Mutual exclusion does not cover this. The mutex only guarantees the pull is not inside
  // a `git add`; the window here is minutes wide and contains no git at all.
  const { store: subject, other, root } = await sharedStateRepo();
  const task = asTaskId("PULL-GUARD-1");

  // Something for the remote to be ahead by, so a pull that DID run would visibly reset.
  await other.run("pull", "--quiet", "--ff-only", "origin", "main");
  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  await subject.writeState({
    id: task,
    status: "running",
    phase: "implementing",
    requires: [],
    sessions: 3,
    limits: { maxSessions: 20 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    progress: { lastProgressSession: 3, noProgressStreak: 0 },
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  });
  await subject.appendJournal(task, 3, "work the housekeeping loop must not destroy");

  assert.equal(await subject.pull("origin", "main"), "skipped");
  assert.equal((await subject.readState(task)).sessions, 3, "the state must survive");
  assert.match(
    (await subject.readJournal(task)) ?? "",
    /must not destroy/,
    "the journal must survive too — `clean -ffdq` would have taken the whole directory",
  );
  assert.ok(
    existsSync(join(root, "tasks", task, "state.json")),
    "and the directory itself, which the sweep removes wholesale",
  );

  // And the deferral is exactly that: once the session commits, the very next pull runs.
  await subject.commitAndPush(`chore(${task}): session 3`, "origin", "main");
  assert.equal(await subject.pull("origin", "main"), "pulled");
  assert.equal((await subject.readState(task)).sessions, 3);
});

test("a write that races a commit is not marked clean by it", async () => {
  // The narrow window the write GENERATION closes, as opposed to the minutes-wide one the
  // `dirty` flag closes on its own.
  //
  // Store writes are plain `writeFile` + `touched()` and deliberately do NOT take the
  // mutex — holding it from a session's `writeState` to its `commitAndPush` is the deadlock
  // `exclusively` exists to avoid. So a write can land INSIDE `stageCommitPush`: after the
  // `add -A tasks` that would have staged it, before the flag is cleared. It is then in
  // neither the commit nor the flag, `pull` believes the tree is clean, and `clean -ffdq`
  // over `tasks/` destroys it — the same five-task incident, reached through a hole two
  // hundred milliseconds wide instead of two minutes.
  //
  // In production the racing writer is a session's `publishArtifact` or `appendJournal`,
  // which may then run for hours before its own commit. That is what makes a window this
  // small worth closing: the loss is taken instantly and noticed much later.
  const { store: subject, other } = await sharedStateRepo();
  const session = asTaskId("RACE-SESSION");
  const housekeeping = asTaskId("RACE-HOUSEKEEPING");

  // Something for a pull to reset onto, so a pull that runs is visibly destructive.
  await other.run("pull", "--quiet", "--ff-only", "origin", "main");
  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  // Housekeeping commits its own work — and the session writes while that is in flight.
  await subject.writeHandoff(housekeeping, "a /resume served while the session ran");
  const committing = subject.commitAndPush(`chore(${housekeeping}): resumed`, "origin", "main");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await subject.appendJournal(session, 1, "written while housekeeping was committing");
  await committing;

  // The commit may or may not have caught that journal shard — it depends on where in the
  // subprocess sequence the write landed, which is exactly why this cannot be reasoned
  // about per-call. What must hold either way is that the flag does not claim otherwise.
  assert.equal(
    subject.hasUncommittedState,
    true,
    "a write racing the commit must leave the tree marked dirty, not silently unstaged",
  );
  assert.equal(
    await subject.pull("origin", "main"),
    "skipped",
    "and the pull that would have destroyed it must therefore decline",
  );
  assert.match(
    (await subject.readJournal(session)) ?? "",
    /while housekeeping was committing/,
    "the racing write must survive",
  );

  // Deferred, not dropped: the next commit carries it and the pull runs again.
  await subject.commitAndPush(`chore(${session}): session 1`, "origin", "main");
  assert.equal(subject.hasUncommittedState, false);
  assert.equal(await subject.pull("origin", "main"), "pulled");
  assert.match((await subject.readJournal(session)) ?? "", /while housekeeping was committing/);
});

test("a write that races a pull is not destroyed by it", async () => {
  // The mirror image of the test above, and the one that cost real work to find.
  //
  // `pull` checks `dirty` inside the mutex and then does a network `fetch` before anything
  // destructive. `dirty` is only a SAMPLE — store writes do not take the mutex — so a write
  // landing during that fetch is invisible to the check at the top and deleted by the
  // `clean -ffdq tasks` at the bottom. The gate looked sufficient and was not: this is the
  // five-destroyed-tasks incident, still reachable after the flag was added.
  //
  // It stopped being theoretical when the work loop began pulling before each claim, which
  // put a pull in the same instant as a `/brainstorm` creating a task. The spec was written
  // between the fetch and the clean, vanished, and the `commitAndPush` immediately after
  // found nothing to commit and reported success — a task acknowledged to the human that
  // existed nowhere.
  const { store: subject, other } = await sharedStateRepo();
  const created = asTaskId("PULL-RACE-1");

  // The remote must have moved, or the pull has nothing to reset onto and the test proves
  // nothing about a destructive refresh.
  await other.run("pull", "--quiet", "--ff-only", "origin", "main");
  await other.run("commit", "--quiet", "--allow-empty", "-m", "remote moves on");
  await other.run("push", "--quiet", "origin", "HEAD:main");

  // Clean at the instant the pull starts — which is what makes the `dirty` check pass and
  // the window open.
  assert.equal(subject.hasUncommittedState, false);

  // The write lands while the pull is inside its fetch. Not awaited first: the whole point
  // is that it happens after the gate was checked and before the tree is touched.
  const pulling = subject.pull("origin", "main");
  await subject.appendJournal(created, 1, "written while the pull was fetching");
  const outcome = await pulling;

  assert.match(
    (await subject.readJournal(created)) ?? "",
    /while the pull was fetching/,
    "a pull must not delete a write that landed after it sampled the dirty flag",
  );
  assert.equal(
    outcome,
    "skipped",
    "and it must report that it declined, rather than claiming a refresh it abandoned",
  );

  // Deferred, not dropped: committing clears the flag and the next pull runs normally.
  await subject.commitAndPush(`chore(${created}): created`, "origin", "main");
  assert.equal(await subject.pull("origin", "main"), "pulled");
  assert.match((await subject.readJournal(created)) ?? "", /while the pull was fetching/);
});
