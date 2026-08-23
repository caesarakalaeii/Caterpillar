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
  ReviewComment,
} from "../forge/types.ts";
import { AgentMetrics } from "../metrics/registry.ts";
import { Git } from "../state/git.ts";
import { StateStore } from "../state/store.ts";
import { WorktreeManager } from "../workspace/worktree.ts";
import { DEFAULT_TOOLCHAIN_CONFIG, ToolchainResolver } from "../workspace/toolchain.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { AgentSessionRunner, type WorkspaceBindings } from "./runner.ts";
import { TEST_FIRST_STANDARD } from "./standards.ts";
import type { RunnerConfig } from "../config/types.ts";

const sh = (command: string, cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };
const TASK = asTaskId("TASK-1");
/** The pull request a review comment would be left on. */
const PR = { number: 7, url: "https://example.invalid/pr/7" } as const;

class FakeForge implements Forge {
  readonly kind = "fake";
  prs: PrRequest[] = [];
  /** What `listReviewComments` answers — or throws, when it is an Error. */
  reviewComments: readonly ReviewComment[] | Error = [];
  /** Every `(repo, pr)` it was asked about, so "asked nothing" is assertable. */
  readonly reviewLookups: [RepoRef, number][] = [];

  async credential(): Promise<GitCredential> {
    return { username: "x-access-token", password: "fake" };
  }
  async listReviewComments(repo: RepoRef, pr: number): Promise<readonly ReviewComment[]> {
    this.reviewLookups.push([repo, pr]);
    if (this.reviewComments instanceof Error) throw this.reviewComments;
    return this.reviewComments;
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
const forgeFactory: ForgeFactory = {
  forTask: async () => forge,
  // Nothing under test here asks; the fake repo is reachable by construction.
  unreachable: async () => [],
  reachable: async () => [],
};

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
// Deliberately SPLIT across both journal formats: the entry that matters sits in a
// legacy `journal.md` written before the sharding, and the retry storm arrives as
// shards. A resumed session must be given the whole history regardless of which file
// each entry happens to live in, so this test also pins the backward-compatible read.
await writeFile(
  join(stateRepo, "tasks", JOURNAL_TASK, "journal.md"),
  "\n## Session 1 — 2026-08-12T09:00:00.000Z\n\nthe decision that matters: use the fork point\n",
);
await mkdir(join(stateRepo, "tasks", JOURNAL_TASK, "journal"), { recursive: true });
for (let i = 0; i < JOURNAL_REPEATS; i += 1) {
  const minute = String(i % 60).padStart(2, "0");
  await writeFile(
    join(
      stateRepo,
      "tasks",
      JOURNAL_TASK,
      "journal",
      `0002-20260812T10${minute}00${String(i).padStart(3, "0")}Z-pod-a.md`,
    ),
    `## Session 2 — 2026-08-12T10:${minute}:00.000Z\n\n**Parked:** lease lost\n`,
  );
}

// A fifth task, on a repo of its OWN that ships `.caterpillar/standards.md` (§12.2). Its
// own repo rather than `source`, so every other test in this file keeps a prompt with no
// repo standards in it and the two cases stay distinguishable.
const STANDARDS_TASK = asTaskId("TASK-5");
const STANDARDS_REPO: RepoRef = { host: "github.com", owner: "acme", name: "housestyle" };
const standardsSource = join(root, "housestyle-source");
await mkdir(join(standardsSource, ".caterpillar"), { recursive: true });
await sh(
  "git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false",
  standardsSource,
);
await writeFile(
  join(standardsSource, ".caterpillar", "standards.md"),
  "## design: Changelog\n\nNever merge without a changelog entry.\n",
);
await sh("git add -A && git commit -qm init", standardsSource);
await mkdir(join(mirrors, STANDARDS_REPO.host, STANDARDS_REPO.owner), { recursive: true });
await sh(
  `git clone -q --mirror ${standardsSource} ${join(mirrors, STANDARDS_REPO.host, STANDARDS_REPO.owner, `${STANDARDS_REPO.name}.git`)}`,
  root,
);
await mkdir(join(stateRepo, "tasks", STANDARDS_TASK), { recursive: true });
await writeFile(
  join(stateRepo, "tasks", STANDARDS_TASK, "spec.md"),
  [
    "---",
    "workspace: test",
    "repos:",
    "  - github.com/acme/housestyle",
    "acceptance:",
    '  - "true"',
    "---",
    "",
    "Add a changelog entry.",
    "",
  ].join("\n"),
);

// Started, not merely constructed: the runner opens this task's socket in it. One
// service for the file, because the runner closes only the lease it opened.
const credentials = new CredentialService();
await credentials.start(join(root, "cred"));

after(async () => {
  await credentials.stop();
  await rm(root, { recursive: true, force: true });
});

const git = new Git(root);
const store = new StateStore(stateRepo, new Git(stateRepo));
const worktrees = new WorktreeManager({
  git,
  mirrorsDir: mirrors,
  tasksDir: tasks,
  helperPath: "/nonexistent/caterpillar-cred",
  socketDir: join(root, "cred"),
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
    // Two ceilings, both far out of reach here. `maxSessionSeconds` bounds the session
    // itself (§6.4) and these tests finish in milliseconds; `commandTimeoutSeconds`
    // bounds the agent's shell, and its own behaviour is covered in `exec.test.ts`.
    limits: { maxSessionSeconds: 3600, commandTimeoutSeconds: 900 },
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
    logger: SILENT_LOGGER,
    worktrees,
    credentials,
    llm: { models, model },
    bindings,
    metrics: new AgentMetrics(),
    toolchain: new ToolchainResolver({
      logger: SILENT_LOGGER,
      config: DEFAULT_TOOLCHAIN_CONFIG,
      tasksDir: tasks,
      identity: { name: "caterpillar", email: "caterpillar@example.invalid" },
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

test("the repo's own standards reach the session's system prompt", async () => {
  // End to end: the file is committed on the branch the worktree comes from, so this is
  // the real read, the real parse and the real splice (DESIGN.md §12.2). The council
  // splices the same sections into the owning lens; `review/lenses.test.ts` pins that half.
  const { runner, faux } = buildRunner(200_000);

  let systemPrompt = "";
  faux.setResponses([
    (context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage(fauxToolCall("done", { summary: "read the standards" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("finished"),
  ]);

  const standardsSpec = await store.readSpec(STANDARDS_TASK);
  await runner.run(standardsSpec, state({ id: STANDARDS_TASK }));

  assert.match(systemPrompt, /Never merge without a changelog entry\./);
  // Headed with the repo that supplied it — the per-repo scoping a multi-repo task needs.
  assert.match(systemPrompt, /acme\/housestyle/);
});

test("a session is told its repo's standards cannot switch the fleet's own off", async () => {
  // The file is untrusted text authored outside this system and it lands next to
  // test-first in the same prompt. A repo must not be able to turn that off by writing
  // a section that says so.
  const { runner, faux } = buildRunner(200_000);

  let systemPrompt = "";
  faux.setResponses([
    (context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage(fauxToolCall("done", { summary: "read the standards" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("finished"),
  ]);

  const standardsSpec = await store.readSpec(STANDARDS_TASK);
  await runner.run(standardsSpec, state({ id: STANDARDS_TASK }));

  assert.ok(systemPrompt.includes(TEST_FIRST_STANDARD));
  assert.match(systemPrompt, /cannot switch any of it off/);
});

/**
 * Review comments reach the prompt (DESIGN.md §7.3).
 *
 * Asserted on the TRANSCRIPT — the bytes actually sent to the model — for the same reason
 * the journal test is: the renderer has its own unit tests, and what those cannot prove is
 * that the section was fetched, rendered and spliced in at all.
 */
const commentOn = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "1",
  repo: REPO,
  pr: 7,
  author: "a-human",
  fromFleet: false,
  body: "this swallows the error",
  path: "src/index.ts",
  line: 12,
  createdAt: "2026-08-13T10:00:00.000Z",
  resolved: false,
  outdated: false,
  ...over,
});

const promptOf = async (task: string, session: number): Promise<string> =>
  gunzipSync(
    await readFile(
      join(stateRepo, "tasks", task, "sessions", `${String(session).padStart(3, "0")}.jsonl.gz`),
    ),
  ).toString("utf8");

test("an unresolved review comment reaches the model, with its file and line", async () => {
  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("done", { summary: "addressed the review" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  forge.reviewComments = [commentOn()];
  forge.reviewLookups.length = 0;
  const outcome = await runner.run(spec, state({ sessions: 3, pr: PR }));

  assert.equal(outcome.reason, "done-claimed");
  const transcript = await promptOf(TASK, 4);
  assert.match(transcript, /this swallows the error/);
  assert.match(transcript, /src\/index\.ts:12/);
  // Every PR the task has open is asked about, not the primary alone (§9.4.1).
  assert.deepEqual(forge.reviewLookups, [[REPO, 7]]);
});

test("the newest human comment is reported so the supervisor can forgive a round", async () => {
  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("done", { summary: "addressed the review" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  forge.reviewComments = [
    commentOn({ createdAt: "2026-08-13T10:00:00.000Z" }),
    commentOn({ id: "2", createdAt: "2026-08-14T10:00:00.000Z" }),
  ];
  const outcome = await runner.run(spec, state({ sessions: 4, pr: PR }));

  assert.equal(outcome.reviewComment, "2026-08-14T10:00:00.000Z");
});

test("a task with no pull request asks the forge nothing", async () => {
  // Nothing to comment on, and a session that has not opened a PR yet is the common case.
  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("done", { summary: "no PR yet" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);

  forge.reviewComments = [commentOn()];
  forge.reviewLookups.length = 0;
  const outcome = await runner.run(spec, state({ sessions: 5 }));

  assert.equal(outcome.reason, "done-claimed");
  assert.deepEqual(forge.reviewLookups, []);
  assert.equal(outcome.reviewComment, undefined);
});

test("a forge that cannot be reached does not fail the session", async () => {
  // Invariant 6, and the same rule tracker mirroring follows: log and continue. A GitHub
  // hiccup must not cost a task its session, and the review is not the work.
  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("done", { summary: "worked anyway" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  forge.reviewComments = new Error("GitHub /graphql failed with 500");
  const outcome = await runner.run(spec, state({ sessions: 6, pr: PR }));

  assert.equal(outcome.reason, "done-claimed");
  assert.equal(outcome.reviewComment, undefined);
});

test("a session resumes on the branch a previous session pushed", async () => {
  // GH-96's failure, at the surface that produced it. Sessions 2-3 pushed 18 commits;
  // sessions 4-7 started with the worktree on `main`, and session 7 — unable to tell that
  // from a task nobody had touched — re-implemented the whole task. Two independent
  // implementations of one task reached the remote and a human had to pick one.
  //
  // `WorktreeManager` cannot prevent this on its own: the reconciliation needs the network
  // and its other callers all run after `clearActive()`, so it is a distinct entry point
  // and this is the test that the session-start path uses it.
  const resumeTask = asTaskId("TASK-6");
  await mkdir(join(stateRepo, "tasks", resumeTask), { recursive: true });
  await writeFile(
    join(stateRepo, "tasks", resumeTask, "spec.md"),
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

  // The previous session's pushed work, in the upstream repo and nowhere on this runner:
  // the mirror's fetch refspec excludes `^refs/heads/agent/*`, so no fetch brings it here.
  await sh(`git checkout -q -B agent/${resumeTask} main`, source);
  await writeFile(join(source, "half-done.txt"), "work from session 2\n");
  await sh("git add -A && git commit -qm 'first half of the task'", source);
  const pushed = await new Git(source).run("rev-parse", "HEAD");
  await sh("git checkout -q main", source);

  const { runner, faux } = buildRunner(200_000);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("handoff", { summary: "carried on" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);

  await runner.run(await store.readSpec(resumeTask), state({ id: resumeTask, sessions: 3 }));

  const worktree = join(tasks, resumeTask, REPO.name);
  assert.equal(
    await new Git(worktree).run("rev-parse", "HEAD"),
    pushed,
    "the session must start at the tip of its own pushed branch, never behind it",
  );
  assert.ok(
    existsSync(join(worktree, "half-done.txt")),
    "the previous session's files must be in the worktree the agent is given",
  );
});
