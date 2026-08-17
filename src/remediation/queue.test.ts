/**
 * Tests for the alert → spec half of the fifth intake path (DESIGN.md §20).
 *
 * Three properties carry the design, and each of them fails silently and unboundedly in
 * production if it breaks — which is why every test here processes the SAME alert several
 * times and asserts on what the later passes did, exactly as `intake/ingest.test.ts` does:
 *
 *   an unlisted alert produces ONE notification however often it fires,
 *   an alert whose task already exists produces NOTHING,
 *   an alertname at its `maxOpenTasks` limit produces a refusal and no second task.
 *
 * The store is a fake and so is the notifier: nothing here touches git, a port or a clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorkspaceName, type TaskId, type TaskSpec, type TaskState } from "../domain/task.ts";
import type { Notification, Notifier, NotifyTarget } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import type { AlertRefusal } from "../state/store.ts";
import { parsePolicy, type AlertPolicy } from "./policy.ts";
import { AlertProcessor, AlertQueue, renderAlertSpec, type AlertStore } from "./queue.ts";
import type { FiringAlert } from "./receiver.ts";

const POLICY = parsePolicy(`
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm run check
      - npm test
    requires:
      - linux
    goalPrefix: |
      This alert usually means a session wedged on a provider cooldown.
    runbook: https://runbooks.example.invalid/no-progress
  - alertname: CaterpillarBudget
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
    maxOpenTasks: 2
`);

const alert = (over: Partial<FiringAlert> = {}): FiringAlert => ({
  alertname: "CaterpillarNoProgress",
  fingerprint: "a1b2c3d4",
  severity: "warning",
  startsAt: "2026-08-17T17:12:39.699Z",
  generatorURL: "https://prometheus.example.invalid/graph",
  labels: [
    { key: "alertname", value: "CaterpillarNoProgress" },
    { key: "severity", value: "warning" },
    { key: "task", value: "GH-acme-widget-12" },
  ],
  annotations: [{ key: "summary", value: "a task is thrashing" }],
  ...over,
});

/**
 * The state repo, in memory.
 *
 * Deliberately not a real `StateStore`: what these tests assert is the SEQUENCE of writes
 * across repeated deliveries — which record existed when, and how many specs were written —
 * and a fake makes that visible without a git invocation per pass.
 */
class FakeStore implements AlertStore {
  readonly specs: TaskSpec[] = [];
  readonly states: TaskState[] = [];
  readonly refusals = new Map<string, AlertRefusal>();
  readonly commits: string[] = [];
  /** Open task count per alertname, as `countOpenAlertTasks` would compute it. */
  open = new Map<string, number>();
  policy: AlertPolicy = POLICY;

  readAlertPolicy(): Promise<AlertPolicy> {
    return Promise.resolve(this.policy);
  }

  readAlertRefusal(fingerprint: string): Promise<AlertRefusal | undefined> {
    return Promise.resolve(this.refusals.get(fingerprint));
  }

  writeAlertRefusal(fingerprint: string, record: AlertRefusal): Promise<void> {
    this.refusals.set(fingerprint, { ...record, at: "2026-08-17T00:00:00.000Z" });
    return Promise.resolve();
  }

  countOpenAlertTasks(alertname: string): Promise<number> {
    return Promise.resolve(this.open.get(alertname) ?? 0);
  }

  hasTask(task: TaskId): Promise<boolean> {
    return Promise.resolve(this.specs.some((spec) => spec.id === task));
  }

  writeState(state: TaskState): Promise<void> {
    this.states.push(state);
    return Promise.resolve();
  }

  writeSpec(spec: TaskSpec): Promise<void> {
    if (this.specs.some((existing) => existing.id === spec.id)) {
      // The real store refuses too: `spec.md` is immutable. A fake that allowed it would
      // hide exactly the double-creation these tests exist to catch.
      throw new Error(`spec for ${spec.id} already exists`);
    }
    this.specs.push(spec);
    return Promise.resolve();
  }

  commitAndPush(message: string): Promise<void> {
    this.commits.push(message);
    return Promise.resolve();
  }
}

class FakeNotifier implements Notifier {
  readonly sent: Notification[] = [];

  notify(notification: Notification, _target?: NotifyTarget): Promise<void> {
    this.sent.push(notification);
    return Promise.resolve();
  }
}

const processor = (
  store: FakeStore,
  notifier: FakeNotifier,
): AlertProcessor =>
  new AlertProcessor({ store, notifier, logger: SILENT_LOGGER, maxSessionsPerTask: 20 });

/** Deliver the same alert `times` times, as Alertmanager does while it keeps firing. */
const deliver = async (
  store: FakeStore,
  notifier: FakeNotifier,
  firing: FiringAlert,
  times: number,
): Promise<void> => {
  const p = processor(store, notifier);
  for (let i = 0; i < times; i += 1) await p.process([firing], "origin", "main");
};

