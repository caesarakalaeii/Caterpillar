import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import type { ToolchainConfig } from "../config/types.ts";
import { asTaskId, asWorkspaceName, KNOWN_CAPABILITIES, type TaskSpec } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import {
  cacheDigest,
  DEFAULT_TOOLCHAIN_CONFIG,
  TASK_SHELL_ARGS,
  ToolchainError,
  ToolchainResolver,
  type RepoInspector,
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

/**
 * The identity every resolver under test commits as. `.invalid` on purpose: a test
 * fixture that names a real forge address is one copy-paste away from being deployed.
 */
const TEST_IDENTITY = { name: "caterpillar", email: "caterpillar@example.invalid" };

const temporaries: string[] = [];

after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "caterpillar-toolchain-"));
  temporaries.push(dir);
  return dir;
};

const exec = promisify(execFile);

/**
 * Keep the operator's own git config out of a test that runs git.
 *
 * A machine runner inherits `~/.gitconfig` — an identity, `commit.gpgsign`, an
 * `insteadOf` — and without these two a test asserting who a commit is by would be
 * measuring the workstation it happens to run on.
 */
const HERMETIC_GIT: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** One git command in `cwd`, under exactly the environment a task's shell would get. */
const git = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: readonly string[]
): Promise<string> => {
  const { stdout } = await exec("git", [...args], { cwd, env });
  return stdout;
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
    identity: TEST_IDENTITY,
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
    identity: TEST_IDENTITY,
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
    identity: TEST_IDENTITY,
    baseEnv: { PATH: "/nonexistent" },
  });

  await assert.rejects(() => blind.resolve(spec, "/tmp/wt"), ToolchainError);
});

// ------------------------------------------------------------------- browser cache

test("every task environment gets a writable cache directory on the work volume", async () => {
  // A rendered-output gate runs a browser, and a browser wants somewhere to cache. This
  // is the one place that decides where, so no task has to (DESIGN.md §12).
  const tasksDir = await scratch();
  const resolved = await resolver({}, tasksDir).resolve(spec, "/tmp/wt");

  assert.equal(resolved.env["XDG_CACHE_HOME"], join(tasksDir, ".cache"));
  assert.ok(existsSync(join(tasksDir, ".cache")), "the directory has to exist to be usable");
});

test("the browser cache is shared between tasks rather than cut per task", async () => {
  // Playwright's browser bundle is hundreds of megabytes. Keyed on the task it would be
  // re-downloaded for every task, on every runner, forever.
  const tasksDir = await scratch();
  const shared = resolver({}, tasksDir);

  const first = await shared.resolve(spec, "/tmp/wt");
  const second = await shared.resolve({ ...spec, id: asTaskId("TASK-2") }, "/tmp/wt");

  assert.equal(first.env["XDG_CACHE_HOME"], join(tasksDir, ".cache"));
  assert.equal(second.env["XDG_CACHE_HOME"], first.env["XDG_CACHE_HOME"]);
});

test("an operator's own XDG_CACHE_HOME is left alone", async () => {
  // A machine runner has a real one, already writable and already populated. Overriding
  // it would throw away a warm cache to enforce a location that only matters in the
  // container, where nothing sets it.
  const tasksDir = await scratch();
  const resolved = await resolver({ XDG_CACHE_HOME: "/home/op/.cache" }, tasksDir).resolve(
    spec,
    "/tmp/wt",
  );

  assert.equal(resolved.env["XDG_CACHE_HOME"], "/home/op/.cache");
});

test("a devShell cannot move the cache out from under the supervisor", async () => {
  // Reserved for the same reason HOME is: the cache directory is the supervisor's
  // decision about the work volume, and a repo-authored mkShell exporting a store path
  // would point every browser at a read-only /nix/store directory.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ cache }", {
    PATH: LIVE_STORE_BIN,
    XDG_CACHE_HOME: "/nix/store/deadbeef-cache",
  });

  const resolved = await resolver({}, tasksDir).resolve(spec, worktree);

  assert.equal(resolved.env["XDG_CACHE_HOME"], join(tasksDir, ".cache"));
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

// -------------------------------------------------------------------------- identity

