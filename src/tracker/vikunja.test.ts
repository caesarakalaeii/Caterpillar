import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TrackerRef } from "../domain/task.ts";
import { TrackerScopeError } from "./types.ts";
import {
  stripHtml,
  toCommentHtml,
  UnknownVikunjaLabelError,
  VikunjaApiError,
  VikunjaTracker,
  type FetchLike,
} from "./vikunja.ts";

const API_BASE = "https://tasks.example/api/v1";
const TASK = asTaskId("TASK-7");
const REF: TrackerRef = { kind: "vikunja", id: "42", container: "3" };

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

const tracker = (fetchImpl: FetchLike, ingestLabel = "agent"): VikunjaTracker =>
  new VikunjaTracker({
    apiBase: API_BASE,
    token: "s3cret",
    ingestLabel,
    fetch: fetchImpl,
  });

const paths = (calls: readonly Call[]): readonly string[] =>
  calls.map((call) => `${call.method} ${call.path}`);

const project = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `project ${id}`,
  ...extra,
});

test("whoami counts real projects and never touches /user", async () => {
  // GET /user is session/JWT-only: any API token gets a 401 there, which would look
  // like a bad token when the token is fine.
  const { fetch, calls } = stub(() => [project(3), project(4), project(-1)]);

  assert.equal(await tracker(fetch).whoami(), 2);
  assert.deepEqual(paths(calls), ["GET projects?per_page=50&page=1"]);
});

test("the token travels as a Bearer header, never in the URL", async () => {
  const { fetch, calls } = stub(() => []);
  await tracker(fetch).whoami();

  assert.equal(calls[0]?.authorization, "Bearer s3cret");
  assert.ok(!calls[0]?.path.includes("s3cret"));
});

test("list routes are paginated to exhaustion", async () => {
  // Vikunja answers list routes with a bare array, so a short page is the only
  // end-of-list signal available.
  const full = Array.from({ length: 50 }, (_, index) => project(index + 1));
  const { fetch, calls } = stub((_method, path) =>
    path.includes("page=1") ? full : [project(51)],
  );

  assert.equal(await tracker(fetch).whoami(), 51);
  assert.deepEqual(paths(calls), [
    "GET projects?per_page=50&page=1",
    "GET projects?per_page=50&page=2",
  ]);
});

test("agent items are aggregated per project, not from /tasks/all", async () => {
  // /tasks/all is session-only too, so there is no global listing to ask for.
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("projects?")) {
      return [project(3), project(4), project(9, { is_archived: true }), project(-1)];
    }
    if (path.startsWith("projects/3/tasks")) {
      return [
        {
          id: 42,
          title: "Wire up dungeon rewards",
          description: "<p>Phase 5 of the <strong>dungeon</strong> domain.</p>",
          labels: [{ id: 1, title: "Agent" }],
        },
        { id: 43, title: "not for the agent", labels: null },
      ];
    }
    return [];
  });

  const items = await tracker(fetch).listAgentItems();

  assert.equal(items.length, 1);
  assert.deepEqual(items[0]?.ref, { kind: "vikunja", id: "42", container: "3" });
  assert.equal(items[0]?.title, "Wire up dungeon rewards");
  // Descriptions are HTML; a spec built from tag soup is noise for the agent.
  assert.equal(items[0]?.body, "Phase 5 of the dungeon domain.");
  assert.equal(items[0]?.url, "https://tasks.example/tasks/42");

  // Archived and pseudo-projects are never queried.
  assert.deepEqual(paths(calls).filter((p) => p.includes("/tasks")), [
    "GET projects/3/tasks?filter=done%20%3D%20false&per_page=50&page=1",
    "GET projects/4/tasks?filter=done%20%3D%20false&per_page=50&page=1",
  ]);
});

test("a task with no labels comes back as null, not an empty array", async () => {
  // Verified shape from the prior-art CLI, which guards with `or []` for this reason.
  const { fetch } = stub((_method, path) =>
    path.startsWith("projects?") ? [project(3)] : [{ id: 42, title: "t", labels: null }],
  );

  assert.deepEqual(await tracker(fetch).listAgentItems(), []);
});

