/**
 * What the digest says happened, against a real state repo.
 *
 * The whole point of collecting from git rather than from the current `state.json` is that
 * a snapshot cannot answer "what changed today" — a task that ran four sessions and one
 * that has sat untouched since Tuesday look identical in it. So these tests build actual
 * history with actual commit dates and assert on the DELTAS, including the two cases a
 * snapshot gets silently wrong: a task that existed before the window, and a catch-up
 * digest run after the window has already closed.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId, type RepoRef, type TaskState } from "../domain/task.ts";
import { Git } from "../state/git.ts";
import type { AuthoredCommit } from "./attribution.ts";
import { collectDay, type AuthorshipRead, type AuthorshipReader } from "./collect.ts";
import { previousWindow, windowFor } from "./day.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 18:00 Berlin on the 15th to 18:00 Berlin on the 16th. */
const WINDOW = windowFor("2026-08-16", { hour: 18, timeZone: "Europe/Berlin" });

const BEFORE = "2026-08-15T09:00:00Z";
const INSIDE = "2026-08-16T09:00:00Z";
const LATER = "2026-08-16T11:00:00Z";
const AFTER = "2026-08-16T20:00:00Z";

const state = (overrides: Partial<TaskState> & Pick<TaskState, "id">): TaskState => ({
  status: "ready",
  phase: "implementing",
  requires: [],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: BEFORE,
  updatedAt: BEFORE,
  ...overrides,
});

const SPEC = (goal: string): string =>
  [
    "---",
    "workspace: primary",
    "repos:",
    "  - github.com/acme/widget",
    "acceptance:",
    "  - npm test",
    "---",
    "",
    goal,
    "",
  ].join("\n");

interface Repo {
  readonly root: string;
  /** Write files and commit them, stamped at `when`. */
  readonly commit: (when: string, files: Record<string, string>) => Promise<void>;
}

const repo = async (): Promise<Repo> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-digest-"));
  roots.push(root);

  const git = new Git(root);
  await git.run("init", "--quiet", "--initial-branch=main");
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");

  return {
    root,
    commit: async (when: string, files: Record<string, string>): Promise<void> => {
      for (const [path, contents] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), contents, "utf8");
      }
      const stamped = new Git(root, {
        ...process.env,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
      await stamped.run("add", "-A");
      await stamped.run("commit", "-m", `state at ${when}`);
    },
  };
};

const collect = (root: string): ReturnType<typeof collectDay> =>
  collectDay({ git: new Git(root), window: WINDOW });

test("a task created and finished inside the window reports the whole of itself", async () => {
  const subject = await repo();
  const id = asTaskId("TASK-1");

  await subject.commit(BEFORE, { "README.md": "state repo\n" });
  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# Fix the widget\n\nIt drops frames."),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
    [`tasks/${id}/journal.md`]: "\n## Session 1\n\nStarted.\n",
  });
  await subject.commit(LATER, {
    [`tasks/${id}/state.json`]: JSON.stringify(
      state({
        id,
        status: "done",
        sessions: 3,
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 2.5 },
        pr: { number: 44, url: "https://example.invalid/pr/44" },
      }),
    ),
    [`tasks/${id}/journal.md`]: "\n## Session 1\n\nStarted.\n\n## Session 3\n\nOpened the PR.\n",
  });

  const digest = await collect(subject.root);

  assert.equal(digest.changed.length, 1);
  const change = digest.changed[0];
  assert.equal(change?.id, id);
  assert.equal(change?.title, "Fix the widget", "the spec's first heading names the task");
  assert.equal(change?.from, undefined, "absent `from` is what marks a task created today");
  assert.equal(change?.to, "done");
  assert.equal(change?.sessions, 3);
  assert.equal(change?.costUsd, 2.5);
  assert.equal(change?.prUrl, "https://example.invalid/pr/44");
  assert.equal(change?.prOpened, true);
  assert.match(change?.journal ?? "", /Opened the PR/);
});

