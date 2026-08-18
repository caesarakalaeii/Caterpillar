import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { largest, measureUsage, nixStoreDir, OTHER, UsageMonitor } from "./usage.ts";

const temporaries: string[] = [];

after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-usage-"));
  temporaries.push(dir);
  return dir;
};

/** A file of exactly `bytes` bytes, parents created. Sizes here are apparent sizes. */
const file = async (path: string, bytes: number): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(bytes));
};

/**
 * A work root shaped like the real one: `mirrors/<host>/<owner>/<name>.git` and
 * `tasks/<id>`, with a file of a known size in each.
 */
const workRoot = async (): Promise<{
  readonly root: string;
  readonly mirrorsDir: string;
  readonly tasksDir: string;
}> => {
  const root = await scratch();
  const mirrorsDir = join(root, "mirrors");
  const tasksDir = join(root, "tasks");

  await file(join(mirrorsDir, "github.com/acme/widget.git/objects/pack/a.pack"), 1000);
  await file(join(mirrorsDir, "github.com/acme/gadget.git/objects/pack/b.pack"), 300);
  await file(join(tasksDir, "TASK-1/widget/node_modules/big.js"), 5000);
  await file(join(tasksDir, "TASK-1/widget/README.md"), 50);
  await file(join(tasksDir, "TASK-2/widget/small.js"), 7);
  // Neither a mirror nor a task: the bucket that keeps the categories adding up.
  await file(join(root, "state/.git/config"), 400);

  return { root, mirrorsDir, tasksDir };
};

test("every category is attributed to the directory it came from", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir });

  assert.equal(usage.mirrorBytes, 1300);
  assert.equal(usage.taskBytes, 5057);
  assert.equal(usage.nixBytes, 0);
  assert.equal(usage.otherBytes, 400);
  assert.equal(usage.partial, false);
});

test("a mirror is named by owner/name, wherever in the host tree it sits", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir });

  assert.deepEqual(usage.mirrors, [
    { name: "acme/widget", bytes: 1000 },
    { name: "acme/gadget", bytes: 300 },
  ]);
});

test("tasks come back largest first, which is the only order anyone reads this in", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir });

  assert.deepEqual(usage.tasks, [
    { name: "TASK-1", bytes: 5050 },
    { name: "TASK-2", bytes: 7 },
  ]);
});

test("the nix store is measured separately, from wherever it is mounted", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();
  const store = await scratch();
  await file(join(store, "abc-hello-1.0/bin/hello"), 2048);

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir, nixStoreDir: store });

  assert.equal(usage.nixBytes, 2048);
  // Outside the work root, so it must not also show up as unattributed bytes there.
  assert.equal(usage.otherBytes, 400);
});

test("a missing directory measures zero rather than failing the whole pass", async () => {
  // The ordinary state of a fresh runner: `paths.mirrors` does not exist until the first
  // clone, and `/nix/store` does not exist at all without nix. Neither is a fault.
  const root = await scratch();

  const usage = await measureUsage({
    workRoot: root,
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    nixStoreDir: join(root, "nope/store"),
  });

  assert.equal(usage.mirrorBytes, 0);
  assert.equal(usage.taskBytes, 0);
  assert.equal(usage.nixBytes, 0);
  assert.equal(usage.otherBytes, 0);
  assert.deepEqual(usage.mirrors, []);
  assert.deepEqual(usage.tasks, []);
  assert.equal(usage.partial, false);
});

test("a work root that does not exist at all is zero, not a throw", async () => {
  const usage = await measureUsage({
    workRoot: "/definitely/not/here",
    mirrorsDir: "/definitely/not/here/mirrors",
    tasksDir: "/definitely/not/here/tasks",
  });

  assert.equal(usage.fs.totalBytes, 0);
  assert.equal(usage.fs.freeBytes, 0);
  assert.equal(usage.mirrorBytes, 0);
});

test("the filesystem is measured from statfs, not by summing anything", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir });

  assert.ok(usage.fs.totalBytes > 0, "a real temp directory has a real filesystem");
  assert.ok(usage.fs.freeBytes >= 0);
  assert.ok(usage.fs.freeBytes <= usage.fs.totalBytes);
});

test("a symlink is counted as the link and never followed", async () => {
  // Following would double-count every store path a dev-profile GC root points at, and a
  // symlink loop would burn the whole deadline on every single pass.
  const root = await scratch();
  const tasksDir = join(root, "tasks");
  await file(join(tasksDir, "TASK-1/real.js"), 100);
  await symlink(join(tasksDir, "TASK-1"), join(tasksDir, "TASK-2"));

  const usage = await measureUsage({
    workRoot: root,
    mirrorsDir: join(root, "mirrors"),
    tasksDir,
  });

  assert.equal(usage.taskBytes, 100);
  assert.deepEqual(usage.tasks, [{ name: "TASK-1", bytes: 100 }]);
});