test("every spawned process is told who it commits as", async () => {
  // Not only the agent's shell: the council's, the plan maintainer's and the gate's come
  // from the same resolver, and a `wip` commit made by any of them is history too.
  const resolved = await resolver().resolve(spec, "/tmp/wt");

  assert.equal(resolved.env["GIT_AUTHOR_NAME"], TEST_IDENTITY.name);
  assert.equal(resolved.env["GIT_AUTHOR_EMAIL"], TEST_IDENTITY.email);
  assert.equal(resolved.env["GIT_COMMITTER_NAME"], TEST_IDENTITY.name);
  assert.equal(resolved.env["GIT_COMMITTER_EMAIL"], TEST_IDENTITY.email);
});

test("a devShell cannot rename the fleet", async () => {
  // Same reasoning as HOME and the credential helper, one step further: a repo-authored
  // `mkShell` exporting GIT_AUTHOR_NAME would put a name the operator never configured on
  // every commit made in that repo, and it would look like the fleet's own doing.
  const worktree = await scratch();
  const tasksDir = await scratch();
  await seedCache(tasksDir, worktree, "{ rename }", {
    PATH: LIVE_STORE_BIN,
    GIT_AUTHOR_NAME: "Somebody Else",
    GIT_COMMITTER_EMAIL: "somebody@else.invalid",
  });

  const resolved = await resolver({}, tasksDir).resolve(spec, worktree);

  assert.equal(resolved.env["GIT_AUTHOR_NAME"], TEST_IDENTITY.name);
  assert.equal(resolved.env["GIT_COMMITTER_EMAIL"], TEST_IDENTITY.email);
});

test("an identity that names a real stranger is refused, not stamped", () => {
  // The value matters more than who typed it. `load.ts` refuses this shape in the
  // ConfigMap, and it is checked again HERE because an identity can reach a commit
  // without passing through the loader — a machine runner's inherited GIT_AUTHOR_EMAIL,
  // a caller wiring the resolver by hand — and this is the last point before it is
  // history. Constructing throws, so the runner does not start rather than committing as
  // the person who holds the login `caterpillar`.
  assert.throws(
    () =>
      new ToolchainResolver({
        logger: SILENT_LOGGER,
        config: TEST_CONFIG,
        tasksDir: "/tmp/caterpillar-tasks",
        identity: { name: "Caterpillar", email: "caterpillar@users.noreply.github.com" },
        baseEnv: { PATH: process.env["PATH"] ?? "" },
      }),
    /users\.noreply\.github\.com/,
  );
});

test("the id-prefixed form of the same domain is the one that is fine", () => {
  // The rule is about ambiguity, not about the domain: a numeric id names exactly one
  // account, so the bot's own address must not be caught by the check above.
  const resolver = new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    identity: {
      name: "caterpillar-agent[bot]",
      email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
    },
    baseEnv: { PATH: process.env["PATH"] ?? "" },
  });

  assert.ok(resolver instanceof ToolchainResolver);
});

