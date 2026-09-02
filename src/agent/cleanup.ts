/**
 * The cleanup pass. See DESIGN.md §12.4.
 *
 * A session that has just claimed completion has written the change it was asked for and
 * nothing has yet read it. What it has ALSO written, reliably, is scaffolding it stopped
 * needing three turns ago and a commentary on its own reasoning: a wrapper that forwards,
 * an interface with one implementation, and paragraphs restating the line beneath them.
 * None of that is caught anywhere else. The acceptance gate measures exit codes and CI
 * measures exit codes; the council reads the diff, but its `design` lens is one blocking
 * vote among five and a reviewer that objects to volume alone is a reviewer sending a
 * correct change back — which §12.1 spends most of its text telling it not to do.
 *
 * So the fix is not another vote. It is a pass that does the deletion itself, before
 * anyone grades the change, and it runs HERE — inside `AgentRunner.run`, in the session's
 * own credential lease — for a reason that is not organisational:
 *
 *   the lease is opened by `credentials.activate` at the top of `run` and closed in its
 *   `finally`, so the task's git remote is only reachable from inside that window. A
 *   cleanup pass in `supervisor/loop.ts`, beside the council where it would otherwise
 *   belong, could edit the worktree and could never push the result — and a cleanup that
 *   does not reach the remote is the worst of the available outcomes, because the
 *   acceptance gate would run on the cleaned tree while CI graded the SHA before it.
 *
 * Ordering follows from the same fact. Everything the §12 gates bless is post-cleanup
 * code: the pass runs before the outcome leaves the runner, so the supervisor's first
 * sight of the task is already the diff that will merge. Nothing is graded twice and
 * nothing merges ungraded.
 *
 * It is never allowed to fail the session. The change was complete before this ran, and
 * trading a finished task for a tidier one is a bad trade at any exchange rate — so every
 * path here ends in a note for the journal, including the ones that end in an exception.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CLEANUP_STANDARD } from "./standards.ts";
import { ContextBudget } from "./limits.ts";
import { runSession } from "./session.ts";
import type { ControlSink } from "./tools.ts";
import { EMPTY_USAGE, type TaskSpec, type UsageTotals } from "../domain/task.ts";
import type { LlmRuntime } from "../llm/models.ts";
import { errorFields, type Logger } from "../obs/log.ts";


/**
 * The git this pass needs, and nothing else. The real `Git` satisfies it structurally, the
 * same way `StateStore` satisfies `ArtifactSource` in `review/council.ts` — a test of what
 * the pass does when the repository will not answer should not need a repository to say so.
 */
export interface CleanupGit {
  run(...args: readonly string[]): Promise<string>;
  hasUncommittedChanges(): Promise<boolean>;
}

/** Where the pass's one report lands. Mirrors `review/tools.ts`'s `VerdictSink`. */
export interface CleanupSink {
  summary?: string;
}

const ReportParams = Type.Object({
  summary: Type.String({
    description:
      "What you took out and why, in a few sentences. If you cut nothing, say that " +
      "instead — a diff that is already lean is a finished diff.",
  }),
});

/**
 * The pass's only control verb, and deliberately not a verdict.
 *
 * It reports; it does not decide. Nothing downstream branches on what this says — the
 * gates run either way and the council reads the result either way — so there is no
 * decision here for a model to get wrong, and the summary is prose for a human rather
 * than a value the supervisor interprets.
 *
 * It does not ask how many lines were cut, and that is the point: `measure` below asks
 * git. A number the model reports is a number nobody can check, and this repository
 * already made that choice once, in §19 — the digest is measured from git, not remembered.
 */
export const reportCleanupTool = (
  sink: CleanupSink,
  control: ControlSink,
): AgentTool<typeof ReportParams, null> => ({
  name: "report_cleanup",
  label: "Report cleanup",
  description:
    "Record what this pass removed and END it. Call this exactly once, as the last thing " +
    "you do, after your edits are made and the checks you ran are green.",
  parameters: ReportParams,
  execute: async (_id, params: Static<typeof ReportParams>) => {
    sink.summary = params.summary;
    control.signal = { reason: "done-claimed", summary: params.summary };

    return {
      content: [{ type: "text" as const, text: "Cleanup recorded. Your pass is complete." }],
      details: null,
    };
  },
});