test("a 401 is reported as a missing scope, not as a bad token", async () => {
  // The single most expensive Vikunja trap: retrying or rotating the token never
  // fixes it, because the token is fine and the route's scope is not granted.
  const { fetch } = stub(() => new Response('{"message":"invalid token"}', { status: 401 }));

  await assert.rejects(
    () => tracker(fetch).comment(REF, "hi"),
    (error: unknown) => {
      assert.ok(error instanceof TrackerScopeError);
      assert.equal(error.route, "tasks/42/comments");
      assert.equal(error.requiredScope, "comments:create");
      assert.match(error.message, /do not retry/);
      return true;
    },
  );
});

test("other failures stay ordinary API errors", async () => {
  const { fetch } = stub(() => new Response("boom", { status: 500 }));
  await assert.rejects(() => tracker(fetch).comment(REF, "hi"), VikunjaApiError);
});

test("session-only routes are refused before any request goes out", async () => {
  const { fetch, calls } = stub(() => []);
  class Probe extends VikunjaTracker {
    reach(route: string): void {
      this.assertReachable(route);
    }
  }
  const probe = new Probe({ apiBase: API_BASE, token: "s3cret", ingestLabel: "agent", fetch });

  assert.throws(() => probe.reach("tasks/all"), /session\/JWT-only/);
  assert.throws(() => probe.reach("user"), /session\/JWT-only/);
  probe.reach("projects");
  assert.equal(calls.length, 0);
});

test("comments are posted as HTML, because the editor is rich text", async () => {
  // Markdown would render as literal asterisks in the UI.
  const { fetch, calls } = stub(() => ({ id: 1 }));
  await tracker(fetch).comment(REF, "line one\n\nline two");

  assert.deepEqual(paths(calls), ["PUT tasks/42/comments"]);
  assert.deepEqual(calls[0]?.body, { comment: "<p>line one</p><p>line two</p>" });
});

test("a non-numeric tracker ref is rejected before any request", async () => {
  const { fetch, calls } = stub(() => null);
  await assert.rejects(
    () => tracker(fetch).comment({ kind: "vikunja", id: "TASK-7" }, "hi"),
    /not a Vikunja task id/,
  );
  assert.equal(calls.length, 0);
});

test("claiming comments first, then labels", async () => {
  // Comment before label: if a scope is missing, the human still sees what happened.
  const { fetch, calls } = stub((_method, path) =>
    path.startsWith("labels?") ? [{ id: 8, title: "agent-wip" }] : null,
  );

  await tracker(fetch).transition(REF, { kind: "claimed", runner: "pod-7f3a" }, TASK);

  assert.deepEqual(paths(calls), [
    "PUT tasks/42/comments",
    "GET labels?per_page=50&page=1",
    "PUT tasks/42/labels",
  ]);
  assert.match(String((calls[0]?.body as { comment: string }).comment), /pod-7f3a/);
  assert.deepEqual(calls[2]?.body, { label_id: 8 });
});

test("claiming clears needs-human, because a claim means the answer arrived", async () => {
  // Vikunja is where this matters most: needs-human is how a human FILTERS for items
  // that want them. A task that was answered and resumed must drop out of that filter,
  // or the list fills with work nobody is blocked on.
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("labels?")) {
      return [
        { id: 8, title: "agent-wip" },
        { id: 9, title: "needs-human" },
      ];
    }
    if (path === "tasks/42") return { id: 42, labels: [{ id: 9 }] };
    return null;
  });

  await tracker(fetch).transition(REF, { kind: "claimed", runner: "pod-7f3a" }, TASK);

  // Bulk replace, not a per-label DELETE: tasksLabels:delete is deliberately withheld.
  assert.deepEqual(paths(calls).at(-1), "POST tasks/42/labels/bulk");
  assert.deepEqual(calls.at(-1)?.body, { labels: [] });
});

test("a label the instance does not have fails loudly rather than being invented", async () => {
  // The token has no labels:create scope, and silently skipping would leave the
  // tracker claiming nothing is in progress while a runner holds the task.
  const { fetch } = stub((_method, path) =>
    path.startsWith("labels?") ? [{ id: 8, title: "something-else" }] : null,
  );

  await assert.rejects(
    () => tracker(fetch).transition(REF, { kind: "claimed", runner: "r" }, TASK),
    UnknownVikunjaLabelError,
  );
});

