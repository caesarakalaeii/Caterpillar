import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceChange } from "./acceptance.ts";

test("a criterion only the amendment names is added, and one only the spec names is removed", () => {
  const change = acceptanceChange(["npm test", "npm run lint"], ["npm test", "npm test -- src"]);

  assert.deepEqual(change.removed, ["npm run lint"]);
  assert.deepEqual(change.added, ["npm test -- src"]);
});

test("an identical list changed nothing", () => {
  const change = acceptanceChange(["npm test"], ["npm test"]);

  assert.deepEqual(change.removed, []);
  assert.deepEqual(change.added, []);
});

test("a reordered list changed nothing, because the gate is a set of commands", () => {
  // Order decides only which command runs first, and every one of them must pass. Calling
  // a reorder an amendment would put two criteria under "added" that nobody touched.
  const change = acceptanceChange(["a", "b"], ["b", "a"]);

  assert.deepEqual(change.removed, []);
  assert.deepEqual(change.added, []);
});
