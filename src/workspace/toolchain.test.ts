import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { ToolchainConfig } from "../config/types.ts";
import { asTaskId, asWorkspaceName, type TaskSpec } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import {
  cacheDigest,
  DEFAULT_TOOLCHAIN_CONFIG,
  TASK_SHELL_ARGS,
  ToolchainError,
  ToolchainResolver,
} from "./toolchain.ts";

const spec: TaskSpec = {
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("test"),
  goal: "goal",
  repos: [{ host: "github.com", owner: "o", name: "r" }],
  requires: [],
  acceptance: ["true"],
};

/** The shipped defaults, but with a timeout no test should ever reach. */
const TEST_CONFIG: ToolchainConfig = { ...DEFAULT_TOOLCHAIN_CONFIG, timeoutSeconds: 60 };

const temporaries: string[] = [];

after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-toolchain-"));
  temporaries.push(dir);
  return dir;
};

/**
 * A real PATH is always kept: shell discovery reads it, and a resolver that cannot find
 * bash throws rather than resolving. Extra entries are what each test actually asserts on.
 */
const resolver = (
  extra: NodeJS.ProcessEnv = {},
  tasksDir = "/tmp/caterpillar-tasks",
): ToolchainResolver =>
  new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir,
    baseEnv: { PATH: process.env["PATH"] ?? "", ...extra },
  });

test("a task with no declaration inherits the supervisor's environment", async () => {
  const resolved = await resolver({ CATERPILLAR_MARKER: "kept", LANG: "C" }).resolve(
    spec,
    "/tmp/wt",
  );

  assert.equal(resolved.source, "inherited");
  assert.equal(resolved.env["CATERPILLAR_MARKER"], "kept");
  assert.equal(resolved.env["LANG"], "C");
});

test("the resolved environment is a copy, so a caller cannot mutate the base", async () => {
  // The same resolver serves every task in a long-lived process. One session appending to
  // PATH in place would leak into every later session on this runner, which is the kind of
  // bug that only shows up on task five.
  const base: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", MARKER: "original" };
  const resolved = await new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    baseEnv: base,
  }).resolve(spec, "/tmp/wt");

  resolved.env["MARKER"] = "tampered";

  assert.equal(base["MARKER"], "original");
});

test("two resolves of the same task do not share one object", async () => {
  const r = resolver();
  const first = await r.resolve(spec, "/tmp/wt");
  const second = await r.resolve(spec, "/tmp/wt");

  assert.notEqual(first.env, second.env);
  assert.deepEqual(first.env, second.env);
});

test("the task shell is NOT a login shell", () => {
  // `bash -lc` sources /etc/profile, which on alpine ASSIGNS PATH rather than appending —
  // it would silently discard whatever environment was handed in. This assertion is the
  // guard on the one line that would undo the entire module.
  assert.deepEqual([...TASK_SHELL_ARGS], ["-c"]);
  assert.ok(!TASK_SHELL_ARGS.some((arg) => arg.includes("l")));
});

test("the resolved shell is an absolute path to a real bash", async () => {
  // pi stats `shellPath` and refuses a bare name, and NixOS — one of the two hosts this
  // runs on — has no /bin/bash at all, so a hardcoded path would break exactly there.
  const resolved = await resolver().resolve(spec, "/tmp/wt");

  assert.ok(
    resolved.shell.startsWith("/"),
    `expected an absolute path, got ${resolved.shell}`,
  );
  assert.match(resolved.shell, /bash$/);
  assert.ok(existsSync(resolved.shell));
});

test("the shell is discovered once and reused across concurrent resolves", async () => {
  const r = resolver();
  const [first, second] = await Promise.all([
    r.resolve(spec, "/tmp/wt"),
    r.resolve(spec, "/tmp/other"),
  ]);

  assert.equal(first?.shell, second?.shell);
});

test("a runner without bash fails loudly instead of falling back to sh", async () => {
  // pi's own fallback is `sh -c`. Accepting it would mean the agent and the acceptance
  // gate run different interpreters again — the exact divergence this module closes.
  const blind = new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    baseEnv: { PATH: "/nonexistent" },
  });

  await assert.rejects(() => blind.resolve(spec, "/tmp/wt"), ToolchainError);
});

// ---------------------------------------------------------------------------- detection

test("an explicit `inherit` beats a flake.nix sitting in the repo", async () => {
  // The escape hatch. A repo can carry a devShell aimed at humans that is wrong for the
  // agent, and this is how a human says so without deleting anything.
  const worktree = await scratch();
  await writeFile(join(worktree, "flake.nix"), "{}", "utf8");

  const resolved = await resolver().resolve(
    { ...spec, toolchain: { mode: "inherit" } },
    worktree,
  );

  assert.equal(resolved.source, "inherited");
});

test("a repo with no nix expression inherits, exactly as before", async () => {
  const resolved = await resolver().resolve(spec, await scratch());

  assert.equal(resolved.source, "inherited");
});

test("flake.nix is preferred over shell.nix", async () => {
  // Both present is a repo mid-migration. Newer wins, and it must be decided here rather
  // than by whichever `readFile` happens to resolve first.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await writeFile(join(worktree, "flake.nix"), "{}", "utf8");
  await writeFile(join(worktree, "shell.nix"), "{}", "utf8");

  await assert.rejects(
    () => resolver({}, tasksDir).resolve(spec, worktree),
    (error: unknown) => error instanceof ToolchainError && error.source === "flake.nix devShell",
  );
});

