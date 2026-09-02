/**
 * The cleanup pass (DESIGN.md §12.4).
 *
 * Three properties carry the weight here, and only one of them is about deleting code.
 *
 * It can never cost a finished task. The pass runs after the session has claimed
 * completion and before the §12 gates, so anything it throws would fail a change that was
 * already correct — every path out of it therefore ends in a note, including the ones that
 * end in an exception.
 *
 * Nothing it edits is left behind. The gate runs the acceptance commands in the worktree
 * and CI grades the pushed SHA, so an edit that is committed but not pushed, or made and
 * not committed, means those two graded different trees.
 *
 * And what it reports is MEASURED, from `git diff --shortstat` rather than from the
 * model's own account of its work.
 *
 * The provider is faux and git is a recording double: the question in every test below is
 * what the pass does with an answer, which needs neither a real model nor a real
 * repository to ask.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  cleanupNote,
  cleanupPrompt,
  parseShortstat,
  reportCleanupTool,
  runCleanupPass,
  type CleanupGit,
  type CleanupSink,
} from "./cleanup.ts";
import { CLEANUP_STANDARD } from "./standards.ts";
import type { ControlSink } from "./tools.ts";
import { asTaskId, asWorkspaceName, type TaskSpec } from "../domain/task.ts";
import type { LlmRuntime } from "../llm/models.ts";
import { SILENT_LOGGER } from "../obs/log.ts";

const spec = (acceptance: readonly string[] = ["npm test"]): TaskSpec => ({
  id: asTaskId("TASK-1"),
  workspace: asWorkspaceName("acme"),
  goal: "Refuse a spec that declares no repos.",
  repos: [{ host: "github.com", owner: "acme", name: "widget" }],
  requires: [],
  acceptance: [...acceptance],
});

/**
 * A provider that answers once and says nothing useful.
 *
 * Deliberately a model that does NOT call `report_cleanup`: what the tests below are
 * about is the git either side of the session, and a pass whose model went quiet is the
 * case where getting that wrong is least visible.
 */
const fauxLlm = (): LlmRuntime => {
  const faux = fauxProvider({
    models: [{ id: "faux-model", contextWindow: 200_000, maxTokens: 4096 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("had a look")]);

  // Same narrowing as `session.test.ts`, and for the same reason: the faux provider is
  // typed over an open `string` api and its runtime shape is a real model's.
  return { models, model: faux.getModel() as unknown as Model<Api> };
};

/** A git that records what it was asked, and answers with whatever the test needs. */
const recordingGit = (
  options: { readonly dirty?: boolean; readonly heads?: readonly string[]; readonly shortstat?: string } = {},
): { readonly git: CleanupGit; readonly calls: readonly (readonly string[])[] } => {
  const calls: string[][] = [];
  const heads = options.heads ?? ["aaa", "aaa"];
  let seen = 0;

  return {
    calls,
    git: {
      run: (...args: readonly string[]): Promise<string> => {
        calls.push([...args]);
        if (args[0] === "rev-parse") return Promise.resolve(heads[seen++] ?? "aaa");
        if (args[0] === "diff") return Promise.resolve(options.shortstat ?? "");
        return Promise.resolve("");
      },
      hasUncommittedChanges: () => Promise.resolve(options.dirty ?? false),
    },
  };
};

const runPass = (git: CleanupGit) =>
  runCleanupPass({
    spec: spec(),
    worktree: "/task/r",
    git,
    base: "abc123",
    llm: fauxLlm(),
    tools: [],
    timeoutSeconds: 3600,
    thresholdFraction: 0.7,
    logger: SILENT_LOGGER,
  });

test("a shortstat with no insertions clause still reads its deletions", () => {
  // The expected shape of a good pass: it only deleted, so git prints no insertions
  // clause at all. Read with a naive two-number parse, the deletions land in the
  // insertions slot and the journal reports a pass that ADDED 128 lines.
  assert.deepEqual(parseShortstat(" 3 files changed, 128 deletions(-)"), {
    insertions: 0,
    deletions: 128,
  });
  assert.deepEqual(parseShortstat(" 2 files changed, 4 insertions(+), 9 deletions(-)"), {
    insertions: 4,
    deletions: 9,
  });
});

test("singular forms and unreadable output are both survivable", () => {
  // git says "1 insertion(+)", not "1 insertions(+)".
  assert.deepEqual(parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)"), {
    insertions: 1,
    deletions: 1,
  });
  // Zeroes rather than a throw: this number is a line in a journal entry, and it is not
  // worth failing a finished task to be unable to render one.
  assert.deepEqual(parseShortstat(""), { insertions: 0, deletions: 0 });
  assert.deepEqual(parseShortstat("fatal: bad revision"), { insertions: 0, deletions: 0 });
});

test("a pass that cut nothing reads as a lean diff, not as a failure", () => {
  const note = cleanupNote({ insertions: 0, deletions: 0 }, "Nothing to take out.");

  assert.match(note, /already lean/);
  // The words that would make a good outcome look like a broken step.
  assert.doesNotMatch(note, /did not run|fail/i);
});

test("the note states the net change, in the direction it actually went", () => {
  assert.match(
    cleanupNote({ insertions: 4, deletions: 130 }, "Deleted the wrapper."),
    /-130\/\+4 lines \(net -126\)/,
  );
  // A pass that GREW the diff is worth seeing in the journal, not hiding behind a net
  // rendered as though it had shrunk.
  assert.match(cleanupNote({ insertions: 10, deletions: 2 }, "s"), /net \+8/);
});

