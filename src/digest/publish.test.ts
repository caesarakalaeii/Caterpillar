/**
 * Publishing once, fleet-wide, and never losing a day quietly.
 *
 * Every runner in a fleet reaches 18:00 at the same moment and every one of them can read
 * the whole state repo, so "publish the digest" is a race by construction. It is settled
 * the way task claiming is (DESIGN.md §5): an atomic ref that only one push can create.
 *
 * The failure these tests exist for is the asymmetric one. Double-posting is embarrassing;
 * a day that is marked published and never was is INVISIBLE — the ref says done, no
 * message arrives, and nobody finds out until they go looking for a digest that never
 * existed. So the claim is released whenever publishing failed.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import type { Notification } from "../notify/discord.ts";
import { JsonLogger } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import type { AttributionReport } from "./attribution.ts";
import { DailyDigest, digestRef } from "./publish.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const BOUNDARY = { hour: 18, timeZone: "Europe/Berlin" } as const;
/** 18:30 Berlin on the 16th — today's digest is due, and yesterday's is overdue. */
const EVENING = new Date("2026-08-16T16:30:00Z");
/** 17:00 Berlin on the 16th — nothing is due but yesterday's. */
const AFTERNOON = new Date("2026-08-16T15:00:00Z");

const state = (id: string): TaskState => ({
  id: asTaskId(id),
  status: "done",
  phase: "implementing",
  requires: [],
  sessions: 2,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 1.5 },
  progress: { lastProgressSession: 2, noProgressStreak: 0 },
  createdAt: "2026-08-16T09:00:00Z",
  updatedAt: "2026-08-16T09:00:00Z",
});

/** A state repo whose only commit lands inside the window for the 16th. */
const stateRepo = async (): Promise<Git> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-publish-"));
  roots.push(root);

  const git = new Git(root, {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-16T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-16T09:00:00Z",
  });
  await git.run("init", "--quiet", "--initial-branch=main");
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");

  await mkdir(join(root, "tasks", "TASK-1"), { recursive: true });
  await writeFile(
    join(root, "tasks", "TASK-1", "state.json"),
    JSON.stringify(state("TASK-1")),
    "utf8",
  );
  await git.run("add", "-A");
  await git.run("commit", "-m", "a task finished");

  return new Git(root);
};

interface Harness {
  readonly digest: DailyDigest;
  readonly written: Map<string, string>;
  readonly pushes: string[];
  readonly notifications: Notification[];
  readonly claims: string[];
  readonly released: string[];
}

interface HarnessOptions {
  readonly claimed?: boolean;
  readonly refExists?: boolean;
  readonly pushFails?: boolean;
  readonly notifyFails?: boolean;
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const written = new Map<string, string>();
  const pushes: string[] = [];
  const notifications: Notification[] = [];
  const claims: string[] = [];
  const released: string[] = [];

  const digest = new DailyDigest({
    git: await stateRepo(),
    boundary: BOUNDARY,
    runner: "pod-7f3a",
    branch: "main",
    logger: new JsonLogger({ level: "error", write: () => undefined }),
    store: {
      writeDigest: async (date, body) => {
        written.set(date, body);
      },
      commitAndPush: async (message) => {
        if (options.pushFails === true) throw new Error("the remote rejected it");
        pushes.push(message);
      },
    },
    leases: {
      claimOnce: async (ref) => {
        claims.push(ref);
        return options.claimed === false ? undefined : `oid-for-${ref}`;
      },
      hasRef: async () => options.refExists === true,
      releaseRef: async (ref) => {
        released.push(ref);
      },
    },
    notifier: {
      notify: async (notification) => {
        if (options.notifyFails === true) throw new Error("discord is down");
        notifications.push(notification);
      },
    },
  });

  return { digest, written, pushes, notifications, claims, released };
};

test("at the hour, the digest is written, pushed and announced", async () => {
  const subject = await harness();

  await subject.digest.maybePublish(EVENING);

  // Yesterday's is the overdue one, so it goes first — the channel must read forwards.
  assert.deepEqual(subject.claims, [digestRef("2026-08-15")]);
  assert.ok(subject.written.has("2026-08-15"));
  assert.equal(subject.pushes.length, 1);
  assert.match(subject.pushes[0] ?? "", /2026-08-15/);

  const announced = subject.notifications[0];
  assert.equal(announced?.kind, "digest");
  assert.equal(announced?.kind === "digest" ? announced.date : undefined, "2026-08-15");
});

test("one digest per poll, even when two are due", async () => {
  // Publishing both back to back delays claiming a task by two model calls and two pushes.
  // The second is still due on the next poll, thirty seconds later.
  const subject = await harness();

  await subject.digest.maybePublish(EVENING);
  assert.equal(subject.written.size, 1);

  await subject.digest.maybePublish(EVENING);
  assert.deepEqual([...subject.written.keys()], ["2026-08-15", "2026-08-16"]);

  // And then it stops: a published day is not re-attempted on every poll for the rest of
  // the evening, which would be a wasted `ls-remote` every thirty seconds.
  await subject.digest.maybePublish(EVENING);
  assert.equal(subject.written.size, 2);
  assert.equal(subject.claims.length, 2);
});

test("nothing is published before the configured hour", async () => {
  const subject = await harness();

  await subject.digest.maybePublish(AFTERNOON);

  assert.deepEqual(
    [...subject.written.keys()],
    ["2026-08-15"],
    "yesterday's cutoff has passed; today's has not",
  );
});

