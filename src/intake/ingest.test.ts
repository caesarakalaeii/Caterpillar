/**
 * Intake's two dangerous properties, driven over a REAL state repo and a real push.
 *
 * Both failure modes are silent and unbounded: a non-deterministic id creates a fresh
 * duplicate task every poll, and an un-suppressed refusal comments on a tracker item
 * every poll. Neither shows up in a single-pass test, so every test here runs intake
 * TWICE and asserts on what the second pass did.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asTaskId, asWorkspaceName, type TaskId, type TrackerRef, type WorkspaceName } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import type { Tracker, TrackerItem, TrackerTransition } from "../tracker/types.ts";
import { Ingester, intakeDue, intakeRef } from "./ingest.ts";

const WORKSPACE = asWorkspaceName("caesar");
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const HERMETIC: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** A real state repo with a real origin, so pushes can be asserted on the remote. */
const stateRepo = async (): Promise<{ store: StateStore; origin: Git }> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-intake-"));
  const originPath = await mkdtemp(join(tmpdir(), "caterpillar-intake-origin-"));
  roots.push(root, originPath);

  const origin = new Git(originPath, HERMETIC);
  await origin.run("init", "--quiet", "--bare", "--initial-branch=main", ".");

  const git = new Git(root, HERMETIC);
  await git.run("init", "--quiet", "--initial-branch=main", ".");
  await git.run("config", "user.email", "supervisor@example.invalid");
  await git.run("config", "user.name", "supervisor");
  await git.run("remote", "add", "origin", originPath);
  await writeFile(join(root, "README.md"), "state\n", "utf8");
  await git.run("add", "-A");
  await git.run("commit", "--quiet", "-m", "seed");
  await git.run("push", "--quiet", "origin", "HEAD:main");

  return { store: new StateStore(root, git), origin };
};

class FakeTracker implements Tracker {
  readonly kind = "github-issues";
  readonly comments: { readonly ref: TrackerRef; readonly text: string }[] = [];
  listCalls = 0;

  private items: readonly TrackerItem[];
  private readonly failList: boolean;

  constructor(items: readonly TrackerItem[], failList = false) {
    this.items = items;
    this.failList = failList;
  }

  setItems(items: readonly TrackerItem[]): void {
    this.items = items;
  }

  listAgentItems(): Promise<readonly TrackerItem[]> {
    this.listCalls += 1;
    if (this.failList) return Promise.reject(new Error("tracker unreachable"));
    return Promise.resolve(this.items);
  }

  comment(ref: TrackerRef, text: string): Promise<void> {
    this.comments.push({ ref, text });
    return Promise.resolve();
  }

  transition(_ref: TrackerRef, _t: TrackerTransition, _task: TaskId): Promise<void> {
    return Promise.resolve();
  }
}

const item = (body: string, number = "12", authorTrusted = true): TrackerItem => ({
  ref: { kind: "github-issues", id: number, container: "acme/widget" },
  title: "Fix the widget",
  body,
  authorTrusted,
  url: `https://github.com/acme/widget/issues/${number}`,
});

const VALID = ["```agent", "acceptance:", '  - "npm test"', "```"].join("\n");

const ingesterFor = (
  store: StateStore,
  trackers: ReadonlyMap<WorkspaceName, Tracker>,
): Ingester =>
  new Ingester({
    store,
    trackers,
    // Every workspace the tests use, on github.com — the scope only bites when an item
    // names a repo somewhere else, which `spec.test.ts` covers directly.
    scopes: new Map([...trackers.keys()].map((name) => [name, { host: "github.com" }])),
    logger: SILENT_LOGGER,
    maxSessionsPerTask: 20,
  });

test("intake is due at boot, then only once per interval", async () => {
  // Intake must NOT ride the supervisor's poll interval. A GitHub pass costs ~66 requests
  // against the live account-wide installation; at a 30s poll that is ~132/min against an
  // ~83/min budget, so it would exhaust the rate limit within minutes and take the forge
  // calls down with it.
  const now = 1_775_000_000_000;
  // Checked explicitly, not by relying on `now - 0` being enormous.
  assert.equal(intakeDue(0, 1_000, 300), true, "never having run means due now");
  assert.equal(intakeDue(now, now, 300), false, "just ran");
  assert.equal(intakeDue(now, now + 299_999, 300), false);
  assert.equal(intakeDue(now, now + 300_000, 300), true, "due on the boundary");
});

