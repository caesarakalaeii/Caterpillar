/**
 * Regression tests for two bugs that only surfaced against a real private repo in
 * the cluster — the unit tests and every live credential check passed while the
 * mirror path was broken.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "../state/git.ts";
import { asTaskId, type RepoRef } from "../domain/task.ts";
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
