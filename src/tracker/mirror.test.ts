/**
 * Mirroring one lifecycle change into the tracker (DESIGN.md §9.5, §4.4).
 *
 * Extracted from `Supervisor.mirror` so the policy has a test at all: it is four rules
 * about a view of git, and every one of them was previously only observable by running a
 * whole supervisor loop.
 *
 *   - a failure only logs — an unreachable tracker must never fail a task;
 *   - a tracker whose kind is not the task's is refused, not written to;
 *   - a transition already on the effect record is not mirrored twice;
 *   - a record that cannot be read means "mirror it", because the record is a fast path
 *     and a duplicate comment is cheaper than a lifecycle change nobody can see.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskId, type TrackerRef } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import type { EffectVerb } from "../state/effects.ts";
import { mirrorTransition, type MirrorLedger } from "./mirror.ts";
import type { Tracker, TrackerItem, TrackerTransition } from "./types.ts";

const TASK: TaskId = asTaskId("GH-acme-widget-98");
const REF: TrackerRef = { kind: "github-issues", id: "98" };

class RecordingTracker implements Tracker {
  readonly kind: string;
  readonly transitions: TrackerTransition[] = [];
  /** Thrown by `transition` when set — an unreachable tracker. */
  failure: Error | undefined;

  constructor(kind = "github-issues") {
    this.kind = kind;
  }

  async listAgentItems(): Promise<readonly TrackerItem[]> {
    return [];
  }
  async comment(): Promise<void> {}
  async transition(_ref: TrackerRef, transition: TrackerTransition): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.transitions.push(transition);
  }
}

class FakeLedger implements MirrorLedger {
  readonly landedVerbs = new Set<string>();
  readonly recorded: string[] = [];
  /** Thrown by both halves when set — the state repo unreachable. */
  failure: Error | undefined;

  private key(verb: EffectVerb, args: unknown): string {
    return `${verb}:${JSON.stringify(args)}`;
  }

  async landed(verb: EffectVerb, args: unknown): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;
    return this.landedVerbs.has(this.key(verb, args));
  }

  async record(verb: EffectVerb, args: unknown): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.recorded.push(this.key(verb, args));
    this.landedVerbs.add(this.key(verb, args));
  }
}

const mirror = (
  tracker: Tracker | undefined,
  transition: TrackerTransition,
  ledger?: MirrorLedger,
  occurrence = 0,
): Promise<void> =>
  mirrorTransition({
    task: TASK,
    ref: REF,
    transition,
    occurrence,
    logger: SILENT_LOGGER,
    ...(tracker === undefined ? {} : { tracker }),
    ...(ledger === undefined ? {} : { ledger }),
  });

const PARKED: TrackerTransition = { kind: "parked", reason: "lease lost" };

test("a transition reaches the tracker and is recorded", async () => {
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();

  await mirror(tracker, PARKED, ledger);

  assert.deepEqual(tracker.transitions, [PARKED]);
  assert.equal(ledger.recorded.length, 1);
  assert.match(ledger.recorded[0] as string, /^tracker\.parked:/);
});

test("the same transition mirrored twice writes to the tracker once", async () => {
  // The requirement: a retried mirror may not duplicate a comment or a label. A mirror
  // happens AFTER the authoritative git write, so a pod killed in between comes back and
  // replays it — an ordinary event on a fleet whose premise is surviving pod restarts.
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();

  await mirror(tracker, PARKED, ledger);
  await mirror(tracker, PARKED, ledger);

  assert.deepEqual(tracker.transitions, [PARKED]);
});

test("a different transition of the same kind is mirrored", async () => {
  // Keyed on the ARGUMENTS, not the kind: a task parked twice for two different reasons
  // has two things to say, and collapsing them would lose the second.
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();

  await mirror(tracker, PARKED, ledger);
  await mirror(tracker, { kind: "parked", reason: "session budget spent" }, ledger);

  assert.equal(tracker.transitions.length, 2);
});

test("each lifecycle kind is its own effect", async () => {
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();

  await mirror(tracker, { kind: "claimed", runner: "pod-7f3a" }, ledger);
  await mirror(tracker, { kind: "question", question: "which host?" }, ledger);
  await mirror(tracker, PARKED, ledger);
  await mirror(tracker, { kind: "completed", prUrl: "https://x.invalid/1" }, ledger);

  assert.equal(tracker.transitions.length, 4);
  assert.deepEqual(
    ledger.recorded.map((key) => key.split(":")[0]),
    ["tracker.claimed", "tracker.question", "tracker.parked", "tracker.completed"],
  );
});

test("the same transition in a later occurrence is mirrored again", async () => {
  // The twin of the test above, and the more dangerous direction. A lifecycle transition
  // RECURS with byte-identical arguments: `claimed` carries only the runner id, which is
  // the pod name and so the same on every claim by that pod. Suppressing the second claim
  // would leave `needs-human` on an issue whose question was answered — `claimed` is the
  // only transition that removes it. The occurrence separates a replay of one attempt
  // (same session) from a genuinely new event (a later session).
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();
  const claimed: TrackerTransition = { kind: "claimed", runner: "pod-7f3a" };

  await mirror(tracker, claimed, ledger, 1);
  await mirror(tracker, claimed, ledger, 1);
  await mirror(tracker, claimed, ledger, 2);

  assert.deepEqual(tracker.transitions, [claimed, claimed]);
});

test("a tracker that cannot be reached does not throw, and is not recorded", async () => {
  // §9.5: the tracker is a VIEW and git wins. An unreachable Vikunja must not fail a task
  // — and it must not be recorded either, or the retry that would have fixed it is skipped.
  const tracker = new RecordingTracker();
  tracker.failure = new Error("vikunja unreachable");
  const ledger = new FakeLedger();

  await mirror(tracker, PARKED, ledger);

  assert.deepEqual(ledger.recorded, []);
});

test("a tracker of the wrong kind is not written to at all", async () => {
  // A config error: the workspace's tracker is not the one the task came from, so its ids
  // mean something else entirely and writing would comment on an unrelated item.
  const tracker = new RecordingTracker("vikunja");
  const ledger = new FakeLedger();

  await mirror(tracker, PARKED, ledger);

  assert.deepEqual(tracker.transitions, []);
  assert.deepEqual(ledger.recorded, []);
});

test("no tracker configured is a no-op", async () => {
  await mirror(undefined, PARKED, new FakeLedger());
});

test("a ledger that cannot be reached still mirrors", async () => {
  // The record is a fast path, never a precondition. If the state repo cannot be read we
  // do not know whether the mirror landed, and a duplicate comment is cheaper than a
  // lifecycle change nobody can see.
  const tracker = new RecordingTracker();
  const ledger = new FakeLedger();
  ledger.failure = new Error("state repo unreachable");

  await mirror(tracker, PARKED, ledger);

  assert.deepEqual(tracker.transitions, [PARKED]);
});

test("no ledger means mirror unconditionally", async () => {
  const tracker = new RecordingTracker();

  await mirror(tracker, PARKED);
  await mirror(tracker, PARKED);

  assert.equal(tracker.transitions.length, 2);
});
