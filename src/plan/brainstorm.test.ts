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
import {
  brainstormId,
  brainstormSpec,
  dedupeRepos,
  parseRepo,
  qualifiedSlug,
  resolveWorkspace,
} from "./brainstorm.ts";

const WIDGET = { host: "github.com", owner: "acme", name: "widget" } as const;
const API = { host: "github.com", owner: "acme", name: "api" } as const;
const CONTOSO = { host: "codeberg.org", owner: "contoso", name: "api" } as const;

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
  const primary = profile("primary", "github.com", "acme");
  const ossProfile = profile("oss", "codeberg.org", "contoso");

  assert.equal(
    resolveWorkspace(workspaces(primary, ossProfile), {
      host: "codeberg.org",
      owner: "contoso",
      name: "api",
    })?.name,
    "oss",
  );
});

test("a single configured workspace needs no matching", () => {
  // With one there is nothing to disambiguate, and refusing would make the common setup
  // the awkward one.
  const only = profile("primary", "github.com", "acme");
  assert.equal(
    resolveWorkspace(workspaces(only), { host: "github.com", owner: "someone-else", name: "x" })
      ?.name,
    "primary",
  );
});

test("an unowned repo across several workspaces is refused rather than guessed", () => {
  const a = profile("primary", "github.com", "acme");
  const b = profile("oss", "codeberg.org", "contoso");

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
  assert.deepEqual(parseRepo("codeberg.org/contoso/api"), {
    host: "codeberg.org",
    owner: "contoso",
    name: "api",
  });
  assert.equal(parseRepo("widget"), undefined);
});

test("a brainstorm spec declares no acceptance criteria, and says it is one", () => {
  // The single exception to §14's rule. Its gate is the council's verdict on the plan,
  // and `kind` is what tells every other path that.
  const spec = brainstormSpec({
    id: brainstormId("42"),
    workspace: asWorkspaceName("primary"),
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

test("a brainstorm spec carries every repo it was given, in order", () => {
  // Order is load-bearing: `repos[0]` is the workspace repo and becomes the agent's
  // working directory (§9.4.1), and plan children inherit the whole list unchanged.
  const spec = brainstormSpec({
    id: brainstormId("42"),
    workspace: asWorkspaceName("primary"),
    topic: "Split the client out of the server",
    repos: [WIDGET, API, CONTOSO],
    author: "operator",
  });

  assert.deepEqual(spec.repos, [WIDGET, API, CONTOSO]);
});

test("the same repo named twice is one repo", () => {
  const spec = brainstormSpec({
    id: brainstormId("42"),
    workspace: asWorkspaceName("primary"),
    topic: "Split the client out of the server",
    repos: [WIDGET, API, WIDGET, { ...API }],
    author: "operator",
  });

  assert.deepEqual(spec.repos, [WIDGET, API], "the first mention wins, so order survives");
  assert.deepEqual(dedupeRepos([API, WIDGET, API]), [API, WIDGET]);
});

test("the goal names every repo the brainstorm may read", () => {
  // The agent reads the GOAL. A sibling checked out under `repos/` that nothing tells it
  // about is a repo it will not open, which is the whole payoff of the list going missing.
  const spec = brainstormSpec({
    id: brainstormId("42"),
    workspace: asWorkspaceName("primary"),
    topic: "Split the client out of the server",
    repos: [WIDGET, CONTOSO],
    author: "operator",
  });

  assert.match(spec.goal, /acme\/widget/);
  assert.match(spec.goal, /codeberg\.org\/contoso\/api/, "a non-GitHub repo stays qualified");
  assert.match(spec.goal, /repos\/<name>/, "and it must be told where the siblings are");
});

test("a repo is named the way a human typed it", () => {
  assert.equal(qualifiedSlug(WIDGET), "acme/widget");
  assert.equal(qualifiedSlug(CONTOSO), "codeberg.org/contoso/api");
});
