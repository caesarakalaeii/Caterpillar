/**
 * The sabotage reviewer's two mechanisms, against a real git fixture.
 *
 * Nothing here is stubbed: a real `git init`, a real `--mirror` clone, a real linked
 * worktree, a real `cp`. That is deliberate — the property under test is what the OTHER
 * four reviewers see while the fifth is writing, and that is a fact about the filesystem
 * and about git's worktree bookkeeping, neither of which a fake can be wrong about in the
 * same way as the real thing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { outputCeiling } from "../agent/budget.ts";
import type { LogFields, Logger } from "../obs/log.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { prepareSabotageCopy, SabotageExecutionEnv } from "./sabotage.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** `bash -lc`, resolving with stdout. Rejects on a non-zero exit, as the fixtures want. */
const sh = (command: string, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

interface Recorded {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recorder = (): { readonly logger: Logger; readonly lines: Recorded[] } => {
  const lines: Recorded[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    lines,
  };
};

interface Fixture {
  /** `<tasksDir>/<task>` — the parent `prepareSabotageCopy` writes beside. */
  readonly taskDir: string;
  /** The reviewers' linked worktree, `<taskDir>/widget`. */
  readonly checkoutRoot: string;
  /** The bare mirror the worktree is linked to. */
  readonly mirror: string;
}

/**
 * A mirror plus one linked worktree of it, laid out the way `WorktreeManager` does.
 *
 * `extensions.worktreeConfig` with `core.bare` relocated is copied from
 * `WorktreeManager.enableWorktreeConfig`: without it a linked worktree of a mirror
 * inherits `core.bare = true` and every command needing a work tree fails. A fixture that
 * skipped it would test a repository shape the fleet never produces.
 */
const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-sabotage-"));
  roots.push(root);

  const source = join(root, "source");
  await sh(`mkdir -p ${source}`, root);
  await sh(
    "git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false",
    source,
  );
  await writeFile(join(source, "widget.ts"), "export const widget = 1;\n");
  await sh("git add -A && git commit -qm 'Add the widget'", source);
  await writeFile(join(source, "widget.test.ts"), "// asserts nothing yet\n");
  await sh("git add -A && git commit -qm 'Add a test for the widget'", source);

  const mirror = join(root, "widget.git");
  await sh(`git clone -q --mirror ${source} ${mirror}`, root);
  await sh("git config extensions.worktreeConfig true", mirror);
  await sh("git config --worktree core.bare true && git config --unset core.bare", mirror);

  const taskDir = join(root, "tasks", "TASK-1");
  const checkoutRoot = join(taskDir, "widget");
  await sh(`mkdir -p ${taskDir}`, root);
  await sh(`git worktree add -q ${checkoutRoot} main`, mirror);

  return { taskDir, checkoutRoot, mirror };
};

const prepare = (
  where: Fixture,
  overrides: { readonly minFreeGb?: number; readonly taskDir?: string; readonly logger?: Logger } = {},
) =>
  prepareSabotageCopy({
    checkoutRoot: where.checkoutRoot,
    taskDir: overrides.taskDir ?? where.taskDir,
    minFreeGb: overrides.minFreeGb ?? 0,
    logger: overrides.logger ?? SILENT_LOGGER,
    task: "TASK-1",
  });

test("the copy is a working git checkout: it has the history, and can restore a file", async () => {
  const where = await fixture();

  const result = await prepare(where);

  assert.equal(result.ok, true, `expected a copy, got ${result.ok ? "" : result.reason}`);
  if (!result.ok) return;

  const log = await sh("git log --oneline", result.path);
  assert.match(log, /Add a test for the widget/);
  assert.match(log, /Add the widget/);

  const original = await readFile(join(result.path, "widget.ts"), "utf8");
  await writeFile(join(result.path, "widget.ts"), "export const widget = 2; // sabotaged\n");
  await sh("git checkout -- .", result.path);
  assert.equal(await readFile(join(result.path, "widget.ts"), "utf8"), original);
});

test("sabotaging the copy leaves the reviewers' worktree completely untouched", async () => {
  // THE TEST THAT MATTERS. The other four reviewers read `checkoutRoot` concurrently and
  // must not see so much as an untracked entry — which is what a copy placed INSIDE the
  // checkout would produce, as `?? .caterpillar/`, since nothing excludes that path.
  const where = await fixture();
  const tracked = join(where.checkoutRoot, "widget.ts");
  const before = await readFile(tracked, "utf8");

  const result = await prepare(where);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await writeFile(join(result.path, "widget.ts"), "throw new Error('sabotaged');\n");

  assert.equal(await sh("git status --porcelain", where.checkoutRoot), "");
  assert.equal(await readFile(tracked, "utf8"), before);
});

test("the mirror's worktree registration is byte-identical afterwards", async () => {
  // `git worktree add` on the copy would have been the easy way to make it a checkout, and
  // it writes a new record into the mirror — a mirror two other tasks may be fetching.
  const where = await fixture();
  const before = await sh("git worktree list --porcelain", where.mirror);

  const result = await prepare(where);
  assert.equal(result.ok, true);

  assert.equal(await sh("git worktree list --porcelain", where.mirror), before);
});

test("cleanup removes the copy, and a second cleanup is a no-op", async () => {
  const where = await fixture();

  const result = await prepare(where);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await result.cleanup();
  assert.equal(existsSync(result.path), false);
  await result.cleanup();
});

test("a disk floor the volume cannot meet refuses the copy instead of making one", async () => {
  const where = await fixture();
  const { logger, lines } = recorder();

  const result = await prepare(where, { minFreeGb: 10_000_000, logger });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /disk/i);
  assert.equal(existsSync(join(where.taskDir, ".caterpillar", "sabotage")), false);
  assert.ok(
    lines.some((line) => line.event === "sabotage.refused"),
    "a refusal must be logged, or an operator sees a reviewer that silently did nothing",
  );
});