test("an alert with no policy entry is refused, and says so exactly once", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  await deliver(store, notifier, alert({ alertname: "SomethingNobodyListed" }), 5);

  assert.equal(store.specs.length, 0);
  // The whole reason the refusal record is durable and pushed: a flapping unlisted alert
  // must produce one message, not one per scrape (§20, and §14.2 verbatim before it).
  assert.equal(notifier.sent.length, 1);
  const sent = notifier.sent[0];
  assert.equal(sent?.kind, "alert-refused");
  assert.ok(sent?.kind === "alert-refused");
  assert.equal(sent.alertname, "SomethingNobodyListed");
  // The message has to name the file an operator would edit, or it says only that
  // something was declined.
  assert.match(sent.detail, /alerts\/policy\.yaml/);

  const record = store.refusals.get("a1b2c3d4");
  assert.equal(record?.reason, "refused-no-policy");
  assert.equal(record?.alertname, "SomethingNobodyListed");
  assert.equal(record?.task, undefined);
});

test("a refusal is still recorded and pushed on the first delivery", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  await deliver(store, notifier, alert({ alertname: "SomethingNobodyListed" }), 1);

  // Written locally and never pushed is exactly the spam the record exists to prevent, so
  // the pass that records one commits.
  assert.equal(store.commits.length, 1);
  assert.match(store.commits[0] ?? "", /refusal/);
});

test("an existing task directory means the alert is already handled", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  await deliver(store, notifier, alert(), 4);

  // Idempotency on the fingerprint is the load-bearing property of this path: Alertmanager
  // re-sends a firing alert every few minutes, and a second spec would be a second session
  // on the same incident.
  assert.equal(store.specs.length, 1);
  assert.equal(store.states.length, 1);
  assert.equal(store.commits.length, 1);
  assert.equal(notifier.sent.filter((n) => n.kind === "alert-task").length, 1);
});

test("a duplicate writes nothing at all — not even a commit", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();
  const p = processor(store, notifier);

  await p.process([alert()], "origin", "main");
  const commitsAfterFirst = store.commits.length;
  await p.process([alert()], "origin", "main");

  assert.equal(store.commits.length, commitsAfterFirst);
});

test("maxOpenTasks refuses rather than opening a second task for the same alertname", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();
  // Two already open, and `CaterpillarBudget` allows two.
  store.open.set("CaterpillarBudget", 2);

  await deliver(
    store,
    notifier,
    alert({ alertname: "CaterpillarBudget", fingerprint: "ff00ff00" }),
    3,
  );

  assert.equal(store.specs.length, 0);
  assert.equal(store.refusals.get("ff00ff00")?.reason, "refused-max-open");
  // One message, like the no-policy refusal — and it must be a DIFFERENT message, because
  // the two refusals need different people to act.
  assert.equal(notifier.sent.length, 1);
  const sent = notifier.sent[0];
  assert.ok(sent?.kind === "alert-refused");
  assert.match(sent.detail, /already has 2 open task/);
});

test("a refusal for a new reason speaks again", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();
  const firing = alert({ alertname: "CaterpillarBudget", fingerprint: "ff00ff00" });

  store.policy = parsePolicy("version: 1\nalerts: []\n");
  await processor(store, notifier).process([firing], "origin", "main");

  // The operator adds the entry, and the alert is now at its limit instead of unlisted.
  store.policy = POLICY;
  store.open.set("CaterpillarBudget", 2);
  await processor(store, notifier).process([firing], "origin", "main");

  assert.equal(notifier.sent.length, 2);
  assert.equal(store.refusals.get("ff00ff00")?.reason, "refused-max-open");
});

test("the happy path writes a spec carrying the policy's acceptance commands verbatim", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  const pass = await processor(store, notifier).process([alert()], "origin", "main");

  assert.deepEqual(pass, { seen: 1, created: 1, duplicate: 0, refused: 0 });

  const spec = store.specs[0];
  assert.ok(spec !== undefined);
  assert.equal(spec.id, "ALERT-a1b2c3d4");
  assert.equal(spec.kind, "remediation");
  assert.equal(spec.workspace, asWorkspaceName("caesar"));
  // VERBATIM. Nothing appended, nothing synthesised: the operator wrote the completion
  // gate, and a receiver that added to it would be writing the gate of a task it created.
  assert.deepEqual([...spec.acceptance], ["npm run check", "npm test"]);
  assert.deepEqual([...spec.requires], ["linux"]);
  assert.deepEqual(
    spec.repos.map((repo) => `${repo.host}/${repo.owner}/${repo.name}`),
    ["github.com/caesarakalaeii/caterpillar"],
  );

  // State first, spec last (§14.2) — and the state carries the spec's own `requires`, or a
  // task would be claimable by a runner that cannot run it.
  assert.equal(store.states[0]?.id, "ALERT-a1b2c3d4");
  assert.equal(store.states[0]?.status, "ready");
  assert.deepEqual([...(store.states[0]?.requires ?? [])], ["linux"]);

  // The success path records too: `countOpenAlertTasks` cannot recover an alertname from a
  // fingerprint, which is a hash (§20).
  const record = store.refusals.get("a1b2c3d4");
  assert.equal(record?.task, "ALERT-a1b2c3d4");
  assert.equal(record?.alertname, "CaterpillarNoProgress");

  const sent = notifier.sent[0];
  assert.ok(sent?.kind === "alert-task");
  assert.equal(sent.task, "ALERT-a1b2c3d4");
});