test("the pass is shown the task's own range and told to leave everything else alone", () => {
  const prompt = cleanupPrompt(spec(), "abc123");

  assert.match(prompt, /git diff abc123\.\.\.HEAD/);
  assert.match(prompt, /the only\s+thing you may edit/);
  // It is not a bug hunt and it is not a feature pass. Both are said, because a model
  // handed a diff and told to improve it will happily do either.
  assert.match(prompt, /not\s+fixing bugs and you are not adding anything/);
});

test("with no branch point it is shown HEAD rather than the repository's history", () => {
  // The conservative fallback: showing it less of its own change beats a range reaching
  // back into the repo, because a pass shown a whole repository as "the diff" edits it.
  assert.match(cleanupPrompt(spec(), undefined), /git diff HEAD\b/);
});

test("the acceptance commands are named, so the pass can leave them green", () => {
  const prompt = cleanupPrompt(spec(["npm run check", "npm test"]), "abc123");

  assert.match(prompt, /`npm run check`/);
  assert.match(prompt, /`npm test`/);
});

test("a task that declares no acceptance commands is still told to check its work", () => {
  const prompt = cleanupPrompt(spec([]), "abc123");

  assert.match(prompt, /declares no acceptance commands/);
  assert.doesNotMatch(prompt, /- ``/);
});

test("report_cleanup records the summary and ends the pass", async () => {
  const sink: CleanupSink = {};
  const control: ControlSink = {};

  await reportCleanupTool(sink, control).execute("id", { summary: "Cut a wrapper." });

  assert.equal(sink.summary, "Cut a wrapper.");
  // Without the signal the session runs on past its own report, reading the repository at
  // cost — the same reason `submit_verdict` sets one.
  assert.notEqual(control.signal, undefined);
});

test("a pass that changed nothing commits nothing and pushes nothing", async () => {
  const { git, calls } = recordingGit({ heads: ["aaa", "aaa"] });

  const outcome = await runPass(git);

  assert.match(outcome.note, /already lean/);
  // A push on an unchanged branch is a no-op that still costs a network round trip and
  // still appears in the log as though the pass had done something.
  assert.equal(
    calls.some((call) => call[0] === "push"),
    false,
  );
  assert.deepEqual({ insertions: outcome.insertions, deletions: outcome.deletions }, {
    insertions: 0,
    deletions: 0,
  });
});

test("work the pass left in the tree is committed and pushed, not abandoned", async () => {
  // THE property that decides where this module lives. The acceptance gate runs in the
  // worktree and CI grades the pushed SHA; an edit that reaches one and not the other has
  // them grading different trees, and the task merges on a review of code that never ran.
  const { git, calls } = recordingGit({
    dirty: true,
    heads: ["aaa", "bbb"],
    shortstat: " 4 files changed, 6 insertions(+), 140 deletions(-)",
  });

  const outcome = await runPass(git);

  const ran = (...prefix: readonly string[]): boolean =>
    calls.some((call) => prefix.every((word, index) => call[index] === word));

  assert.ok(ran("add", "-A"), "uncommitted cleanup was left in the tree");
  assert.ok(ran("commit"), "the cleanup was never committed");
  assert.ok(ran("push"), "the cleanup never reached the remote");
  assert.equal(outcome.deletions, 140);
  assert.match(outcome.note, /net -134/);
});

test("the commit comes before the push, and the measurement after both", async () => {
  // Order is the whole guarantee. Measuring before the commit reports a pass that cut
  // nothing; pushing before the commit sends the branch without the cleanup on it.
  const { git, calls } = recordingGit({
    dirty: true,
    heads: ["aaa", "bbb"],
    shortstat: " 1 file changed, 3 deletions(-)",
  });

  await runPass(git);

  const at = (word: string): number => calls.findIndex((call) => call[0] === word);
  assert.ok(at("commit") < at("push"), "pushed before committing");
  assert.ok(at("push") < at("diff"), "measured before pushing");
});

test("a pass that cannot reach git costs the task nothing", async () => {
  // This runs on a task that has ALREADY claimed completion, so a throw here fails a
  // change that was correct before the pass started.
  const git: CleanupGit = {
    run: () => Promise.reject(new Error("not a git repository")),
    hasUncommittedChanges: () => Promise.resolve(false),
  };

  const outcome = await runPass(git);

  assert.match(outcome.note, /Cleanup pass did not run/);
  assert.match(outcome.note, /not a git repository/);
  // And it has to say the change survived, or the next reader of the journal goes looking
  // for damage that was never done.
  assert.match(outcome.note, /change is unaffected/);
  assert.deepEqual(outcome.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
});

test("the standard keeps the comments that carry why, and cuts the ones that restate", () => {
  // This repository records rationale in prose deliberately — `README.md` and
  // `remediation/receiver.ts` both say so in their own text — so a cleanup standard that
  // read as "fewer comments" would delete the most valuable thing in the codebase. The
  // rule is about information, and the test is what a reader loses.
  assert.match(CLEANUP_STANDARD, /load-bearing and stays/);
  assert.match(CLEANUP_STANDARD, /what a reader loses if the comment is gone/);
  assert.match(CLEANUP_STANDARD, /restates the line under it/);
});

test("the standard forbids the shortcuts that make a diff smaller and the code worse", () => {
  // The failure mode that would make this pass a net negative: a smaller diff bought by
  // deleting the things that are only there for the bad day.
  assert.match(CLEANUP_STANDARD, /Never weaken a test/);
  assert.match(CLEANUP_STANDARD, /validation at a trust boundary/);
  assert.match(CLEANUP_STANDARD, /security measures, and accessibility/);
});
