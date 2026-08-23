/**
 * Regression tests for two bugs that only surfaced against a real private repo in
 * the cluster — the unit tests and every live credential check passed while the
 * mirror path was broken.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git, type GitResult } from "../state/git.ts";
import { asTaskId, type RepoRef, type TaskId } from "../domain/task.ts";
import { assertInside, WorktreeManager } from "./worktree.ts";

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

test("refreshing an EXISTING mirror carries the credential helper too", async () => {
  // The regression that arrived with per-task credential keying. The helper moved out of
  // the mirror's shared config into each worktree's `config.worktree`, and a mirror is not
  // a worktree — so the refresh had nothing to read and went out anonymous, while the CLONE
  // still authenticated because it is passed `-c` explicitly.
  //
  // That asymmetry is what made it invisible: a repo's FIRST task built the mirror and
  // succeeded, and every task afterwards failed on the fetch with `could not read
  // Username`. It reads as "the second task on a repo is broken", and no existing test
  // caught it because a `file://` origin needs no credential to fetch from.
  //
  // Asserted on the invocation, like the clone test above, because "it threw" is true with
  // or without the fix.
  const root = await scratch();
  const invocations: (readonly string[])[] = [];

  class RecordingGit extends Git {
    override async run(...args: readonly string[]): Promise<string> {
      invocations.push(args);
      // `refspecs` reads `worktree list --porcelain` to avoid fetching a checked-out
      // branch; empty output is a mirror with no worktrees, which is the case here.
      return "";
    }
    override async tryRun(...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      invocations.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }
    override at(): Git {
      return this;
    }
    override withoutCredentials(): Git {
      return this;
    }
  }

  const mirror = mirrorDir(root);
  // A mirror that already exists, which is the whole point: this is the path taken by every
  // task after the first one on a repo.
  await mkdir(mirror, { recursive: true });
  await writeFile(join(mirror, "HEAD"), "ref: refs/heads/main\n");

  const subject = new WorktreeManager({
    git: new RecordingGit(root),
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    helperPath: "/usr/local/bin/caterpillar-cred",
    socketDir: "/run/caterpillar/cred",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  await subject.syncMirror(REPO, asTaskId("T-2")).catch(() => undefined);

  const fetched = invocations.find((args) => args.includes("fetch"));
  assert.ok(fetched !== undefined, "an existing mirror must be refreshed");
  assert.ok(!invocations.some((args) => args.includes("clone")), "and must not be re-cloned");

  const joined = fetched.join(" ");
  assert.match(joined, /credential\.helper=!\/usr\/local\/bin\/caterpillar-cred/);
  // This task's socket, not another task's and not a shared one.
  assert.match(joined, /--socket \/run\/caterpillar\/cred\/T-2\.sock/);
  assert.match(joined, /credential\.useHttpPath=true/);
  // `git fetch -c ...` is not valid — the overrides belong before the subcommand.
  assert.ok(
    fetched.indexOf("-c") < fetched.indexOf("fetch"),
    "-c overrides must come before the subcommand",
  );
  assert.ok(!/ghs_|ghp_|x-access-token/.test(joined), "the token never reaches argv (\u00a79.2)");
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

/**
 * A repo, a mirror of it, and worktrees for one multi-repo task — the state a finished
 * task actually leaves on the volume.
 *
 * Built through `ensureTaskCheckout` rather than by hand, because what the reap has to
 * clean up is whatever THAT function laid down: a workspace worktree at
 * `<tasksDir>/<task>/<name>`, a sibling worktree at `<root>/repos/<name>`, and each of
 * them registered in its own mirror's administrative records. A fixture that placed the
 * directories itself would prove the `rm` works and nothing about the layout.
 */
const HERMETIC: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "caterpillar",
  GIT_AUTHOR_EMAIL: "caterpillar@example.invalid",
  GIT_COMMITTER_NAME: "caterpillar",
  GIT_COMMITTER_EMAIL: "caterpillar@example.invalid",
};

