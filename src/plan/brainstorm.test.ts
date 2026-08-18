/**
 * Starting a brainstorm.
 *
 * The id scheme is the load-bearing part. It is derived from the Discord thread id, which
 * makes it unique without coordination and makes a message in a thread resolvable to a
 * task without a lookup table — the same property `taskIdFor` gets from a tracker ref.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceProfile } from "../config/types.ts";
import { asWorkspaceName, isTaskId, type WorkspaceName } from "../domain/task.ts";
import { brainstormId, brainstormSpec, parseRepo, resolveWorkspace } from "./brainstorm.ts";

const profile = (name: string, host: string, owner: string): WorkspaceProfile => ({
  name: asWorkspaceName(name),
  forge: { kind: host === "codeberg.org" ? "forgejo" : "github", host, owner, apiBase: `https://${host}` },
  secretRef: `caterpillar-${name}`,
});

const workspaces = (
  ...profiles: readonly WorkspaceProfile[]
): ReadonlyMap<WorkspaceName, WorkspaceProfile> =>
  new Map(profiles.map((p) => [p.name, p]));

test("a brainstorm's id is its thread, and is a usable task id", () => {
  const id = brainstormId("1537550186388258866");
  assert.equal(id, "BS-1537550186388258866");
  // It becomes a directory under `tasks/`, so it has to survive the same check every
  // other id does.
  assert.ok(isTaskId(id));
});

test("a workspace is matched on host and owner", () => {
  const caesar = profile("caesar", "github.com", "acme");
  const boogaloo = profile("electric-boogaloo", "codeberg.org", "eb");

  assert.equal(
    resolveWorkspace(workspaces(caesar, boogaloo), {
      host: "codeberg.org",
      owner: "eb",
      name: "api",
    })?.name,
    "electric-boogaloo",
  );
});

test("a single configured workspace needs no matching", () => {
  // With one there is nothing to disambiguate, and refusing would make the common setup
  // the awkward one.
  const only = profile("caesar", "github.com", "acme");
  assert.equal(
    resolveWorkspace(workspaces(only), { host: "github.com", owner: "someone-else", name: "x" })
      ?.name,
    "caesar",
  );
});

test("an unowned repo across several workspaces is refused rather than guessed", () => {
  const a = profile("caesar", "github.com", "acme");
  const b = profile("electric-boogaloo", "codeberg.org", "eb");

  assert.equal(
    resolveWorkspace(workspaces(a, b), { host: "github.com", owner: "stranger", name: "x" }),
    undefined,
  );
});

test("a repo is accepted qualified or not", () => {
  assert.deepEqual(parseRepo("acme/widget"), {
    host: "github.com",
    owner: "acme",
    name: "widget",
  });
  assert.deepEqual(parseRepo("codeberg.org/eb/api"), {
    host: "codeberg.org",
    owner: "eb",
    name: "api",
  });
  assert.equal(parseRepo("widget"), undefined);
});

test("a brainstorm spec declares no acceptance criteria, and says it is one", () => {
  // The single exception to §14's rule. Its gate is the council's verdict on the plan,
  // and `kind` is what tells every other path that.
  const spec = brainstormSpec({
    id: brainstormId("42"),
    workspace: asWorkspaceName("caesar"),
    topic: "Make intake accept a Linear issue",
    repos: [{ host: "github.com", owner: "acme", name: "widget" }],
    author: "operator",
  });

  assert.equal(spec.kind, "brainstorm");
  assert.deepEqual(spec.acceptance, []);
  assert.deepEqual(spec.repos, [{ host: "github.com", owner: "acme", name: "widget" }]);
  assert.match(spec.goal, /Make intake accept a Linear issue/);
  assert.match(spec.goal, /submit_plan/, "the agent must be told how this ends");
});