test("`git -c user.email=` cannot outrank the configured identity", async () => {
  // The defect, verbatim. A session recovering a reset branch merged main back in with
  //
  //   git -c user.name=Caterpillar -c user.email=caterpillar@users.noreply.github.com \
  //       merge --no-edit <sha>
  //
  // unprompted — the name from its own system prompt, the address invented to match. It is
  // the pre-2017 personal noreply form, so GitHub resolved it to the stranger holding the
  // login `caterpillar`, who became the author of a merge into a repo they have never seen
  // (DESIGN.md §9.7). The worktree's git CONFIG was correct throughout; `-c` simply outranks
  // it. Only the environment does not lose that argument, which is what this pins.
  const repo = await scratch();
  const env = { ...(await resolver().resolve(spec, "/tmp/wt")).env, ...HERMETIC_GIT };

  await git(repo, env, "init", "--initial-branch=main", ".");
  await writeFile(join(repo, "a.txt"), "a\n", "utf8");
  await git(repo, env, "add", "a.txt");
  await git(
    repo,
    env,
    "-c",
    "user.name=Caterpillar",
    "-c",
    "user.email=caterpillar@users.noreply.github.com",
    "commit",
    "-m",
    "who wrote this",
  );

  const who = await git(repo, env, "log", "-1", "--format=%an <%ae>|%cn <%ce>");

  assert.equal(
    who.trim(),
    `${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>|${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>`,
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

// ------------------------------------------------------------------------- capabilities

/**
 * A resolver whose `nix` probe has a decided answer.
 *
 * The probe resolves the binary through the PATH it is handed, so a stub on a scratch
 * PATH settles it without the outcome depending on whether the machine running the tests
 * happens to have nix. It did depend on that at first, which passed here and failed in CI
 * — the one host guaranteed not to have nix.
 */
const withNix = async (installed: boolean, exitCode = 0): Promise<ToolchainResolver> => {
  const bin = await scratch();
  if (installed) {
    const stub = join(bin, "nix");
    await writeFile(stub, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
    await chmod(stub, 0o755);
  }
  return new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    identity: TEST_IDENTITY,
    baseEnv: { PATH: bin },
  });
};

test("a runner with nix advertises it without being told to", async () => {
  // The whole point. The deployed ConfigMap says `["linux", "net"]`, an explicit
  // `toolchain: mode: nix` implies `requires: [nix]` at intake, and a runner that has nix
  // but does not say so leaves that task `ready` forever with nothing logged — the exact
  // failure §8.1 removes, arriving through config instead of through the enum.
  const advertised = await (await withNix(true)).capabilities(["linux", "net"]);

  assert.deepEqual([...advertised], ["linux", "net", "nix"]);
});

test("a runner without nix does not claim it can build environments", async () => {
  const advertised = await (await withNix(false)).capabilities(["linux", "net"]);

  assert.deepEqual([...advertised], ["linux", "net"]);
});

test("a nix that is present but does not run is not advertised", async () => {
  // Installed-but-broken is not the same as installed. Advertising on the strength of the
  // file existing would have the runner claim tasks it can only park.
  const advertised = await (await withNix(true, 1)).capabilities(["linux", "net"]);

  assert.deepEqual([...advertised], ["linux", "net"]);
});

test("an explicit declaration is neither duplicated nor overridden", async () => {
  // Config still wins where it can be right. An operator who lists `nix` on a machine that
  // does not have it yet gets a warning at boot, not a silent removal — they may be about
  // to install it, and a config the runner quietly edits is worse than one that is wrong.
  const present = await (await withNix(true)).capabilities(["linux", "nix"]);
  assert.deepEqual([...present], ["linux", "nix"]);

  const absent = await (await withNix(false)).capabilities(["linux", "nix"]);
  assert.deepEqual([...absent], ["linux", "nix"]);
});

test("every derived capability is one the config loader would accept", async () => {
  // Derivation must not be able to invent a capability the rest of the system refuses:
  // `claimNext` compares against this list and intake validates `requires` against it.
  const advertised = await (await withNix(true)).capabilities(["linux"]);

  assert.ok(advertised.includes("nix"), "expected the stub to be detected");
  for (const capability of advertised) {
    assert.ok(
      KNOWN_CAPABILITIES.includes(capability),
      `derived '${capability}' is not a known capability`,
    );
  }
});

test("ToolchainError carries the source that failed", () => {
  const error = new ToolchainError("flake.nix devShell", "evaluation failed");

  assert.equal(error.name, "ToolchainError");
  assert.equal(error.source, "flake.nix devShell");
  assert.equal(error.message, "evaluation failed");
  assert.ok(error instanceof Error);
});

// ------------------------------------------------------------------- stale branch note

/** A repo whose default branch is `main` and which carries exactly `files`. */
const inspector = (files: readonly string[]): RepoInspector => ({
  defaultBranch: () => Promise.resolve("main"),
  hasFileOn: (_worktree, _ref, path) => Promise.resolve(files.includes(path)),
});

const withInspector = (repo: RepoInspector | undefined): ToolchainResolver =>
  new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: TEST_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    identity: TEST_IDENTITY,
    baseEnv: { PATH: process.env["PATH"] ?? "" },
    ...(repo === undefined ? {} : { repo: () => repo }),
  });

test("a worktree that predates the repo's flake is told so, not left to guess", async () => {
  // The failure this exists for: a task's worktree is cut from the default branch once
  // and lives on the PVC for the life of the task, so a flake added afterwards is
  // invisible to it. The resolver falls back correctly and the agent gets a shell missing
  // exactly the tools the task is about. Two of the first three real tasks hit this.
  const resolved = await withInspector(inspector(["flake.nix"])).resolve(
    spec,
    await scratch(),
  );

  assert.equal(resolved.source, "inherited");
  assert.match(resolved.note ?? "", /predates/);
  assert.match(resolved.note ?? "", /git merge main/);
});