test("the deadline reports a partial answer rather than throwing", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  // A clock that is already past the deadline on its second reading, so the walk stops
  // before it has descended anywhere.
  let ticks = 0;
  const usage = await measureUsage({
    workRoot: root,
    mirrorsDir,
    tasksDir,
    deadlineMs: 1,
    now: () => (ticks++ === 0 ? 0 : 1_000),
  });

  assert.equal(usage.partial, true);
  assert.equal(usage.mirrorBytes, 0);
  assert.equal(usage.taskBytes, 0);
  assert.ok(usage.measuredAt.endsWith("Z"), "a partial measurement is still stamped");
});

test("a walk that finishes inside the deadline is not partial", async () => {
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({ workRoot: root, mirrorsDir, tasksDir, deadlineMs: 60_000 });

  assert.equal(usage.partial, false);
  assert.equal(usage.mirrorBytes + usage.taskBytes + usage.otherBytes, 6757);
});

test("only the top N get a series of their own; the rest are summed into one", async () => {
  // Uncapped, this is one Prometheus series per task the runner has ever worked, forever.
  const entries = Array.from({ length: 12 }, (_, index) => ({
    name: `TASK-${index}`,
    bytes: (index + 1) * 10,
  }));

  const top = largest(entries, 3);

  assert.deepEqual(top, [
    { name: "TASK-11", bytes: 120 },
    { name: "TASK-10", bytes: 110 },
    { name: "TASK-9", bytes: 100 },
    { name: OTHER, bytes: 450 },
  ]);
  // The bucket exists so the parts still add up to the whole.
  assert.equal(
    top.reduce((sum, entry) => sum + entry.bytes, 0),
    entries.reduce((sum, entry) => sum + entry.bytes, 0),
  );
});

test("nothing truncated means no empty remainder row", async () => {
  const top = largest([{ name: "a", bytes: 1 }], 3);
  assert.deepEqual(top, [{ name: "a", bytes: 1 }]);
});

test("the first idle poll only starts the clock", async () => {
  // Exactly `maybeCollectGarbage`'s rule, and for the same reason: a pod crash-looping
  // every few minutes would otherwise walk the whole volume on every boot.
  const { root, mirrorsDir, tasksDir } = await workRoot();
  let clock = 1_000_000;
  const monitor = new UsageMonitor({
    workRoot: root,
    mirrorsDir,
    tasksDir,
    intervalHours: 1,
    now: () => clock,
  });

  assert.equal(await monitor.maybeMeasure(), undefined);
  assert.equal(monitor.current(), undefined);

  clock += 59 * 60 * 1000;
  assert.equal(await monitor.maybeMeasure(), undefined, "still inside the interval");

  clock += 2 * 60 * 1000;
  const measured = await monitor.maybeMeasure();
  assert.ok(measured !== undefined, "past the interval, it measures");
  assert.equal(measured.mirrorBytes, 1300);
  assert.equal(monitor.current()?.taskBytes, 5057);

  assert.equal(await monitor.maybeMeasure(), undefined, "and the clock restarts");
});

test("the nix store path is where nix would look for it", async () => {
  assert.equal(nixStoreDir({}), "/nix/store");
  assert.equal(nixStoreDir({ NIX_STORE_DIR: "/mnt/nix/store" }), "/mnt/nix/store");
});

test("an interval of zero turns the measurement off rather than running it constantly", async () => {
  // 0 would otherwise mean "every idle poll", which at the default poll interval is the
  // one setting that could actually hurt. An operator reaching for 0 wants less, not more.
  const { root, mirrorsDir, tasksDir } = await workRoot();
  let clock = 1_000_000;
  const monitor = new UsageMonitor({
    workRoot: root,
    mirrorsDir,
    tasksDir,
    intervalHours: 0,
    now: () => clock,
  });

  assert.equal(await monitor.maybeMeasure(), undefined);
  clock += 24 * 60 * 60 * 1000;
  assert.equal(await monitor.maybeMeasure(), undefined, "still off a day later");
  assert.equal(monitor.current(), undefined, "and there is nothing for the page to show");
});

test("a trailing slash in the config does not make `other` absorb everything twice", async () => {
  // `paths.mirrors` and `paths.tasks` are free-form ConfigMap strings, and `/work/mirrors/`
  // is how a human writes one without thinking. Compared literally the exclusion matches
  // nothing the walk produces, so `other` counts the mirrors and the tasks a second time
  // and the categories stop adding up — a wrong number from a config that looks right.
  const { root, mirrorsDir, tasksDir } = await workRoot();

  const usage = await measureUsage({
    workRoot: `${root}/`,
    mirrorsDir: `${mirrorsDir}/`,
    tasksDir: `${tasksDir}/`,
  });

  assert.equal(usage.mirrorBytes, 1300);
  assert.equal(usage.taskBytes, 5057);
  assert.equal(usage.otherBytes, 400, "only the state checkout, counted once");
});

test("a relative work root is resolved before anything is excluded", async () => {
  // Same failure, arrived at differently: an absolute exclusion never matches a relative
  // walk, so `other` would swallow both categories again.
  const { root, mirrorsDir, tasksDir } = await workRoot();
  const cwd = process.cwd();
  process.chdir(root);

  try {
    const usage = await measureUsage({ workRoot: ".", mirrorsDir, tasksDir });
    assert.equal(usage.otherBytes, 400);
  } finally {
    process.chdir(cwd);
  }
});