test("`mode: nix` with nothing to build is refused, not silently inherited", async () => {
  // The human asked for an environment and named nothing to put in it. Inheriting would
  // hide the mistake until the acceptance gate went red for an unrelated-looking reason.
  const worktree = await scratch();

  await assert.rejects(
    () => resolver().resolve({ ...spec, toolchain: { mode: "nix" } }, worktree),
    (error: unknown) => error instanceof ToolchainError && error.source === "declaration",
  );
});

// ------------------------------------------------------------------------- materialising

test("a broken nix expression parks with nix's own error, not a bare exit code", async () => {
  const worktree = await scratch();
  const tasksDir = await scratch();
  await writeFile(join(worktree, "flake.nix"), "{ this is not a flake", "utf8");

  await assert.rejects(
    () => resolver({}, tasksDir).resolve(spec, worktree),
    (error: unknown) =>
      error instanceof ToolchainError &&
      error.source === "flake.nix devShell" &&
      error.message.length > 40,
  );
});

// -------------------------------------------------------------------------------- cache

/**
 * A `/nix/store` path that really exists, when the test host has one.
 *
 * A cache hit is only honoured if the store paths it names are still on disk, so a made-up
 * path would make every cache test a cache MISS. On NixOS this resolves to node's own
 * store path; anywhere else (CI) it is a non-store path, which the check ignores.
 */
const LIVE_STORE_BIN = dirname(process.execPath);

/**
 * Seed the on-disk cache so a resolve answers from it without invoking nix.
 *
 * This is how a runner behaves after a Keel roll: the environment was resolved by a
 * process that no longer exists, and the entry on the PVC is all that is left.
 */
const seedCache = async (
  tasksDir: string,
  worktree: string,
  contents: string,
  variables: Record<string, string>,
): Promise<void> => {
  const dir = join(tasksDir, spec.id, ".caterpillar");
  await mkdir(dir, { recursive: true });
  await writeFile(join(worktree, "flake.nix"), contents, "utf8");
  const digest = cacheDigest(TEST_CONFIG.nixpkgs, { kind: "flake", contents, source: "" }, "");
  await writeFile(join(dir, "env.json"), JSON.stringify({ digest, variables }), "utf8");
};

test("a cached environment is answered without invoking nix", async () => {
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ cached }", {
    PATH: `${LIVE_STORE_BIN}:/usr/bin`,
    LUA_PATH: "/nix/store/fake/share-not-on-PATH",
  });

  const resolved = await resolver({}, tasksDir).resolve(spec, worktree);

  // `{ cached }` is not a valid flake — reaching nix at all would have thrown.
  assert.equal(resolved.source, "flake.nix devShell");
  assert.equal(resolved.env["PATH"], `${LIVE_STORE_BIN}:/usr/bin`);
  assert.equal(resolved.env["LUA_PATH"], "/nix/store/fake/share-not-on-PATH");
});

test("editing the nix expression invalidates the cache", async () => {
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ cached }", { PATH: LIVE_STORE_BIN });

  // Same cache entry, different expression: the digest no longer matches, so the resolver
  // must go back to nix — which fails on this garbage, proving it went.
  await writeFile(join(worktree, "flake.nix"), "{ edited }", "utf8");

  await assert.rejects(
    () => resolver({}, tasksDir).resolve(spec, worktree),
    ToolchainError,
  );
});

test("a devShell cannot move the credential helper or HOME", async () => {
  // A devShell is repo-authored. Left unguarded it could point the git credential helper
  // somewhere else or move HOME out from under the credential socket, so the supervisor's
  // own variables are re-asserted after the devShell has had its say.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ hijack }", {
    PATH: LIVE_STORE_BIN,
    CRED_HELPER: "/hijacked/helper",
    HOME: "/hijacked/home",
  });

  const resolved = await resolver(
    { CRED_HELPER: "/real/caterpillar-cred", HOME: "/real/home" },
    tasksDir,
  ).resolve(spec, worktree);

  assert.equal(resolved.env["PATH"], LIVE_STORE_BIN);
  assert.equal(resolved.env["CRED_HELPER"], "/real/caterpillar-cred");
  assert.equal(resolved.env["HOME"], "/real/home");
});

test("a cache entry whose store paths are gone is a miss, not a broken PATH", async () => {
  // The entry and the store it points into have different lifetimes: a garbage collection
  // can take a path, and an ephemeral /nix inside the image is replaced on every deploy
  // while env.json sits on the durable PVC. Trusting the entry would not fail loudly — it
  // would hand the agent a PATH of directories that do not exist, which looks exactly like
  // the missing toolchain this module exists to fix.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ collected }", {
    PATH: "/nix/store/0000000000000000000000000000000-gone/bin",
  });

  await assert.rejects(
    () => resolver({}, tasksDir).resolve(spec, worktree),
    ToolchainError,
  );
});

test("a reserved variable the supervisor does not set is removed, not inherited", async () => {
  // The supervisor has no ANTHROPIC_API_KEY, so a devShell exporting one must not be able
  // to introduce it — the credential the agent uses is not the agent's to choose.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ sneak }", {
    PATH: LIVE_STORE_BIN,
    ANTHROPIC_API_KEY: "sk-not-yours",
  });

  const resolved = await resolver({}, tasksDir).resolve(spec, worktree);

  assert.equal(resolved.env["ANTHROPIC_API_KEY"], undefined);
});

test("ToolchainError carries the source that failed", () => {
  const error = new ToolchainError("flake.nix devShell", "evaluation failed");

  assert.equal(error.name, "ToolchainError");
  assert.equal(error.source, "flake.nix devShell");
  assert.equal(error.message, "evaluation failed");
  assert.ok(error instanceof Error);
});
