/**
 * Tests for the tool bundles, and for which kind gets which (DESIGN.md §13, §20).
 *
 * The load-bearing assertions here are about ABSENCE. `cluster_logs`, `cluster_events` and
 * `cluster_describe` are the only tools in this repo that reach a live cluster, and the
 * whole security boundary of alert-driven remediation is that they bind for `kind:
 * remediation` and for nothing else. That is a property of the binding, so it is asserted
 * on the binding — the tool NAMES a kind produces — rather than on the behaviour of a
 * session, which could only be observed by running one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ClusterReader, DescribeRequest, EventsRequest, LogsRequest } from "../cluster/client.ts";
import { NamespaceNotAllowedError } from "../cluster/guard.ts";
import { InvalidNameError } from "../cluster/names.ts";
import { UnsupportedKindError } from "../cluster/redact.ts";
import type { RepoRef, TaskKind } from "../domain/task.ts";
import type { MergeQueueSupport } from "../forge/mergeability.ts";
import type {
  CheckStatus,
  Forge,
  GitCredential,
  PrRequest,
  PrResult,
  ReviewComment,
} from "../forge/types.ts";
import type { EffectVerb } from "../state/effects.ts";
import type { TrackerRef } from "../domain/task.ts";
import type { Tracker, TrackerItem } from "../tracker/types.ts";
import {
  brainstormTools,
  clusterTools,
  controlTools,
  remediationTools,
  submitPlanTool,
  toolsForKind,
  type ClusterReadOutcome,
  type ControlSink,
  type EffectLedger,
  type ToolContext,
} from "./tools.ts";

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
/** The second repo of a two-repo task — the one `open_pr` could never reach. */
const SIBLING: RepoRef = { host: "github.com", owner: "acme", name: "widget-extension" };

class StubForge implements Forge {
  readonly kind = "stub";
  /** Every repo `openPr` was asked for, in order. The assertion for §9.4.1's fix. */
  readonly prCalls: RepoRef[] = [];
  async credential(): Promise<GitCredential> {
    return { username: "x", password: "y" };
  }
  async openPr(repo: RepoRef, _request: PrRequest): Promise<PrResult> {
    this.prCalls.push(repo);
    return { number: this.prCalls.length, url: `https://example.invalid/${repo.name}/${this.prCalls.length}` };
  }
  async checks(): Promise<CheckStatus> {
    return { conclusion: "success", summary: "ok" };
  }
  async listReviewComments(): Promise<readonly ReviewComment[]> {
    return [];
  }
  async approve(): Promise<void> {}
  async merge(): Promise<void> {}
  async mergeQueue(): Promise<MergeQueueSupport> {
    return "absent";
  }
  async enqueue(): Promise<void> {}
  async revoke(): Promise<void> {}
}

/** A reader that records what it was asked and answers with whatever it was given. */
class FakeReader implements ClusterReader {
  readonly logsCalls: LogsRequest[] = [];
  readonly eventsCalls: EventsRequest[] = [];
  readonly describeCalls: DescribeRequest[] = [];

  private readonly answer: string | Error;

  constructor(answer: string | Error) {
    this.answer = answer;
  }

  private reply(): Promise<string> {
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }

  logs(request: LogsRequest): Promise<string> {
    this.logsCalls.push(request);
    return this.reply();
  }
  events(request: EventsRequest): Promise<string> {
    this.eventsCalls.push(request);
    return this.reply();
  }
  describe(request: DescribeRequest): Promise<string> {
    this.describeCalls.push(request);
    return this.reply();
  }
}

interface Harness {
  readonly ctx: ToolContext;
  readonly reads: { tool: string; outcome: ClusterReadOutcome; seconds: number }[];
  readonly forge: StubForge;
  readonly control: ControlSink;
}

const harness = (cluster?: ClusterReader): Harness => {
  const reads: { tool: string; outcome: ClusterReadOutcome; seconds: number }[] = [];
  const control: ControlSink = {};
  const forge = new StubForge();
  const ctx: ToolContext = {
    forge,
    repos: [REPO, SIBLING],
    control,
    ...(cluster === undefined
      ? {}
      : {
          cluster,
          recordClusterRead: (tool, outcome, seconds) => reads.push({ tool, outcome, seconds }),
        }),
  };
  return { ctx, reads, forge, control };
};

