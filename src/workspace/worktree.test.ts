/**
 * Regression tests for two bugs that only surfaced against a real private repo in
 * the cluster — the unit tests and every live credential check passed while the
 * mirror path was broken.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "../state/git.ts";
import type { RepoRef } from "../domain/task.ts";
import { WorktreeManager } from "./worktree.ts";

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-worktree-"));
  roots.push(root);
  return root;
};

const manager = (root: string): WorktreeManager =>
  new WorktreeManager({
    git: new Git(root),
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    helperPath: "/usr/local/bin/caterpillar-cred",
    socketPath: "/run/caterpillar/cred.sock",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

const mirrorDir = (root: string): string =>
  join(root, "mirrors", REPO.host, REPO.owner, `${REPO.name}.git`);

test("a failed clone leaves no directory behind to poison the next attempt", async () => {
  // The original bug: syncMirror mkdir'd the target BEFORE cloning, so a clone that
  // failed (a private repo, anonymously — see the next test) left an empty directory.
  // Every later call then saw "the directory exists", took the fetch branch, and died
  // with `not a git repository` — a message describing the symptom, not the cause.
  // The task was unrecoverable without deleting the path by hand.
  const root = await scratch();

  await assert.rejects(() => manager(root).syncMirror(REPO));
  assert.equal(
    existsSync(mirrorDir(root)),
    false,
    "a failed clone must not leave the mirror path behind",
  );
});

test("an existing but empty mirror directory is discarded, not fetched into", async () => {
  // Recovery for a PVC already poisoned by the old code: the check is for HEAD inside
  // the mirror, not for the directory, so a partial mirror is re-cloned.
  const root = await scratch();
  await mkdir(mirrorDir(root), { recursive: true });

  // Still fails (no such remote), but the failure must come from the CLONE, not from
  // fetching inside a non-repository.
  await assert.rejects(
    () => manager(root).syncMirror(REPO),
    (error: unknown) =>
      error instanceof Error && !/not a git repository/i.test(error.message),
  );
  assert.equal(existsSync(mirrorDir(root)), false);
});

test("the mirror clone carries the credential helper, not just the repo config", async () => {
  // The bug that broke the first end-to-end run: `configure` set credential.helper
  // AFTER cloning, so the clone itself was anonymous. Every private repo failed with
  // `could not read Username for 'https://github.com'`, and public repos hid it.
  //
  // Asserted on the invocation rather than on an error, because "it threw" is true
  // with or without the fix — the earlier version of this test proved nothing.
  const root = await scratch();
  const invocations: (readonly string[])[] = [];

  class RecordingGit extends Git {
    override async run(...args: readonly string[]): Promise<string> {
      invocations.push(args);
      return "";
    }
    override at(): Git {
      return this;
    }
    // Both derivation points must fold back to the recorder, or the manager records
    // nothing: it strips the credential once up front (see the next test).
    override withoutCredentials(): Git {
      return this;
    }
  }

  const subject = new WorktreeManager({
    git: new RecordingGit(root),
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    helperPath: "/usr/local/bin/caterpillar-cred",
    socketPath: "/run/caterpillar/cred.sock",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  await subject.syncMirror(REPO).catch(() => undefined);

  const clone = invocations.find((args) => args.includes("clone"));
  assert.ok(clone !== undefined, "syncMirror must clone when no mirror exists");

  const joined = clone.join(" ");
  assert.match(joined, /credential\.helper=!\/usr\/local\/bin\/caterpillar-cred/);
  assert.match(joined, /--socket \/run\/caterpillar\/cred\.sock/);
  assert.match(joined, /credential\.useHttpPath=true/);

  // The overrides must precede the subcommand — `git clone -c ...` is not valid.
  assert.ok(
    clone.indexOf("-c") < clone.indexOf("clone"),
    "-c overrides must come before the subcommand",
  );
  // And the token itself must never appear on argv (DESIGN.md §9.2) — the helper
  // path is passed, the credential is resolved over the socket.
  assert.ok(!/ghs_|ghp_|x-access-token/.test(joined));
});

test("the mirror clone does not inherit the supervisor's own credential", async () => {
  // The bug that produced `remote: Repository not found` on the first real task.
  // `index.ts` builds ONE Git for the state repo, carrying an http.extraHeader with an
  // App token scoped to the state repo alone, and passed that same object to
  // WorktreeManager. `syncMirror` is the one call site that uses it directly instead of
  // going through `at()`, so `git clone` of a TASK repo authenticated as the state repo.
  //
  // GitHub answers a valid-but-unauthorised token with 404 `Repository not found`, NOT
  // 401 — so git never asks the credential helper at all, and the correct task-scoped
  // token was never even requested. Against a Codeberg workspace the same bug ships a
  // GitHub token to a different host.
  const root = await scratch();

  // The credential provider records every consultation. `Git` only calls it when it is
  // about to hand the credential to a git process, so a single call is the bug.
  let consulted = 0;
  const stateRepoCredential = (): Promise<NodeJS.ProcessEnv> => {
    consulted += 1;
    return Promise.resolve({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic c3RhdGUtcmVwby10b2tlbg==",
    });
  };

  const subject = new WorktreeManager({
    git: new Git(root, process.env, stateRepoCredential),
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    helperPath: "/usr/local/bin/caterpillar-cred",
    socketPath: "/run/caterpillar/cred.sock",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  await subject.syncMirror(REPO).catch(() => undefined);

  assert.equal(
    consulted,
    0,
    "the workspace clone must never resolve the supervisor's own git credential",
  );
});