test("a repo with no nix expression at all says nothing", async () => {
  // The note must be specific to a STALE branch. "Your branch is behind" is true of
  // almost every branch almost always; a repo that simply has no flake is not a problem
  // and must not be reported as one.
  const resolved = await withInspector(inspector([])).resolve(spec, await scratch());

  assert.equal(resolved.source, "inherited");
  assert.equal(resolved.note, undefined);
});

test("a worktree that HAS the flake is never called stale", async () => {
  const worktree = await scratch();
  const tasksDir = await scratch();
  await writeFile(join(worktree, "flake.nix"), "{ broken }", "utf8");

  // Reaching nix at all proves detection chose the devShell over the fallback; the build
  // failing afterwards is beside the point here.
  await assert.rejects(
    () =>
      new ToolchainResolver({
        logger: SILENT_LOGGER,
        config: TEST_CONFIG,
        tasksDir,
        identity: TEST_IDENTITY,
        baseEnv: { PATH: process.env["PATH"] ?? "" },
        repo: () => inspector(["flake.nix"]),
      }).resolve(spec, worktree),
    ToolchainError,
  );
});

test("shell.nix on the default branch counts too", async () => {
  const resolved = await withInspector(inspector(["shell.nix"])).resolve(
    spec,
    await scratch(),
  );

  assert.match(resolved.note ?? "", /shell\.nix/);
});

test("without an inspector the fallback is unchanged and silent", async () => {
  // The inspector is optional, and its absence must not turn a working fallback into an
  // error — a machine runner wired without one still resolves, it just cannot explain.
  const resolved = await withInspector(undefined).resolve(spec, await scratch());

  assert.equal(resolved.source, "inherited");
  assert.equal(resolved.note, undefined);
});

test("a git that cannot answer degrades to silence, never to a failed session", async () => {
  const hostile: RepoInspector = {
    defaultBranch: () => Promise.reject(new Error("not a git repository")),
    hasFileOn: () => Promise.reject(new Error("not a git repository")),
  };

  const resolved = await withInspector(hostile).resolve(spec, await scratch());

  assert.equal(resolved.source, "inherited");
  assert.equal(resolved.note, undefined);
});

/** A resolver whose config names binary caches, with everything else at defaults. */
const cached = (
  over: Partial<ToolchainConfig>,
  extra: NodeJS.ProcessEnv = {},
): ToolchainResolver =>
  new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: { ...TEST_CONFIG, ...over },
    tasksDir: "/tmp/caterpillar-tasks",
    identity: TEST_IDENTITY,
    baseEnv: { PATH: process.env["PATH"] ?? "", ...extra },
  });

test("configured substituters reach every spawned process via NIX_CONFIG", async () => {
  const resolved = await cached({ substituters: ["http://cache.invalid/"] }).resolve(spec, "/tmp/wt");

  assert.match(resolved.env["NIX_CONFIG"] ?? "", /^extra-substituters = http:\/\/cache\.invalid\/$/m);
});