const names = (tools: readonly AgentTool[]): readonly string[] => tools.map((tool) => tool.name);

const CLUSTER_NAMES = ["cluster_logs", "cluster_events", "cluster_describe"] as const;

/** Runs one tool by name and returns the text it produced. */
const call = async (
  tools: readonly AgentTool[],
  name: string,
  params: unknown,
): Promise<string> => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `${name} is not in the bundle`);
  const result = await tool.execute("call-1", params as never);
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
};

test("an implement task never receives the cluster tools, even with a reader configured", () => {
  // The whole security boundary of §20, asserted the only way it can be: on the binding.
  // A reader IS present in the context here — the point is that the kind decides.
  const { ctx } = harness(new FakeReader("logs"));
  const bound = names(toolsForKind("implement", ctx));

  for (const name of CLUSTER_NAMES) assert.ok(!bound.includes(name), `implement got ${name}`);
  assert.deepEqual(bound, names(controlTools(ctx)));
});

test("a brainstorm task never receives the cluster tools", () => {
  const { ctx } = harness(new FakeReader("logs"));
  const bound = names(toolsForKind("brainstorm", ctx));

  for (const name of CLUSTER_NAMES) assert.ok(!bound.includes(name), `brainstorm got ${name}`);
  assert.deepEqual(bound, names(brainstormTools(ctx)));
  // And it still cannot open a PR or claim done, which is the older half of the same rule.
  assert.ok(!bound.includes("open_pr"));
  assert.ok(!bound.includes("done"));
});

test("a remediation task receives the control verbs plus the three reads", () => {
  const { ctx } = harness(new FakeReader("logs"));
  const bound = names(toolsForKind("remediation", ctx));

  for (const name of CLUSTER_NAMES) assert.ok(bound.includes(name), `remediation lacks ${name}`);
  // A strict superset: a remediation task ends in a pull request and §12 applies to it
  // unchanged, so nothing an implement task has may be missing.
  for (const name of names(controlTools(ctx))) {
    assert.ok(bound.includes(name), `remediation lacks the control verb ${name}`);
  }
  assert.deepEqual(bound, names(remediationTools(ctx)));
});

test("a remediation task on a runner with no cluster reader gets the ordinary bundle", () => {
  // Not a crash and not a silent privilege either: the session diagnoses from the repo.
  const { ctx } = harness();
  const bound = names(toolsForKind("remediation", ctx));

  for (const name of CLUSTER_NAMES) assert.ok(!bound.includes(name));
  assert.deepEqual(bound, names(controlTools(ctx)));
});

test("every kind is covered, and only remediation can reach the cluster", () => {
  const { ctx } = harness(new FakeReader("logs"));
  const kinds: readonly TaskKind[] = ["implement", "brainstorm", "remediation"];

  for (const kind of kinds) {
    const bound = names(toolsForKind(kind, ctx));
    assert.ok(bound.length > 0, `${kind} got no tools at all`);
    const reachesCluster = CLUSTER_NAMES.some((name) => bound.includes(name));
    assert.equal(reachesCluster, kind === "remediation", `${kind} cluster access is wrong`);
  }
});

test("the three descriptions say read-only, who performs the call, and the namespace bound", () => {
  // The description is the only thing the model knows about a tool. A read that does not
  // say it is read-only invites a session to look for the write it assumes must exist.
  const { ctx } = harness(new FakeReader("x"));
  for (const tool of clusterTools(ctx)) {
    assert.match(tool.description, /READ-ONLY/, `${tool.name} does not say it is read-only`);
    assert.match(tool.description, /supervisor performs/, `${tool.name} does not say who calls`);
    assert.match(tool.description, /allowlisted namespaces/, `${tool.name} omits the bound`);
  }
});

test("cluster_describe warns that Secret values are never returned", () => {
  const { ctx } = harness(new FakeReader("x"));
  const describe = clusterTools(ctx).find((tool) => tool.name === "cluster_describe");
  assert.ok(describe !== undefined);
  assert.match(describe.description, /values are never returned/);
  assert.match(describe.description, /wasted turn/);
  // The kinds are named, so the model does not have to discover them by being refused.
  assert.match(describe.description, /PersistentVolumeClaim/);
});

