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
import type {
  CheckStatus,
  Forge,
  GitCredential,
  PrRequest,
  PrResult,
} from "../forge/types.ts";
import {
  brainstormTools,
  clusterTools,
  controlTools,
  remediationTools,
  toolsForKind,
  type ClusterReadOutcome,
  type ControlSink,
  type ToolContext,
} from "./tools.ts";

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };

class StubForge implements Forge {
  readonly kind = "stub";
  async credential(): Promise<GitCredential> {
    return { username: "x", password: "y" };
  }
  async openPr(_repo: RepoRef, _request: PrRequest): Promise<PrResult> {
    return { number: 1, url: "https://example.invalid/1" };
  }
  async checks(): Promise<CheckStatus> {
    return { conclusion: "success", summary: "ok" };
  }
  async approve(): Promise<void> {}
  async merge(): Promise<void> {}
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
}

const harness = (cluster?: ClusterReader): Harness => {
  const reads: { tool: string; outcome: ClusterReadOutcome; seconds: number }[] = [];
  const control: ControlSink = {};
  const ctx: ToolContext = {
    forge: new StubForge(),
    repo: REPO,
    control,
    ...(cluster === undefined
      ? {}
      : {
          cluster,
          recordClusterRead: (tool, outcome, seconds) => reads.push({ tool, outcome, seconds }),
        }),
  };
  return { ctx, reads };
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
    repo: REPO,
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
