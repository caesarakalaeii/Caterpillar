import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TrackerRef } from "../domain/task.ts";
import { DEFAULT_CANDIDATE_LABEL, TrackerScopeError } from "./types.ts";
import {
  GitHubIssuesApiError,
  GitHubIssuesTracker,
  UnknownGitHubLabelError,
  type FetchLike,
} from "./github-issues.ts";

const API_BASE = "https://api.github.test";
const OWNER = "acme";
const TASK = asTaskId("TASK-7");
const REF: TrackerRef = { kind: "github-issues", id: "42", container: `${OWNER}/widget` };

interface Call {
  readonly method: string;
  /** Path relative to the API base, query included. */
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

type Handler = (method: string, path: string, body: unknown) => unknown;

/** Records every request and answers from `handler`; returning a Response wins. */
const stub = (handler: Handler): { readonly fetch: FetchLike; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = input.slice(`${API_BASE}/`.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    const result = handler(method, path, body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? null), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
};

const tracker = (fetchImpl: FetchLike, ingestLabel = "agent"): GitHubIssuesTracker =>
  new GitHubIssuesTracker({
    apiBase: API_BASE,
    owner: OWNER,
    ingestLabel,
    token: async () => "ghs_token",
    fetch: fetchImpl,
  });

const paths = (calls: readonly Call[]): readonly string[] =>
  calls.map((call) => `${call.method} ${call.path}`);

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  owner: { login: OWNER },
  ...extra,
});

/** Answers the two lookups every transition makes before it mutates anything. */
const lifecycle =
  (labels: readonly string[] = ["agent-wip", "needs-human"]): Handler =>
  (_method, path) => {
    if (path.includes("/labels?")) return labels.map((name) => ({ name }));
    return null;
  };

test("the token travels as a Bearer header, never in the URL", async () => {
  const { fetch, calls } = stub(() => ({ repositories: [] }));
  await tracker(fetch).repos();

  assert.equal(calls[0]?.authorization, "Bearer ghs_token");
  assert.ok(!calls[0]?.path.includes("ghs_token"));
});

test("intake enumerates the installation instead of using the search API", async () => {
  // /search/issues is eventually consistent, separately rate limited, and its legacy
  // issue-search behaviour is deprecated. A freshly labelled issue must be visible now.
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("installation/repositories")) {
      return { repositories: [repo("widget")] };
    }
    return [];
  });

  await tracker(fetch).listAgentItems();

  assert.ok(!paths(calls).some((p) => p.includes("search")));
  assert.deepEqual(paths(calls), [
    "GET installation/repositories?per_page=100&page=1",
    "GET repos/acme/widget/issues?state=open&labels=agent&per_page=100&page=1",
  ]);
});

test("pull requests are dropped from intake — every PR is also an issue", async () => {
  // The trap that would otherwise hand the agent its own open PRs as fresh work.
  const { fetch } = stub((_method, path) => {
    if (path.startsWith("installation/repositories")) {
      return { repositories: [repo("widget")] };
    }
    return [
      { number: 42, title: "Real issue", body: "do the thing", html_url: "https://gh/42" },
      { number: 43, title: "A pull request", pull_request: { url: "https://gh/pulls/43" } },
    ];
  });

  const items = await tracker(fetch).listAgentItems();

  assert.equal(items.length, 1);
  assert.deepEqual(items[0]?.ref, {
    kind: "github-issues",
    id: "42",
    container: "acme/widget",
  });
  assert.equal(items[0]?.title, "Real issue");
  assert.equal(items[0]?.url, "https://gh/42");
});

test("author_association decides whether an issue's body may become a task", async () => {
  // Read off the list response, so gating on it costs no extra request. CONTRIBUTOR is
  // NOT trusted: GitHub grants it for a single merged commit, which on a public repo is
  // close to "anyone who has ever been helpful once".
  const { fetch } = stub((_method, path) =>
    path.startsWith("installation/repositories")
      ? { repositories: [repo("widget")] }
      : [
          { number: 1, title: "from the owner", author_association: "OWNER" },
          { number: 2, title: "from a collaborator", author_association: "COLLABORATOR" },
          { number: 3, title: "from an org member", author_association: "MEMBER" },
          { number: 4, title: "from a drive-by contributor", author_association: "CONTRIBUTOR" },
          { number: 5, title: "from a stranger", author_association: "NONE" },
          { number: 6, title: "from an ancient GHES that omits the field" },
        ],
  );

  const items = await tracker(fetch).listAgentItems();

  assert.deepEqual(
    items.map((i) => i.authorTrusted),
    [true, true, true, false, false, false],
  );
});

