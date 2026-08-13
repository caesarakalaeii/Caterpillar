import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type RepoRef, type TaskSpec } from "../domain/task.ts";
import { ForgejoForgeFactory, MissingRepoTokenError, summariseCombinedStatus } from "./forgejo.ts";
import { RepoOutOfScopeError } from "./types.ts";

const REPO: RepoRef = { host: "codeberg.org", owner: "ElectricBoogaloo", name: "eb-api" };

const spec = (repos: readonly RepoRef[]): TaskSpec => ({
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("electric-boogaloo"),
  goal: "g",
  repos,
  requires: [],
  acceptance: ["true"],
});

const factory = (entries: readonly [string, string][]) =>
  new ForgejoForgeFactory({
    apiBase: "https://codeberg.org/api/v1",
    username: "bot",
    tokensByRepo: new Map(entries),
  });

test("serves the repo-scoped token for a declared repo", async () => {
  const forge = await factory([["ElectricBoogaloo/eb-api", "tok"]]).forTask(spec([REPO]));
  const credential = await forge.credential(REPO);

  assert.equal(credential.username, "bot");
  assert.equal(credential.password, "tok");
  // Forgejo tokens do not expire, so there is deliberately no expiry to renew against.
  assert.equal(credential.expiresAt, undefined);
});

test("a repo outside the task's spec is refused before any request", async () => {
  const forge = await factory([["ElectricBoogaloo/eb-api", "tok"]]).forTask(spec([REPO]));
  await assert.rejects(
    () => forge.credential({ ...REPO, name: "other" }),
    RepoOutOfScopeError,
  );
});

test("a declared repo with no configured token fails loudly, never falling back", async () => {
  // The absence of a fallback is the point: a broader token must never be substituted.
  const forge = await factory([]).forTask(spec([REPO]));
  await assert.rejects(() => forge.credential(REPO), MissingRepoTokenError);
});

test("no statuses at all is 'none', not success", () => {
  const status = summariseCombinedStatus({ state: "", total_count: 0, statuses: [] });
  assert.equal(status.conclusion, "none");
});

test("handles Forgejo returning statuses as null rather than an empty array", () => {
  // This is the literal shape codeberg.org returns for a ref with no statuses:
  // {"state":"","sha":"","total_count":0,"statuses":null,...}
  const status = summariseCombinedStatus({ state: "", total_count: 0, statuses: null });
  assert.equal(status.conclusion, "none");
});

test("Forgejo's 'error' state is a hard failure, like 'failure'", () => {
  // GitHub has no 'error' state; treating it as unknown-and-therefore-fine would let a
  // broken pipeline through the completion gate.
  const status = summariseCombinedStatus({
    state: "error",
    total_count: 1,
    statuses: [{ status: "error", context: "build", description: "boom" }],
  });
  assert.equal(status.conclusion, "failure");
  assert.match(status.summary, /build/);
});

test("'warning' is non-blocking in Forgejo, so it passes but is reported", () => {
  const status = summariseCombinedStatus({
    state: "warning",
    total_count: 2,
    statuses: [
      { status: "success", context: "test", description: "" },
      { status: "warning", context: "lint", description: "" },
    ],
  });
  assert.equal(status.conclusion, "success");
  assert.match(status.summary, /warning/);
});

test("a pending status wins over passing ones", () => {
  const status = summariseCombinedStatus({
    state: "pending",
    total_count: 2,
    statuses: [
      { status: "success", context: "test", description: "" },
      { status: "pending", context: "build", description: "" },
    ],
  });
  assert.equal(status.conclusion, "pending");
});

test("a failure wins over a pending status", () => {
  const status = summariseCombinedStatus({
    state: "pending",
    total_count: 2,
    statuses: [
      { status: "pending", context: "test", description: "" },
      { status: "failure", context: "build", description: "" },
    ],
  });
  assert.equal(status.conclusion, "failure");
});

test("all-success is success", () => {
  const status = summariseCombinedStatus({
    state: "success",
    total_count: 2,
    statuses: [
      { status: "success", context: "test", description: "" },
      { status: "success", context: "build", description: "" },
    ],
  });
  assert.equal(status.conclusion, "success");
});