const seedMirror = async (root: string, repo: RepoRef): Promise<void> => {
  const plain = new Git(root, HERMETIC);
  const origin = join(root, `${repo.name}-origin.git`);
  await plain.run("init", "--bare", "--initial-branch=main", origin);

  const seed = join(root, `${repo.name}-seed`);
  await plain.run("clone", origin, seed);
  const seedGit = new Git(seed, HERMETIC);
  await writeFile(join(seed, "f"), "one\n");
  await seedGit.run("add", "-A");
  await seedGit.run("commit", "-m", "one");
  await seedGit.run("push", "origin", "HEAD:main");

  const mirror = join(root, "mirrors", repo.host, repo.owner, `${repo.name}.git`);
  await mkdir(join(mirror, ".."), { recursive: true });
  await plain.run("clone", "--mirror", origin, mirror);
};

test("a finished multi-repo task leaves nothing behind, siblings and all", async () => {
  // The whole point of the feature. `removeWorktree` — the only removal that existed —
  // took ONE repo and left everything else: the sibling checkouts under `<root>/repos/`,
  // the toolchain resolver's `.caterpillar` cache, and the `<tasksDir>/<task>` directory
  // itself, which git has never heard of and would never remove.
  const root = await scratch();
  const sibling: RepoRef = { host: "github.com", owner: "acme", name: "gadget" };
  await seedMirror(root, REPO);
  await seedMirror(root, sibling);

  const task = asTaskId("REAP-1");
  const subject = manager(root);
  const checkout = await subject.ensureTaskCheckout([REPO, sibling], task);

  // The resolver writes here, and nothing in git knows about it (toolchain.ts,
  // `materialise`). A reap that only asked git would leave it.
  await mkdir(join(root, "tasks", task, ".caterpillar"), { recursive: true });
  await writeFile(join(root, "tasks", task, ".caterpillar", "env.json"), "{}\n");
  // Stand in for `node_modules`: the bytes that make this worth doing at all.
  await writeFile(join(checkout.root, "big"), "x".repeat(4096));

  assert.ok(existsSync(join(checkout.root, "repos", sibling.name)), "fixture is wrong");

  const reaped = await subject.removeTaskWorktrees(task, [REPO, sibling]);

  assert.equal(existsSync(join(root, "tasks", task)), false, "the task directory must go");
  assert.equal(reaped.worktrees, 1, "one task is one reap, however many repos it declared");
  assert.deepEqual([...reaped.tasks], [task]);
  assert.ok(reaped.bytes >= 4096, `must report the bytes it reclaimed, got ${reaped.bytes}`);

  // And the mirrors must not still believe those worktrees exist. An unpruned record is
  // not merely untidy: `checkedOutBranches` reads `worktree list` to build the fetch
  // refspec, so a mirror that is never pruned accumulates one permanent exclusion per
  // finished task and quietly stops tracking upstream.
  for (const repo of [REPO, sibling]) {
    const mirror = join(root, "mirrors", repo.host, repo.owner, `${repo.name}.git`);
    const listed = await new Git(mirror, HERMETIC).run("worktree", "list", "--porcelain");
    assert.ok(
      !listed.includes(task),
      `${repo.name}'s mirror still lists a worktree for ${task}:\n${listed}`,
    );
  }
});

test("reaping a task twice is not an error", async () => {
  // Idempotence is a requirement, not a nicety: the supervisor's terminal paths overlap,
  // and a pod that dies between the removal and the push comes back to a task whose
  // status says reap it again. It must be a no-op rather than a park.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("REAP-2");
  const subject = manager(root);
  await subject.ensureTaskCheckout([REPO], task);

  const first = await subject.removeTaskWorktrees(task, [REPO]);
  assert.equal(first.worktrees, 1);

  const second = await subject.removeTaskWorktrees(task, [REPO]);
  assert.equal(second.worktrees, 0, "a second reap must find nothing and say so");
  assert.equal(second.bytes, 0);
});

test("reaping a task whose worktree git will not remove still frees the disk", async () => {
  // `git worktree remove` refuses anything it finds surprising — a stale index.lock, a
  // submodule, a file it cannot stat. That refusal must not become "the biggest directory
  // on the volume stays forever", because the refusal is exactly the state a killed pod
  // leaves behind. `removeWorktree` swallows it via `tryRun`; the `rm -rf` is what makes
  // the swallowing honest.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("REAP-3");
  const subject = manager(root);
  const worktree = await subject.ensureWorktree(REPO, task);
  await writeFile(join(worktree, "index.lock"), "");
  await writeFile(join(worktree, "uncommitted"), "work the agent never pushed\n");

  await subject.removeTaskWorktrees(task, [REPO]);

  assert.equal(existsSync(join(root, "tasks", task)), false);
});