test("deltas are against the start of the window, not against zero", async () => {
  // The failure this pins: reporting a task's LIFETIME sessions and cost as though the
  // fleet had spent them today. A long-running task would then dominate every digest it
  // appears in, with numbers that grow every day and are wrong every day.
  const subject = await repo();
  const id = asTaskId("TASK-2");

  await subject.commit(BEFORE, {
    [`tasks/${id}/spec.md`]: SPEC("# Long one"),
    [`tasks/${id}/state.json`]: JSON.stringify(
      state({
        id,
        status: "running",
        sessions: 2,
        usage: { inputTokens: 500, outputTokens: 100, costUsd: 1 },
      }),
    ),
  });
  await subject.commit(INSIDE, {
    [`tasks/${id}/state.json`]: JSON.stringify(
      state({
        id,
        status: "awaiting-human",
        sessions: 5,
        usage: { inputTokens: 2000, outputTokens: 400, costUsd: 4 },
      }),
    ),
    [`tasks/${id}/questions/001-question.md`]: "Which schema?\n",
  });

  const digest = await collect(subject.root);
  const change = digest.changed[0];

  assert.equal(change?.from, "running", "it existed before the window");
  assert.equal(change?.to, "awaiting-human");
  assert.equal(change?.sessions, 3, "5 today minus 2 at the start");
  assert.equal(change?.costUsd, 3);
  assert.equal(change?.questionsAsked, 1);
  assert.equal(digest.totals.sessions, 3);
  assert.equal(digest.totals.costUsd, 3);
});

test("a task nothing touched is not a change, but is still open", async () => {
  // A digest that only listed movement would let a task sit in `awaiting-human` for a
  // week without ever being mentioned again — which is exactly the task most worth
  // mentioning.
  const subject = await repo();
  const moved = asTaskId("TASK-3");
  const stuck = asTaskId("TASK-4");

  await subject.commit(BEFORE, {
    [`tasks/${stuck}/spec.md`]: SPEC("# Blocked on you"),
    [`tasks/${stuck}/state.json`]: JSON.stringify(
      state({ id: stuck, status: "awaiting-human", sessions: 2, updatedAt: BEFORE }),
    ),
  });
  await subject.commit(INSIDE, {
    [`tasks/${moved}/spec.md`]: SPEC("# Something new"),
    [`tasks/${moved}/state.json`]: JSON.stringify(state({ id: moved, status: "ready" })),
  });

  const digest = await collect(subject.root);

  assert.deepEqual(
    digest.changed.map((c) => c.id),
    [moved],
  );
  assert.deepEqual(
    digest.open.map((o) => o.id),
    [stuck],
    "still waiting, and it did not move today",
  );
  assert.equal(digest.open[0]?.since, BEFORE);
});

test("a catch-up digest stops at the window's end", async () => {
  // Run the morning after, the collector must describe the day it names — not the day it
  // is running in. Reading HEAD instead of the commit at the window's end would fold
  // this morning's work into yesterday's digest.
  const subject = await repo();
  const id = asTaskId("TASK-5");

  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# In the window"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
  });
  await subject.commit(AFTER, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "done", sessions: 9 })),
  });

  const digest = await collect(subject.root);
  const change = digest.changed[0];

  assert.equal(change?.to, "running", "as it stood at 18:00, not as it stands now");
  assert.equal(change?.sessions, 1);
});

test("a window with no commits in it is an empty day, not a failure", async () => {
  const subject = await repo();
  await subject.commit(BEFORE, { "README.md": "state repo\n" });

  const digest = await collect(subject.root);

  assert.equal(digest.changed.length, 0);
  assert.equal(digest.totals.sessions, 0);
  assert.equal(digest.quiet, true);
});

test("a state repo younger than the window reports everything in it as new", async () => {
  // The first day. There is no commit before the window's start, so there is no baseline
  // to diff against and everything present appeared inside it.
  const subject = await repo();
  const id = asTaskId("TASK-FIRST");

  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# The first task there ever was"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
  });

  const digest = await collect(subject.root);

  assert.equal(digest.changed.length, 1);
  assert.equal(digest.changed[0]?.from, undefined);
  assert.equal(digest.changed[0]?.sessions, 1);
});

test("a control record that is not shaped like one costs its task, not the day", async () => {
  // It parses as JSON and then has no `usage`. Left to throw, this fails the digest — and
  // fails it identically on every retry, because the collector is deterministic, so the
  // day is never published at all. The task is named instead.
  const subject = await repo();
  const broken = asTaskId("TASK-BROKEN");
  const fine = asTaskId("TASK-FINE");

  await subject.commit(BEFORE, { "README.md": "state repo\n" });
  await subject.commit(INSIDE, {
    [`tasks/${broken}/spec.md`]: SPEC("# Half-migrated"),
    [`tasks/${broken}/state.json`]: JSON.stringify({ id: broken, status: "done" }),
    [`tasks/${fine}/spec.md`]: SPEC("# Perfectly ordinary"),
    [`tasks/${fine}/state.json`]: JSON.stringify(state({ id: fine, status: "done", sessions: 2 })),
  });

  const digest = await collect(subject.root);

  assert.deepEqual(digest.unreadable, [broken]);
  assert.deepEqual(
    digest.changed.map((c) => c.id),
    [fine],
    "the readable task is still reported",
  );
  assert.equal(digest.totals.sessions, 2);
});

