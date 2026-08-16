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
import { asTaskId, type TaskState } from "../domain/task.ts";
import { Git } from "../state/git.ts";
import { collectDay } from "./collect.ts";
import { windowFor } from "./day.ts";

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
    "workspace: caesar",
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