test("the sweep does not touch a task the caller says is live", async () => {
  // The worst failure this feature can produce, and the reason `live` is a parameter
  // rather than something inferred from mtimes: deleting the worktree of a session that
  // is running takes the agent's uncommitted work, its index and its resolved environment
  // at once, mid-turn, and what it reports afterwards is a git error about a directory
  // that vanished underneath it.
  const root = await scratch();
  await seedMirror(root, REPO);

  const live = asTaskId("REAP-LIVE");
  const dead = asTaskId("REAP-DEAD");
  const subject = manager(root);
  await subject.ensureWorktree(REPO, live);
  await subject.ensureWorktree(REPO, dead);

  // Both are far older than any keep-age, so the ONLY thing that can save the live one is
  // the guard under test.
  const reaped = await subject.reapStaleWorktrees({
    live: new Set([live]),
    keepHours: 0,
    now: Date.now() + 60_000,
  });

  assert.ok(existsSync(join(root, "tasks", live)), "a live task's worktree must survive");
  assert.equal(existsSync(join(root, "tasks", dead)), false, "an orphan must not");
  assert.deepEqual([...reaped.tasks], [dead]);
  assert.equal(reaped.worktrees, 1);
});

test("the sweep leaves a worktree that is younger than the keep-age", async () => {
  // The between-sessions case: parked awaiting a human, handed off and waiting to be
  // re-claimed, or sitting behind a provider cooldown. None of those are live and all of
  // them resume against this directory within hours.
  const root = await scratch();
  await seedMirror(root, REPO);

  const recent = asTaskId("REAP-RECENT");
  const subject = manager(root);
  await subject.ensureWorktree(REPO, recent);

  const reaped = await subject.reapStaleWorktrees({ live: new Set(), keepHours: 72 });

  assert.ok(existsSync(join(root, "tasks", recent)), "a fresh worktree must survive a sweep");
  assert.equal(reaped.worktrees, 0);
});

test("the sweep dates a task by its children, not just the directory git made", async () => {
  // A directory's mtime moves when an entry is added to or removed from IT — not when a
  // file inside one of its children is written. So `<tasksDir>/<TASK-ID>` carries the
  // timestamp of the moment the first repo was checked out and never moves again, and a
  // task worked over six sessions in the same checkout looks, from that one number, exactly
  // as stale as one abandoned on day one.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("REAP-NESTED");
  const subject = manager(root);
  const worktree = await subject.ensureWorktree(REPO, task);

  // Backdate the task directory itself past any keep-age, exactly as a long-lived checkout
  // would be, while the worktree under it is current — a session wrote in it just now.
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(join(root, "tasks", task), old, old);

  const reaped = await subject.reapStaleWorktrees({ live: new Set(), keepHours: 24 });

  assert.ok(
    existsSync(worktree),
    "a checkout whose CONTENTS are fresh must not be reaped for a stale parent directory",
  );
  assert.equal(reaped.worktrees, 0);
});

test("the sweep prunes the mirrors of what it removed", async () => {
  // The sweep never learns which repos an orphan held — the state repo that could say is
  // on another replica by now — so it prunes every mirror on the volume. Without it the
  // administrative record survives the `rm`, keeps holding its branch, and keeps
  // narrowing the fetch refspec for every later task on that repo.
  const root = await scratch();
  await seedMirror(root, REPO);

  const orphan = asTaskId("REAP-ORPHAN");
  const subject = manager(root);
  await subject.ensureWorktree(REPO, orphan);

  const mirror = mirrorDir(root);
  const before = await new Git(mirror, HERMETIC).run("worktree", "list", "--porcelain");
  assert.ok(before.includes(orphan), "fixture is wrong: the mirror should list the worktree");

  await subject.reapStaleWorktrees({
    live: new Set(),
    keepHours: 0,
    now: Date.now() + 60_000,
  });

  const after = await new Git(mirror, HERMETIC).run("worktree", "list", "--porcelain");
  assert.ok(!after.includes(orphan), `the mirror still lists the removed worktree:\n${after}`);
});