test("a spec that will not parse costs a title and nothing else", async () => {
  // The digest must never be the thing that fails because one task is malformed: the
  // task it cannot describe is precisely the one an operator needs to see moved.
  const subject = await repo();
  const id = asTaskId("TASK-6");

  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: "no front matter here at all",
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "failed", sessions: 1 })),
  });

  const digest = await collect(subject.root);

  assert.equal(digest.changed[0]?.title, id, "falls back to the id");
  assert.equal(digest.changed[0]?.to, "failed");
});

/*
 * The journal window, over shards (DESIGN.md §4.1).
 *
 * The journal is one file per entry, so "what was added in the window" is "which shard
 * files appeared between the two commits" rather than "what suffix the earlier copy did
 * not have". These pin both, because a window can straddle the format change.
 */

test("only the journal shards that appeared inside the window are reported", async () => {
  const subject = await repo();
  const id = asTaskId("TASK-SHARD");

  await subject.commit(BEFORE, {
    [`tasks/${id}/spec.md`]: SPEC("# Shard the journal"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
    [`tasks/${id}/journal/0001-20260815T090000000Z-pod-a.md`]:
      "## Session 1 — 2026-08-15T09:00:00.000Z\n\nYesterday's entry.\n",
  });
  await subject.commit(INSIDE, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 2 })),
    [`tasks/${id}/journal/0002-20260816T090000000Z-pod-a.md`]:
      "## Session 2 — 2026-08-16T09:00:00.000Z\n\nToday's first entry.\n",
  });
  await subject.commit(LATER, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "done", sessions: 3 })),
    [`tasks/${id}/journal/0003-20260816T110000000Z-pod-b.md`]:
      "## Session 3 — 2026-08-16T11:00:00.000Z\n\nToday's second entry, by another runner.\n",
  });

  const change = (await collect(subject.root)).changed[0];
  assert.match(change?.journal ?? "", /Today's first entry/);
  assert.match(change?.journal ?? "", /another runner/);
  assert.doesNotMatch(
    change?.journal ?? "",
    /Yesterday's entry/,
    "a shard that existed before the window is not news",
  );
  assert.ok(
    (change?.journal ?? "").indexOf("first entry") <
      (change?.journal ?? "").indexOf("second entry"),
    "shards concatenate in name order, which is chronological order",
  );
});

test("a window straddling the format change reports both the legacy file and the shards", async () => {
  // The live state repo has `journal.md` files written before the sharding. A window
  // that contains the last append to one and the first shard after it must show both,
  // or the day the format changed is the day the digest quietly lost half its evidence.
  const subject = await repo();
  const id = asTaskId("TASK-STRADDLE");

  await subject.commit(BEFORE, {
    [`tasks/${id}/spec.md`]: SPEC("# Straddle the change"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
    [`tasks/${id}/journal.md`]: "\n## Session 1\n\nBefore the window.\n",
  });
  await subject.commit(INSIDE, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 2 })),
    [`tasks/${id}/journal.md`]:
      "\n## Session 1\n\nBefore the window.\n\n## Session 2\n\nThe last legacy append.\n",
  });
  await subject.commit(LATER, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "done", sessions: 3 })),
    [`tasks/${id}/journal/0003-20260816T110000000Z-pod-a.md`]:
      "## Session 3 — 2026-08-16T11:00:00.000Z\n\nThe first shard.\n",
  });

  const change = (await collect(subject.root)).changed[0];
  assert.match(change?.journal ?? "", /The last legacy append/);
  assert.match(change?.journal ?? "", /The first shard/);
  assert.doesNotMatch(
    change?.journal ?? "",
    /Before the window/,
    "the legacy path still subtracts the prefix the earlier commit already had",
  );
});

