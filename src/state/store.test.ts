/**
 * Round-trip tests for the intake write path.
 *
 * `writeSpec` and `readSpec` are two halves of one contract, and intake is the only
 * thing that writes a spec the supervisor did not get from a human. If they disagree,
 * intake creates a task that `readSpec` refuses — the queue then carries an item nothing
 * can claim and nothing can explain, which is strictly worse than never creating it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
