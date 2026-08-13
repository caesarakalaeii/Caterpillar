import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorkspaceName, type RepoRef } from "../domain/task.ts";
import { stripHtml } from "../tracker/vikunja.ts";
import type { TrackerItem } from "../tracker/types.ts";
import { renderSpec, taskIdFor } from "./spec.ts";

const WORKSPACE = asWorkspaceName("caesar");
const SELF: RepoRef = { host: "github.com", owner: "acme", name: "widget" };

const item = (body: string, title = "Make the thing work"): TrackerItem => ({
  ref: { kind: "github-issues", id: "12", container: "acme/widget" },
  title,
  body,
  url: "https://github.com/acme/widget/issues/12",
});

const block = (yaml: string): string => ["```agent", yaml, "```"].join("\n");

test("renders a spec from an agent block", async () => {
  const result = renderSpec(
    item(
      [
        "The widget drops every second frame.",
        "",
        block(["repos:", "  - acme/widget", "acceptance:", '  - "npm test"'].join("\n")),
        "",
        "Reproduce with `npm run demo`.",
      ].join("\n"),
    ),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;

  assert.equal(result.spec.workspace, WORKSPACE);
  assert.deepEqual(result.spec.repos, [SELF]);
  assert.deepEqual(result.spec.acceptance, ["npm test"]);
  // The back-reference is what lets the supervisor mirror transitions (§9.5, §14).
  assert.deepEqual(result.spec.tracker, {
    kind: "github-issues",
    id: "12",
    container: "acme/widget",
  });
});

test("the goal keeps the prose and the title but drops the agent block", async () => {
  // The block is configuration, not instruction. Leaving it in the goal invites the
  // agent to treat the acceptance commands as a checklist it may edit or re-interpret.
  const result = renderSpec(
    item(
      [
        "The widget drops every second frame.",
        block(["acceptance:", '  - "npm test"'].join("\n")),
        "Reproduce with `npm run demo`.",
      ].join("\n"),
    ),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;

  assert.match(result.spec.goal, /Make the thing work/, "the title carries the summary");
  assert.match(result.spec.goal, /drops every second frame/);
  assert.match(result.spec.goal, /npm run demo/);
  assert.equal(result.spec.goal.includes("```agent"), false);
  assert.equal(result.spec.goal.includes("acceptance:"), false);
});

test("an item with no agent block is rejected", async () => {
  const result = renderSpec(item("Please fix the widget, it is broken."), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });

  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  // The reason is commented back onto the tracker item, so it has to tell a human what
  // to actually write.
  assert.match(result.reason, /```agent/);
  assert.match(result.reason, /acceptance/);
});

test("an agent block without acceptance criteria is rejected", async () => {
  // DESIGN.md §14: a spec with no machine-checkable criteria can never satisfy §12, so
  // it could never be marked done. Rejecting at intake beats accepting a task that is
  // structurally impossible to finish.
  const result = renderSpec(item(block(["repos:", "  - acme/widget"].join("\n"))), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });

  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.match(result.reason, /acceptance/);
});

test("an empty acceptance list is rejected", async () => {
  const result = renderSpec(item(block("acceptance: []")), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });
  assert.equal(result.kind, "rejected");
});

test("a non-string acceptance entry is rejected rather than dropped", async () => {
  // The realistic hazard, verified against the parser: an unquoted command containing
  // `: ` is a MAPPING, not a string — `- npm test: unit` parses to
  // `{"npm test": "unit"}`. Silently filtering it would shrink the completion gate, and
  // intake must agree with `store.ts`, which fails loudly on the same input: accepting
  // here what `readSpec` later refuses would write a task nothing can read and nothing
  // can explain, which is worse than never creating it.
  const mapping = renderSpec(
    item(block(["acceptance:", "  - npm test: unit", '  - "npm run lint"'].join("\n"))),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(mapping.kind, "rejected");
  if (mapping.kind !== "rejected") return;
  assert.match(mapping.reason, /acceptance/);
  assert.match(mapping.reason, /quote/i, "the fix is to quote it — say so");

  // `true` is the other one this parser coerces. Note `no`/`yes`/`on`/`off` do NOT
  // coerce: the `yaml` package is YAML 1.2, where only `true`/`false` are booleans.
  const boolean = renderSpec(item(block(["acceptance:", "  - true"].join("\n"))), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });
  assert.equal(boolean.kind, "rejected");
});

test("repos defaults to the repo the item itself lives in", async () => {
  const result = renderSpec(item(block(["acceptance:", '  - "npm test"'].join("\n"))), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;
  assert.deepEqual(result.spec.repos, [SELF]);
});

test("an item with no repo to fall back on must declare one", async () => {
  // A Vikunja task has no repo of its own, so omitting `repos` there is unresolvable.
  const result = renderSpec(
    {
      ref: { kind: "vikunja", id: "42", container: "3" },
      title: "Do the thing",
      body: block(["acceptance:", '  - "npm test"'].join("\n")),
      url: "https://tasks.example.invalid/tasks/42",
    },
    { workspace: WORKSPACE },
  );

  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.match(result.reason, /repos/);
});

test("requires defaults to empty so any runner may claim the task", async () => {
  const result = renderSpec(item(block(["acceptance:", '  - "npm test"'].join("\n"))), {
    workspace: WORKSPACE,
    defaultRepo: SELF,
  });

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;
  assert.deepEqual(result.spec.requires, []);
});

test("declared requires and multiple repos are carried through", async () => {
  const result = renderSpec(
    item(
      block(
        [
          "repos:",
          "  - acme/widget",
          "  - codeberg.org/acme/sibling",
          "requires:",
          "  - linux",
          "  - k8s",
          "acceptance:",
          '  - "npm test"',
          '  - "npm run lint"',
        ].join("\n"),
      ),
    ),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;
  assert.deepEqual(result.spec.requires, ["linux", "k8s"]);
  assert.deepEqual(result.spec.repos, [
    SELF,
    { host: "codeberg.org", owner: "acme", name: "sibling" },
  ]);
  assert.deepEqual(result.spec.acceptance, ["npm test", "npm run lint"]);
});

test("an unknown capability is rejected instead of reaching the claim predicate", async () => {
  // `requires` is the claim predicate. A typo that becomes an unknown capability makes
  // the task unclaimable by every runner forever, which looks like a stuck queue.
  const result = renderSpec(
    item(block(["requires:", "  - linix", "acceptance:", '  - "npm test"'].join("\n"))),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.match(result.reason, /linix/);
});

test("an unrelated code block before the agent block is not mistaken for it", async () => {
  // Issue bodies routinely open with a stack trace or a repro snippet. Taking the FIRST
  // fence would read that as configuration and refuse the item.
  const result = renderSpec(
    item(
      [
        "Repro:",
        "```sh",
        "npm run demo   # explodes",
        "```",
        "",
        block(["acceptance:", '  - "npm test"'].join("\n")),
      ].join("\n"),
    ),
    { workspace: WORKSPACE, defaultRepo: SELF },
  );

  assert.equal(result.kind, "spec");
  if (result.kind !== "spec") return;
  assert.deepEqual(result.spec.acceptance, ["npm test"]);
  // The unrelated block is prose and must survive into the goal.
  assert.match(result.spec.goal, /npm run demo/);
});