/** What one pass did, measured rather than claimed. */
export interface CleanupOutcome {
  /** Lines added and removed BY THIS PASS, from `git diff --shortstat`. */
  readonly insertions: number;
  readonly deletions: number;
  /** Prose for the journal. Always present, including when the pass failed. */
  readonly note: string;
  readonly usage: UsageTotals;
}

export interface CleanupOptions {
  readonly spec: TaskSpec;
  readonly worktree: string;
  /** Bound to `worktree`. The pass measures, commits and pushes through this. */
  readonly git: CleanupGit;
  readonly llm: LlmRuntime;
  /**
   * Where this task's work forks from the default branch, for the diff the pass is shown.
   *
   * `WorktreeManager.branchPoint` already answers this, locally and without a credential,
   * and it is passed in rather than recomputed so the pass reads the same range the review
   * council reads (`review/council.ts` resolves it the same way). Undefined when it cannot
   * be resolved, which shows the pass `HEAD` alone — deliberately less of its own change
   * rather than a range reaching into the repository's history, because a pass shown a
   * whole repository as "the diff" is a pass that edits it.
   */
  readonly base: string | undefined;
  /**
   * `read`, `write`, `edit` and `bash`, already bound to the session's execution
   * environment — the same bounded shell, the same resolved toolchain, the same output
   * ceilings. Taken rather than built so the pass cannot end up in a different
   * environment from the session whose work it is editing, which is the failure
   * `workspace/toolchain.ts` exists to prevent.
   *
   * The caller passes the file tools WITHOUT the control verbs: this pass may not open a
   * pull request, claim completion, ask a human or hand off. Its whole output is edits
   * and one report.
   */
  readonly tools: readonly AgentTool[];
  readonly timeoutSeconds: number;
  readonly thresholdFraction: number;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

/**
 * Parse `git diff --shortstat`. Pure, and exported to be tested.
 *
 * The shape is ` 3 files changed, 4 insertions(+), 128 deletions(-)`, with either number
 * absent when it is zero — a pass that only deletes, which is the expected shape here,
 * prints no insertions clause at all. Singular forms ("1 insertion(+)") occur too.
 *
 * Anything it cannot read is zeroes rather than a throw. This number is a line in a
 * journal entry; it is not worth failing a finished task to be unable to render it.
 */
export const parseShortstat = (
  text: string,
): { readonly insertions: number; readonly deletions: number } => {
  const of = (unit: string): number => {
    const found = new RegExp(`(\\d+) ${unit}`).exec(text);
    return found === null ? 0 : Number(found[1]);
  };

  return { insertions: of("insertion"), deletions: of("deletion") };
};

/**
 * The note the journal gets, from what git measured.
 *
 * Pure, and separate from the pass because this is the part a human reads and the part
 * that must not overstate. A pass that ran and cut nothing is a real and good outcome —
 * it means the session wrote lean code — and it must not read as a pass that failed.
 */
export const cleanupNote = (
  outcome: { readonly insertions: number; readonly deletions: number },
  summary: string,
): string => {
  const net = outcome.deletions - outcome.insertions;
  if (outcome.insertions === 0 && outcome.deletions === 0) {
    return `**Cleanup pass: nothing to cut.** The diff was already lean.\n\n${summary}`;
  }

  return (
    `**Cleanup pass: -${outcome.deletions}/+${outcome.insertions} lines ` +
    `(net ${net >= 0 ? "-" : "+"}${Math.abs(net)}).**\n\n${summary}`
  );
};

/** What the pass is told about the change it is cleaning. */
export const cleanupPrompt = (spec: TaskSpec, base: string | undefined): string => {
  const range = base === undefined ? "HEAD" : `${base}...HEAD`;
  const acceptance =
    spec.acceptance.length === 0
      ? "This task declares no acceptance commands. Run whatever check the repository " +
        "uses before you report."
      : `Before you report, run every one of these and leave them green:\n${spec.acceptance
          .map((command) => `  - \`${command}\``)
          .join("\n")}`;

  return `A coding session has just finished this task and claims it is done. Its work is
correct and its tests pass. You are the pass that goes over it before anybody reads it.

