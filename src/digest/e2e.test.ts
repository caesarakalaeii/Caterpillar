/**
 * The whole digest path against real git: a real remote, a real state repo, a real bare
 * mirror, and two runners racing for the same day.
 *
 * Everything else about a digest is testable with fakes. This is not. The claim rests on
 * `--force-with-lease=<ref>:` with an EMPTY expected value meaning "must not already
 * exist" — a git behaviour, not a behaviour of this code — and a fake that returns
 * "already claimed" proves only that the fake was written to. The same goes for the push:
 * a digest that is written to disk and never staged survives until the next poll's
 * `reset --hard` and then does not exist.
 *
 * So this test asserts on the ORIGIN, never on a checkout: what a second runner would find.
 *
 * The model is the one thing left out. It has no ground truth to check against and it costs
 * money to ask; `summarise.test.ts` pins what it is shown instead.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asRunnerId, asTaskId, type TaskState } from "../domain/task.ts";
import type { Notification } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import { LeaseManager } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { WorktreeManager } from "../workspace/worktree.ts";
import { MirrorChangeReader } from "./changes.ts";
import { digestRef, DailyDigest } from "./publish.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const BOUNDARY = { hour: 18, timeZone: "Europe/Berlin" } as const;
/** 18:30 Berlin on the 16th. Both the 15th and the 16th are due; the 15th goes first. */
const EVENING = new Date("2026-08-16T16:30:00Z");
const TASK = asTaskId("TASK-118");

const identify = async (git: Git): Promise<void> => {
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");
};

const state = (): TaskState => ({
  id: TASK,
  status: "done",
  phase: "review",
  requires: ["linux"],
  sessions: 4,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 120_000, outputTokens: 9_000, costUsd: 2.11 },
  progress: { lastProgressSession: 4, noProgressStreak: 0 },
  pr: { number: 44, url: "https://example.invalid/acme/widget/pull/44" },
  createdAt: "2026-08-16T09:00:00Z",
  updatedAt: "2026-08-16T15:00:00Z",
});

const SPEC = [
  "---",
  "workspace: caesar",
  "repos:",
  "  - github.com/acme/widget",
  "acceptance:",
  "  - npm test",
  "---",
  "",
  "# resume clears the no-progress streak",
  "",
  "A parked task that is resumed keeps counting sessions it never ran.",
  "",
].join("\n");

interface World {
  readonly origin: string;
  readonly root: string;
  /** A runner with its own clone of the state repo and its own mirrors. */
  readonly runner: (id: string) => Promise<Runner>;
}

interface Runner {
  readonly digest: DailyDigest;
  readonly notifications: Notification[];
}

/**
 * A bare origin holding one finished task, and a mirror carrying the branch it produced.
 *
 * The task's history is committed at a moment inside the window for the 16th, stamped with
 * `GIT_COMMITTER_DATE` — the collector selects commits by committer date, so this is what
 * puts the work inside the day.
 */
