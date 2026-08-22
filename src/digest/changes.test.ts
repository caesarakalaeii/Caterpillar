/**
 * The digest's only claim about code, and the one thing in it that is not in the state repo.
 *
 * A task branch lives in a bare mirror on the runner's own disk, so this is the half of a
 * digest that a runner can be honestly unable to answer — it never worked that task, so it
 * never cloned that repo. These tests pin both halves: the numbers when the mirror is
 * there, and silence rather than a zero when it is not. A `0 files changed` on a task that
 * merged a hundred of them is the worst answer available.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId, type RepoRef } from "../domain/task.ts";
import { Git } from "../state/git.ts";
import { MirrorChangeReader } from "./changes.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
const TASK = asTaskId("TASK-1");

/** A repo shaped like a mirror: a default branch, and a task branch off it. */
const mirror = async (): Promise<Git> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-changes-"));
  roots.push(root);

  const git = new Git(root);
  await git.run("init", "--quiet", "--initial-branch=main");
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");

  await writeFile(join(root, "app.ts"), "export const one = 1;\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "-m", "base");

  await git.run("checkout", "--quiet", "-b", `agent/${TASK}`);
  await writeFile(join(root, "app.ts"), "export const one = 1;\nexport const two = 2;\n", "utf8");
  await writeFile(join(root, "app.test.ts"), "// a test\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "-m", "feat(app): a second constant");
  await writeFile(join(root, "app.test.ts"), "// a test\n// and another\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "-m", "test(app): cover it");

  // A mirror's HEAD points at the default branch, never at the task's.
  await git.run("checkout", "--quiet", "main");
  return git;
};

test("a task branch reports its commits and its diffstat", async () => {
  const git = await mirror();
  const reader = new MirrorChangeReader({ localMirror: () => git });

  const changes = await reader.read(TASK, [REPO]);

  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.equal(change?.repo, "acme/widget");
  assert.deepEqual(
    change?.commits,
    ["feat(app): a second constant", "test(app): cover it"],
    "oldest first — a day reads forwards",
  );
  assert.equal(change?.filesChanged, 2);
  assert.equal(change?.insertions, 3);
  assert.equal(change?.deletions, 0);
  assert.deepEqual([...(change?.files ?? [])].sort(), ["app.test.ts", "app.ts"]);
});

test("a repo this runner has never mirrored says nothing at all", async () => {
  // Not an empty change record: `collect.ts` turns an absent repo into a declared gap,
  // and a zeroed one would read as "this task changed no code".
  const reader = new MirrorChangeReader({ localMirror: () => undefined });

  assert.deepEqual(await reader.read(TASK, [REPO]), []);
});

test("a mirror without the task's branch says nothing either", async () => {
  const git = await mirror();
  const reader = new MirrorChangeReader({ localMirror: () => git });

  assert.deepEqual(await reader.read(asTaskId("TASK-NEVER-RAN-HERE"), [REPO]), []);
});

test("a branch with no commits on it is not reported as a change", async () => {
  const git = await mirror();
  await git.run("branch", "agent/TASK-EMPTY", "main");
  const reader = new MirrorChangeReader({ localMirror: () => git });

  assert.deepEqual(await reader.read(asTaskId("TASK-EMPTY"), [REPO]), []);
});

/* ------------------------------------------------------- authorship over a window */

const FLEET = "316492202+caterpillar-agent[bot]@users.noreply.github.com";
const WINDOW_START = new Date("2026-08-15T16:00:00Z");
const WINDOW_END = new Date("2026-08-16T16:00:00Z");

/**
 * A mirror with one commit by the fleet and one by a person inside the window, plus one
 * of each outside it. Committer dates, because that is what the digest's own window
 * filters on (`collect.ts` uses `--before`) and what a rebase resets to the moment the
 * fleet actually pushed.
 */
const authoredMirror = async (): Promise<Git> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-authorship-"));
  roots.push(root);

  const git = new Git(root);
  await git.run("init", "--quiet", "--initial-branch=main");

  const commit = async (
    email: string,
    name: string,
    when: string,
    file: string,
    body: string,
  ): Promise<void> => {
    await writeFile(join(root, file), body, "utf8");
    await git.run("add", "-A");
    await git
      .withEnv({
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: when,
      })
      .run("commit", "-m", `touch ${file}`);
  };

  await commit(FLEET, "caterpillar-agent[bot]", "2026-08-14T10:00:00Z", "before.ts", "1\n");
  await commit(FLEET, "caterpillar-agent[bot]", "2026-08-16T09:00:00Z", "fleet.ts", "1\n2\n3\n");
  await commit("dev@example.invalid", "A Person", "2026-08-16T10:00:00Z", "human.ts", "1\n");
  await commit(FLEET, "caterpillar-agent[bot]", "2026-08-17T10:00:00Z", "after.ts", "1\n");

  return git;
};

test("authorship reports every commit in the window with its author and line counts", async () => {
  const git = await authoredMirror();
  const reader = new MirrorChangeReader({ localMirror: () => git });

  const read = await reader.readAuthorship([REPO], WINDOW_START, WINDOW_END);

  assert.deepEqual(read.unavailable, []);
  assert.deepEqual(
    read.commits.map((entry) => ({
      repo: entry.repo,
      email: entry.authorEmail,
      lines: entry.insertions + entry.deletions,
    })),
    [
      { repo: "acme/widget", email: FLEET, lines: 3 },
      { repo: "acme/widget", email: "dev@example.invalid", lines: 1 },
    ],
    "the commits before and after the window are not in it",
  );
});

test("a repo with no mirror on this runner is named as unreadable, not reported empty", async () => {
  // The §19 rule, applied to authorship: a runner that never worked this repo has no
  // history for it, and a repo with zero commits in it is a different fact entirely.
  const reader = new MirrorChangeReader({ localMirror: () => undefined });

  const read = await reader.readAuthorship([REPO], WINDOW_START, WINDOW_END);

  assert.deepEqual(read.commits, []);
  assert.deepEqual(read.unavailable, ["acme/widget"]);
});

test("a mirror whose window is empty is readable and simply has no commits", async () => {
  // The other half of the same distinction: this runner CAN see the repo, and nothing was
  // committed in it. That must not be reported as an unreadable repo.
  const git = await authoredMirror();
  const reader = new MirrorChangeReader({ localMirror: () => git });

  const read = await reader.readAuthorship(
    [REPO],
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-02T00:00:00Z"),
  );

  assert.deepEqual(read.commits, []);
  assert.deepEqual(read.unavailable, []);
});

test("a commit that is only on a forge's own ref is not counted as authorship", async () => {
  // A mirror fetches `+refs/*:refs/*`, so on GitHub it carries `refs/pull/*` too. Those
  // hold the heads of pull requests that were closed without merging and of branches that
  // were force-pushed over — code nobody landed. Counting it would report work that does
  // not exist in the repository.
  const git = await authoredMirror();
  const head = await git.run("rev-parse", "HEAD");
  await git.run("update-ref", "refs/pull/7/head", head);
  await git.run("checkout", "--quiet", "--detach", head);
  await writeFile(join(await git.run("rev-parse", "--show-toplevel"), "abandoned.ts"), "1\n");
  await git.run("add", "-A");
  await git
    .withEnv({
      GIT_AUTHOR_NAME: "caterpillar-agent[bot]",
      GIT_AUTHOR_EMAIL: FLEET,
      GIT_AUTHOR_DATE: "2026-08-16T11:00:00Z",
      GIT_COMMITTER_NAME: "caterpillar-agent[bot]",
      GIT_COMMITTER_EMAIL: FLEET,
      GIT_COMMITTER_DATE: "2026-08-16T11:00:00Z",
    })
    .run("commit", "-m", "abandoned");
  await git.run("update-ref", "refs/pull/7/head", await git.run("rev-parse", "HEAD"));
  await git.run("checkout", "--quiet", "main");

  const read = await new MirrorChangeReader({ localMirror: () => git }).readAuthorship(
    [REPO],
    WINDOW_START,
    WINDOW_END,
  );

  assert.equal(read.commits.length, 2, "the two commits on branches, and not the abandoned one");
});

test("a commit reachable from two refs is counted once", async () => {
  // A merged task branch is reachable from both `agent/<task>` and the default branch. The
  // fleet's share would be inflated by every branch that was kept if this double-counted.
  const git = await authoredMirror();
  await git.run("branch", "agent/TASK-MERGED", "main");
  const reader = new MirrorChangeReader({ localMirror: () => git });

  const read = await reader.readAuthorship([REPO], WINDOW_START, WINDOW_END);

  assert.equal(read.commits.length, 2);
});
