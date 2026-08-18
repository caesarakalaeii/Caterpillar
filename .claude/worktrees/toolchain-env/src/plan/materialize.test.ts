/**
 * Turning a proposed plan into claimable tasks.
 *
 * The two failure modes worth pinning are asymmetric. A rejected plan costs a round trip
 * with the agent. A wave numbered too low lets a task be claimed alongside a dependency
 * that has not run — on a multi-replica runner that is two agents editing the same repo,
 * which is the exact hazard waves exist to prevent. So the layering is tested harder than
 * the validation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type ProposedPlan, type RepoRef } from "../domain/task.ts";
import { childId, layer, materialise, relayer } from "./materialize.ts";

const PARENT = asTaskId("BS-1537550186388258866");
const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };

const options = {
  parent: PARENT,
  workspace: asWorkspaceName("caesar"),
  defaultRepos: [REPO],
};

const task = (
  localId: string,
  dependsOn: readonly string[] = [],
): ProposedPlan["tasks"][number] => ({
  localId,
  title: `Do ${localId}`,
  goal: `The ${localId} part.`,
  repos: [],
  requires: [],
  acceptance: ["npm test"],
  dependsOn,
});

const plan = (tasks: ProposedPlan["tasks"]): ProposedPlan => ({
  title: "A plan",
  summary: "Some work.",
  tasks,
});

test("ids are positional and stable, not derived from titles", () => {
  const result = materialise(plan([task("a"), task("b")]), options);
  assert.equal(result.kind, "plan");
  assert.deepEqual(
    result.kind === "plan" ? result.tasks.map((t) => t.spec.id) : [],
    [`${PARENT}-01`, `${PARENT}-02`],
  );
  assert.equal(childId(PARENT, 0), `${PARENT}-01`);
});

test("dependencies become blockedBy on real task ids", () => {
  const result = materialise(plan([task("schema"), task("api", ["schema"])]), options);
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;

  assert.deepEqual(result.tasks[1]?.plan.blockedBy, [asTaskId(`${PARENT}-01`)]);
  assert.deepEqual(result.tasks[0]?.plan.blockedBy, []);
});

test("a diamond puts the join one wave past its LATEST blocker", () => {
  // The failure this pins: taking the shortest path puts `d` in wave 1, alongside `c`,
  // which it depends on. Longest-path layering is the whole correctness of a wave.
  //
  //   a → b → c
  //    ╲       ╲
  //     ────────→ d
  const result = materialise(
    plan([task("a"), task("b", ["a"]), task("c", ["b"]), task("d", ["a", "c"])]),
    options,
  );
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;

  assert.deepEqual(
    result.tasks.map((t) => t.plan.wave),
    [0, 1, 2, 3],
  );
});

test("independent tasks all land in wave 0", () => {
  const result = materialise(plan([task("a"), task("b"), task("c")]), options);
  assert.equal(result.kind, "plan");
  assert.deepEqual(result.kind === "plan" ? result.tasks.map((t) => t.plan.wave) : [], [0, 0, 0]);
});

test("a cycle is a rejected plan, named, not a crash", () => {
  const result = materialise(plan([task("a", ["b"]), task("b", ["a"])]), options);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.reason : "", /cycle/);
  assert.match(result.kind === "rejected" ? result.reason : "", /a → b → a|b → a → b/);
});

test("a task with no acceptance criteria is refused, as at intake", () => {
  // The same §12 rule intake enforces. Caught here so the agent is told while it still
  // has the context to fix it, rather than by a task that can never be marked done.
  const result = materialise(plan([{ ...task("a"), acceptance: [] }]), options);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.reason : "", /acceptance/);
});

test("a capability no runner advertises is refused", () => {
  const result = materialise(plan([{ ...task("a"), requires: ["quantum"] }]), options);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.reason : "", /never be claimed/);
});

test("a dependency on a task that is not in the plan is refused", () => {
  const result = materialise(plan([task("a", ["ghost"])]), options);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.reason : "", /not in the plan/);
});

test("duplicate local ids are refused before they can silently merge", () => {
  const result = materialise(plan([task("a"), task("a")]), options);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.reason : "", /unique/);
});

test("an empty plan is refused", () => {
  assert.equal(materialise(plan([]), options).kind, "rejected");
});

test("a task inherits the brainstorm's repos when it names none", () => {
  const result = materialise(plan([task("a")]), options);
  assert.equal(result.kind, "plan");
  assert.deepEqual(result.kind === "plan" ? result.tasks[0]?.spec.repos : [], [REPO]);
});

test("a task may name its own repos, qualified or not", () => {
  const result = materialise(
    plan([{ ...task("a"), repos: ["other/thing", "codeberg.org/eb/api"] }]),
    options,
  );
  assert.equal(result.kind, "plan");
  assert.deepEqual(result.kind === "plan" ? result.tasks[0]?.spec.repos : [], [
    { host: "github.com", owner: "other", name: "thing" },
    { host: "codeberg.org", owner: "eb", name: "api" },
  ]);
});

test("children are implementation tasks, never more brainstorms", () => {
  const result = materialise(plan([task("a")]), options);
  assert.equal(result.kind === "plan" ? result.tasks[0]?.spec.kind : undefined, "implement");
});

test("relayering after an edge changes recomputes every wave", () => {
  const waves = relayer([
    { id: asTaskId("P-01"), blockedBy: [] },
    { id: asTaskId("P-02"), blockedBy: [asTaskId("P-01")] },
    { id: asTaskId("P-03"), blockedBy: [asTaskId("P-02")] },
  ]);

  assert.deepEqual([...waves.values()], [0, 1, 2]);
});

test("relayering ignores blockers that are no longer in the set", () => {
  // A blocker that has been completed and dropped must not push its dependents down a
  // layer, or every finished task permanently inflates the waves behind it.
  const waves = relayer([{ id: asTaskId("P-02"), blockedBy: [asTaskId("P-01")] }]);
  assert.equal(waves.get(asTaskId("P-02")), 0);
});

test("layering reports the cycle it found, in order", () => {
  const result = layer([
    { localId: "a", dependsOn: ["b"] },
    { localId: "b", dependsOn: ["c"] },
    { localId: "c", dependsOn: ["a"] },
  ]);

  assert.equal(result.kind, "cycle");
  assert.deepEqual(result.kind === "cycle" ? result.cycle : [], ["a", "b", "c", "a"]);
});