test("a taskDir that is not the checkout's parent throws rather than copying somewhere unreaped", async () => {
  // Nothing reaps a directory outside `<tasksDir>/<task>`, so a wrong `taskDir` is a leak
  // per review round. It is a programmer error, not a refusal.
  const where = await fixture();

  await assert.rejects(
    prepare(where, { taskDir: join(where.taskDir, "widget") }),
    /parent/i,
  );
});

test("the command cap stops the shell running a third command, not merely reporting one", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-sabotage-env-"));
  roots.push(root);
  const { logger, lines } = recorder();
  const subject = new SabotageExecutionEnv({
    cwd: root,
    timeoutSeconds: 30,
    output: outputCeiling({}),
    overflowDir: join(root, ".caterpillar", "output"),
    logger,
    task: "TASK-1",
    maxCommands: 2,
  });

  const first = await subject.exec("echo x >> counter");
  const second = await subject.exec("echo x >> counter");
  const third = await subject.exec("echo x >> counter");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.error.message, /budget/i);

  // The file, not the results: a class that counted without refusing would return the same
  // three results and still have run the command three times.
  const counter = await readFile(join(root, "counter"), "utf8");
  assert.equal(counter, "x\nx\n");
  assert.equal(subject.used, 2);
  assert.ok(
    lines.some((line) => line.event === "sabotage.budget"),
    "hitting the cap must be logged once",
  );
});

test("a generous command cap runs commands normally and counts them", async () => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-sabotage-env-"));
  roots.push(root);
  const subject = new SabotageExecutionEnv({
    cwd: root,
    timeoutSeconds: 30,
    output: outputCeiling({}),
    overflowDir: join(root, ".caterpillar", "output"),
    logger: SILENT_LOGGER,
    task: "TASK-1",
    maxCommands: 50,
  });

  const result = await subject.exec("echo hello");

  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.value.stdout, /hello/);
  assert.equal(subject.used, 1);
});
