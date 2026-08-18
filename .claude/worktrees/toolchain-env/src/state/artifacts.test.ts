/**
 * Artifacts in the state repo. See DESIGN.md §17.
 *
 * The caps ARE the design here, not a safety net: every runner clones this repo and pulls
 * it on every poll, and git keeps whatever lands in it forever. So the tests are mostly
 * about what is refused, and about a name being a single path segment — it is chosen by a
 * model, which makes it the least trustworthy string in the system.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { Git } from "./git.ts";
import { ARTIFACT_BYTES, ARTIFACT_COUNT, isArtifactName, StateStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const store = async (): Promise<StateStore> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-artifacts-"));
  roots.push(root);
  return new StateStore(root, new Git(root));
};

const TASK = asTaskId("BS-1-01");

test("an artifact round-trips", async () => {
  const subject = await store();
  await subject.writeArtifact(TASK, "scan.json", Buffer.from('{"sublevels":754}'));

  assert.deepEqual(await subject.listArtifacts(TASK), ["scan.json"]);
  assert.equal(String(await subject.readArtifact(TASK, "scan.json")), '{"sublevels":754}');
});

test("a name that is not one path segment is refused", async () => {
  // Model-authored, and it becomes a path inside the task directory. This is the least
  // trustworthy string in the system.
  const subject = await store();

  for (const name of ["../escape", "a/b", "/abs", "..", ".hidden", ""]) {
    await assert.rejects(
      () => subject.writeArtifact(TASK, name, Buffer.from("x")),
      /not a usable artifact name/,
      name,
    );
  }
  assert.equal(isArtifactName("scan.json"), true);
  assert.equal(isArtifactName("a".repeat(200)), false);
});

test("an oversized artifact is refused rather than committed", async () => {
  // The state repo is cloned by every runner. A 40 MB dump here is 40 MB on every
  // machine, forever, because git history does not forget.
  const subject = await store();

  await assert.rejects(
    () => subject.writeArtifact(TASK, "dump.bin", Buffer.alloc(ARTIFACT_BYTES + 1)),
    /the limit is/,
  );
  assert.deepEqual(await subject.listArtifacts(TASK), []);
});

test("a task cannot accumulate more than the cap", async () => {
  const subject = await store();
  for (let i = 0; i < ARTIFACT_COUNT; i += 1) {
    await subject.writeArtifact(TASK, `a${i}.txt`, Buffer.from("x"));
  }

  await assert.rejects(
    () => subject.writeArtifact(TASK, "one-too-many.txt", Buffer.from("x")),
    /the limit is/,
  );
});

test("overwriting an existing artifact does not count against the cap", async () => {
  // Otherwise a session that revises its own output hits the ceiling for no reason.
  const subject = await store();
  for (let i = 0; i < ARTIFACT_COUNT; i += 1) {
    await subject.writeArtifact(TASK, `a${i}.txt`, Buffer.from("x"));
  }

  await subject.writeArtifact(TASK, "a0.txt", Buffer.from("revised"));
  assert.equal(String(await subject.readArtifact(TASK, "a0.txt")), "revised");
  assert.equal((await subject.listArtifacts(TASK)).length, ARTIFACT_COUNT);
});

test("reading an artifact that does not exist, or a hostile name, yields nothing", async () => {
  const subject = await store();

  assert.equal(await subject.readArtifact(TASK, "absent.json"), undefined);
  assert.equal(await subject.readArtifact(TASK, "../../etc/passwd"), undefined);
});

test("a task with no artifacts lists none rather than failing", async () => {
  const subject = await store();
  assert.deepEqual(await subject.listArtifacts(asTaskId("NEVER-RAN")), []);
});