const world = async (): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-digest-e2e-"));
  roots.push(root);

  const origin = join(root, "origin.git");
  const setup = new Git(root);
  await setup.run("init", "--bare", "--quiet", "--initial-branch=main", origin);

  // Seed the state repo, from a throwaway clone that is not one of the runners.
  const seedPath = join(root, "seed");
  await setup.run("clone", "--quiet", origin, seedPath);
  const seed = new Git(seedPath, {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-16T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-16T09:00:00Z",
  });
  await identify(seed);

  await mkdir(join(seedPath, "tasks", TASK), { recursive: true });
  await writeFile(join(seedPath, "tasks", TASK, "spec.md"), SPEC, "utf8");
  await writeFile(
    join(seedPath, "tasks", TASK, "state.json"),
    `${JSON.stringify(state(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(seedPath, "tasks", TASK, "journal.md"),
    "\n## Session 4 — 2026-08-16T14:00:00Z\n\nThe streak was never cleared on resume. Fixed and covered.\n",
    "utf8",
  );
  await seed.run("add", "-A");
  await seed.run("commit", "-m", `chore(${TASK}): done`);
  await seed.run("push", "origin", "HEAD:main");

  // The repo the task worked in, and the mirror a runner would hold of it.
  const upstream = join(root, "upstream");
  await setup.run("init", "--quiet", "--initial-branch=main", upstream);
  const app = new Git(upstream);
  await identify(app);
  await writeFile(join(upstream, "commands.ts"), "export const resume = () => 1;\n", "utf8");
  await app.run("add", "-A");
  await app.run("commit", "-m", "base");
  await app.run("checkout", "--quiet", "-b", `agent/${TASK}`);
  await writeFile(
    join(upstream, "commands.ts"),
    "export const resume = () => 1;\nexport const clearStreak = () => 0;\n",
    "utf8",
  );
  await writeFile(join(upstream, "commands.test.ts"), "// covers the streak\n", "utf8");
  await app.run("add", "-A");
  await app.run("commit", "-m", "fix(notify): /resume clears the no-progress streak");
  await app.run("checkout", "--quiet", "main");

  return {
    origin,
    root,
    runner: async (id: string): Promise<Runner> => {
      const statePath = join(root, id);
      await setup.run("clone", "--quiet", origin, statePath);
      const git = new Git(statePath);
      await identify(git);

      const mirrorsDir = join(root, `${id}-mirrors`);
      await mkdir(join(mirrorsDir, "github.com", "acme"), { recursive: true });
      await setup.run(
        "clone",
        "--mirror",
        "--quiet",
        upstream,
        join(mirrorsDir, "github.com", "acme", "widget.git"),
      );

      const notifications: Notification[] = [];
      return {
        notifications,
        digest: new DailyDigest({
          git,
          store: new StateStore(statePath, git),
          leases: new LeaseManager({
            git,
            remote: "origin",
            runner: asRunnerId(id),
            staleAfterSeconds: 300,
          }),
          notifier: {
            notify: async (notification) => {
              notifications.push(notification);
            },
          },
          logger: SILENT_LOGGER,
          boundary: BOUNDARY,
          runner: id,
          branch: "main",
          changes: new MirrorChangeReader(
            new WorktreeManager({
              git,
              mirrorsDir,
              tasksDir: join(root, `${id}-tasks`),
              helperPath: "/nonexistent/helper",
              socketDir: "/nonexistent/socket",
              identity: { name: "test", email: "test@example.invalid" },
            }),
          ),
        }),
      };
    },
  };
};

/** What is on the remote — the only thing another runner can see. */
const onOrigin = async (origin: string, path: string): Promise<string | undefined> => {
  const result = await new Git(origin).tryRun("show", `main:${path}`);
  return result.code === 0 ? result.stdout : undefined;
};

test("a digest reaches the remote, with the code it is describing", async () => {
  const scene = await world();
  const runner = await scene.runner("pod-a");

  // The 15th first — the state repo has no history in that window, so it is a quiet day.
  await runner.digest.maybePublish(EVENING);
  await runner.digest.maybePublish(EVENING);

  const published = await onOrigin(scene.origin, "digests/2026-08-16.md");
  assert.ok(published !== undefined, "the digest must be committed AND pushed, not just written");

  assert.match(published, /# Daily digest — 2026-08-16/);
  assert.match(published, /TASK-118/);
  assert.match(published, /resume clears the no-progress streak/);
  assert.match(published, /new → \*\*done\*\*/);
  assert.match(published, /4 sessions/);
  assert.match(published, /\$2\.11/);
  assert.match(published, /example\.invalid\/acme\/widget\/pull\/44/);

  // From the mirror, not from anything the agent claimed about itself.
  assert.match(published, /acme\/widget/);
  assert.match(published, /fix\(notify\): \/resume clears the no-progress streak/);
  assert.match(published, /2 files, \+2\/-0/);

  const announced = runner.notifications.at(-1);
  assert.equal(announced?.kind, "digest");
  assert.equal(announced?.kind === "digest" ? announced.date : "", "2026-08-16");
  assert.match(announced?.kind === "digest" ? announced.body : "", /TASK-118/);
});

test("two runners racing publish each day exactly once between them", async () => {
  // The claim is `--force-with-lease=<ref>:` with an empty expected value, which is a
  // GIT behaviour: a fake that answers "already claimed" proves only that the fake was
  // written to. Both runners here push to the same real remote.
  //
  // Interleaved on purpose. Two days are due, each publishes at most one per poll, and a
  // day the other runner took must be skipped rather than treated as this runner's turn
  // to stop — so the pair converge on one digest per day with neither doing both.
  const scene = await world();
  const first = await scene.runner("pod-a");
  const second = await scene.runner("pod-b");

  for (let poll = 0; poll < 4; poll += 1) {
    await first.digest.maybePublish(EVENING);
    await second.digest.maybePublish(EVENING);
  }

  const published = [...first.notifications, ...second.notifications].map((notification) =>
    notification.kind === "digest" ? notification.date : "not a digest",
  );

  assert.deepEqual(
    [...published].sort(),
    ["2026-08-15", "2026-08-16"],
    "each day once, and no day twice",
  );
  assert.ok(first.notifications.length > 0 && second.notifications.length > 0, "both took one");

  const refs = await new Git(scene.origin).run(
    "for-each-ref",
    "--format=%(refname)",
    "refs/digests",
  );
  assert.deepEqual(refs.split("\n").filter(Boolean), [
    digestRef("2026-08-15"),
    digestRef("2026-08-16"),
  ]);
});

test("a published day stays published, for a runner that never saw it happen", async () => {
  // The in-memory set of settled days is an optimisation over a check that is
  // authoritative on the remote. A restarted pod has an empty one, and must still not
  // republish a day someone already did.
  const scene = await world();
  const runner = await scene.runner("pod-a");
  const other = await scene.runner("pod-b");

  await runner.digest.maybePublish(EVENING);
  await runner.digest.maybePublish(EVENING);
  assert.ok(await onOrigin(scene.origin, "digests/2026-08-16.md"));

  await other.digest.maybePublish(EVENING);
  await other.digest.maybePublish(EVENING);
  assert.equal(other.notifications.length, 0, "both days are already claimed on the remote");
});

test("a push the remote refuses hands the day back rather than losing it", async () => {
  // The asymmetric failure, with a real refusal: the claim lands, the state push does not.
  // A day left claimed and unpublished is silent — the ref says done, no message arrives,
  // and nothing ever revisits it.
  //
  // The refusal is a server-side hook that declines `main` only, which is what a protected
  // branch or a full disk looks like from here. It has to be installed AFTER seeding, or
  // there would be no state repo to report on.
  const scene = await world();
  const hook = join(scene.origin, "hooks", "update");
  await writeFile(
    hook,
    '#!/bin/sh\ncase "$1" in refs/heads/main) echo "declined" >&2; exit 1;; esac\nexit 0\n',
    { encoding: "utf8", mode: 0o755 },
  );

  const runner = await scene.runner("pod-a");
  await runner.digest.maybePublish(EVENING);

  assert.equal(runner.notifications.length, 0, "nothing is announced that is not in git");
  assert.equal(await onOrigin(scene.origin, "digests/2026-08-15.md"), undefined);

  const refs = await new Git(scene.origin).run(
    "for-each-ref",
    "--format=%(refname)",
    "refs/digests",
  );
  assert.equal(refs.trim(), "", "the claim was handed back, so the day can be retried");

  // And once the remote accepts pushes again, the day publishes on an ordinary poll.
  await rm(hook);
  await runner.digest.maybePublish(EVENING);
  assert.ok(await onOrigin(scene.origin, "digests/2026-08-15.md"));
});