test("the goal carries the sanitized labels, the runbook and what the session may not do", () => {
  const spec = renderAlertSpec(
    "ALERT-a1b2c3d4" as TaskId,
    alert({ annotations: [{ key: "summary", value: "``` closed the fence" }] }),
    POLICY.entries[0]!,
  );

  // The operator's prose leads, because it is the one part of the goal a human wrote.
  assert.match(spec.goal, /^This alert usually means a session wedged/);
  assert.match(spec.goal, /CaterpillarNoProgress/);
  assert.match(spec.goal, /severity: warning/i);
  assert.match(spec.goal, /2026-08-17T17:12:39\.699Z/);
  assert.match(spec.goal, /GH-acme-widget-12/);
  assert.match(spec.goal, /runbooks\.example\.invalid/);
  assert.match(spec.goal, /prometheus\.example\.invalid/);

  // The three things the session gets wrong by default if nothing says otherwise.
  assert.match(spec.goal, /cannot change the cluster/i);
  assert.match(spec.goal, /pull request/);
  assert.match(spec.goal, /ask_human/);
  // The cluster tools are OFFERED, not promised: they are bound only when a cluster reader
  // is configured, so a goal that assumed them would send a session looking for a tool it
  // does not have.
  assert.match(spec.goal, /cluster_logs/);
  assert.match(spec.goal, /if they are not in/i);

  // Exactly the fences this rendered — the annotation could not add one.
  assert.equal(spec.goal.split("\n").filter((line) => line.startsWith("```")).length, 4);
});

test("a fingerprint that is not one is refused even here", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  // The receiver already checks this. The second check is what stops a future second caller
  // from choosing a path under `tasks/`.
  const pass = await processor(store, notifier).process(
    [alert({ fingerprint: "../../etc/passwd" })],
    "origin",
    "main",
  );

  assert.equal(pass.created, 0);
  assert.equal(store.specs.length, 0);
  assert.equal(store.refusals.size, 0);
});

test("one alert that throws does not cost the rest of the batch", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();
  const good = alert({ fingerprint: "00ff00ff" });

  // A store that refuses the first write and then behaves, which is what a transient
  // filesystem or git failure looks like from here.
  let first = true;
  const flaky: AlertStore = {
    ...store,
    readAlertPolicy: () => store.readAlertPolicy(),
    readAlertRefusal: (fingerprint) => store.readAlertRefusal(fingerprint),
    writeAlertRefusal: (fingerprint, record) => store.writeAlertRefusal(fingerprint, record),
    countOpenAlertTasks: (alertname) => store.countOpenAlertTasks(alertname),
    hasTask: (task) => store.hasTask(task),
    writeState: (state) => store.writeState(state),
    writeSpec: (spec) => {
      if (first) {
        first = false;
        throw new Error("disk full");
      }
      return store.writeSpec(spec);
    },
    commitAndPush: (message) => store.commitAndPush(message),
  };

  const pass = await new AlertProcessor({
    store: flaky,
    notifier,
    logger: SILENT_LOGGER,
    maxSessionsPerTask: 20,
  }).process([alert(), good], "origin", "main");

  assert.equal(pass.created, 1);
  assert.equal(store.specs[0]?.id, "ALERT-00ff00ff");
});

test("an empty drain reads no policy and pushes nothing", async () => {
  const store = new FakeStore();
  const notifier = new FakeNotifier();

  const pass = await processor(store, notifier).process([], "origin", "main");

  assert.deepEqual(pass, { seen: 0, created: 0, duplicate: 0, refused: 0 });
  assert.equal(store.commits.length, 0);
});

test("the queue is bounded and drops rather than growing", () => {
  const queue = new AlertQueue(3);

  assert.equal(queue.submit(alert()), true);
  assert.equal(queue.submit(alert()), true);
  assert.equal(queue.submit(alert()), true);
  // An alert storm must not be able to exhaust memory. A dropped alert is still firing and
  // will be re-delivered, which is why dropping is safe and growing is not.
  assert.equal(queue.submit(alert()), false);
  assert.equal(queue.size, 3);

  assert.equal(queue.drain().length, 3);
  assert.equal(queue.size, 0);
  // Swapped rather than emptied in place, so room is available immediately after a drain.
  assert.equal(queue.submit(alert()), true);
});