test("nothing outside tasksDir can be removed, whatever the task is called", async () => {
  // The containment assertion, tested directly because the input it guards against comes
  // from outside this process: task ids are read from directory names on a volume and
  // from a state repo that intake writes. `join(tasksDir, "..")` is the parent of every
  // mirror on the PVC — one `..` reaching the `rm` unchecked deletes the mirrors, the nix
  // store's GC roots and the state checkout, on a timer, and logs that it reclaimed a lot
  // of disk.
  const tasks = "/work/tasks";

  assert.throws(
    () => assertInside(tasks, "/work/tasks/../mirrors"),
    /refusing to remove/,
    "a `..` must never resolve out of tasksDir",
  );
  assert.throws(
    () => assertInside(tasks, "/work"),
    /refusing to remove/,
    "the parent is not inside the child",
  );
  assert.throws(
    () => assertInside(tasks, tasks),
    /refusing to remove/,
    "tasksDir itself is never removable — that would take every live task with it",
  );
  assert.throws(
    () => assertInside(tasks, "/work/tasks-old/T-1"),
    /refusing to remove/,
    "a prefix comparison would accept this sibling; `relative()` must not",
  );

  // And the ones that must be allowed, so the guard is not merely a refusal of everything.
  assert.doesNotThrow(() => assertInside(tasks, "/work/tasks/T-1"));
  assert.doesNotThrow(() => assertInside(tasks, "/work/tasks/T-1/widget/repos/gadget"));
  // A task id that merely LOOKS like a traversal is a legitimate directory name.
  assert.doesNotThrow(() => assertInside(tasks, "/work/tasks/..foo"));
});

test("a task id that escapes tasksDir is refused rather than obeyed", async () => {
  // The same guard reached through the public API, because the assertion is only worth
  // anything if the reap actually routes every removal through it.
  const root = await scratch();
  const outside = join(root, "precious");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "mirrors-live-here"), "do not delete\n");

  await mkdir(join(root, "tasks"), { recursive: true });

  await assert.rejects(
    () => manager(root).removeTaskWorktrees(asTaskId("../precious"), [REPO]),
    /refusing to remove/,
  );
  assert.ok(existsSync(join(outside, "mirrors-live-here")), "and it must still be there");
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

