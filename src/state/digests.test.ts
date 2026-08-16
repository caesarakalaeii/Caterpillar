/**
 * Daily digests in the state repo. See DESIGN.md §19.
 *
 * The published copy is the record: it is what the Discord message was cut from, what the
 * web view renders, and the only place a day that scrolled out of the channel still
 * exists. So the two things that matter are that a date is a path segment nothing can
 * escape through — it reaches `readDigest` from a URL — and that the directory is actually
 * STAGED. A digest that is written and never committed is one that survives until the next
 * poll's `reset --hard` and then is not there at all.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "./git.ts";
import { StateStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly store: StateStore;
  readonly root: string;
  readonly git: Git;
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-digests-"));
  roots.push(root);

  const git = new Git(root);
  await git.run("init", "--quiet", "--initial-branch=main");
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");

  return { store: new StateStore(root, git), root, git };
};

test("a digest round-trips and is listed newest first", async () => {
  const subject = await fixture();

  await subject.store.writeDigest("2026-08-15", "# Daily digest — 2026-08-15\n");
  await subject.store.writeDigest("2026-08-16", "# Daily digest — 2026-08-16\n");

  assert.deepEqual(await subject.store.listDigests(), ["2026-08-16", "2026-08-15"]);
  assert.match(
    (await subject.store.readDigest("2026-08-16")) ?? "",
    /# Daily digest — 2026-08-16/,
  );
  assert.equal(await subject.store.readDigest("2026-08-01"), undefined);
});

test("a date that is not a date never becomes a path", async () => {
  // It arrives from a URL and from a ref name. `..` is a legal directory name and
  // resolves to the state repo root, which is the whole reason this is checked at all —
  // the same rule task ids live under (`domain/task.ts`).
  const subject = await fixture();

  assert.equal(await subject.store.readDigest("../../etc/passwd"), undefined);
  assert.equal(await subject.store.readDigest(".."), undefined);
  assert.equal(await subject.store.readDigest("2026-8-1"), undefined);
  assert.equal(await subject.store.readDigest(""), undefined);

  await assert.rejects(() => subject.store.writeDigest("../escape", "x"), /not a date/);
});

test("digests are staged, not left untracked", async () => {
  // `commitAndPush` names the paths it stages one by one, and a directory missing from
  // that list is written to disk and then destroyed by the next poll's reset.
  const subject = await fixture();
  await subject.store.writeDigest("2026-08-16", "# Daily digest — 2026-08-16\n");

  await subject.git.run("add", "-A");
  await subject.git.run("commit", "-m", "baseline");
  await subject.store.writeDigest("2026-08-17", "# Daily digest — 2026-08-17\n");

  // Exactly what `commitAndPush` does, minus the push there is no remote for here.
  await subject.git.run("add", "-A", "digests");
  assert.equal(await subject.git.hasUncommittedChanges(), true);
  await subject.git.run("commit", "-m", "chore(digest): 2026-08-17");

  assert.equal(await subject.git.hasUncommittedChanges(), false);
  assert.match(
    await readFile(join(subject.root, "digests", "2026-08-17.md"), "utf8"),
    /2026-08-17/,
  );
});