test("a first-ever digest with no starting commit reports every shard present", async () => {
  // No `from` means the window is the repo's whole history, so everything present
  // counts as having appeared inside it — the same rule `filesTouched` uses.
  const subject = await repo();
  const id = asTaskId("TASK-FIRST");

  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# First day"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "running", sessions: 1 })),
    [`tasks/${id}/journal/0001-20260816T090000000Z-pod-a.md`]:
      "## Session 1 — 2026-08-16T09:00:00.000Z\n\nThe very first entry.\n",
  });

  const change = (await collect(subject.root)).changed[0];
  assert.match(change?.journal ?? "", /The very first entry/);
});

/* -------------------------------------------------------------------- attribution */

const FLEET_EMAIL = "316492202+caterpillar-agent[bot]@users.noreply.github.com";

/**
 * An authorship reader that records what it was asked, so the tests can assert on the
 * QUESTION as well as the answer: which repos, and which two windows.
 */
class RecordingAuthorship implements AuthorshipReader {
  readonly asked: { repos: readonly string[]; from: Date; to: Date }[] = [];

  private readonly commits: readonly AuthoredCommit[];
  private readonly unavailable: readonly string[];

  constructor(commits: readonly AuthoredCommit[], unavailable: readonly string[] = []) {
    this.commits = commits;
    this.unavailable = unavailable;
  }

  async readAuthorship(
    repos: readonly RepoRef[],
    from: Date,
    to: Date,
  ): Promise<AuthorshipRead> {
    this.asked.push({ repos: repos.map((r) => `${r.owner}/${r.name}`), from, to });
    // The window before is the second call, and the fixture only describes the first: a
    // baseline of nothing is the ordinary case for a first-ever digest.
    return this.asked.length === 1
      ? { commits: this.commits, unavailable: this.unavailable }
      : { commits: [], unavailable: [] };
  }
}

const authored = (email: string, lines: number): AuthoredCommit => ({
  repo: "acme/widget",
  sha: `${email}-${lines}`,
  authorEmail: email,
  insertions: lines,
  deletions: 0,
});

/** A state repo with one task that moved inside the window, on `acme/widget`. */
const movedTask = async (): Promise<Repo> => {
  const subject = await repo();
  const id = asTaskId("TASK-ATTRIB");

  await subject.commit(BEFORE, { "README.md": "state repo\n" });
  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# Fix the widget"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "done", sessions: 1 })),
  });

  return subject;
};

test("the digest attributes the window's code to the fleet or to a person", async () => {
  const subject = await movedTask();
  const reader = new RecordingAuthorship([
    authored(FLEET_EMAIL, 90),
    authored("dev@example.invalid", 10),
  ]);

  const digest = await collectDay({
    git: new Git(subject.root),
    window: WINDOW,
    authorship: reader,
    identity: { emails: [FLEET_EMAIL] },
  });

  assert.equal(digest.attribution?.total.fleet.lines, 90);
  assert.equal(digest.attribution?.total.human.lines, 10);
  assert.equal(digest.attribution?.total.fleetLineShare, 0.9);
});

test("the trend is read from the window before this one, at the same repos", async () => {
  const subject = await movedTask();
  const reader = new RecordingAuthorship([authored(FLEET_EMAIL, 10)]);

  await collectDay({
    git: new Git(subject.root),
    window: WINDOW,
    authorship: reader,
    identity: { emails: [FLEET_EMAIL] },
  });

  const before = previousWindow(WINDOW);
  assert.deepEqual(reader.asked.length, 2, "this window and the one before it");
  assert.deepEqual(reader.asked[0]?.repos, ["acme/widget"], "the repos the window's tasks name");
  assert.equal(reader.asked[0]?.from.getTime(), WINDOW.start.getTime());
  assert.equal(reader.asked[1]?.from.getTime(), before.start.getTime());
  assert.equal(reader.asked[1]?.to.getTime(), WINDOW.start.getTime(), "the windows must meet");
});

test("a repo the runner cannot read is carried through, not counted as zero", async () => {
  // The §19 trap: a task branch lives in the mirror of the runner that worked it, so
  // another runner has no history for that repo. Reporting 0% fleet there is a false
  // statement about a repo the fleet may have written entirely.
  const subject = await movedTask();
  const reader = new RecordingAuthorship([], ["acme/widget"]);

  const digest = await collectDay({
    git: new Git(subject.root),
    window: WINDOW,
    authorship: reader,
    identity: { emails: [FLEET_EMAIL] },
  });

  assert.deepEqual(digest.attribution?.unavailable, ["acme/widget"]);
  assert.equal(digest.attribution?.measured, false);
});