test("two concurrent checkouts against one mirror do not corrupt it", async () => {
  // Two tasks on the SAME repo, checked out at the same time — the case N concurrent
  // sessions per runner introduces (DESIGN.md §6.4) and the one that cannot be discovered
  // by reading the code, because git's own locking makes it intermittent rather than
  // wrong.
  //
  // `ensureTaskCheckout` fetches the mirror, adds a worktree to it and writes its common
  // config. Every one of those wants `index.lock`, and git does NOT queue for it: the loser
  // exits non-zero with `Unable to create '…/index.lock': File exists`. So without the
  // per-mirror lock this is a session that dies in its first thirty seconds, on a task with
  // nothing wrong with it, only when two tasks on one repo happen to start together — a
  // flaky task failure, which is the worst possible way to find out about a race.
  //
  // Started in the same tick and awaited together, which is what makes this a test of the
  // lock rather than of two sequential calls: if `onMirror` advanced its chain after an
  // await instead of synchronously, both would see the same predecessor and both would run.
  const root = await scratch();
  await seedMirror(root, REPO);

  const a = asTaskId("MIRROR-CONC-A");
  const b = asTaskId("MIRROR-CONC-B");

  // **The order of git invocations is the subject, and it has to be, because the damage is
  // not reliably reproducible from the outside.** Two `worktree add`s against a
  // three-commit mirror on a warm page cache finish in single-digit milliseconds, so the
  // `index.lock` collision that wrecks a production mirror lands maybe once in a hundred
  // runs here — and a test that catches a race one run in a hundred is a test that reports
  // the fix works while the bug is still in. Asserting on interleaving instead makes the
  // property deterministic, which is exactly the argument `loop.test.ts` makes for testing
  // the state-store mutex on ORDER rather than on the absence of a crash.
  //
  // The recorded delay is what a real fetch costs against a real remote, injected so that
  // an unsynchronised second caller has somewhere to interleave INTO. Without it both
  // callers race to completion and "they did not interleave" is a statement about the
  // scheduler rather than about the lock.
  const order: string[] = [];
  const MUTATING = new Set(["fetch", "clone", "worktree", "config"]);

  class TracingGit extends Git {
    override async tryRun(...args: readonly string[]): Promise<GitResult> {
      await this.trace(args);
      return super.tryRun(...args);
    }

    override async run(...args: readonly string[]): Promise<string> {
      await this.trace(args);
      return super.run(...args);
    }

    private async trace(args: readonly string[]): Promise<void> {
      const [subcommand] = args;
      if (subcommand === undefined || !MUTATING.has(subcommand)) return;
      // Which TASK this call belongs to, read off the arguments: every mirror-mutating call
      // in a checkout either names the task's path or its credential socket.
      const joined = args.join(" ");
      const task = joined.includes(a) ? a : joined.includes(b) ? b : undefined;
      if (task === undefined) return;
      order.push(`${task}:${subcommand}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    override at(cwd: string): Git {
      return new TracingGit(cwd, HERMETIC);
    }

    override withoutCredentials(): Git {
      return this;
    }
  }

  const subject = new WorktreeManager({
    git: new TracingGit(root, HERMETIC),
    mirrorsDir: join(root, "mirrors"),
    tasksDir: join(root, "tasks"),
    helperPath: "/usr/local/bin/caterpillar-cred",
    socketDir: "/run/caterpillar/cred",
    identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
  });

  const [first, second] = await Promise.all([
    subject.ensureTaskCheckout([REPO], a),
    subject.ensureTaskCheckout([REPO], b),
  ]);

  // Nothing belonging to one task may appear between the first and last call of the other.
  // That is the whole property: a checkout's fetch, `worktree add` and config writes are
  // one transaction against one mirror, and git's own locking refuses rather than queues.
  const owners = order.map((entry) => entry.split(":")[0]);
  const switches = owners.filter((owner, index) => index > 0 && owner !== owners[index - 1]);
  assert.ok(order.length >= 4, `the trace saw nothing to interleave: ${order.join(" ")}`);
  assert.equal(
    switches.length,
    1,
    `one mirror admits one checkout at a time; the trace changed hands ${switches.length} ` +
      `times: ${order.join(" ")}`,
  );

  // Both checkouts exist, on their own branches. A lost `worktree add` shows up here.
  assert.ok(existsSync(join(first.root, ".git")), "task A has no checkout");
  assert.ok(existsSync(join(second.root, ".git")), "task B has no checkout");

  const mirror = mirrorDir(root);
  const mirrorGit = new Git(mirror, HERMETIC);

  // The mirror itself must still be a coherent repository. `fsck` is the assertion that
  // covers what a half-written ref or a torn administrative record actually looks like —
  // "it did not throw" is true of a corrupted mirror right up until the next task uses it.
  await mirrorGit.run("fsck", "--no-progress");

  // And it must know about exactly the two worktrees, each on its own branch. A record
  // clobbered by a concurrent `worktree add` leaves a checkout on disk the mirror cannot
  // see, which `checkedOutBranches` then omits from the fetch refspec — so the NEXT task
  // on this repo fails with `refusing to fetch into branch … checked out at …`, naming a
  // branch it has never touched.
  const listed = await mirrorGit.run("worktree", "list", "--porcelain");
  const branches = listed
    .split("\n")
    .filter((line) => line.startsWith("branch "))
    .map((line) => line.slice("branch ".length).trim())
    .sort();
  assert.deepEqual(
    branches,
    [`refs/heads/agent/${a}`, `refs/heads/agent/${b}`],
    `the mirror must list both worktrees, on their own branches:\n${listed}`,
  );

  // Each worktree is on its own branch and neither has been left detached or pointed at
  // the other's. This is the failure the `revParse`-then-`worktree add` window produces
  // when a concurrent fetch moves a ref between the two calls.
  for (const [task, checkout] of [[a, first], [b, second]] as const) {
    const head = await new Git(checkout.root, HERMETIC).run("rev-parse", "--abbrev-ref", "HEAD");
    assert.equal(head.trim(), `agent/${task}`, `${task} is not on its own branch`);
  }

  // The shared config each checkout writes is identical between tasks — which is why those
  // writes are safe to share at all — and the per-task credential helper is NOT, which is
  // why that one lives in worktree scope. Both must have survived two writers.
  for (const [task, checkout] of [[a, first], [b, second]] as const) {
    const git = new Git(checkout.root, HERMETIC);
    assert.equal((await git.run("config", "remote.origin.push")).trim(), "HEAD");
    assert.match(await git.run("config", "credential.helper"), new RegExp(task));
  }
});

/**
 * Push a commit onto the remote's `agent/<task>` branch, as a session on another runner
 * would have. Answers with the oid the remote branch now points at.
 *
 * Goes through the seed clone `seedMirror` left behind rather than through the mirror,
 * because the mirror is the thing under test: the point is that the remote moved without
 * this runner's mirror hearing about it.
 */
const pushAgentBranch = async (
  root: string,
  repo: RepoRef,
  task: TaskId,
  content: string,
): Promise<string> => {
  const seed = join(root, `${repo.name}-seed`);
  const git = new Git(seed, HERMETIC);
  const branch = `agent/${task}`;

  const existing = await git.tryRun("rev-parse", "--verify", "--quiet", branch);
  await git.run(...(existing.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]));
  await writeFile(join(seed, "pushed"), content);
  await git.run("add", "-A");
  await git.run("commit", "-m", `work from another runner: ${content.trim()}`);
  await git.run("push", "origin", `HEAD:refs/heads/${branch}`);
  return (await git.run("rev-parse", "HEAD")).trim();
};

test("a session starts on the remote tip of its own branch, never behind it", async () => {
  // GH-96: eighteen commits went missing between sessions of one task, and session 7
  // re-implemented the whole thing from scratch because its worktree started on `main`.
  //
  // The mechanism is `MIRROR_REFSPECS`. `^refs/heads/agent/*` stops the mirror refresh
  // writing a branch a worktree holds, and it does that by never fetching agent refs at
  // all — so a mirror that has no local `refs/heads/agent/<task>` will never learn one
  // from the remote. `addWorktreeLocked` then finds no branch, creates one from the
  // mirror's default branch, and the session begins on the base with no way to tell that
  // apart from a task nobody has ever touched.
  //
  // Reachable whenever the local ref is missing or stale where the remote's is not: a
  // runner that never worked this task, a reaped worktree, a mirror re-cloned after a
  // failed fetch, or the branch reset GH-95 reported. In every one of those the remote
  // has the work and the invariant is the same — the worktree is at the remote tip, or
  // the session does not start.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("GH-96");
  const pushed = await pushAgentBranch(root, REPO, task, "eighteen commits\n");

  const worktree = await manager(root).ensureWorktree(REPO, task);

  assert.equal(
    (await new Git(worktree, HERMETIC).run("rev-parse", "HEAD")).trim(),
    pushed,
    "a fresh worktree must start at the remote tip of agent/<task>, not at the base",
  );
  assert.equal(
    (await new Git(worktree, HERMETIC).run("rev-parse", "--abbrev-ref", "HEAD")).trim(),
    `agent/${task}`,
  );
  // And the file the earlier session wrote is actually in the tree, so the agent can see
  // its own previous work rather than merely being on a ref that mentions it.
  assert.ok(
    existsSync(join(worktree, "pushed")),
    "the previous session's committed files must be checked out",
  );
});

test("a worktree reset behind its remote branch is not handed to a session as-is", async () => {
  // GH-95, the other half of GH-96. That session found its EXISTING worktree reset to a
  // commit before its own work, with the branch's commits reachable only from
  // `refs/pull/111/head`, and recovered them by hand.
  //
  // `addWorktreeLocked` returns early when the directory is already there, and the
  // comment says why: the probe and the verifier both call `ensureWorktree` after
  // `clearActive()` has closed the credential service (§9.2), so a fetch on that path
  // fails on a private repo and takes the post-session work down with it. That reasoning
  // holds for the READ paths. It does not license handing a session a checkout that is
  // behind the branch it is about to commit on: the next `git push` is refused as
  // non-fast-forward at the earliest, and at worst the agent concludes the task is
  // untouched and starts again.
  //
  // So the invariant is the same as the fresh-worktree one, minus the part this path
  // cannot promise: the session is at the remote tip, or it does not start. Refusing is
  // the acceptable outcome here — a human reconciles two histories, which is what GH-95
  // did — and it is strictly better than silence.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("GH-95");
  const subject = manager(root);

  // A worktree that exists and is BEHIND: created first, then another runner pushes.
  const worktree = await subject.ensureWorktree(REPO, task);
  const base = (await new Git(worktree, HERMETIC).run("rev-parse", "HEAD")).trim();
  const pushed = await pushAgentBranch(root, REPO, task, "the commits GH-95 recovered\n");
  assert.notEqual(pushed, base, "fixture is wrong: the remote must be ahead");

  const reused = await subject.ensureWorktree(REPO, task).catch((error: unknown) => error);

  if (reused instanceof Error) {
    assert.match(reused.message, /GH-95/, "a refusal must name the task a human has to look at");
    return;
  }
  assert.equal(
    (await new Git(String(reused), HERMETIC).run("rev-parse", "HEAD")).trim(),
    pushed,
    "a reused worktree must be moved to the remote tip, or the call must throw",
  );
});

test("a worktree holding commits the remote has not seen keeps them", async () => {
  // The regression `catchUpWorktree` could most easily introduce. A session commits and has
  // not pushed yet — the state this very task's own branch was found in — and the reuse path
  // now consults the remote. Anything that RESET the worktree to the remote tip would delete
  // work that exists nowhere else, which is strictly worse than the bug being fixed: a stale
  // start costs a duplicate implementation, a reset costs the implementation itself.
  //
  // So a fast-forward and only a fast-forward. `merge --ff-only` against an ancestor is a
  // no-op, which is the whole reason it is the verb there.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("AHEAD-1");
  const subject = manager(root);
  const pushed = await pushAgentBranch(root, REPO, task, "work from another runner\n");

  const worktree = await subject.ensureWorktree(REPO, task);
  const git = new Git(worktree, HERMETIC);
  await writeFile(join(worktree, "local-only"), "not pushed anywhere\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "committed here, never pushed");
  const local = (await git.run("rev-parse", "HEAD")).trim();
  assert.notEqual(local, pushed, "fixture is wrong: the worktree must be ahead");

  const reused = await subject.ensureWorktree(REPO, task);

  assert.equal(
    (await new Git(reused, HERMETIC).run("rev-parse", "HEAD")).trim(),
    local,
    "a worktree ahead of the remote must be left exactly where it is",
  );
  assert.ok(existsSync(join(reused, "local-only")), "and the file only it carries with it");
});

test("a worktree an agent moved off its own branch is left alone, not merged into", async () => {
  // `refspecs` already carries the evidence that this happens: an agent that ran
  // `git checkout` reproduced the mirror-fetch refusal under a branch name no pattern
  // could match, which is why the held set comes from `worktree list` rather than from a
  // convention. So the catch-up cannot assume HEAD is on `agent/<task>`.
  //
  // Getting it wrong is not a missed opportunity, it is damage: `merge --ff-only` while the
  // worktree stands on `main` would fast-forward MAIN onto the task branch, and the agent's
  // next push — pinned to the current branch by `remote.origin.push = HEAD` — would deliver
  // unreviewed task commits to the default branch.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("WANDERED-1");
  const subject = manager(root);
  const pushed = await pushAgentBranch(root, REPO, task, "work from another runner\n");

  const worktree = await subject.ensureWorktree(REPO, task);
  const git = new Git(worktree, HERMETIC);
  // The mirror's default branch is behind the task branch here, which is exactly the shape
  // that makes a stray `merge --ff-only` succeed and therefore be dangerous.
  await git.run("checkout", "-B", "wandered", `${pushed}~1`);
  const before = (await git.run("rev-parse", "HEAD")).trim();

  const reused = await subject.ensureWorktree(REPO, task);
  const after = new Git(String(reused), HERMETIC);

  assert.equal(
    (await after.run("rev-parse", "HEAD")).trim(),
    before,
    "a worktree standing on another branch must not be fast-forwarded onto the task branch",
  );
  assert.equal((await after.run("rev-parse", "--abbrev-ref", "HEAD")).trim(), "wandered");
});

test("a session refuses to start when origin cannot be asked about its branch", async () => {
  // The hole the rest of this fix leaves open, and it is GH-96 by another route. Every
  // question this module asks about `origin/agent/<task>` is asked with a fetch, and a fetch
  // reports "the remote has no such branch" and "I could not reach the remote at all" as the
  // same plain non-zero. `fetchAgentBranch` therefore answers `undefined` to both, and the
  // reuse path reads that as "nothing pushed" and hands the worktree over as it found it.
  //
  // So one expired credential, one DNS blip, one throttled forge is enough to start a
  // session on the base with eighteen commits sitting upstream — the exact outcome the
  // invariant says must be impossible, reached without any local ref being wrong.
  //
  // Tolerating it is not an option a caller inside a live credential lease needs. The
  // reason `fetchAgentBranch` cannot throw is the POST-session callers, which run after
  // `clearActive()` (§9.2) and must not fail verification over a fetch they never needed.
  // The session-start caller is the opposite case: it holds the lease, so a remote it
  // cannot reach is a fault to report, not a silence to read as an answer.
  const root = await scratch();
  await seedMirror(root, REPO);

  const task = asTaskId("UNREACHABLE-1");
  const subject = manager(root);

  // A worktree that exists, so the reuse path runs and the mirror is not synced. Then
  // another runner pushes, and only then does origin become unreachable — the pushed work
  // is real and the remote is the only place that knows about it.
  await subject.ensureWorktree(REPO, task);
  await pushAgentBranch(root, REPO, task, "work this runner cannot see\n");
  await rename(join(root, `${REPO.name}-origin.git`), join(root, "origin-moved-away.git"));

  await assert.rejects(
    () => subject.ensureTaskCheckout([REPO], task, { mustReachRemote: true }),
    (error: unknown) =>
      error instanceof Error && new RegExp(`agent/${task}`).test(error.message),
    "a session-start checkout must refuse rather than guess that nothing was pushed",
  );
});

test("commitsSince reads the branch's commits oldest-first, with what each touched", async () => {
  // Feeds `review/tdd.ts`, whose whole subject is the ORDER — so oldest-first is the
  // contract, not a detail. `git log` defaults to newest-first, which would invert every
  // test-first verdict the council reaches while looking entirely plausible.
  const root = await scratch();
  const repo = join(root, "work");
  const plain = new Git(root, HERMETIC);
  await plain.run("init", "--initial-branch=main", repo);

  const git = new Git(repo, HERMETIC);
  await writeFile(join(repo, "README.md"), "seed\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "Seed the repository");
  const base = (await git.run("rev-parse", "HEAD")).trim();

  await writeFile(join(repo, "widget.test.ts"), "assert(false)\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "Add a failing test for the widget");

  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "widget.ts"), "export const widget = 1\n");
  await writeFile(join(repo, "widget.test.ts"), "assert(true)\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "Make the widget test pass");

  const commits = await manager(root).commitsSince(repo, base);

  assert.deepEqual(
    commits.map((c) => c.subject),
    ["Add a failing test for the widget", "Make the widget test pass"],
  );
  assert.deepEqual(commits[0]?.files, ["widget.test.ts"]);
  assert.deepEqual(commits[1]?.files, ["src/widget.ts", "widget.test.ts"]);
  // Abbreviated, because it is shown to a reviewer next to the `git log` it can run.
  assert.match(commits[0]?.oid ?? "", /^[0-9a-f]{7,}$/);
});

test("commitsSince is empty when the branch has added nothing", async () => {
  const root = await scratch();
  const repo = join(root, "work");
  await new Git(root, HERMETIC).run("init", "--initial-branch=main", repo);

  const git = new Git(repo, HERMETIC);
  await writeFile(join(repo, "f"), "one\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "Seed");
  const base = (await git.run("rev-parse", "HEAD")).trim();

  assert.deepEqual(await manager(root).commitsSince(repo, base), []);
});

test("commitsSince answers with nothing rather than throwing on a bad base", async () => {
  // Reachable: `branchPoint` resolves against the mirror's default branch, and a worktree
  // whose mirror has been re-pointed can hand over a ref this repository does not carry.
  // The council must still convene — losing the evidence block is a degradation, losing
  // the review is an outage.
  const root = await scratch();
  const repo = join(root, "work");
  await new Git(root, HERMETIC).run("init", "--initial-branch=main", repo);

  const git = new Git(repo, HERMETIC);
  await writeFile(join(repo, "f"), "one\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "Seed");

  assert.deepEqual(await manager(root).commitsSince(repo, "0000000000000000000000000000000000000000"), []);
});