Read the change first: \`git diff ${range}\` is what this task wrote, and it is the only
thing you may edit. \`git log ${range}\` is how it got there.

Take out what should not have gone in. Leave the change doing exactly what it does now —
same behaviour, same public surface, same tests passing for the same reasons. You are not
fixing bugs and you are not adding anything; if you find a bug, leave it and say so in
your report.

${acceptance}

Then call \`report_cleanup\` once. You do not need to commit — anything you leave in the
working tree is committed and pushed for you.`;
};

/**
 * Run the pass. Never throws.
 *
 * The three git calls around the session are the whole measurement: HEAD before, HEAD
 * after, and the diff between them. Whether the pass committed its own work or left it in
 * the tree makes no difference to that — the commit below runs first, so by the time the
 * range is measured every edit is on the branch either way.
 */
export const runCleanupPass = async (options: CleanupOptions): Promise<CleanupOutcome> => {
  const { spec, git, llm, logger, signal } = options;
  const nothing = { insertions: 0, deletions: 0, usage: EMPTY_USAGE };

  try {
    const before = await git.run("rev-parse", "HEAD");
    const sink: CleanupSink = {};
    const control: ControlSink = {};

    logger.info("cleanup.start", { task: spec.id });

    const result = await runSession({
      timeoutSeconds: options.timeoutSeconds,
      models: llm.models,
      model: llm.model,
      systemPrompt:
        `You are a senior engineer with a long memory for over-engineered codebases, ` +
        `going over a change before anyone else reads it. The best code is the code that ` +
        `was never written, and the second best is the code you just deleted.\n\n` +
        `${CLEANUP_STANDARD}\n\nYour working directory is ${options.worktree}.`,
      initialPrompt: cleanupPrompt(spec, options.base),
      tools: [...options.tools, reportCleanupTool(sink, control) as AgentTool],
      budget: new ContextBudget({
        contextWindow: llm.model.contextWindow,
        thresholdFraction: options.thresholdFraction,
      }),
      control,
      ...(signal === undefined ? {} : { signal }),
    });

    // Committed here rather than asked for, so "the pass edited but did not commit" is not
    // a state anything downstream has to know about. The gate and CI must grade the same
    // tree, and the only way to guarantee that is to leave nothing uncommitted behind.
    if (await git.hasUncommittedChanges()) {
      await git.run("add", "-A");
      await git.run("commit", "-m", `refactor(${spec.id}): cleanup pass`);
    }

    const after = await git.run("rev-parse", "HEAD");
    const summary = sink.summary ?? "The pass ended without reporting what it did.";
    if (after === before) {
      logger.info("cleanup.no-change", { task: spec.id, costUsd: result.outcome.usage.costUsd });
      return { ...nothing, note: cleanupNote(nothing, summary), usage: result.outcome.usage };
    }

    // The push the whole placement of this module is for (see the header). Last, after the
    // commit, so a failure here leaves the work on the branch for the next session rather
    // than losing it.
    //
    // Bare, and that is the SAFE form here rather than the careless one — which is the
    // opposite of how it reads. `disarmMirrorPush` in `workspace/worktree.ts` pins
    // `remote.origin.push = HEAD` on the mirror every task on the repo shares, so this
    // pushes the current branch to its own name upstream and can move nothing else. The
    // careful-looking `git push -u origin <branch>` is the one that fails on these
    // checkouts; read that method before changing this line.
    await git.run("push");

    const measured = parseShortstat(
      await git.run("diff", "--shortstat", `${before}..${after}`),
    );
    logger.info("cleanup.done", {
      task: spec.id,
      insertions: measured.insertions,
      deletions: measured.deletions,
      costUsd: result.outcome.usage.costUsd,
    });

    return { ...measured, note: cleanupNote(measured, summary), usage: result.outcome.usage };
  } catch (error) {
    // Deliberately swallowed, and this is the one place in the runner where that is the
    // right call: the task is COMPLETE and its gates have not run yet. A cleanup that
    // could fail a finished change would make every session's outcome depend on a step
    // that adds no correctness — so the failure becomes a line in the journal and the
    // task carries on to the gates with the code the session wrote.
    logger.warn("cleanup.failed", { task: spec.id, ...errorFields(error) });
    const message = error instanceof Error ? error.message : String(error);

    return {
      ...nothing,
      note:
        `**Cleanup pass did not run:** ${message}\n\n` +
        `The change is unaffected — this pass never gates a task, and what follows is ` +
        `exactly what the session wrote.`,
    };
  }
};