test("parking removes agent-wip via bulk replace, preserving other labels", async () => {
  // The per-label DELETE needs tasksLabels:delete, which is deliberately not granted.
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("labels?")) return [{ id: 8, title: "agent-wip" }];
    if (path === "tasks/42") return { id: 42, labels: [{ id: 8 }, { id: 9 }] };
    return null;
  });

  await tracker(fetch).transition(REF, { kind: "parked", reason: "no progress" }, TASK);

  assert.deepEqual(paths(calls), [
    "PUT tasks/42/comments",
    "GET labels?per_page=50&page=1",
    "GET tasks/42",
    "POST tasks/42/labels/bulk",
  ]);
  assert.deepEqual(calls[3]?.body, { labels: [{ id: 9 }] });
});

test("removing a label the task does not carry writes nothing", async () => {
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("labels?")) return [{ id: 8, title: "agent-wip" }];
    if (path === "tasks/42") return { id: 42, labels: null };
    return null;
  });

  await tracker(fetch).transition(REF, { kind: "parked", reason: "why not" }, TASK);
  assert.ok(!paths(calls).some((p) => p.includes("bulk")));
});

test("completion marks done last, after the PR link is recorded", async () => {
  // done is only ever reached from a supervisor transition, after the §12 gates. If
  // the flag write fails, the item still reads as finished and can be closed by hand.
  const { fetch, calls } = stub((_method, path) => {
    if (path.startsWith("labels?")) return [{ id: 8, title: "agent-wip" }];
    if (path === "tasks/42") return { id: 42, labels: [{ id: 8 }] };
    return null;
  });

  await tracker(fetch).transition(
    REF,
    { kind: "completed", prUrl: "https://codeberg.org/CONTOSO/acme-api/pulls/12" },
    TASK,
  );

  assert.deepEqual(paths(calls).at(-1), "POST tasks/42");
  assert.deepEqual(calls.at(-1)?.body, { done: true });
  assert.match(
    String((calls[0]?.body as { comment: string }).comment),
    /<a href="https:\/\/codeberg\.org\/CONTOSO\/acme-api\/pulls\/12">/,
  );
});

test("the label index is fetched once, not per transition", async () => {
  const { fetch, calls } = stub((_method, path) =>
    path.startsWith("labels?") ? [{ id: 8, title: "agent-wip" }] : null,
  );
  const subject = tracker(fetch);

  await subject.transition(REF, { kind: "claimed", runner: "r" }, TASK);
  await subject.transition(REF, { kind: "claimed", runner: "r" }, TASK);

  assert.equal(paths(calls).filter((p) => p.startsWith("GET labels")).length, 1);
});

test("comment HTML escapes markup rather than emitting it", () => {
  assert.equal(
    toCommentHtml("<script>alert(1)</script> & \"quotes\""),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p>',
  );
  assert.equal(toCommentHtml("a\nb"), "<p>a<br>b</p>");
  assert.equal(toCommentHtml("  \n\n  "), "");
});

test("stripHtml turns a description into readable prose", () => {
  assert.equal(
    stripHtml("<p>Goal:</p><ul><li>one</li><li>two &amp; three</li></ul>"),
    "Goal:\n- one\n- two & three",
  );
  assert.equal(stripHtml("plain"), "plain");
});

test("stripHtml restores fences around a code block", () => {
  // Intake's `agent` block is a FENCED block (§14.1), and TipTap stores a code block as
  // `<pre><code>`, where the ``` markers exist only in the rendering. Stripping tags
  // alone deletes them, so an item written with the editor's code-block button would
  // look right in Vikunja and be unparseable to intake.
  const parsed = stripHtml(
    "<p>Fix it.</p><pre><code>agent\nacceptance:\n  - &quot;npm test&quot;</code></pre>",
  );

  assert.match(parsed, /```/, "the fence must survive the HTML round-trip");
  assert.match(parsed, /acceptance:/);
  assert.match(parsed, /"npm test"/, "entities inside a code block are still decoded");
  // Two fences, opening and closing — not one, and not four.
  assert.equal(parsed.match(/```/g)?.length, 2);
});