test("the tools pass through only the parameters that were supplied", async () => {
  const reader = new FakeReader("ok");
  const { ctx } = harness(reader);
  const tools = clusterTools(ctx);

  await call(tools, "cluster_logs", { namespace: "caterpillar" });
  assert.deepEqual(reader.logsCalls[0], { namespace: "caterpillar" });

  await call(tools, "cluster_logs", {
    namespace: "caterpillar",
    pod: "caterpillar-0",
    sinceMinutes: 5,
    limit: 10,
  });
  assert.deepEqual(reader.logsCalls[1], {
    namespace: "caterpillar",
    pod: "caterpillar-0",
    sinceMinutes: 5,
    limit: 10,
  });

  await call(tools, "cluster_events", { namespace: "caterpillar", involvedObject: "Pod/x" });
  assert.deepEqual(reader.eventsCalls[0], { namespace: "caterpillar", involvedObject: "Pod/x" });

  await call(tools, "cluster_describe", { kind: "Pod", name: "x", namespace: "caterpillar" });
  assert.deepEqual(reader.describeCalls[0], { kind: "Pod", name: "x", namespace: "caterpillar" });
});

test("a successful read is returned verbatim and counted as ok", async () => {
  const { ctx, reads } = harness(new FakeReader("2026-01-01T00:00:00Z  pod  hello"));
  const text = await call(clusterTools(ctx), "cluster_logs", { namespace: "caterpillar" });

  assert.match(text, /hello/);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.tool, "cluster_logs");
  assert.equal(reads[0]?.outcome, "ok");
  assert.ok((reads[0]?.seconds ?? -1) >= 0);
});

test("a denied namespace comes back as text, counted as denied", async () => {
  // Text rather than a thrown error: the session cannot fix it by retrying, and it is not a
  // fault on the supervisor's side. The message has to carry the allowlist so the next call
  // can be right, and the counter has to move so an operator can see the allowlist is wrong.
  const { ctx, reads } = harness(
    new FakeReader(new NamespaceNotAllowedError("kube-system", ["caterpillar"])),
  );
  const text = await call(clusterTools(ctx), "cluster_events", { namespace: "kube-system" });

  assert.match(text, /^Refused:/);
  assert.match(text, /caterpillar/);
  assert.equal(reads[0]?.outcome, "denied");
});

test("a refused kind or name is counted as denied, not as an error", async () => {
  const kindDenied = harness(new FakeReader(new UnsupportedKindError("Node")));
  await call(clusterTools(kindDenied.ctx), "cluster_describe", {
    kind: "Node",
    name: "n",
    namespace: "caterpillar",
  });
  assert.equal(kindDenied.reads[0]?.outcome, "denied");

  const nameDenied = harness(new FakeReader(new InvalidNameError("pod", 'x"', "a name")));
  await call(nameDenied.ctx.cluster === undefined ? [] : clusterTools(nameDenied.ctx), "cluster_logs", {
    namespace: "caterpillar",
    pod: 'x"',
  });
  assert.equal(nameDenied.reads[0]?.outcome, "denied");
});

test("a cluster failure is reported as an error, distinctly from a refusal", async () => {
  // The distinction is the operator's: `denied` means the allowlist refused, `error` means
  // the supervisor could not read what it was allowed to read. Collapsing them would hide a
  // broken Loki behind a metric that reads like a misconfiguration.
  const { ctx, reads } = harness(new FakeReader(new Error("Loki query failed with HTTP 503")));
  const text = await call(clusterTools(ctx), "cluster_logs", { namespace: "caterpillar" });

  assert.match(text, /^The read failed:/);
  assert.match(text, /503/);
  assert.equal(reads[0]?.outcome, "error");
});

test("a non-Error rejection still produces text and a count", async () => {
  const reader: ClusterReader = {
    logs: () => Promise.reject("something threw a string"),
    events: () => Promise.reject(new Error("unused")),
    describe: () => Promise.reject(new Error("unused")),
  };
  const { ctx, reads } = harness(reader);
  const text = await call(clusterTools(ctx), "cluster_logs", { namespace: "caterpillar" });

  assert.match(text, /something threw a string/);
  assert.equal(reads[0]?.outcome, "error");
});