test("a Vikunja description survives the HTML round-trip into a spec", async () => {
  // The two halves have to meet: a Vikunja body is TipTap HTML that the adapter strips
  // back to text (§9.5), and intake then looks for a fenced block in that text. Tested
  // through the REAL `stripHtml` rather than a hand-written string, because the failure
  // mode is precisely a disagreement between the two.
  const description =
    "<p>The widget drops frames.</p>" +
    "<pre><code>agent\nrepos:\n  - acme/widget\nacceptance:\n  - &quot;npm test&quot;</code></pre>" +
    "<p>Thanks!</p>";

  const result = renderSpec(
    {
      ref: { kind: "vikunja", id: "42", container: "3" },
      title: "Widget drops frames",
      body: stripHtml(description),
      url: "https://tasks.example.invalid/tasks/42",
    },
    { workspace: WORKSPACE },
  );

  assert.equal(result.kind, "spec", "a Vikunja item must be ingestable");
  if (result.kind !== "spec") return;
  assert.deepEqual(result.spec.acceptance, ["npm test"]);
  assert.deepEqual(result.spec.repos, [{ host: "github.com", owner: "acme", name: "widget" }]);
  assert.match(result.spec.goal, /drops frames/);
  assert.equal(result.spec.goal.includes("acceptance:"), false);
});

test("the task id is deterministic, so re-running intake cannot duplicate a task", async () => {
  // Idempotency rests entirely on this: the ingester skips an item whose task directory
  // already exists, and intake runs on every poll.
  const ref = { kind: "github-issues", id: "12", container: "acme/widget" } as const;
  assert.equal(taskIdFor(ref), taskIdFor(ref));
  assert.equal(taskIdFor(ref), "GH-acme-widget-12");
  assert.equal(taskIdFor({ kind: "vikunja", id: "42", container: "3" }), "VK-3-42");
});

test("the task id is a safe single path segment", async () => {
  // The id becomes a directory name in the state repo, built from tracker-supplied
  // strings. A separator or a traversal sequence surviving into it would let an item
  // title write outside `tasks/`.
  const id = taskIdFor({
    kind: "github-issues",
    id: "7",
    container: "../../etc/pass wd",
  });

  assert.equal(id.includes("/"), false);
  assert.equal(id.includes(".."), false);
  assert.equal(id.includes(" "), false);
  assert.match(id, /^[A-Za-z0-9-]+$/);
});