test("an issue with no body arrives as null and becomes empty prose", async () => {
  const { fetch } = stub((_method, path) =>
    path.startsWith("installation/repositories")
      ? { repositories: [repo("widget")] }
      : [{ number: 42, title: "titled only", body: null }],
  );

  const items = await tracker(fetch).listAgentItems();
  assert.equal(items[0]?.body, "");
});

test("archived repos and other owners are never queried", async () => {
  // An issue on an archived repo cannot receive a PR, so a task from one could never
  // pass its acceptance gate.
  const { fetch, calls } = stub((_method, path) =>
    path.startsWith("installation/repositories")
      ? {
          repositories: [
            repo("widget"),
            repo("old", { archived: true }),
            { name: "someone-elses", owner: { login: "third-party" } },
          ],
        }
      : [],
  );

  await tracker(fetch).listAgentItems();

  assert.deepEqual(
    paths(calls).filter((p) => p.includes("/issues")),
    ["GET repos/acme/widget/issues?state=open&labels=agent&per_page=100&page=1"],
  );
});

test("list routes are paginated to exhaustion across both page shapes", async () => {
  // /installation/repositories answers with an object; issue lists with a bare array.
  const full = Array.from({ length: 100 }, (_, index) => repo(`r${index}`));
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("installation/repositories")) {
      // Anchored on the trailing parameter: `per_page=100` itself contains "page=1",
      // so a loose match here answers every page with a full one and never terminates.
      return path.endsWith("&page=1") ? { repositories: full } : { repositories: [repo("last")] };
    }
    return [];
  });

  await tracker(fetch).repos();

  assert.deepEqual(paths(calls), [
    "GET installation/repositories?per_page=100&page=1",
    "GET installation/repositories?per_page=100&page=2",
  ]);
});