test("a runner that loses the claim publishes nothing", async () => {
  const subject = await harness({ claimed: false, refExists: true });

  await subject.digest.maybePublish(EVENING);

  assert.equal(subject.written.size, 0);
  assert.equal(subject.notifications.length, 0);
  assert.equal(subject.released.length, 0, "it never held the claim, so it must not delete it");
});

test("a claim that failed for any other reason is retried, not written off", async () => {
  // `claimOnce` cannot tell a lost race from a dead network — both are a failed push. If
  // the ref is not there afterwards, nobody has published that day and this runner must
  // try again rather than mark it done forever.
  const subject = await harness({ claimed: false, refExists: false });

  await subject.digest.maybePublish(EVENING);
  await subject.digest.maybePublish(EVENING);

  assert.equal(subject.claims.length, 2, "it tried again on the next poll");
});

test("a failed push releases the claim, so the day is not lost", async () => {
  // The asymmetry this whole path is built around: a claimed-but-unpublished day is
  // silent. Nothing ever revisits it, and nobody notices a digest that never arrived.
  const subject = await harness({ pushFails: true });

  await subject.digest.maybePublish(EVENING);

  assert.deepEqual(subject.released, [digestRef("2026-08-15")]);
  assert.equal(subject.notifications.length, 0, "nothing was announced that is not in git");

  await subject.digest.maybePublish(EVENING);
  assert.equal(subject.claims.length, 2, "and the day is attempted again");
});

test("Discord failing does not undo a digest that is already in git", async () => {
  // Same rule as every other notification (§11.2): git is authoritative and Discord is a
  // view. Re-publishing to recover a lost message would rewrite the record it announces.
  const subject = await harness({ notifyFails: true });

  await subject.digest.maybePublish(EVENING);

  assert.equal(subject.written.size, 1);
  assert.equal(subject.pushes.length, 1);
  assert.deepEqual(subject.released, [], "the claim stands — the digest exists");
});

test("a shutdown during the summary hands the day back whole", async () => {
  // The prose is one model call and it is the only part of a digest that waits on a
  // network. A pod being torn down must not push half a document and must not mark the day
  // done — the next boot publishes it complete, prose included.
  const subject = await harness();
  const controller = new AbortController();

  await subject.digest.maybePublish(EVENING, controller.signal);
  assert.equal(subject.written.size, 1, "an unaborted poll publishes normally");

  controller.abort();
  await subject.digest.maybePublish(EVENING, controller.signal);

  assert.equal(subject.written.size, 1, "nothing more was written after the abort");
  assert.equal(subject.claims.length, 1, "and no further day was even claimed");
});

test("the digest names the day it covers, and says what moved", async () => {
  const subject = await harness();

  await subject.digest.maybePublish(EVENING);
  await subject.digest.maybePublish(EVENING);

  const today = subject.written.get("2026-08-16") ?? "";
  assert.match(today, /# Daily digest — 2026-08-16/);
  assert.match(today, /TASK-1/);
  assert.match(today, /done/);
});

/* -------------------------------------------------------------------- attribution */

const FLEET_EMAIL = "316492202+caterpillar-agent[bot]@users.noreply.github.com";

/** The same state repo, plus a spec naming a repo so authorship has somewhere to look. */
const stateRepoWithSpec = async (): Promise<Git> => {
  const git = await stateRepo();
  const root = await git.run("rev-parse", "--show-toplevel");

  const stamped = new Git(root, {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-16T09:30:00Z",
    GIT_COMMITTER_DATE: "2026-08-16T09:30:00Z",
  });
  await writeFile(
    join(root, "tasks", "TASK-1", "spec.md"),
    ["---", "workspace: primary", "repos:", "  - github.com/acme/widget", "---", "", "# Fix it", ""].join("\n"),
    "utf8",
  );
  await stamped.run("add", "-A");
  await stamped.run("commit", "-m", "the spec");

  return new Git(root);
};

test("the published digest carries the authorship split and counts it", async () => {
  const written = new Map<string, string>();
  const recorded: AttributionReport[] = [];

  const digest = new DailyDigest({
    git: await stateRepoWithSpec(),
    boundary: BOUNDARY,
    runner: "pod-7f3a",
    branch: "main",
    logger: new JsonLogger({ level: "error", write: () => undefined }),
    store: {
      writeDigest: async (date, body) => {
        written.set(date, body);
      },
      commitAndPush: async () => undefined,
    },
    leases: {
      claimOnce: async (ref) => `oid-for-${ref}`,
      hasRef: async () => false,
      releaseRef: async () => undefined,
    },
    notifier: { notify: async () => undefined },
    identity: { emails: [FLEET_EMAIL] },
    authorship: {
      readAuthorship: async (repos, from) => ({
        // Only the window being reported has commits; the baseline before it is empty,
        // which is the ordinary shape of a first-ever digest.
        commits:
          from.getTime() === new Date("2026-08-15T16:00:00Z").getTime()
            ? [
                {
                  repo: `${repos[0]?.owner}/${repos[0]?.name}`,
                  sha: "abc",
                  authorEmail: FLEET_EMAIL,
                  insertions: 40,
                  deletions: 0,
                },
              ]
            : [],
        unavailable: [],
      }),
    },
    onAttributed: (report) => recorded.push(report),
  });

  await digest.maybePublish(EVENING);
  await digest.maybePublish(EVENING);

  const today = written.get("2026-08-16") ?? "";
  assert.match(today, /## Authorship/);
  assert.match(today, /acme\/widget/);
  assert.match(today, /100%/);

  assert.equal(recorded.at(-1)?.total.fleet.lines, 40, "the metric sees the same report");
});
