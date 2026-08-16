import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type RepoRef, type TaskSpec } from "../domain/task.ts";
import { ForgejoForgeFactory, MissingRepoTokenError, summariseCombinedStatus } from "./forgejo.ts";
import { RepoOffWorkspaceError, RepoOutOfScopeError } from "./types.ts";

const REPO: RepoRef = { host: "codeberg.org", owner: "ElectricBoogaloo", name: "eb-api" };

const spec = (repos: readonly RepoRef[]): TaskSpec => ({
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("electric-boogaloo"),
  goal: "g",
  repos,
  requires: [],
  acceptance: ["true"],
});

const factory = (
  owners: readonly [string, string][],
  repos: readonly [string, string][] = [],
) =>
  new ForgejoForgeFactory(
    {
      apiBase: "https://codeberg.org/api/v1",
      username: "bot",
      tokensByOwner: new Map(owners),
      ...(repos.length > 0 ? { tokensByRepo: new Map(repos) } : {}),
    },
    { host: "codeberg.org" },
  );

test("serves the owner-wide token for a declared repo", async () => {
  // Owner-wide is the normal unit on Codeberg: these ecosystems are worked as one
  // workspace plus sibling clones, so essentially no task touches a single repo.
  const forge = await factory([["ElectricBoogaloo", "tok"]]).forTask(spec([REPO]));
  const credential = await forge.credential(REPO);

  assert.equal(credential.username, "bot");
  assert.equal(credential.password, "tok");
  // Forgejo tokens do not expire, so there is deliberately no expiry to renew against.
  assert.equal(credential.expiresAt, undefined);
});

test("a repo outside the task's spec is refused before any request", async () => {
  // The spec, not the token, is the scope boundary on Forgejo — the token cannot be
  // narrowed at use time because there is no mint step.
  const forge = await factory([["ElectricBoogaloo", "tok"]]).forTask(spec([REPO]));
  await assert.rejects(
    () => forge.credential({ ...REPO, name: "other" }),
    RepoOutOfScopeError,
  );
});

test("a repo on another host is refused when the task is built, not when it is used", async () => {
  // The Codeberg token is owner-wide and never expires, so serving one to a host the
  // operator did not configure is a permanent compromise. `spec.repos` cannot be the
  // check — it is rendered from an issue body, so a hostile entry matches itself.
  const hostile: RepoRef = { ...REPO, host: "evil.example.com" };

  await assert.rejects(
    () => factory([["ElectricBoogaloo", "tok"]]).forTask(spec([REPO, hostile])),
    RepoOffWorkspaceError,
  );
});

test("a declared repo under an unknown owner fails loudly", async () => {
  const forge = await factory([["SomeoneElse", "tok"]]).forTask(spec([REPO]));
  await assert.rejects(() => forge.credential(REPO), MissingRepoTokenError);
});

test("a per-repo token overrides the owner-wide one", async () => {
  // Lets a sensitive repo carry a tighter credential without changing how the rest of
  // the ecosystem is reached.
  const forge = await factory(
    [["ElectricBoogaloo", "broad"]],
    [["ElectricBoogaloo/eb-api", "narrow"]],
  ).forTask(spec([REPO]));

  assert.equal((await forge.credential(REPO)).password, "narrow");

  const sibling = { ...REPO, name: "eb-admin" };
  const multi = await factory(
    [["ElectricBoogaloo", "broad"]],
    [["ElectricBoogaloo/eb-api", "narrow"]],
  ).forTask(spec([REPO, sibling]));
  assert.equal((await multi.credential(sibling)).password, "broad");
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
