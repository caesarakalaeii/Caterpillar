/**
 * End-to-end session test. Real git, real worktrees, real pi Agent, real tool
 * execution — only the LLM and the forge are faked.
 *
 * This is the test that proves the pieces fit: prompt assembly, tool binding, the
 * built-in bash/write tools running in the right cwd, control-plane tools ending the
 * session, and the context budget cutting a session off at the threshold.
 */
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createModels,
  type Api,
  type Model,

} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CredentialService } from "../credential/service.ts";
import {
  asTaskId,
  asWorkspaceName,
  type RepoRef,
  type TaskSpec,
  type TaskState,
} from "../domain/task.ts";
import type {
  CheckStatus,
  Forge,
  ForgeFactory,
  GitCredential,
  PrRequest,
  PrResult,
} from "../forge/types.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import { WorktreeManager } from "../workspace/worktree.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { AgentSessionRunner, type WorkspaceBindings } from "./runner.ts";
import type { RunnerConfig } from "../config/types.ts";

const sh = (command: string, cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
const TASK = asTaskId("TASK-1");

class FakeForge implements Forge {
  readonly kind = "fake";
  prs: PrRequest[] = [];

  async credential(): Promise<GitCredential> {
    return { username: "x-access-token", password: "fake" };
  }
  async openPr(_repo: RepoRef, request: PrRequest): Promise<PrResult> {
    this.prs.push(request);
    return { number: 7, url: "https://example.invalid/pr/7" };
  }
  async checks(): Promise<CheckStatus> {
    return { conclusion: "success", summary: "ok" };
  }
  async approve(): Promise<void> {
    throw new Error("a session's forge never approves — that is the reviewer identity");
  }
  async merge(): Promise<void> {
    throw new Error("a session's forge never merges — that is the reviewer identity");
  }
  async revoke(): Promise<void> {}
}

const forge = new FakeForge();
const forgeFactory: ForgeFactory = { forTask: async () => forge };

const root = await mkdtemp(join(tmpdir(), "caterpillar-e2e-"));
const source = join(root, "source");
const mirrors = join(root, "mirrors");
const tasks = join(root, "tasks");
const stateRepo = join(root, "state");

// A real upstream repo, mirrored to the path WorktreeManager expects. Pre-creating the
// mirror means syncMirror takes the fetch path and never reaches the network.
await mkdir(source, { recursive: true });
await sh("git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false", source);
await writeFile(join(source, "README.md"), "# widget\n");
await sh("git add -A && git commit -qm init", source);

const mirrorDir = join(mirrors, REPO.host, REPO.owner, `${REPO.name}.git`);
await mkdir(join(mirrors, REPO.host, REPO.owner), { recursive: true });
await sh(`git clone -q --mirror ${source} ${mirrorDir}`, root);

// Minimal state repo containing one task.
await mkdir(join(stateRepo, "tasks", TASK), { recursive: true });
await writeFile(
  join(stateRepo, "tasks", TASK, "spec.md"),
  [
    "---",
    "workspace: test",
    "repos:",
    "  - github.com/acme/widget",
    "acceptance:",
    "  - \"true\"",
    "---",
    "",
    "Create a file called generated.txt.",
    "",
  ].join("\n"),
);

// A second task whose SPEC is large enough to fill a small context window. The faux
// provider derives usage from the real prompt text, so this is the honest way to
// exercise the handoff trigger.
//
// It used to be the journal that was oversized here. That stopped working the moment
// the journal became bounded on its way into the prompt (`journalForPrompt`) — which is
// the point of the bound, and why the thing that fills the window in this test has to be
// a part that has no cap. The spec is the immutable goal; nothing truncates it.
const BIG_TASK = asTaskId("TASK-2");
await mkdir(join(stateRepo, "tasks", BIG_TASK), { recursive: true });
await writeFile(
  join(stateRepo, "tasks", BIG_TASK, "spec.md"),
  [
    "---",
    "workspace: test",
    "repos:",
    "  - github.com/acme/widget",
    "acceptance:",
    '  - "true"',
    "---",
    "",
    "Keep working. ".repeat(200),
    "Investigated the widget subsystem in detail. ".repeat(4_000),
    "",
  ].join("\n"),
);

// A third task carrying the shape SMOKE-1 ended up with: a retry storm's worth of
// byte-identical park entries around the one entry that says something.
const JOURNAL_TASK = asTaskId("TASK-4"); // TASK-3 is taken by the sibling-repo test
const JOURNAL_REPEATS = 400;
await mkdir(join(stateRepo, "tasks", JOURNAL_TASK), { recursive: true });
await writeFile(
  join(stateRepo, "tasks", JOURNAL_TASK, "spec.md"),
  [
    "---",
    "workspace: test",
    "repos:",
    "  - github.com/acme/widget",
    "acceptance:",
    '  - "true"',
    "---",
    "",
    "Create a file called generated.txt.",
    "",
  ].join("\n"),
);
await writeFile(
  join(stateRepo, "tasks", JOURNAL_TASK, "journal.md"),
  [
    "\n## Session 1 — 2026-08-12T09:00:00.000Z\n\nthe decision that matters: use the fork point\n",
    ...Array.from(
      { length: JOURNAL_REPEATS },
      (_, i) => `\n## Session 0 — 2026-08-12T10:${String(i % 60).padStart(2, "0")}:00.000Z\n\n**Parked:** lease lost\n`,
    ),
  ].join(""),
);

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const git = new Git(root);
const store = new StateStore(stateRepo, new Git(stateRepo));
const worktrees = new WorktreeManager({
  git,
  mirrorsDir: mirrors,
  tasksDir: tasks,
  helperPath: "/nonexistent/caterpillar-cred",
  socketPath: join(root, "cred.sock"),
  identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
});

const spec: TaskSpec = await store.readSpec(TASK);

const state = (overrides: Partial<TaskState> = {}): TaskState => ({
  id: TASK,
  status: "running",
  phase: "implementing",
  requires: ["linux"],
  sessions: 0,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  progress: { lastProgressSession: 0, noProgressStreak: 0 },
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
  ...overrides,
});


const buildRunner = (
  contextWindow: number,
): {
  runner: AgentSessionRunner;
  faux: ReturnType<typeof fauxProvider>;
} => {
  const faux = fauxProvider({ models: [{ id: "faux-model", contextWindow, maxTokens: 4096 }] });
  const models = createModels();
  models.setProvider(faux.provider);

  // The faux provider is typed over an open `string` api; the runtime shape is
  // identical to a real model, so this narrowing is safe and confined to the test.
  const model = faux.getModel() as unknown as Model<Api>;

  const config = {
    handoff: { thresholdFraction: 0.7 },
    // The runner reads the workspace profile to build the credential scope: the host a
    // task's repos must live on, and the state repo none of them may be (§9.1, §9.3).
    workspaces: new Map([
      [
        asWorkspaceName("test"),
        { name: asWorkspaceName("test"), forge: { host: "github.com" }, secretRef: "test" },
      ],
    ]),
    stateRepo: { url: "https://github.com/acme/state.git" },
  } as unknown as RunnerConfig;

  const bindings: WorkspaceBindings = {
    forges: new Map([[asWorkspaceName("test"), forgeFactory]]),
    trackers: new Map(),
  };

  const runner = new AgentSessionRunner({
    config,
    store,
    worktrees,
    credentials: new CredentialService(),
    llm: { models, model },
    bindings,
    metrics: new AgentMetrics(),
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: tasks,
    }),
  });

  return { runner, faux };
};