test("a labelled item becomes a ready task, and a second pass does not duplicate it", async () => {
  const { store, origin } = await stateRepo();
  const tracker = new FakeTracker([item(VALID)]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  assert.equal((await subject.ingest("origin", "main")).created, 1);

  const tasks = await store.listTasks();
  assert.deepEqual(tasks, ["GH-acme-widget-12"]);
  const id = tasks[0];
  assert.ok(id !== undefined);

  const state = await store.readState(id);
  assert.equal(state.status, "ready", "the supervisor only claims `ready` tasks");
  assert.equal(state.sessions, 0);
  assert.equal(state.limits.maxSessions, 20);

  const spec = await store.readSpec(id);
  assert.deepEqual(spec.acceptance, ["npm test"]);
  assert.deepEqual(spec.tracker, {
    kind: "github-issues",
    id: "12",
    container: "acme/widget",
  });

  // The push actually landed — the working tree looks the same either way.
  const listed = await origin.run("ls-tree", "-r", "--name-only", "main");
  assert.match(listed, /^tasks\/GH-acme-widget-12\/spec\.md$/m);

  // Second pass: the item is still labelled and still returned by the tracker.
  assert.equal((await subject.ingest("origin", "main")).created, 0, "must not re-ingest");
  assert.deepEqual(await store.listTasks(), ["GH-acme-widget-12"]);
});

test("an item that cannot become a task is commented on exactly once", async () => {
  // The spam vector: `listAgentItems` filters on the `agent` label alone, so a refused
  // item comes back on every single poll.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  assert.equal((await subject.ingest("origin", "main")).created, 0);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]?.text ?? "", /acceptance/);
  assert.deepEqual(await store.listTasks(), [], "a refused item must not become a task");

  for (let pass = 0; pass < 3; pass += 1) {
    assert.equal((await subject.ingest("origin", "main")).created, 0);
  }
  assert.equal(tracker.comments.length, 1, "one comment, however many passes run");
});

test("an item from an author without write access never becomes a task", async () => {
  // The attack this closes: `listAgentItems` filters on the label alone, and the body is
  // re-read from the tracker on every pass. An outside contributor opens an issue, a
  // maintainer labels it, and the author — who can edit their own body forever — then
  // pastes in an `agent` block whose `acceptance` list runs as shell on the runner.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item(VALID, "12", false)]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  const pass = await subject.ingest("origin", "main");
  assert.equal(pass.created, 0);
  assert.equal(pass.rejected, 1);
  assert.deepEqual(await store.listTasks(), []);
});

test("the refusal to an untrusted author does not hand them the template", async () => {
  // Posting "here is how to write an agent block" to someone we just declined to trust
  // is what turned the first refusal into a working set of instructions.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.", "12", false)]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  await subject.ingest("origin", "main");

  const text = tracker.comments[0]?.text ?? "";
  assert.equal(tracker.comments.length, 1);
  assert.doesNotMatch(text, /```agent/, "the template must not be quoted back");
  assert.match(text, /write access/);
});

test("an untrusted author cannot re-open the item by editing it", async () => {
  // The digest re-opens a refusal when the human-authored content changes, which is
  // correct for a maintainer fixing their own block and is exactly the wrong behaviour
  // for an author who is not allowed to supply one at all.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.", "12", false)]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  await subject.ingest("origin", "main");
  tracker.setItems([item(VALID, "12", false)]);

  assert.equal((await subject.ingest("origin", "main")).created, 0);
  assert.deepEqual(await store.listTasks(), []);
});

test("editing a refused item makes intake look again", async () => {
  // The refusal record is keyed by a digest of the human-authored content, so fixing the
  // issue re-opens it. Without that the only recovery would be deleting a file in the
  // state repo by hand.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  assert.equal((await subject.ingest("origin", "main")).created, 0);
  assert.equal(tracker.comments.length, 1);

  tracker.setItems([item(`Please just fix it.\n\n${VALID}`)]);
  assert.equal((await subject.ingest("origin", "main")).created, 1, "the fixed item is ingested");
  assert.deepEqual(await store.listTasks(), ["GH-acme-widget-12"]);

  // And the stale refusal is gone, so a future re-refusal is reported rather than
  // suppressed by a record describing a body that no longer exists.
  assert.equal(await store.readIntakeRejection("GH-acme-widget-12" as TaskId), undefined);
});

test("a still-broken edit is reported again rather than suppressed", async () => {
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  await subject.ingest("origin", "main");
  assert.equal(tracker.comments.length, 1);

  // Edited, still no acceptance criteria.
  tracker.setItems([item("Please just fix it. It is urgent.")]);
  await subject.ingest("origin", "main");
  assert.equal(tracker.comments.length, 2, "a changed item earns a fresh answer");
});

test("an unreachable tracker does not stop another workspace's intake", async () => {
  // Intake is best-effort. The state repo is authoritative, and a task already in
  // `tasks/` is unaffected by a tracker being down — so one failure must not take the
  // whole pass, or a Vikunja outage would stop GitHub intake too.
  const { store } = await stateRepo();
  const broken = new FakeTracker([], true);
  const working = new FakeTracker([item(VALID)]);
  const subject = ingesterFor(
    store,
    new Map([
      [asWorkspaceName("electric-boogaloo"), broken],
      [WORKSPACE, working],
    ]),
  );

  assert.equal((await subject.ingest("origin", "main")).created, 1);
  assert.deepEqual(await store.listTasks(), ["GH-acme-widget-12"]);
});

test("a pass reports what it saw, not only what it created", async () => {
  // `created: 0` is the normal case, so it cannot be the only thing reported: a working
  // intake and a broken one would look identical. `seen` separates "nobody labelled
  // anything" from "items came back and none became tasks".
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item(VALID, "1"), item("no block here", "2")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  assert.deepEqual(await subject.ingest("origin", "main"), {
    seen: 2,
    created: 1,
    rejected: 1,
    failed: 0,
  });

  // Second pass: both items still come back from the tracker, and neither does anything.
  assert.deepEqual(await subject.ingest("origin", "main"), {
    seen: 2,
    created: 0,
    rejected: 0,
    failed: 0,
  });
});

test("a tracker that cannot be listed is counted, not silently dropped", async () => {
  const { store } = await stateRepo();
  const subject = ingesterFor(
    store,
    new Map([[asWorkspaceName("electric-boogaloo"), new FakeTracker([], true)]]),
  );

  assert.deepEqual(await subject.ingest("origin", "main"), {
    seen: 0,
    created: 0,
    rejected: 0,
    failed: 1,
  });
});

test("nothing is committed when there is nothing to do", async () => {
  // An idle intake pass must not churn the state repo's history — it runs every poll.
  const { store, origin } = await stateRepo();
  const before = await origin.run("rev-parse", "main");

  const subject = ingesterFor(store, new Map([[WORKSPACE, new FakeTracker([])]]));
  assert.equal((await subject.ingest("origin", "main")).created, 0);

  assert.equal(await origin.run("rev-parse", "main"), before, "no empty commits");
});

test("several items in one pass produce one commit", async () => {
  const { store, origin } = await stateRepo();
  const before = await origin.run("rev-list", "--count", "main");
  const tracker = new FakeTracker([item(VALID, "1"), item(VALID, "2"), item(VALID, "3")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  assert.equal((await subject.ingest("origin", "main")).created, 3);
  assert.equal((await store.listTasks()).length, 3);

  const after = await origin.run("rev-list", "--count", "main");
  assert.equal(
    Number(after) - Number(before),
    1,
    "one intake pass is one commit, not one per item",
  );
});

test("runners that booted at different moments compute the SAME intake bucket", () => {
  // The property the fleet claim rests on. If two pods bucketed from their own boot time
  // they would contend for two different refs, both would win, and both would ingest —
  // which is precisely the request storm the claim exists to prevent.
  const interval = 300;
  // Deliberately bucket-ALIGNED: the agreement is over a bucket, and starting mid-bucket
  // would be asserting the boundary case below rather than this one.
  const aligned = Math.floor(1_700_000_000_000 / 300_000) * 300_000;

  assert.equal(intakeRef(aligned, interval), intakeRef(aligned + 40_000, interval));
  assert.equal(intakeRef(aligned, interval), intakeRef(aligned + 299_999, interval));
});

test("two runners straddling a bucket boundary cost one extra pass, not N", () => {
  // The honest limit of wall-clock bucketing. Runners whose intervals fire either side of
  // a boundary land in ADJACENT buckets and both win, so a fleet of ten can ingest twice
  // in one interval — never ten times, because everyone before the boundary shares one
  // ref and everyone after shares the other. Two passes is ~132 requests against an
  // ~83/min budget for a single minute, which the hourly allowance absorbs; ten passes is
  // what would not be absorbed.
  const interval = 300;
  const boundary = Math.floor(1_700_000_000_000 / 300_000) * 300_000 + 300_000;

  const before = new Set([
    intakeRef(boundary - 1, interval),
    intakeRef(boundary - 20_000, interval),
  ]);
  const after = new Set([intakeRef(boundary, interval), intakeRef(boundary + 20_000, interval)]);

  assert.equal(before.size, 1, "everyone before the boundary contends for one ref");
  assert.equal(after.size, 1, "everyone after it contends for one other ref");
  assert.equal(new Set([...before, ...after]).size, 2, "at most two passes, never N");
});

test("a new interval is a new bucket, so intake is not claimed once and never again", () => {
  const interval = 300;
  const base = 1_700_000_000_000;

  assert.notEqual(intakeRef(base, interval), intakeRef(base + 300_000, interval));
});

test("the intake ref lives under refs/intake, away from leases and digests", () => {
  // Shares the compare-and-swap with them but must not share a namespace: a bucket number
  // colliding with a task id would make one silently claim the other.
  assert.match(intakeRef(1_700_000_000_000, 300), /^refs\/intake\/\d+$/);
});

test("a refusal record carries what a page needs to link to the item", async () => {
  // `GH-acme-widget-12` cannot be turned back into a URL: it does not say where the owner
  // ends and the repo begins. Without these fields `/intake` shows a reason and no link to
  // the thing being refused.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.")]);
  await ingesterFor(store, new Map([[WORKSPACE, tracker]])).ingest("origin", "main");

  const record = await store.readIntakeRejection(asTaskId("GH-acme-widget-12"));
  assert.equal(record?.url, "https://github.com/acme/widget/issues/12");
  assert.equal(record?.title, "Fix the widget");
  assert.equal(record?.workspace, "caesar");
});

test("adding the page's fields does not re-comment on an item already refused", async () => {
  // The reason those fields are OPTIONAL rather than required. The digest is the
  // suppression key and covers the item's title and body — not the record's shape — so a
  // record written by the previous build must still silence the item on the first pass
  // after a deploy. Keel rolls the pod on every push to main, so "the first pass after a
  // deploy" is every push.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item("Please just fix it.")]);
  const subject = ingesterFor(store, new Map([[WORKSPACE, tracker]]));

  // Exactly what the shipped writer produced: digest, reason, at. Nothing else.
  const digest = createHash("sha256")
    .update(`${item("Please just fix it.").title}\n\n${"Please just fix it."}`)
    .digest("hex");
  await store.writeIntakeRejection(asTaskId("GH-acme-widget-12"), {
    digest,
    reason: "written by an older build",
  });

  const pass = await subject.ingest("origin", "main");
  assert.equal(pass.rejected, 0, "an unchanged item is still suppressed");
  assert.deepEqual(tracker.comments, []);
});

test("every decision reaches the observer, so Grafana can count them", async () => {
  // Intake had no metric at all: a labelled issue that never became a task was a warn line
  // in one pod's stdout while every other path had a counter.
  const { store } = await stateRepo();
  const tracker = new FakeTracker([item(VALID, "12"), item("Please just fix it.", "13")]);
  const observed: string[] = [];
  const items: number[] = [];

  const subject = new Ingester({
    store,
    trackers: new Map([[WORKSPACE, tracker]]),
    scopes: new Map([[WORKSPACE, { host: "github.com" }]]),
    logger: SILENT_LOGGER,
    maxSessionsPerTask: 20,
    metrics: {
      observe: (workspace, outcome) => observed.push(`${workspace}:${outcome}`),
      items: (_workspace, seen) => items.push(seen),
    },
  });

  await subject.ingest("origin", "main");
  assert.deepEqual(observed.sort(), ["caesar:created", "caesar:rejected"]);
  assert.deepEqual(items, [2]);

  // The second pass is the normal case: the created task is skipped and the refused one is
  // suppressed, and `skipped` must be its own outcome rather than folded into either.
  observed.length = 0;
  await subject.ingest("origin", "main");
  assert.deepEqual(observed, ["caesar:skipped", "caesar:skipped"]);
  assert.deepEqual(items, [2, 2], "the gauge is published even when nothing changes");
});
