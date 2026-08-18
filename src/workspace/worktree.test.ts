/**
 * Regression tests for two bugs that only surfaced against a real private repo in
 * the cluster — the unit tests and every live credential check passed while the
 * mirror path was broken.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "../state/git.ts";
import { asTaskId, type RepoRef } from "../domain/task.ts";
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
    socketDir: "/run/caterpillar/cred",
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
    socketDir: "/run/caterpillar/cred",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  await subject.syncMirror(REPO, asTaskId("T-1")).catch(() => undefined);

  const clone = invocations.find((args) => args.includes("clone"));
  assert.ok(clone !== undefined, "syncMirror must clone when no mirror exists");

  const joined = clone.join(" ");
  assert.match(joined, /credential\.helper=!\/usr\/local\/bin\/caterpillar-cred/);
  // The socket is the CLONING TASK's, not a shared one: the clone happens under a task
  // and must resolve that task's credential and no other's.
  assert.match(joined, /--socket \/run\/caterpillar\/cred\/T-1\.sock/);
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
    socketDir: "/run/caterpillar/cred",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  await subject.syncMirror(REPO).catch(() => undefined);

  assert.equal(
    consulted,
    0,
    "the workspace clone must never resolve the supervisor's own git credential",
  );
});

test("refreshing a mirror does not fail because a task branch is checked out", async () => {
  // The bug that parked the second task on a repo two seconds after it was claimed.
  //
  // `clone --mirror` configures `+refs/*:refs/*`, so `fetch --prune` tries to write every
  // remote ref onto the same-named LOCAL ref. Once a task pushes `agent/<task>`, the
  // remote has it, and the local head of that name is checked out in the task's worktree —
  // which persists on the PVC after the session ends. git then refuses the entire fetch:
  //
  //   fatal: refusing to fetch into branch 'refs/heads/agent/T-1' checked out at ...
  //
  // So ONE task pushing broke `syncMirror` for every later task on that repo, forever. It
  // surfaced as `task.parked` with a git message, which reads as a scheduler fault.
  const root = await scratch();
  const origin = join(root, "origin.git");
  const hermetic = {
    ...process.env,
    // A runner must never author from the operator's global config, and a test that reads
    // it measures the workstation rather than the subject.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "caterpillar",
    GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
    GIT_COMMITTER_NAME: "caterpillar",
    GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
  };
  const plain = new Git(root, hermetic);

  await plain.run("init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, hermetic);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  // The agent's branch, pushed — the precondition that turns the shared mirror hostile.
  await seedGit.run("checkout", "-b", "agent/T-1");
  await writeFile(join(seed, "f"), "two\n");
  await seedGit.run("commit", "-am", "two");
  await seedGit.run("push", "origin", "HEAD:refs/heads/agent/T-1");

  // A mirror as `syncMirror` would have left it, pointed at the local origin so the fetch
  // path runs without a network or a credential.
  const mirror = mirrorDir(root);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);
  const mirrorGit = new Git(mirror, hermetic);
  await mirrorGit.run("worktree", "add", join(root, "wt"), "agent/T-1");

  // Upstream moves, and so does the agent branch — a merge, or the next session's push.
  await seedGit.run("checkout", "main");
  await writeFile(join(seed, "g"), "later\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "later");
  await seedGit.run("push", "origin", "HEAD:main");
  const upstreamMain = (await seedGit.run("rev-parse", "HEAD")).trim();

  const agentBefore = await mirrorGit.revParse("refs/heads/agent/T-1");

  // The assertion that matters: this used to throw for every task after the first.
  await manager(root).syncMirror(REPO);

  assert.equal(
    (await mirrorGit.revParse("refs/heads/main"))?.trim(),
    upstreamMain,
    "the mirror must still pick up upstream history — excluding agent refs must not " +
      "quietly stop the refresh doing its job",
  );
  assert.equal(
    await mirrorGit.revParse("refs/heads/agent/T-1"),
    agentBefore,
    "an agent branch checked out by a worktree must not be written by a mirror refresh",
  );
  assert.equal(
    (await new Git(join(root, "wt"), hermetic).run("rev-parse", "--abbrev-ref", "HEAD")).trim(),
    "agent/T-1",
    "the live worktree must survive the refresh",
  );
});

test("refreshing a mirror survives a branch the agent named itself", async () => {
  // The same bug again, under a name the `agent/*` exclusion does not match:
  //
  //   BS-…-02 parked — session failed: git fetch --prune origin +refs/*:refs/*
  //   ^refs/heads/agent/* failed (128): fatal: refusing to fetch into branch
  //   'refs/heads/ci/govulncheck-go-1.25.13' checked out at '/work/tasks/BS-…-01/ci-fix'
  //
  // Excluding `refs/heads/agent/*` assumed the agent stays on the branch we created for
  // it. Nothing holds it there — the session drives git through its bash tool, and the
  // PR tool takes whatever `head` it is told — so `git checkout -b ci/<something>`
  // followed by a push re-creates the original failure exactly. And again the task that
  // dies is the NEXT one on that repo, over a branch it has never heard of.
  const root = await scratch();
  const origin = join(root, "origin.git");
  const hermetic = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "caterpillar",
    GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
    GIT_COMMITTER_NAME: "caterpillar",
    GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
  };
  const plain = new Git(root, hermetic);

  await plain.run("init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, hermetic);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  const mirror = mirrorDir(root);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);

  // Task -01 works exactly as the reported one did: it renames its branch to something
  // meaningful and pushes that. The worktree persists on the PVC afterwards.
  const worktree = await manager(root).ensureWorktree(REPO, asTaskId("T-1"));
  const agent = new Git(worktree, hermetic);
  await agent.run("checkout", "-b", "ci/govulncheck-go-1.25.13");
  await writeFile(join(worktree, "w"), "task work\n");
  await agent.run("add", "-A");
  await agent.run("commit", "-m", "task work");
  await agent.run("push");

  // Upstream moves on, which is the only reason a later task fetches at all.
  await writeFile(join(seed, "g"), "later\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "later");
  await seedGit.run("push", "origin", "HEAD:main");
  const upstreamMain = (await seedGit.run("rev-parse", "HEAD")).trim();

  const mirrorGit = new Git(mirror, hermetic);
  const agentBefore = await mirrorGit.revParse("refs/heads/ci/govulncheck-go-1.25.13");

  // Task -02 claiming the same repo. This is the call that parked it.
  await manager(root).syncMirror(REPO);

  assert.equal(
    (await mirrorGit.revParse("refs/heads/main"))?.trim(),
    upstreamMain,
    "the mirror must still pick up upstream history",
  );
  assert.equal(
    await mirrorGit.revParse("refs/heads/ci/govulncheck-go-1.25.13"),
    agentBefore,
    "a branch a live worktree holds must not be written by a mirror refresh",
  );
  assert.equal(
    (await agent.run("rev-parse", "--abbrev-ref", "HEAD")).trim(),
    "ci/govulncheck-go-1.25.13",
    "the live worktree must survive the refresh",
  );
});

test("an agent's plain `git push` cannot move any branch but its own", async () => {
  // The bug that rewound shared `main` by a commit nobody had fetched.
  //
  // `clone --mirror` writes `remote.origin.mirror = true`, and a linked worktree shares
  // the mirror's config — so the agent's own `git push`, run through the bash tool from
  // its worktree, was a MIRROR push. It force-updated every ref the mirror held onto the
  // remote, and the mirror's `main` is whatever the last fetch saw:
  //
  //   + 6a889c2...b0b1f47 main -> main (forced update)
  //
  // A sibling task on the same repo had pushed a commit that this mirror had never
  // fetched, so the push silently reset upstream `main` backwards. It also made the
  // correct incantation impossible — `git push -u origin <branch>` died with
  // "--mirror can't be combined with refspecs", which pushes the agent towards the bare
  // `git push` that does the damage.
  const root = await scratch();
  const origin = join(root, "origin.git");
  const hermetic = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "caterpillar",
    GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
    GIT_COMMITTER_NAME: "caterpillar",
    GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
  };
  const plain = new Git(root, hermetic);

  await plain.run("init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, hermetic);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  // A mirror as `syncMirror` would have left it, pointed at the local origin so the rest
  // runs without a network or a credential.
  const mirror = mirrorDir(root);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);

  // `ensureWorktree` takes the fetch path and, crucially, runs `configure`.
  const worktree = await manager(root).ensureWorktree(REPO, asTaskId("T-1"));
  const agent = new Git(worktree, hermetic);

  // A SIBLING task pushes to main after this mirror last fetched, so the mirror's idea
  // of `main` is now stale — exactly the state that made the mirror push destructive.
  await writeFile(join(seed, "g"), "sibling\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "sibling agent commit");
  await seedGit.run("push", "origin", "HEAD:main");
  const siblingMain = (await seedGit.run("rev-parse", "HEAD")).trim();

  await writeFile(join(worktree, "w"), "task work\n");
  await agent.run("add", "-A");
  await agent.run("commit", "-m", "task work");

  // What the agent actually types. It must succeed — a task that cannot push is broken
  // too — but it must only ever carry the task's own branch.
  await agent.run("push");

  const originGit = new Git(origin, hermetic);
  assert.equal(
    (await originGit.revParse("refs/heads/main"))?.trim(),
    siblingMain,
    "an agent push must never move `main`, least of all backwards over a commit the " +
      "mirror never fetched",
  );
  assert.equal(
    (await originGit.revParse("refs/heads/agent/T-1"))?.trim(),
    (await agent.run("rev-parse", "HEAD")).trim(),
    "the agent's own branch must still reach the remote",
  );

  // The form the agent reaches for when a bare push looks unsafe must also work, so it is
  // never pushed back towards the destructive one.
  const explicit = await agent.tryRun("push", "-u", "origin", "agent/T-1");
  assert.equal(
    explicit.code,
    0,
    `\`git push -u origin <branch>\` must work, got: ${explicit.stderr}`,
  );
});

test("two worktrees of the SAME mirror get DIFFERENT credential helpers", async () => {
  // The failure mode `configure`'s own comment warns about, and the one that would have
  // silently defeated per-task credential keying.
  //
  // `git config` inside a linked worktree writes to the repository's COMMON config,
  // shared by the mirror and every other worktree of it. So a per-task socket path
  // written that way is not per-task at all: the second task to configure overwrites the
  // first, every worktree resolves to the LAST task's socket, and task A's push asks for
  // — and gets — task B's credential. Keying the service by task would then buy nothing,
  // because git would name the wrong task.
  //
  // The fix is `git config --worktree`, which needs `extensions.worktreeConfig`. This
  // test asserts on what git actually resolves in each checkout, not on which file was
  // written, because the file is an implementation detail and the resolution is the bug.
  const root = await scratch();
  const origin = join(root, "origin.git");
  const hermetic = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "caterpillar",
    GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
    GIT_COMMITTER_NAME: "caterpillar",
    GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
  };
  const plain = new Git(root, hermetic);

  await plain.run("init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, hermetic);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  // A mirror as `syncMirror` would have left it, pointed at the local origin so the rest
  // runs without a network or a credential.
  const mirror = mirrorDir(root);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);

  const subject = manager(root);
  const first = await subject.ensureWorktree(REPO, asTaskId("T-1"));
  const second = await subject.ensureWorktree(REPO, asTaskId("T-2"));

  const helperIn = async (worktree: string): Promise<string> =>
    (await new Git(worktree, hermetic).run("config", "credential.helper")).trim();

  assert.equal(
    await helperIn(first),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-1.sock",
  );
  assert.equal(
    await helperIn(second),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-2.sock",
  );

  // Re-configuring the second must not disturb the first. `ensureWorktree` runs on every
  // create AND reuse, so a resumed session re-enters this path while a sibling task is
  // live — which is exactly when the shared-config version overwrote its neighbour.
  await subject.ensureWorktree(REPO, asTaskId("T-2"));
  assert.equal(
    await helperIn(first),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-1.sock",
    "reusing one task's worktree must not repoint another task's",
  );

  // Nothing shared may name a socket: a leftover there is dormant (worktree scope wins)
  // but it is the setting a later reader would believe.
  const shared = await new Git(mirror, hermetic).tryRun(
    "config",
    "--file",
    join(mirror, "config"),
    "--get",
    "credential.helper",
  );
  assert.notEqual(shared.code, 0, "the common config must not carry a per-task socket path");

  // And the mirror must still be bare while its worktrees are not — the `core.bare`
  // relocation `extensions.worktreeConfig` forces. Get this wrong and every command
  // needing a working tree dies with "this operation must be run in a work tree", so the
  // agent could not so much as run `git status` in its own checkout.
  assert.equal(
    (await new Git(mirror, hermetic).run("rev-parse", "--is-bare-repository")).trim(),
    "true",
  );
  assert.equal(
    (await new Git(first, hermetic).run("rev-parse", "--is-bare-repository")).trim(),
    "false",
  );
  const status = await new Git(first, hermetic).tryRun("status", "--porcelain");
  assert.equal(status.code, 0, `a task worktree must have a working tree: ${status.stderr}`);
});

test("a mirror and worktree left by the OLD shared-socket scheme are migrated in place", async () => {
  // The upgrade path, which has no other test: PVCs already hold mirrors whose common
  // config names the single shared `cred.sock`, and worktrees created before
  // `extensions.worktreeConfig` existed. A runner that only got this right on a fresh
  // clone would keep serving every one of those worktrees the old shared helper, so the
  // fix would appear to work on a new deployment and change nothing on a real one.
  const root = await scratch();
  const hermetic = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "caterpillar",
    GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
    GIT_COMMITTER_NAME: "caterpillar",
    GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
  };
  const plain = new Git(root, hermetic);

  const origin = join(root, "origin.git");
  await plain.run("init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, hermetic);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  const mirror = mirrorDir(root);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);

  // Exactly what the previous code left behind: one shared helper in the common config,
  // and a worktree whose repository has no `extensions.worktreeConfig` at all.
  const mirrorGit = new Git(mirror, hermetic);
  await mirrorGit.run(
    "config",
    "credential.helper",
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred.sock",
  );
  const existing = join(root, "tasks", "T-OLD", REPO.name);
  await mkdir(join(existing, ".."), { recursive: true });
  await mirrorGit.run("worktree", "add", "-b", "agent/T-OLD", existing, "main");

  const subject = manager(root);
  assert.equal(await subject.ensureWorktree(REPO, asTaskId("T-OLD")), existing);

  const helperIn = async (worktree: string): Promise<string> =>
    (await new Git(worktree, hermetic).run("config", "credential.helper")).trim();

  assert.equal(
    await helperIn(existing),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-OLD.sock",
    "reusing a pre-existing worktree must repoint it at its own task's socket",
  );

  // The migration must leave the checkout usable, not merely correctly configured.
  const status = await new Git(existing, hermetic).tryRun("status", "--porcelain");
  assert.equal(status.code, 0, `the migrated worktree must still work: ${status.stderr}`);
  assert.equal(
    (await mirrorGit.run("rev-parse", "--is-bare-repository")).trim(),
    "true",
    "the mirror must stay bare across the migration",
  );

  // And a NEW task on that same migrated mirror is independent of the old one.
  const fresh = await subject.ensureWorktree(REPO, asTaskId("T-NEW"));
  assert.equal(
    await helperIn(fresh),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-NEW.sock",
  );
  assert.equal(
    await helperIn(existing),
    "!/usr/local/bin/caterpillar-cred --socket /run/caterpillar/cred/T-OLD.sock",
  );

  // Idempotent: the migration runs on every create and reuse, so a second pass must be
  // a no-op rather than moving `core.bare` a second time.
  await subject.ensureWorktree(REPO, asTaskId("T-OLD"));
  assert.equal((await mirrorGit.run("rev-parse", "--is-bare-repository")).trim(), "true");
  assert.equal(
    (await new Git(existing, hermetic).run("rev-parse", "--is-bare-repository")).trim(),
    "false",
  );
});