test("a 403 is a missing permission; a 401 is a bad credential", async () => {
  // GitHub keeps these distinct, unlike Vikunja, so conflating them here would throw
  // away a signal the API actually gives us.
  const forbidden = stub(() => new Response('{"message":"Resource not accessible"}', { status: 403 }));
  await assert.rejects(() => tracker(forbidden.fetch).comment(REF, "hi"), TrackerScopeError);

  const unauthorized = stub(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
  await assert.rejects(
    () => tracker(unauthorized.fetch).comment(REF, "hi"),
    (error: unknown) => error instanceof GitHubIssuesApiError && error.status === 401,
  );
});

test("comments are markdown, posted verbatim", async () => {
  // GitHub renders markdown natively — no HTML round trip, unlike Vikunja.
  const { fetch, calls } = stub(() => null);
  await tracker(fetch).comment(REF, "**bold** and a https://example.com link");

  assert.deepEqual(paths(calls), ["POST repos/acme/widget/issues/42/comments"]);
  assert.deepEqual(calls[0]?.body, { body: "**bold** and a https://example.com link" });
});

test("claiming comments, applies wip, and stops advertising needs-human", async () => {
  // A claim after a question means the question was ANSWERED — that is the only way a
  // task leaves `awaiting-human`. Leaving the label behind sends whoever filters on it
  // to an item nobody is waiting on, and the first intake-sourced task ended `done`,
  // closed, and still labelled `needs-human`.
  const { fetch, calls } = stub(lifecycle());
  await tracker(fetch).transition(REF, { kind: "claimed", runner: "runner-1" }, TASK);

  assert.deepEqual(
    paths(calls).filter((p) => !p.includes("/labels?")),
    [
      "POST repos/acme/widget/issues/42/comments",
      "POST repos/acme/widget/issues/42/labels",
      "DELETE repos/acme/widget/issues/42/labels/needs-human",
    ],
  );
  assert.deepEqual(calls.at(-2)?.body, { labels: ["agent-wip"] });
});

test("a label GitHub would have silently created is refused instead", async () => {
  // POST .../labels CREATES an unknown label with a random colour. That is the
  // "adapter invents tracker vocabulary" failure the Vikunja adapter avoids by
  // withholding a scope; here it has to be refused in code.
  const { fetch, calls } = stub(lifecycle(["bug", "enhancement"]));

  await assert.rejects(
    () => tracker(fetch).transition(REF, { kind: "claimed", runner: "runner-1" }, TASK),
    (error: unknown) =>
      error instanceof UnknownGitHubLabelError && /Known labels: bug, enhancement/.test(error.message),
  );

  // The comment still landed, so the human sees what happened.
  assert.ok(paths(calls).includes("POST repos/acme/widget/issues/42/comments"));
  assert.ok(!paths(calls).some((p) => p.startsWith("POST") && p.endsWith("/labels")));
});

test("a question keeps agent-wip and adds needs-human", async () => {
  const { fetch, calls } = stub(lifecycle());
  await tracker(fetch).transition(REF, { kind: "question", question: "which db?" }, TASK);

  assert.deepEqual(calls.at(-1)?.body, { labels: ["needs-human"] });
  // The task is still owned, just blocked — nothing removes the wip label.
  assert.ok(!paths(calls).some((p) => p.startsWith("DELETE")));
});

test("parking removes the wip label and leaves the issue open", async () => {
  const { fetch, calls } = stub(lifecycle());
  await tracker(fetch).transition(REF, { kind: "parked", reason: "no progress" }, TASK);

  assert.deepEqual(
    paths(calls).filter((p) => !p.includes("/labels?")),
    [
      "POST repos/acme/widget/issues/42/comments",
      "DELETE repos/acme/widget/issues/42/labels/agent-wip",
    ],
  );
  assert.ok(!paths(calls).some((p) => p.startsWith("PATCH")));
});

test("completion closes the issue last, after the prose and the label", async () => {
  // Ordering is deliberate: a failure at the close still leaves an issue that reads as
  // finished and can be closed by hand.
  const { fetch, calls } = stub(lifecycle());
  await tracker(fetch).transition(
    REF,
    { kind: "completed", prUrl: "https://github.test/pr/9" },
    TASK,
  );

  assert.deepEqual(
    paths(calls).filter((p) => !p.includes("/labels?")),
    [
      "POST repos/acme/widget/issues/42/comments",
      "DELETE repos/acme/widget/issues/42/labels/agent-wip",
      // A done task is waiting on nobody, whatever it asked along the way.
      "DELETE repos/acme/widget/issues/42/labels/needs-human",
      "PATCH repos/acme/widget/issues/42",
    ],
  );
  assert.deepEqual(calls.at(-1)?.body, { state: "closed", state_reason: "completed" });
});

test("removing a label the issue does not carry is a no-op, not a 404", async () => {
  const { fetch } = stub((method, path) => {
    if (path.includes("/labels?")) return [{ name: "agent-wip" }];
    if (method === "DELETE") return new Response('{"message":"Label does not exist"}', { status: 404 });
    return null;
  });

  await assert.doesNotReject(() =>
    tracker(fetch).transition(REF, { kind: "parked", reason: "no progress" }, TASK),
  );
});

test("label lookups are cached per repo across transitions", async () => {
  const { fetch, calls } = stub(lifecycle());
  const subject = tracker(fetch);

  await subject.transition(REF, { kind: "claimed", runner: "r" }, TASK);
  await subject.transition(REF, { kind: "parked", reason: "done for now" }, TASK);

  assert.equal(paths(calls).filter((p) => p.includes("/labels?")).length, 1);
});

test("create POSTs to the repo's issues route and carries title, body and labels", async () => {
  const { fetch, calls } = stub((_method, path) => {
    if (path.includes("/labels?")) return [{ name: DEFAULT_CANDIDATE_LABEL }];
    return { number: 77, html_url: "https://gh/acme/widget/issues/77" };
  });

  const ref = await tracker(fetch).create({
    title: "Crash on empty spec",
    body: "Steps to reproduce…",
    container: "acme/widget",
    labels: [DEFAULT_CANDIDATE_LABEL],
  });

  assert.deepEqual(
    paths(calls).filter((p) => !p.includes("/labels?")),
    ["POST repos/acme/widget/issues"],
  );
  assert.deepEqual(calls.at(-1)?.body, {
    title: "Crash on empty spec",
    body: "Steps to reproduce…",
    labels: ["agent-candidate"],
  });
  assert.deepEqual(ref, { kind: "github-issues", id: "77", container: "acme/widget" });
});

test("a filed issue never carries the ingest label that would mint it as a task", async () => {
  // Self-amplifying if it did: intake would turn the report into a running task on the
  // next pass, which could file another report.
  const { fetch, calls } = stub((_method, path) =>
    path.includes("/labels?")
      ? [{ name: "agent" }, { name: DEFAULT_CANDIDATE_LABEL }]
      : { number: 77 },
  );

  await tracker(fetch).create({
    title: "t",
    body: "b",
    container: "acme/widget",
    labels: [DEFAULT_CANDIDATE_LABEL],
  });

  const applied = (calls.at(-1)?.body as { labels: readonly string[] }).labels;
  assert.deepEqual(applied, ["agent-candidate"]);
  assert.ok(!applied.includes("agent"));
});

test("the ref create returns round-trips back through comment", async () => {
  // A ref that cannot address the item afterwards makes the report unreachable.
  const { fetch, calls } = stub((_method, path) =>
    path.includes("/labels?") ? [{ name: DEFAULT_CANDIDATE_LABEL }] : { number: 77 },
  );
  const subject = tracker(fetch);

  const ref = await subject.create({
    title: "t",
    body: "b",
    container: "acme/widget",
    labels: [DEFAULT_CANDIDATE_LABEL],
  });
  await subject.comment(ref, "a follow-up");

  assert.equal(paths(calls).at(-1), "POST repos/acme/widget/issues/77/comments");
});

test("a label the repo lacks is dropped and reported, and the issue is still filed", async () => {
  // A dropped label is recoverable by hand; a lost report is not. GitHub would have
  // silently created the label — the same vocabulary-inventing failure addLabel refuses.
  const { fetch, calls } = stub((_method, path) =>
    path.includes("/labels?") ? [{ name: "bug" }] : { number: 77 },
  );
  const omitted: string[][] = [];

  const ref = await tracker(fetch).create({
    title: "t",
    body: "b",
    container: "acme/widget",
    labels: [DEFAULT_CANDIDATE_LABEL, "bug"],
    onLabelsOmitted: (labels) => omitted.push([...labels]),
  });

  assert.deepEqual(ref, { kind: "github-issues", id: "77", container: "acme/widget" });
  assert.deepEqual(omitted, [["agent-candidate"]]);
  assert.deepEqual(calls.at(-1)?.body, { title: "t", body: "b", labels: ["bug"] });
  // Nothing tries to create the missing label.
  assert.ok(!paths(calls).includes("POST repos/acme/widget/labels"));
});

test("create surfaces a missing permission as a scope error on its own route", async () => {
  const { fetch } = stub((_method, path) => {
    if (path.includes("/labels?")) return [{ name: DEFAULT_CANDIDATE_LABEL }];
    return new Response('{"message":"Resource not accessible"}', { status: 403 });
  });

  await assert.rejects(
    () =>
      tracker(fetch).create({
        title: "t",
        body: "b",
        container: "acme/widget",
        labels: [DEFAULT_CANDIDATE_LABEL],
      }),
    (error: unknown) => {
      assert.ok(error instanceof TrackerScopeError);
      assert.equal(error.route, "repos/acme/widget/issues");
      assert.equal(error.requiredScope, "issues");
      return true;
    },
  );
});

test("create refuses a request whose container is not an owner/name slug", async () => {
  const { fetch, calls } = stub(() => null);

  await assert.rejects(
    () =>
      tracker(fetch).create({ title: "t", body: "b", container: "widget", labels: [] }),
    /is not an 'owner\/name' repo slug/,
  );
  assert.equal(calls.length, 0);
});

test("a ref without an owner/name container is rejected as ambiguous", async () => {
  // Issue numbers are per repo, so the repo cannot be inferred from the id alone.
  const { fetch } = stub(() => null);

  await assert.rejects(
    () => tracker(fetch).comment({ kind: "github-issues", id: "42" }, "hi"),
    /has no 'owner\/name' container/,
  );
});
