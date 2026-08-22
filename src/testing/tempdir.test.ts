import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { removeTempTree } from "./tempdir.ts";

test("a temp tree is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-tempdir-"));
  await mkdir(join(root, "nested", "deeper"), { recursive: true });
  await writeFile(join(root, "nested", "deeper", "file"), "content");

  await removeTempTree(root);

  assert.equal(existsSync(root), false);
});

test("removing a tree that is already gone is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-tempdir-"));
  await removeTempTree(root);

  // Teardown runs on the failure path too, where an earlier step may already have
  // removed the tree. That must not turn one failure into two.
  await removeTempTree(root);

  assert.equal(existsSync(root), false);
});

test("a tree still being written into by another process is removed, not refused", async () => {
  // The CI flake this exists for. `rm -rf` walks the tree, then rmdir's each directory it
  // has emptied; a process that creates a file in one of those directories between the
  // two steps makes the rmdir fail with ENOTEMPTY. `force: true` does not cover it — that
  // suppresses ENOENT, the opposite race.
  //
  // Reproduced against git in supervisor/loop.test.ts, whose file-level teardown deleted
  // the fixture root while a housekeeping pass's `git fetch` was still writing into
  // `state/.git/objects`. Here a plain writer stands in for git so the test needs no
  // repo and stays fast.
  const root = await mkdtemp(join(tmpdir(), "caterpillar-tempdir-"));
  const busy = join(root, "busy");
  await mkdir(busy, { recursive: true });

  // Creates files under `busy` as fast as it can, for longer than the removal takes to
  // start, and dies with its parent rather than outliving the test.
  const writer = spawn(
    process.execPath,
    [
      "-e",
      `const {writeFileSync}=require("fs");const {join}=require("path");` +
        `const dir=${JSON.stringify(busy)};let n=0;` +
        `const t=setInterval(()=>{try{writeFileSync(join(dir,"f"+n++),"x")}catch{clearInterval(t);process.exit(0)}},1);` +
        `setTimeout(()=>{clearInterval(t);process.exit(0)},2000);`,
    ],
    { stdio: "ignore" },
  );

  try {
    // Wait until the writer is genuinely producing files. Spawning a node process takes
    // ~70ms, and a removal started before the first write wins the race every time — the
    // test then passes against a naive `rm` and asserts nothing.
    for (let waited = 0; waited < 3000 && readdirSync(busy).length === 0; waited += 10) {
      await sleep(10);
    }
    assert.ok(readdirSync(busy).length > 0, "the writer must be writing before the removal");

    await removeTempTree(root);
    assert.equal(existsSync(root), false);
  } finally {
    writer.kill("SIGKILL");
  }
});