test("metrics are optional — a context without the callback still works", async () => {
  const ctx: ToolContext = {
    forge: new StubForge(),
    repos: [REPO],
    control: {},
    cluster: new FakeReader("lines"),
  };

  assert.match(await call(clusterTools(ctx), "cluster_logs", { namespace: "caterpillar" }), /lines/);
});

test("controlTools is unchanged by any of this", () => {
  const { ctx } = harness();
  assert.deepEqual(names(controlTools(ctx)), [
    "open_pr",
    "ask_human",
    "handoff",
    "done",
    "task_note",
    "publish_artifact",
  ]);
});

test("open_pr opens against a NAMED repo, not always the primary one", async () => {
  // THE defect. `open_pr` posted to `spec.repos[0]` unconditionally and took no repo argument,
  // so on `GH-acme-all-chat-543` the extension half was built, committed and pushed
  // and then had nowhere to go: two attempts, two 422s from the wrong repository, and a session
  // that parked on a question a human had to answer by opening the PR themselves.
  const { ctx, forge, control } = harness();

  const text = await call(controlTools(ctx), "open_pr", {
    title: "Harden reconnect",
    body: "…",
    head: "agent/T-1",
    base: "main",
    repo: "acme/widget-extension",
  });

  assert.deepEqual(forge.prCalls, [SIBLING]);
  assert.match(text, /acme\/widget-extension/, "the reply should say where it landed");
  assert.deepEqual(
    control.prs?.map((pr) => pr.repo.name),
    ["widget-extension"],
  );
});

test("open_pr without a repo still means the primary one", async () => {
  const { ctx, forge, control } = harness();

  await call(controlTools(ctx), "open_pr", { title: "t", body: "b", head: "h", base: "main" });

  assert.deepEqual(forge.prCalls, [REPO]);
  assert.deepEqual(control.prs?.map((pr) => pr.repo.name), ["widget"]);
});

test("a two-repo task carries BOTH pull requests to the gate", async () => {
  // The half that a repo argument alone would not have fixed: the completion gate reads this
  // list, so a sink that kept only the last call would leave one PR ungated and unmerged.
  const { ctx, forge, control } = harness();
  const tools = controlTools(ctx);

  await call(tools, "open_pr", { title: "a", body: "b", head: "h", base: "main" });
  await call(tools, "open_pr", { title: "c", body: "d", head: "h", base: "main", repo: "acme/widget-extension" });

  assert.deepEqual(forge.prCalls, [REPO, SIBLING]);
  assert.deepEqual(control.prs?.map((pr) => `${pr.repo.name}#${pr.number}`), [
    "widget#1",
    "widget-extension#2",
  ]);
});

test("re-opening against the same repo replaces its entry rather than adding one", async () => {
  // A session that retries after a failure must not leave the gate two numbers for one repo —
  // it would check the stale one and merge the stale one.
  const { ctx, control } = harness();
  const tools = controlTools(ctx);

  await call(tools, "open_pr", { title: "a", body: "b", head: "h", base: "main" });
  await call(tools, "open_pr", { title: "a again", body: "b", head: "h", base: "main" });

  assert.equal(control.prs?.length, 1);
  assert.equal(control.prs?.[0]?.number, 2, "the newer PR wins");
});

