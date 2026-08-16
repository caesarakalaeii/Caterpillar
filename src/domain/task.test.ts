import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  asTaskId,
  capabilitiesSatisfy,
  EMPTY_USAGE,
  isClaimable,
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