test("NIX_CONFIG is APPENDED, so the image's experimental-features survive", async () => {
  // The image ships NIX_CONFIG="experimental-features = nix-command flakes". Replacing it
  // turns every flake reference into an error about an experimental feature, which reads
  // as a broken flake rather than as a clobbered variable.
  const resolved = await cached(
    { substituters: ["http://cache.invalid/"] },
    { NIX_CONFIG: "experimental-features = nix-command flakes" },
  ).resolve(spec, "/tmp/wt");

  const config = resolved.env["NIX_CONFIG"] ?? "";
  assert.match(config, /experimental-features = nix-command flakes/);
  assert.match(config, /extra-substituters = http:\/\/cache\.invalid\//);
});

test("trusted keys are emitted separately from the caches that need them", async () => {
  const resolved = await cached({
    substituters: ["http://cache.invalid/", "http://other.invalid/"],
    trustedPublicKeys: ["cache.invalid:AAAA", "other.invalid:BBBB"],
  }).resolve(spec, "/tmp/wt");

  const config = resolved.env["NIX_CONFIG"] ?? "";
  assert.match(config, /^extra-substituters = http:\/\/cache\.invalid\/ http:\/\/other\.invalid\/$/m);
  assert.match(config, /^extra-trusted-public-keys = cache\.invalid:AAAA other\.invalid:BBBB$/m);
});

test("nothing configured at all leaves NIX_CONFIG exactly as the environment had it", async () => {
  // A machine runner and a local `docker run` have no in-cluster cache to point at, and
  // must behave precisely as they did before any of this existed. `minFreeGb: 0` is the
  // documented off switch and has to be given explicitly, because the quota — unlike the
  // caches — is ON by default.
  const off = { minFreeGb: 0 };

  const untouched = await cached(off, { NIX_CONFIG: "experimental-features = flakes" }).resolve(
    spec,
    "/tmp/wt",
  );
  assert.equal(untouched.env["NIX_CONFIG"], "experimental-features = flakes");

  const absent = await cached(off).resolve(spec, "/tmp/wt");
  assert.equal(absent.env["NIX_CONFIG"], undefined);
});

test("the store quota reaches nix as min-free/max-free, in bytes", async () => {
  // The only bound on the store that actually exists. A volumeClaimTemplate's 15Gi is a
  // scheduling request under `local-path` and enforces nothing, so without these a store
  // that grows to 60Gi fills the node and takes every other pod on it down.
  const resolved = await cached({ minFreeGb: 5, maxFreeGb: 20 }).resolve(spec, "/tmp/wt");
  const config = resolved.env["NIX_CONFIG"] ?? "";

  // Plain integers, not "5G": nix silently ignores a value it cannot parse, which would
  // leave the quota off while the config insists it is on.
  assert.match(config, /^min-free = 5368709120$/m);
  assert.match(config, /^max-free = 21474836480$/m);
});

test("the quota is on by default, because an unbounded store fills a node", async () => {
  // Deliberately unlike the caches, which default to empty. A workstation runner filling
  // a laptop's disk is the same failure as a replica filling a cluster node, with a shorter fuse.
  const resolved = await new ToolchainResolver({
    logger: SILENT_LOGGER,
    config: DEFAULT_TOOLCHAIN_CONFIG,
    tasksDir: "/tmp/caterpillar-tasks",
    identity: TEST_IDENTITY,
    baseEnv: { PATH: process.env["PATH"] ?? "" },
  }).resolve(spec, "/tmp/wt");

  assert.match(resolved.env["NIX_CONFIG"] ?? "", /^min-free = \d+$/m);
});

test("minFreeGb 0 switches the quota off without switching the caches off", async () => {
  // The two are independent levers on one variable, and a runner that turned off its
  // cache to turn off its quota would silently start substituting from the internet.
  const resolved = await cached({
    minFreeGb: 0,
    substituters: ["http://cache.invalid/"],
  }).resolve(spec, "/tmp/wt");
  const config = resolved.env["NIX_CONFIG"] ?? "";

  assert.match(config, /extra-substituters = http:\/\/cache\.invalid\//);
  assert.ok(!config.includes("min-free"), "the quota must be absent, not zeroed");
});

/**
 * `NODE_ENV=production` is set by the supervisor's own Dockerfile, correctly — its
 * runtime image installed with `--omit=dev`. But it is process-wide, and every agent
 * session and acceptance command is a child of the supervisor, so all of them inherited
 * it. npm honours it by skipping devDependencies, so a task whose acceptance list starts
 * `npm ci` installs no `typescript` and the next command dies with
 * `tsc: command not found` (exit 127) — an acceptance list the container cannot satisfy,
 * which no agent can fix from inside the repo.
 *
 * This repo also clears `omit` in its own `.npmrc`, which is the right fix for a repo
 * that knows about the problem. This is the fix for the repos that do not: the fleet runs
 * acceptance commands for containers that never heard of this supervisor.
 */
test("NODE_ENV=production does not leak into a task's environment", async () => {
  const resolved = await resolver({ NODE_ENV: "production" }).resolve(spec, "/tmp/wt");

  assert.equal(resolved.env["NODE_ENV"], undefined);
});

test("a NODE_ENV that is not production is left alone", async () => {
  // Only the npm-devDependency-skipping value is stripped. Anything else is somebody's
  // deliberate choice and none of this module's business.
  const resolved = await resolver({ NODE_ENV: "test" }).resolve(spec, "/tmp/wt");

  assert.equal(resolved.env["NODE_ENV"], "test");
});
