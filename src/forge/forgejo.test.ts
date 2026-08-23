import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type RepoRef, type TaskSpec } from "../domain/task.ts";
import { ForgejoForgeFactory, MissingRepoTokenError, summariseCombinedStatus } from "./forgejo.ts";
import { RepoOffWorkspaceError, RepoOutOfScopeError } from "./types.ts";

const REPO: RepoRef = { host: "codeberg.org", owner: "Acme", name: "acme-api" };

const spec = (repos: readonly RepoRef[]): TaskSpec => ({
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("oss"),
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
  const forge = await factory([["Acme", "tok"]]).forTask(spec([REPO]));
  const credential = await forge.credential(REPO);

  assert.equal(credential.username, "bot");
  assert.equal(credential.password, "tok");
  // Forgejo tokens do not expire, so there is deliberately no expiry to renew against.
  assert.equal(credential.expiresAt, undefined);
});

test("a repo outside the task's spec is refused before any request", async () => {
  // The spec, not the token, is the scope boundary on Forgejo — the token cannot be
  // narrowed at use time because there is no mint step.
  const forge = await factory([["Acme", "tok"]]).forTask(spec([REPO]));
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
    () => factory([["Acme", "tok"]]).forTask(spec([REPO, hostile])),
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
    [["Acme", "broad"]],
    [["Acme/acme-api", "narrow"]],
  ).forTask(spec([REPO]));

  assert.equal((await forge.credential(REPO)).password, "narrow");

  const sibling = { ...REPO, name: "acme-admin" };
  const multi = await factory(
    [["Acme", "broad"]],
    [["Acme/acme-api", "narrow"]],
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

/**
 * Reachability (DESIGN.md §9.1).
 *
 * The same door as GitHub's, answered from what Forgejo actually has: there is no
 * installation, so "can this credential reach that repo" is two questions — is a token
 * configured for it, and does the repo exist.
 */
const reachable = (
  owners: readonly [string, string][],
  handler: (route: string) => Response,
): ForgejoForgeFactory =>
  new ForgejoForgeFactory(
    {
      apiBase: "https://codeberg.org/api/v1",
      username: "bot",
      tokensByOwner: new Map(owners),
      fetch: (input) => Promise.resolve(handler(input.replace("https://codeberg.org/api/v1", ""))),
    },
    { host: "codeberg.org" },
  );

test("a repo with no configured token is unreachable, and says which secret to edit", async () => {
  const unreachable = await reachable([["Acme", "tok"]], () => {
    throw new Error("no request should be made for a repo with no token");
  }).unreachable([{ host: "codeberg.org", owner: "stranger", name: "thing" }]);

  assert.equal(unreachable.length, 1);
  assert.match(unreachable[0]?.reason ?? "", /token/);
  assert.match(unreachable[0]?.reason ?? "", /stranger/);
});

test("a repo the token cannot see is unreachable; one it can is not", async () => {
  const factory = reachable([["Acme", "tok"]], (route) =>
    route === "/repos/Acme/acme-api"
      ? new Response("{}", { status: 200 })
      : new Response("Not Found", { status: 404 }),
  );

  assert.deepEqual(await factory.unreachable([REPO]), []);

  const unreachable = await factory.unreachable([
    { host: "codeberg.org", owner: "Acme", name: "acme-apy" },
  ]);
  assert.equal(unreachable.length, 1);
  assert.match(unreachable[0]?.reason ?? "", /acme-apy/);
});

test("a forge that cannot answer THROWS rather than calling a repo unreachable", async () => {
  // Every caller fails open on a throw: a 500 from Codeberg is not evidence that a repo
  // was deleted, and turning it into one would park a task over a blip.
  const factory = reachable([["Acme", "tok"]], () => new Response("", { status: 500 }));
  await assert.rejects(factory.unreachable([REPO]), /500/);
});

test("the state repo is refused at the door, not at the mint", async () => {
  const factory = new ForgejoForgeFactory(
    {
      apiBase: "https://codeberg.org/api/v1",
      username: "bot",
      tokensByOwner: new Map([["acme", "tok"]]),
      fetch: () => Promise.reject(new Error("no request should be needed")),
    },
    { host: "codeberg.org", stateRepo: { host: "codeberg.org", owner: "acme", name: "state" } },
  );

  const unreachable = await factory.unreachable([
    { host: "codeberg.org", owner: "acme", name: "state" },
  ]);
  assert.equal(unreachable.length, 1);
  assert.match(unreachable[0]?.reason ?? "", /state repo/);
});

test("the catalogue is what the tokens can enumerate, narrowed to owners we hold", async () => {
  // A bot account can be a collaborator on repos this workspace holds no token for.
  // Suggesting one offers work that cannot be cloned.
  const factory = reachable([["Acme", "tok"]], (route) =>
    route.startsWith("/user/repos")
      ? new Response(
          JSON.stringify(
            route.includes("page=1")
              ? [
                  { full_name: "Acme/acme-api" },
                  { full_name: "SomeoneElse/not-ours" },
                  { full_name: "Acme/acme-web" },
                ]
              : [],
          ),
          { status: 200 },
        )
      : new Response("Not Found", { status: 404 }),
  );

  assert.deepEqual(await factory.reachable(), [
    "Acme/acme-api",
    "Acme/acme-web",
  ]);
});

test("a token that may not list falls back to the repos it was configured for", async () => {
  // A repository-scoped token answers 403 here. An empty box is a working box; a thrown
  // error inside an autocomplete would be a Discord interaction that never gets answered.
  const factory = new ForgejoForgeFactory(
    {
      apiBase: "https://codeberg.org/api/v1",
      username: "bot",
      tokensByOwner: new Map([["Acme", "tok"]]),
      tokensByRepo: new Map([["Acme/acme-api", "narrow"]]),
      fetch: () => Promise.resolve(new Response("Forbidden", { status: 403 })),
    },
    { host: "codeberg.org" },
  );

  assert.deepEqual(await factory.reachable(), ["Acme/acme-api"]);
});

/* ─────────────────────── review comments as task guidance ─────────────────────── */

/**
 * Forgejo needs no GraphQL for this (DESIGN.md §7.3): Gitea's `PullReviewComment` carries
 * `resolver` — the account that closed the thread — so resolution comes back over REST,
 * one request per review.
 */
const served = (handler: (route: string) => unknown): ForgejoForgeFactory =>
  new ForgejoForgeFactory(
    {
      apiBase: "https://codeberg.org/api/v1",
      username: "bot",
      tokensByOwner: new Map([["Acme", "tok"]]),
      fetch: (input) => {
        const body = handler(input.replace("https://codeberg.org/api/v1", ""));
        return Promise.resolve(
          body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    },
    { host: "codeberg.org" },
  );

const reviewComment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  body: "this swallows the error",
  path: "src/index.ts",
  position: 12,
  user: { login: "a-human" },
  created_at: "2026-08-13T10:00:00.000Z",
  html_url: "https://codeberg.org/Acme/acme-api/pulls/7#issuecomment-1",
  ...over,
});

test("review comments come back with their file, line and resolution", async () => {
  const forge = await served((route) => {
    if (route === "/repos/Acme/acme-api/pulls/7/reviews") {
      return [{ id: 10 }, { id: 11 }];
    }
    if (route === "/repos/Acme/acme-api/pulls/7/reviews/10/comments") {
      return [reviewComment()];
    }
    if (route === "/repos/Acme/acme-api/pulls/7/reviews/11/comments") {
      // `resolver` is the account that closed the thread. Its presence IS the resolved flag.
      return [reviewComment({ id: 2, body: "dealt with", resolver: { login: "a-human" } })];
    }
    throw new Error(`unexpected route ${route}`);
  }).forTask(spec([REPO]));

  const comments = await forge.listReviewComments(REPO, 7);

  assert.equal(comments.length, 2, "resolved comments are returned, not filtered");
  assert.deepEqual(
    comments.map((c) => [c.body, c.resolved]),
    [["this swallows the error", false], ["dealt with", true]],
  );
  const first = comments[0];
  assert.equal(first?.path, "src/index.ts");
  assert.equal(first?.line, 12);
  assert.equal(first?.author, "a-human");
  assert.equal(first?.fromFleet, false);
  assert.deepEqual(first?.repo, REPO);
  assert.equal(first?.pr, 7);
});

test("a comment from the account the tokens belong to is the fleet's own", async () => {
  // Forgejo has no bot flag: the fleet is an ordinary account, and the only thing that
  // tells it apart from a human is that it is the one the tokens were issued for.
  const forge = await served((route) => {
    if (route.endsWith("/reviews")) return [{ id: 10 }];
    return [reviewComment({ user: { login: "bot" } })];
  }).forTask(spec([REPO]));

  const comments = await forge.listReviewComments(REPO, 7);
  assert.equal(comments[0]?.fromFleet, true);
});

test("a comment whose line has moved is reported as outdated, without a line", async () => {
  // Forgejo answers `position: null` for a comment whose diff hunk no longer exists, and
  // keeps `original_position`. That is the same thing GitHub calls outdated, and a null
  // carried through as a number renders as `src/index.ts:null`.
  const forge = await served((route) => {
    if (route.endsWith("/reviews")) return [{ id: 10 }];
    return [reviewComment({ position: null, original_position: 12 })];
  }).forTask(spec([REPO]));

  const comments = await forge.listReviewComments(REPO, 7);
  assert.equal(comments[0]?.outdated, true);
  assert.equal(comments[0]?.line, undefined);
});

test("the review body itself is guidance, even though it is attached to no file", async () => {
  // "this is the wrong approach" is written in the review, not against a line. Reading only
  // the per-line comments would drop the objection that is about the change as a whole.
  const forge = await served((route) => {
    if (route.endsWith("/reviews")) {
      return [
        {
          id: 10,
          body: "this is the wrong approach",
          user: { login: "a-human" },
          submitted_at: "2026-08-13T10:00:00.000Z",
          html_url: "https://codeberg.org/Acme/acme-api/pulls/7#review-10",
        },
      ];
    }
    return [];
  }).forTask(spec([REPO]));

  const comments = await forge.listReviewComments(REPO, 7);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, "this is the wrong approach");
  assert.equal(comments[0]?.path, undefined);
});

test("an empty review body is not a comment at all", async () => {
  // An APPROVED review with no prose is the ordinary way to approve, and rendering it as a
  // blank quote in the prompt would say a human had objected to nothing.
  const forge = await served((route) => {
    if (route.endsWith("/reviews")) return [{ id: 10, body: "", user: { login: "a-human" } }];
    return [];
  }).forTask(spec([REPO]));

  assert.deepEqual(await forge.listReviewComments(REPO, 7), []);
});

test("Forgejo returning null instead of an empty array is not a crash", async () => {
  // Verified against codeberg.org for commit statuses, and the same is true here: a `.map`
  // over the absence of a list is how that was discovered the first time.
  const forge = await served(() => null).forTask(spec([REPO]));
  assert.deepEqual(await forge.listReviewComments(REPO, 7), []);
});

test("a forge that cannot be asked throws, so an empty list never means 'could not ask'", async () => {
  const forge = await served(() => new Response("boom", { status: 500 })).forTask(spec([REPO]));
  await assert.rejects(() => forge.listReviewComments(REPO, 7), /500/);
});

test("review comments are refused for a repo outside the task's scope", async () => {
  const forge = await served(() => {
    throw new Error("no request should be made for an out-of-scope repo");
  }).forTask(spec([REPO]));

  await assert.rejects(
    () => forge.listReviewComments({ host: "codeberg.org", owner: "Acme", name: "other" }, 1),
    RepoOutOfScopeError,
  );
});
