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
