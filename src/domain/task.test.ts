import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  asTaskId,
  capabilitiesSatisfy,
  EMPTY_USAGE,
  claimOrder,
  isClaimable,
  isTaskId,
  KNOWN_CAPABILITIES,
  type Capability,
  type TaskState,
} from "./task.ts";

/** Enough of a state to ask about claimability; every test overrides `status`. */
const BASE_STATE = {
  id: asTaskId("T-1"),
  status: "ready",
  phase: "planning",
  requires: [],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: EMPTY_USAGE,
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as TaskState;

/**
 * The shell installer cannot import the enum, so it carries a fourth copy. A capability
 * that exists here and not there is refused by `--capabilities` and the machine never gets
 * installed; one that exists there and not here starts a runner that config loading then
 * rejects at boot. Both are silent until someone tries to add a machine, which is exactly
 * when nobody wants to debug a list.
 */
test("install-runner.sh advertises the same capabilities the code knows", async () => {
  const script = fileURLToPath(new URL("../../scripts/install-runner.sh", import.meta.url));
  const source = await readFile(script, "utf8");

  const match = /^KNOWN_CAPABILITIES="([^"]*)"$/m.exec(source);
  assert.ok(match !== null, "install-runner.sh has no KNOWN_CAPABILITIES= line to check");

  assert.deepEqual(
    match[1]?.split(" ").filter((entry) => entry.length > 0),
    [...KNOWN_CAPABILITIES],
  );
});

test("capabilitiesSatisfy is subset containment, not equality", () => {
  const runner: readonly Capability[] = ["linux", "gpu", "usb"];

  assert.ok(capabilitiesSatisfy(runner, []));
  assert.ok(capabilitiesSatisfy(runner, ["gpu"]));
  assert.ok(capabilitiesSatisfy(runner, ["linux", "usb"]));
  assert.ok(!capabilitiesSatisfy(runner, ["k8s"]));
  assert.ok(!capabilitiesSatisfy(runner, ["gpu", "human-present"]));
});

/**
 * A task interrupted mid-flight must be reclaimable.
 *
 * From the end of session 1 the pushed `state.json` says `running`, so every exit that
 * is not a clean terminal transition — a killed pod, a Keel roll, a graceful SIGTERM
 * after a handoff — leaves it that way. Excluding `running` here made the stale-lease
 * steal unreachable for exactly the tasks that needed it: one task stranded per deploy,
 * with no notification and no path back except `/cancel` followed by `/resume`.
 */
test("a task left `running` by a dead runner is claimable again", () => {
  const running = { ...BASE_STATE, status: "running" } as TaskState;
  assert.equal(isClaimable(running, () => undefined), true);
});

test("claimability still stops at terminal and parked statuses", () => {
  // The lease CAS decides whether a `running` task may actually be taken. What must
  // never be re-claimed on the strength of a stale read is a task that FINISHED.
  for (const status of ["done", "failed", "cancelled", "awaiting-human"] as const) {
    assert.equal(
      isClaimable({ ...BASE_STATE, status } as TaskState, () => undefined),
      false,
      `${status} must not be claimable`,
    );
  }
});

test("an interrupted task still waits for its plan blockers", () => {
  // Reclaiming a `running` task must not route around wave ordering: the previous
  // runner died, the dependency graph did not change.
  const blocked = {
    ...BASE_STATE,
    status: "running",
    plan: { parent: asTaskId("P"), wave: 1, blockedBy: [asTaskId("P-01")] },
  } as TaskState;

  assert.equal(isClaimable(blocked, () => "running"), false);
  assert.equal(isClaimable(blocked, () => "done"), true);
});

test("a task id may not be a relative path segment", async () => {
  // An id becomes a directory name under `tasks/`, and it arrives from outside the state
  // repo — a slash command, a button's custom_id, a URL. The character class alone admits
  // `.` and `..`, which resolve to the task tree's parent: the state repo root.
  assert.equal(isTaskId("."), false);
  assert.equal(isTaskId(".."), false);
  assert.equal(isTaskId("..."), false);

  assert.equal(isTaskId("TASK-1"), true);
  assert.equal(isTaskId("GH-acme-widget-12"), true);
  assert.equal(isTaskId("v1.2.3-fix"), true, "a dot inside an id is still ordinary");
});

test("a brainstorm is claimed before batch work, whatever its id sorts as", () => {
  // The defect. A brainstorm's id is its Discord thread id, and thread ids are
  // snowflakes — monotonically increasing — so a NEW brainstorm always sorts LAST
  // under `(wave, id)`. It could therefore only ever start when the queue was empty,
  // which for a runner working a multi-session task means never. Observed live: a
  // brainstorm created at 19:35 was still unclaimed twenty minutes later while the
  // runner re-claimed an older task six sessions running.
  const older = { state: { ...BASE_STATE, id: asTaskId("BS-1537800044915331092-04") } as TaskState, kind: "implement" } as const;
  const brainstorm = { state: { ...BASE_STATE, id: asTaskId("BS-1538626232302960801") } as TaskState, kind: "brainstorm" } as const;

  assert.ok(claimOrder(brainstorm, older) < 0, "the human waiting at a keyboard goes first");
  assert.ok(claimOrder(older, brainstorm) > 0, "and the order is antisymmetric");
});

test("priority does not reorder a plan's waves among themselves", () => {
  // `blockedBy` is the authority and `isClaimable` enforces it, but the wave order is
  // what keeps a runner from taking wave 3 while wave 1 is still claimable. Putting
  // brainstorms first must not disturb that.
  const wave = (n: number, id: string) =>
    ({
      state: {
        ...BASE_STATE,
        id: asTaskId(id),
        plan: { parent: asTaskId("P"), wave: n, blockedBy: [] },
      } as TaskState,
      kind: "implement",
    }) as const;

  assert.ok(claimOrder(wave(1, "P-99"), wave(3, "P-01")) < 0, "earlier wave first");
  assert.ok(claimOrder(wave(2, "P-01"), wave(2, "P-02")) < 0, "then by id");
});

test("two brainstorms fall back to wave and id, so runners agree", () => {
  // Priority is a tie-break, not a replacement for the total order: two runners sorting
  // the same queue must reach the same answer or they claim the same task at once and
  // one of them wastes a CAS.
  const bs = (id: string) => ({ state: { ...BASE_STATE, id: asTaskId(id) } as TaskState, kind: "brainstorm" }) as const;

  assert.ok(claimOrder(bs("BS-1"), bs("BS-2")) < 0);
  assert.equal(claimOrder(bs("BS-1"), bs("BS-1")), 0);
});