test("no authorship reader means no attribution section at all", async () => {
  // Rather than an all-zero report. A digest that cannot measure authorship must say
  // nothing about it, not assert that the fleet wrote none of the code.
  const subject = await movedTask();

  const digest = await collectDay({ git: new Git(subject.root), window: WINDOW });

  assert.equal(digest.attribution, undefined);
});

test("a reader that throws costs the attribution section and not the day", async () => {
  // The collector's standing rule (§19): a digest that throws fails identically on every
  // retry, so the day would never be published at all.
  const subject = await movedTask();

  const digest = await collectDay({
    git: new Git(subject.root),
    window: WINDOW,
    identity: { emails: [FLEET_EMAIL] },
    authorship: {
      readAuthorship: () => Promise.reject(new Error("the mirror is gone")),
    },
  });

  assert.equal(digest.attribution, undefined);
  assert.equal(digest.changed.length, 1, "the rest of the day is still reported");
});

test("a re-verified alert is reported as a fact, not left buried in the journal", async () => {
  // §20's closing edge, as the digest has to render it: "fix merged, alert cleared after 4m"
  // or "fix merged, alert still firing". A silent success and a silent failure must not look
  // the same, and a reader scanning a day's tasks should not have to read prose to tell
  // which one this was.
  const subject = await repo();
  const cleared = asTaskId("ALERT-6155dbaa");
  const firing = asTaskId("ALERT-6155dbbb");

  await subject.commit(BEFORE, { "README.md": "state repo\n" });
  await subject.commit(INSIDE, {
    [`tasks/${cleared}/spec.md`]: SPEC("# Alert `CaterpillarBudget` is firing"),
    [`tasks/${cleared}/state.json`]: JSON.stringify(state({ id: cleared, status: "done" })),
    [`tasks/${cleared}/journal/0002-20260816T090000000Z-pod-a.md`]:
      "## Session 2\n\n**Re-verified:** fix merged, alert cleared after 4m.\n",
    [`tasks/${firing}/spec.md`]: SPEC("# Alert `CaterpillarNoProgress` is firing"),
    [`tasks/${firing}/state.json`]: JSON.stringify(state({ id: firing, status: "parked" })),
    [`tasks/${firing}/journal/0002-20260816T090000000Z-pod-a.md`]:
      "## Session 2\n\n**Re-verified:** fix merged, alert still firing (last delivered " +
      "2026-08-16T08:59:00.000Z).\n\nThe change merged and passed every gate.\n",
  });

  const digest = await collect(subject.root);
  const byId = new Map(digest.changed.map((change) => [change.id, change]));

  assert.equal(byId.get(cleared)?.reverified, "fix merged, alert cleared after 4m");
  // The whole sentence, including the timestamp: the reader's next act on a failure is to
  // go and look at the alert, and "when was it last seen" is the first thing they need.
  assert.match(
    byId.get(firing)?.reverified ?? "",
    /^fix merged, alert still firing \(last delivered 2026-08-16T08:59:00\.000Z\)$/,
  );
  // Absent, not empty, on a task nobody re-verified — `exactOptionalPropertyTypes`, and a
  // reader that treated "" as a verdict would print a blank one.
  assert.equal("reverified" in (byId.get(asTaskId("TASK-1")) ?? { reverified: undefined }), true);
});

test("only the last re-verification in the window is reported", async () => {
  // A task can be re-verified, parked, resumed, re-merged and re-verified again inside one
  // day. The verdict a digest reports is the one that stands at the window's end; an
  // earlier "still firing" printed beside a later "cleared" would read as a contradiction.
  const subject = await repo();
  const id = asTaskId("ALERT-6155dbcc");

  await subject.commit(BEFORE, { "README.md": "state repo\n" });
  await subject.commit(INSIDE, {
    [`tasks/${id}/spec.md`]: SPEC("# Alert `CaterpillarBudget` is firing"),
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "parked" })),
    [`tasks/${id}/journal/0002-20260816T090000000Z-pod-a.md`]:
      "## Session 2\n\n**Re-verified:** fix merged, alert still firing.\n",
  });
  await subject.commit(LATER, {
    [`tasks/${id}/state.json`]: JSON.stringify(state({ id, status: "done" })),
    [`tasks/${id}/journal/0003-20260816T110000000Z-pod-a.md`]:
      "## Session 3\n\n**Re-verified:** fix merged, alert cleared after 7m.\n",
  });

  assert.equal(
    (await collect(subject.root)).changed[0]?.reverified,
    "fix merged, alert cleared after 7m",
  );
});