test("runs a session, executes tools in the worktree, and records a done claim", async () => {
  const { runner, faux } = buildRunner(200_000);

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "echo generated > generated.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("done", { summary: "created generated.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("finished"),
  ]);

  const outcome = await runner.run(spec, state());

  assert.equal(outcome.reason, "done-claimed");
  assert.match(outcome.summary, /generated\.txt/);

  // The bash tool must have run inside the task's worktree, not the process cwd.
  const worktree = join(tasks, TASK, REPO.name);
  const produced = join(worktree, "generated.txt");
  assert.ok(existsSync(produced), "expected the tool to write into the worktree");
  assert.equal((await readFile(produced, "utf8")).trim(), "generated");

  // The transcript is persisted even though the session ended via a control tool.
  assert.ok(existsSync(join(stateRepo, "tasks", TASK, "sessions", "001.jsonl.gz")));
});

test("a retry storm's journal reaches the model collapsed, not in full", async () => {
  // End to end through the real runner, asserted on the TRANSCRIPT — the actual bytes
  // sent to the model, not a unit test of the renderer. SMOKE-1's journal was 347KB of
  // one repeated sentence, and every later session on that task would have opened by
  // paying for all of it.
  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("done", { summary: "nothing left to do" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  const journalSpec = await store.readSpec(JOURNAL_TASK);
  await runner.run(journalSpec, state({ id: JOURNAL_TASK }));

  const transcript = gunzipSync(
    await readFile(join(stateRepo, "tasks", JOURNAL_TASK, "sessions", "001.jsonl.gz")),
  ).toString("utf8");

  const copies = transcript.split("**Parked:** lease lost").length - 1;
  assert.equal(copies, 1, `the prompt carried ${copies} copies of one park entry`);
  assert.match(transcript, new RegExp(`repeated ${JOURNAL_REPEATS} times`), "say how many");
  assert.match(
    transcript,
    /the decision that matters/,
    "collapsing repeats must not cost the entry that mattered",
  );
});

test("hands off when the context budget is exceeded", async () => {
  // 60k is near the smallest window a 0.7 threshold permits: below ~54.6k the 16,384
  // reserve leaves no room, and ContextBudget rejects it outright rather than letting
  // an overrun beat the handoff.
  const { runner, faux } = buildRunner(60_000);
  const bigSpec = await store.readSpec(BIG_TASK);

  // More scripted turns than the budget should allow. If the trigger works, the
  // session stops after the first turn with responses left unconsumed.
  faux.setResponses([
    fauxAssistantMessage("first turn"),
    fauxAssistantMessage("second turn"),
    fauxAssistantMessage("third turn"),
  ]);

  const outcome = await runner.run(bigSpec, state({ id: BIG_TASK, sessions: 1 }));

  assert.equal(outcome.reason, "handoff");
  assert.match(outcome.summary, /context budget/);
  assert.ok(
    outcome.contextTokens >= 42_000,
    `expected to exceed the 42k threshold, got ${outcome.contextTokens}`,
  );
});

test("checks out sibling repos under the workspace and excludes them locally", async () => {
  // The Codeberg workflow: one workspace repo with the rest cloned inside it. A task
  // spanning the ecosystem must see siblings where its own docs say they are.
  const sibling: RepoRef = { host: "github.com", owner: "acme", name: "gadget" };
  const siblingSource = join(root, "gadget-source");
  await mkdir(siblingSource, { recursive: true });
  await sh("git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false", siblingSource);
  await writeFile(join(siblingSource, "lib.txt"), "gadget\n");
  await sh("git add -A && git commit -qm init", siblingSource);
  await sh(
    `git clone -q --mirror ${siblingSource} ${join(mirrors, sibling.host, sibling.owner, `${sibling.name}.git`)}`,
    root,
  );

  const multiTask = asTaskId("TASK-3");
  const checkout = await worktrees.ensureTaskCheckout([REPO, sibling], multiTask);

  assert.equal(checkout.root, join(tasks, multiTask, REPO.name));
  assert.equal(checkout.siblings.get("acme/gadget"), join(checkout.root, "repos", "gadget"));
  assert.ok(existsSync(join(checkout.root, "repos", "gadget", "lib.txt")));

  // The nested checkout must not show up as untracked in the workspace repo, or the
  // agent will eventually commit a whole sibling repository into it.
  const status = await worktrees.gitAt(checkout.root).run("status", "--porcelain");
  assert.equal(status, "", `workspace should be clean, got: ${status}`);
});

test("an open_pr call is surfaced on the outcome for the completion gate", async () => {
  const { runner, faux } = buildRunner(200_000);

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("open_pr", {
        title: "add generated file",
        body: "as requested",
        head: "agent/TASK-1",
        base: "main",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("done", { summary: "opened the PR" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  const outcome = await runner.run(spec, state({ sessions: 2 }));

  assert.equal(outcome.reason, "done-claimed");
  assert.deepEqual(outcome.pr, { number: 7, url: "https://example.invalid/pr/7" });
  assert.equal(forge.prs.at(-1)?.head, "agent/TASK-1");
});
