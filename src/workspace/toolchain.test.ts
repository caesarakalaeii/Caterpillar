import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type TaskSpec } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { TASK_SHELL_ARGS, ToolchainError, ToolchainResolver } from "./toolchain.ts";

const spec: TaskSpec = {
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("test"),
  goal: "goal",
  repos: [{ host: "github.com", owner: "o", name: "r" }],
  requires: [],
  acceptance: ["true"],
};

/**
 * A real PATH is always kept: shell discovery reads it, and a resolver that cannot find
 * bash throws rather than resolving. Extra entries are what each test actually asserts on.
 */
const resolver = (extra: NodeJS.ProcessEnv = {}): ToolchainResolver =>
  new ToolchainResolver({
    logger: SILENT_LOGGER,
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
    baseEnv: { PATH: "/nonexistent" },
  });

  await assert.rejects(() => blind.resolve(spec, "/tmp/wt"), ToolchainError);
});

test("ToolchainError carries the source that failed", () => {
  const error = new ToolchainError("flake.nix devShell", "evaluation failed");

  assert.equal(error.name, "ToolchainError");
  assert.equal(error.source, "flake.nix devShell");
  assert.equal(error.message, "evaluation failed");
  assert.ok(error instanceof Error);
});