test("a repo the task does not have is refused in prose, and the refusal says what is allowed", async () => {
  // The failure this replaces was a raw 422 from a repository the agent never asked for. A
  // refusal it can read is one it can correct inside the same turn; it is also the SCOPE — the
  // argument is agent-authored text, and a tool that opened a PR anywhere the credential
  // reaches would be a session choosing its own blast radius (§9.1).
  const { ctx, forge, control } = harness();

  const text = await call(controlTools(ctx), "open_pr", {
    title: "t",
    body: "b",
    head: "h",
    base: "main",
    repo: "acme/somebody-elses-repo",
  });

  assert.deepEqual(forge.prCalls, [], "nothing may reach the forge");
  assert.equal(control.prs, undefined);
  assert.match(text, /not one of this task's repos/);
  assert.match(text, /acme\/widget, acme\/widget-extension/, "it must name what IS allowed");
});

test("ask_human carries enumerated options through to the control signal", async () => {
  // The options are what become one-press buttons in Discord (§7). They travel on the
  // signal because the supervisor, not the tool, owns the state repo the text is stored in.
  const { ctx, control } = harness();

  await call(controlTools(ctx), "ask_human", {
    question: "Which migration path?",
    options: ["Use the existing one", "Write a new one"],
  });

  assert.equal(control.signal?.reason, "ask-human");
  assert.deepEqual(control.signal?.questionOptions, ["Use the existing one", "Write a new one"]);
});

test("ask_human without options leaves the signal carrying none", async () => {
  const { ctx, control } = harness();

  await call(controlTools(ctx), "ask_human", { question: "What is the retention policy?" });

  assert.equal(control.signal?.questionOptions, undefined);
});

test("more than five options is refused at the tool boundary, not truncated", async () => {
  // Five is Discord's buttons-per-row limit (`row` throws above it), so a sixth option
  // cannot be rendered at all. Truncating would silently drop a choice the human should
  // have had; the refusal is text the model can act on inside the same turn, like `open_pr`'s.
  const { ctx, control } = harness();

  const text = await call(controlTools(ctx), "ask_human", {
    question: "Which one?",
    options: ["a", "b", "c", "d", "e", "f"],
  });

  assert.equal(control.signal, undefined, "a refused question must not end the session");
  assert.match(text, /at most 5/);
  assert.match(text, /6/, "the refusal should say how many were offered");
});

test("the ask_human description tells the agent when to use options", () => {
  const { ctx } = harness();
  const ask = controlTools(ctx).find((tool) => tool.name === "ask_human");
  assert.ok(ask !== undefined);

  assert.match(ask.description, /options/);
  assert.match(ask.description, /prose/, "it must say what NOT to enumerate");
});

test("a bare repo name is accepted — the host is not the agent's to type", async () => {
  // `spec.repos` is one workspace, so one forge and one host (§3.1). Demanding `github.com/`
  // in front of what every other surface calls `owner/name` is friction with nothing behind it.
  const { ctx, forge } = harness();

  await call(controlTools(ctx), "open_pr", {
    title: "t",
    body: "b",
    head: "h",
    base: "main",
    repo: "widget-extension",
  });

  assert.deepEqual(forge.prCalls, [SIBLING]);
});

/**
 * A ledger backed by a map, counting what it was asked (DESIGN.md §4.4).
 *
 * The real one writes the state repo, which a tool cannot reach (§9.3); this is the same
 * seam the supervisor fills, so the tests can assert on the property that matters — a
 * replayed verb does not perform its side effect twice — without a git checkout.
 */
class FakeLedger implements EffectLedger {
  readonly recorded = new Map<string, unknown>();
  readonly lookups: string[] = [];

  private key(verb: EffectVerb, args: unknown): string {
    return `${verb}:${JSON.stringify(args)}`;
  }

  async landed<T>(verb: EffectVerb, args: unknown): Promise<{ readonly result: T } | undefined> {
    const key = this.key(verb, args);
    this.lookups.push(key);
    if (!this.recorded.has(key)) return undefined;
    return { result: this.recorded.get(key) as T };
  }

  async record<T>(verb: EffectVerb, args: unknown, result: T): Promise<void> {
    this.recorded.set(this.key(verb, args), result);
  }
}

/** A tracker that counts comments. Everything else on the interface is unreachable here. */
class CountingTracker implements Tracker {
  readonly kind = "github-issues";
  readonly comments: string[] = [];

  async listAgentItems(): Promise<readonly TrackerItem[]> {
    return [];
  }
  async comment(_ref: TrackerRef, text: string): Promise<void> {
    this.comments.push(text);
  }
  async transition(): Promise<void> {}
}

const TRACKER_REF: TrackerRef = { kind: "github-issues", id: "98" };

interface LedgerHarness extends Harness {
  readonly ledger: FakeLedger;
  readonly tracker: CountingTracker;
  readonly stored: string[];
}

const withLedger = (): LedgerHarness => {
  const base = harness();
  const ledger = new FakeLedger();
  const tracker = new CountingTracker();
  const stored: string[] = [];
  const ctx: ToolContext = {
    ...base.ctx,
    effects: ledger,
    tracker,
    trackerRef: TRACKER_REF,
    publish: async (name) => {
      stored.push(name);
      return { stored: true, message: `Stored ${name}.` };
    },
  };
  return { ...base, ctx, ledger, tracker, stored };
};

test("task_note posted twice with the same text comments once", async () => {
  // A pod killed between the comment and the state write comes back and repeats the call.
  // Without a record that is two identical comments on the tracker item, forever.
  const { ctx, tracker } = withLedger();
  const tools = controlTools(ctx);

  await call(tools, "task_note", { text: "rebased onto main" });
  const second = await call(tools, "task_note", { text: "rebased onto main" });

  assert.deepEqual(tracker.comments, ["rebased onto main"]);
  assert.match(second, /already/i, "the reply must say the note was already recorded");
});

test("task_note with different text is a different effect", async () => {
  const { ctx, tracker } = withLedger();
  const tools = controlTools(ctx);

  await call(tools, "task_note", { text: "first" });
  await call(tools, "task_note", { text: "second" });

  assert.deepEqual(tracker.comments, ["first", "second"]);
});

test("publish_artifact stores once for the same arguments", async () => {
  const { ctx, stored } = withLedger();
  const tools = controlTools(ctx);
  const params = { name: "scan.json", path: "out/scan.json", note: "sublevel scan" };

  const first = await call(tools, "publish_artifact", params);
  const second = await call(tools, "publish_artifact", params);

  assert.deepEqual(stored, ["scan.json"]);
  assert.equal(second, first, "a replay hands back what the first call returned");
});

test("republishing changed contents under one name stores them", async () => {
  // `StateStore.writeArtifact` guards the count cap with `!existing.includes(name)`
  // precisely so an overwrite is allowed: regenerating a file and publishing it again
  // under the same name is a supported operation. Keyed on the ARGUMENTS alone the second
  // call is a replay, so the new contents are silently dropped and the agent is handed the
  // first call's message — a stale record producing a WRONG ANSWER rather than a duplicate
  // attempt, which is the one outcome effects.ts says must never happen.
  const base = harness();
  const published: string[] = [];
  const ctx: ToolContext = {
    ...base.ctx,
    effects: new FakeLedger(),
    publish: async (name) => {
      published.push(name);
      return { stored: true, message: `Stored \`${name}\` (${published.length} bytes).` };
    },
  };
  const tools = controlTools(ctx);
  const params = { name: "scan.json", path: "scan.json", note: "the sublevel scan" };

  await call(tools, "publish_artifact", params);
  const second = await call(tools, "publish_artifact", params);

  assert.deepEqual(published, ["scan.json", "scan.json"], "the second publish must reach the store");
  assert.match(second, /2 bytes/, "the agent must be told about the contents it just stored");
});

test("a refused publish_artifact is not recorded, so the agent can fix it and retry", async () => {
  // `publish` answers refusals in PROSE rather than throwing — a file too big to store is a
  // prompt to summarise, not an error. Recording one would replay the refusal forever and
  // the agent would never be able to store the file it just fixed.
  const base = harness();
  const ledger = new FakeLedger();
  const attempts: string[] = [];
  const ctx: ToolContext = {
    ...base.ctx,
    effects: ledger,
    publish: async (name, path) => {
      attempts.push(name);
      return attempts.length === 1
        ? { stored: false, message: `Could not read \`${path}\`; nothing was stored.` }
        : { stored: true, message: `Stored ${name}.` };
    },
  };
  const tools = controlTools(ctx);
  const params = { name: "scan.json", path: "out/scan.json", note: "sublevel scan" };

  const refused = await call(tools, "publish_artifact", params);
  assert.match(refused, /nothing was stored/);
  assert.equal(ledger.recorded.size, 0, "a refusal is not an effect that landed");

  const stored = await call(tools, "publish_artifact", params);
  assert.match(stored, /Stored scan\.json/);
  assert.deepEqual(attempts, ["scan.json", "scan.json"]);
});

test("open_pr asks the forge even when the effect is on record", async () => {
  // The constraint: a record must never be the authority on its own. If it says a PR was
  // opened and the forge says otherwise, the forge wins — and `Forge.openPr` already adopts
  // an existing pull request, so asking twice is cheap and asking is the only way to be right.
  const { ctx, forge, control } = withLedger();
  const tools = controlTools(ctx);
  const params = { title: "t", body: "b", head: "agent/T-1", base: "main" };

  await call(tools, "open_pr", params);
  await call(tools, "open_pr", params);

  assert.deepEqual(forge.prCalls, [REPO, REPO]);
  assert.equal(control.prs?.length, 1, "the gate still sees one PR for one repo");
});

test("a replayed done still ends the session", async () => {
  // The sink is in memory and the record is not. A session that claimed done, lost the
  // state write and came back must still stop — a recorded verb that no longer signalled
  // would leave the session running with nothing left to do.
  const { ctx, control, ledger } = withLedger();
  await ledger.record("done", { summary: "landed the schema" }, null);

  await call(controlTools(ctx), "done", { summary: "landed the schema" });

  assert.equal(control.signal?.reason, "done-claimed");
  assert.equal(control.signal?.summary, "landed the schema");
});

test("a replayed ask_human still parks the session", async () => {
  const { ctx, control, ledger } = withLedger();
  await ledger.record("ask_human", { question: "which host?" }, null);

  await call(controlTools(ctx), "ask_human", { question: "which host?" });

  assert.equal(control.signal?.reason, "ask-human");
  assert.equal(control.signal?.question, "which host?");
});

test("a replayed handoff still hands off, and keeps its capabilities", async () => {
  const { ctx, control, ledger } = withLedger();
  const args = { summary: "schema is in", requires: ["gpu"] };
  await ledger.record("handoff", args, null);

  await call(controlTools(ctx), "handoff", args);

  assert.equal(control.signal?.reason, "blocked");
  assert.deepEqual(control.signal?.requires, ["gpu"]);
});

test("a replayed submit_plan still ends the brainstorm with its plan", async () => {
  const { ctx, control, ledger } = withLedger();
  const plan = {
    title: "Split the migration",
    summary: "Three tasks.",
    tasks: [],
  };
  await ledger.record("submit_plan", plan, null);

  await call([submitPlanTool(ctx) as AgentTool], "submit_plan", plan);

  assert.equal(control.signal?.reason, "plan-proposed");
  assert.equal(control.plan?.title, "Split the migration");
});

test("every control verb is recorded, so the session's effects are auditable", async () => {
  const { ctx, ledger } = withLedger();
  const tools = controlTools(ctx);

  await call(tools, "open_pr", { title: "t", body: "b", head: "h", base: "main" });
  await call(tools, "ask_human", { question: "q" });
  await call(tools, "handoff", { summary: "s" });
  await call(tools, "done", { summary: "s" });
  await call(tools, "task_note", { text: "n" });
  await call(tools, "publish_artifact", { name: "a.json", path: "a.json", note: "n" });

  const verbs = [...ledger.recorded.keys()].map((key) => key.split(":")[0]);
  assert.deepEqual(verbs.sort(), [
    "ask_human",
    "done",
    "handoff",
    "open_pr",
    "publish_artifact",
    "task_note",
  ]);
});

test("a context with no ledger behaves exactly as it did before", async () => {
  // A CLI verifier and a runner mid-rollout construct a context without one. The verbs must
  // still work: an idempotency record is an optimisation, and an optimisation that becomes a
  // precondition is an outage.
  const base = harness();
  const tracker = new CountingTracker();
  const ctx: ToolContext = { ...base.ctx, tracker, trackerRef: TRACKER_REF };
  const tools = controlTools(ctx);

  await call(tools, "task_note", { text: "n" });
  await call(tools, "task_note", { text: "n" });
  await call(tools, "done", { summary: "s" });

  assert.deepEqual(tracker.comments, ["n", "n"], "without a record there is nothing to check");
  assert.equal(base.control.signal?.reason, "done-claimed");
});

test("a ledger that throws does not fail the verb", async () => {
  // The state repo is remote and git can fail. A verb that could not be recorded has still
  // happened, and turning that into a tool error would park a task over bookkeeping.
  const base = harness();
  const tracker = new CountingTracker();
  const ctx: ToolContext = {
    ...base.ctx,
    tracker,
    trackerRef: TRACKER_REF,
    effects: {
      landed: () => Promise.reject(new Error("state repo unreachable")),
      record: () => Promise.reject(new Error("state repo unreachable")),
    },
  };

  const text = await call(controlTools(ctx), "task_note", { text: "n" });

  assert.deepEqual(tracker.comments, ["n"]);
  assert.match(text, /Note added/);
});
