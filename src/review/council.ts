/**
 * The review council. See DESIGN.md §12.1.
 *
 * Runs AFTER the §12 gates, never instead of them. By the time this is reached the
 * supervisor has already established, independently of any agent, that the acceptance
 * commands exit 0 and that CI is green. The council is the third gate, and the only one
 * that reads the change rather than its outcome.
 *
 * The read-only reviewers run CONCURRENTLY in the task's existing worktree. They share it,
 * which is safe because none of them can write: their tool surface is `read`, `bash` and
 * `submit_verdict`, with no `write`, no `edit`, and none of the implementation agent's
 * control verbs. A reviewer cannot open a PR, cannot claim completion, and cannot hand
 * off; its whole output is one typed verdict.
 *
 * The `sabotage` lens is the exception, and the only one: it breaks the changed source on
 * purpose to find out whether the tests notice, so it gets `write` and `edit` — in a
 * PRIVATE copy of the checkout, never in the shared one. `reviewerPlan` below is where
 * that distinction is decided, and it is pure so that it can be tested without a session.
 *
 * Nothing here decides anything. It gathers their verdicts and hands them to `decide`,
 * which is pure and is where the rule actually lives.
 */
import { join } from "node:path";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  NodeExecutionEnv,
  type AgentHarnessTool,
  type AgentTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core/node";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { RunnerConfig } from "../config/types.ts";
import {
  addUsage,
  EMPTY_USAGE,
  type ProposedPlan,
  type ProviderOutage,
  type TaskSpec,
  type TaskState,
  type UsageTotals,
} from "../domain/task.ts";
import { ContextBudget } from "../agent/limits.ts";
import { runSession } from "../agent/session.ts";
import type { ControlSink } from "../agent/tools.ts";
import type { LlmRuntime } from "../llm/models.ts";
import { classifyProviderFailure } from "../llm/outage.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { outputCeiling } from "../agent/budget.ts";
import { BoundedExecutionEnv } from "../agent/exec.ts";
import type { ResolvedEnv, ToolchainResolver } from "../workspace/toolchain.ts";
import { decide, type CouncilVerdict, type ReviewerVerdict } from "./decide.ts";
import { PLAN_LENSES, prLenses, SABOTAGE_LENS, type Lens } from "./lenses.ts";
import {
  prepareSabotageCopy,
  SabotageExecutionEnv,
  type PrepareOptions,
  type PrepareResult,
} from "./sabotage.ts";
import { renderEvidence, testFirstEvidence, type Commit } from "./tdd.ts";
import { submitVerdictTool, type VerdictSink } from "./tools.ts";

interface ExecContext {
  readonly env: NodeExecutionEnv;
}

/** Same binding shim as `agent/runner.ts` — pi's built-ins take context as a trailing arg. */
const bindTool = <TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecContext, TParameters, TDetails>,
  context: ExecContext,
): AgentTool<TParameters, TDetails> => ({
  ...tool,
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>> =>
    tool.execute(toolCallId, params, signal, onUpdate, context),
});

export interface ReviewerPlanInput {
  readonly lensKey: string;
  /** The shared, read-only task checkout. Every reviewer but `sabotage` works here. */
  readonly worktree: string;
  /** The private copy, when one was prepared. Only `sabotage` may be pointed at it. */
  readonly sabotageCopy?: string;
  /** `limits.sabotageMaxCommands`. Applied to the sabotage reviewer only. */
  readonly maxCommands: number;
}

export interface ReviewerPlan {
  readonly cwd: string;
  /** pi's own tool names, in the order the tools are built. */
  readonly toolNames: readonly string[];
  /** Set only for the sabotage reviewer, whose loop is otherwise unbounded. */
  readonly maxCommands?: number;
}

/** What every reviewer gets, and what only the sabotage reviewer gets on top. */
const READ_ONLY_TOOLS = ["read", "bash", "submit_verdict"] as const;
const SABOTAGE_TOOLS = ["read", "bash", "write", "edit", "submit_verdict"] as const;

/**
 * Where a reviewer works and what it may do there. Pure, and exported to be tested.
 *
 * All of it is one decision — read-only in the shared worktree, or writable in a private
 * copy — and it is extracted rather than inlined into `runReviewer` because `runReviewer`
 * needs a provider, a toolchain and a session to reach, and the decision needs none of
 * those. A test of this function is a test of the rule; a test of `runReviewer` against a
 * hand-built fake session would mostly be a test of the fake.
 *
 * Throws for a sabotage reviewer with no copy. That is the one outcome that must be
 * impossible: `write` and `edit` in the shared worktree reach the checkout the other four
 * reviewers are reading concurrently, and would rewrite the very diff they are grading.
 * `runReviewer` turns the throw into an abstention, which is the honest reading — the lens
 * did not review anything.
 */
export const reviewerPlan = (input: ReviewerPlanInput): ReviewerPlan => {
  if (input.lensKey !== SABOTAGE_LENS.key) {
    return { cwd: input.worktree, toolNames: READ_ONLY_TOOLS };
  }

  if (input.sabotageCopy === undefined) {
    throw new Error(
      "refusing to run the sabotage reviewer: no private copy was prepared, and it must " +
        "never be given write access to the shared worktree",
    );
  }

  return {
    cwd: input.sabotageCopy,
    toolNames: SABOTAGE_TOOLS,
    maxCommands: input.maxCommands,
  };
};

/**
 * A round with the sabotage lens dropped, and the abstention that says why.
 *
 * A copy that could not be made is not a defect in the change under review, so it must not
 * fail the council — and it must not silently vanish either, or a review round with four
 * lenses would be indistinguishable from one with five. The lens leaves the round and its
 * reason is recorded as an abstention, which `decide` already counts separately from an
 * approval.
 */
export const sabotageAbstentionFor = (
  lenses: readonly Lens[],
  reason: string,
): { readonly lenses: readonly Lens[]; readonly verdicts: readonly ReviewerVerdict[] } => {
  const dropped = lenses.filter((lens) => lens.key === SABOTAGE_LENS.key);

  return {
    lenses: lenses.filter((lens) => lens.key !== SABOTAGE_LENS.key),
    verdicts: dropped.map((lens) => abstention(lens, reason)),
  };
};

/**
 * Run `body` with a sabotage copy prepared, and remove the copy whatever happens.
 *
 * The try/finally is here, in a function of its own, because that is what makes the
 * guarantee testable: `convene` needs a provider and five concurrent sessions to reach,
 * and "the copy is removed even when a reviewer throws" is the property least likely to be
 * exercised by a passing run and most expensive to get wrong — a leaked copy is a whole
 * second checkout of the task, per review round, on a volume up to four replicas share.
 *
 * `body` is handed the same discriminated shape `prepare` returned, minus `cleanup`, so it
 * cannot forget the refused case and cannot remove the copy out from under this `finally`.
 */
export type SabotageCopy =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export const withSabotageCopy = async <T>(
  prepare: (options: PrepareOptions) => Promise<PrepareResult>,
  options: PrepareOptions,
  body: (copy: SabotageCopy) => Promise<T>,
): Promise<T> => {
  const prepared = await prepare(options);
  if (!prepared.ok) return body({ ok: false, reason: prepared.reason });

  try {
    return await body({ ok: true, path: prepared.path });
  } finally {
    await prepared.cleanup();
  }
};

export interface CouncilResult {
  readonly verdict: CouncilVerdict;
  /** Tokens and cost the council itself spent. Added to the task's totals. */
  readonly usage: UsageTotals;
  /**
   * Set when a reviewer abstained because the PROVIDER stopped answering (§6.3).
   *
   * Carried out rather than folded into the verdict because it is not a review outcome
   * at all: the supervisor must back off and convene again later, not record that the
   * council had reservations. A verdict written from unreachable reviewers would
   * be a permanent document about a temporary condition.
   */
  readonly outage?: ProviderOutage;
}

export interface Council {
  review(spec: TaskSpec, state: TaskState): Promise<CouncilResult>;
  /** The same machinery, different lenses, on a plan that has not been built yet (§14.3). */
  reviewPlan(spec: TaskSpec, state: TaskState, plan: ProposedPlan): Promise<CouncilResult>;
}

export interface ReviewCouncilOptions {
  readonly config: RunnerConfig;
  readonly worktrees: WorktreeManager;
  readonly llm: LlmRuntime;
  readonly logger: Logger;
  readonly toolchain: ToolchainResolver;
  /** Overridable so a future plan council can supply its own (DESIGN.md §12.1). */
  readonly lenses?: readonly Lens[];
  /**
   * How the sabotage reviewer's private copy is made. Defaults to the real thing.
   *
   * A seam, not a feature: `prepareSabotageCopy` shells out to `cp -a` on a whole checkout
   * and rewrites git pointer files, so a test of what the council does with its ANSWER —
   * drop the lens on a refusal, remove the copy on a throw — cannot afford to call it. This
   * repo does not use module mocking and `npm test` does not enable it, so the substitution
   * has to be a constructor argument.
   */
  readonly prepareSabotage?: typeof prepareSabotageCopy;
}

export class ReviewCouncil implements Council {
  private readonly options: ReviewCouncilOptions;

  constructor(options: ReviewCouncilOptions) {
    this.options = options;
  }

  async review(spec: TaskSpec, state: TaskState): Promise<CouncilResult> {
    const checkout = await this.options.worktrees.ensureTaskCheckout(spec.repos, spec.id);
    const base = await this.options.worktrees.branchPoint(checkout.root);
    // Only with a base. Without one there is no range to log, and an unbounded `git log`
    // would present the repository's whole history as this task's commits — which reads
    // as damning evidence about a change that did not write any of it.
    const commits =
      base === undefined ? [] : await this.options.worktrees.commitsSince(checkout.root, base);

    return this.convene(
      // `touchesSource` is the "is there anything to break" question, already answered here
      // for the evidence block the prompt carries.
      this.options.lenses ?? prLenses(testFirstEvidence(commits).touchesSource),
      checkout.root,
      reviewPrompt(spec, state, base, commits),
      spec,
      state,
    );
  }

  async reviewPlan(
    spec: TaskSpec,
    state: TaskState,
    plan: ProposedPlan,
  ): Promise<CouncilResult> {
    // The brainstorm's own worktree. The reviewers read the code the plan is about, which
    // is the only way to catch a plan that assumes files nobody has written.
    const checkout = await this.options.worktrees.ensureTaskCheckout(spec.repos, spec.id);

    return this.convene(PLAN_LENSES, checkout.root, planPrompt(spec, plan), spec, state);
  }

  private async convene(
    lenses: readonly Lens[],
    worktree: string,
    prompt: string,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<CouncilResult> {
    // The sabotage lens needs somewhere to write before any reviewer starts, and there is
    // exactly one copy for the round. A refusal drops the lens rather than failing the
    // council, and `withSabotageCopy` removes the copy whichever way the round ends.
    if (!lenses.some((lens) => lens.key === SABOTAGE_LENS.key)) {
      return this.round(lenses, [], worktree, undefined, prompt, spec, state);
    }

    const prepare = this.options.prepareSabotage ?? prepareSabotageCopy;
    return withSabotageCopy(
      prepare,
      {
        checkoutRoot: worktree,
        taskDir: join(this.options.config.paths.tasks, spec.id),
        // NOT `config.toolchain.minFreeGb`: that is the nix store's GC threshold, where 0
        // is a documented off switch, and reusing it would disable this floor on every
        // runner with store collection turned off.
        minFreeGb: this.options.config.limits.sabotageMinFreeGb,
        logger: this.options.logger,
        task: spec.id,
      },
      async (copy) => {
        if (!copy.ok) {
          const round = sabotageAbstentionFor(lenses, copy.reason);
          return this.round(
            round.lenses,
            round.verdicts,
            worktree,
            undefined,
            prompt,
            spec,
            state,
          );
        }
        return this.round(lenses, [], worktree, copy.path, prompt, spec, state);
      },
    );
  }

  /** One convened round, with the sabotage copy (if any) already prepared. */
  private async round(
    lenses: readonly Lens[],
    /** Verdicts for lenses that never ran, merged in before `decide`. */
    dropped: readonly ReviewerVerdict[],
    worktree: string,
    sabotageCopy: string | undefined,
    prompt: string,
    spec: TaskSpec,
    state: TaskState,
  ): Promise<CouncilResult> {
    const { logger } = this.options;

    logger.info("council.start", {
      task: spec.id,
      session: state.sessions,
      lenses: lenses.map((l) => l.key).join(","),
    });

    // Resolved once and shared by every reviewer. They read the same worktree, so a
    // resolve each would be one identical answer each — and a reviewer judging the code
    // in a different environment from the one that produced it is the failure this
    // module exists to prevent (see `workspace/toolchain.ts`).
    const toolchain = await this.options.toolchain.resolve(spec, worktree);

    // The council's own ceiling, and until it existed there was NONE (DESIGN.md §6.4).
    // `maxSessionSeconds` in the supervisor loop wraps `runner.run` and is cleared before
    // the council is convened, so a reviewer that hung had nothing above it at all — the
    // implementation session was bounded at four hours and the review of it was bounded
    // by nothing. The per-command timeout should mean this never fires; it is here
    // because that was true of the session ceiling too, right up until it was not.
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      logger.error("council.timeout", {
        task: spec.id,
        session: state.sessions,
        maxSeconds: this.options.config.limits.maxSessionSeconds,
      });
      deadline.abort();
    }, this.options.config.limits.maxSessionSeconds * 1000);
    timer.unref();

    let results: Awaited<ReturnType<typeof this.runReviewer>>[];
    try {
      results = await Promise.all(
        lenses.map((lens) =>
          this.runReviewer(
            lens,
            worktree,
            sabotageCopy,
            prompt,
            spec,
            toolchain,
            deadline.signal,
          ),
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    const verdict = decide([...dropped, ...results.map((r) => r.verdict)]);
    const usage = results.reduce<UsageTotals>((total, r) => addUsage(total, r.usage), EMPTY_USAGE);
    // Any of them is enough: the reviewers share one account, so one that could not
    // reach the provider is a statement about all of them.
    const outage = results.find((r) => r.outage !== undefined)?.outage;

    logger.info("council.verdict", {
      task: spec.id,
      decision: verdict.decision,
      blockers: verdict.blockers.map((b) => b.lens).join(",") || undefined,
      abstentions: verdict.abstentions.length,
      outage: outage?.kind,
      costUsd: usage.costUsd,
    });

    return { verdict, usage, ...(outage === undefined ? {} : { outage }) };
  }

  /**
   * One reviewer.
   *
   * Never throws. A reviewer that dies is an ABSTENTION carrying the reason, because the
   * alternative — letting one failed session fail the whole council — would make a
   * provider hiccup indistinguishable from a rejected change, and the alternative to
   * THAT, swallowing it as a pass, would merge a change nobody read.
   */
  private async runReviewer(
    lens: Lens,
    worktree: string,
    /** The sabotage reviewer's private copy, when the round has one. */
    sabotageCopy: string | undefined,
    prompt: string,
    spec: TaskSpec,
    toolchain: ResolvedEnv,
    signal?: AbortSignal,
  ): Promise<{
    readonly verdict: ReviewerVerdict;
    readonly usage: UsageTotals;
    readonly outage?: ProviderOutage;
  }> {
    const { llm, config, logger } = this.options;

    const sink: VerdictSink = {};
    // The session's exit reason is read for one thing only — whether the provider was
    // reachable. Everything else about the review comes from the sink, so a reviewer
    // that stopped for its own reasons still speaks through its verdict.
    const control: ControlSink = {};

    // Bounded, exactly as the agent's own shell is (DESIGN.md §6.4). This is not a
    // symmetry nicety — THIS is the shell that wedged. A reviewer ran `npm test`, one
    // subprocess never exited, and it sat in that call for 2h42m holding the task's lease.
    // A reviewer is told the suite has already passed and not to run it again; it ran it
    // anyway, which is the whole argument for the ceiling living here rather than in a
    // prompt.
    try {
      // Everything that differs between the read-only lenses and the sabotage one, decided
      // in one pure place. It throws for a sabotage reviewer with no copy, and inside this
      // `try` that becomes an abstention rather than a council failure.
      const plan = reviewerPlan({
        lensKey: lens.key,
        worktree,
        ...(sabotageCopy === undefined ? {} : { sabotageCopy }),
        maxCommands: config.limits.sabotageMaxCommands,
      });
      const envOptions = {
        cwd: plan.cwd,
        shellPath: toolchain.shell,
        shellEnv: toolchain.env,
        timeoutSeconds: config.limits.commandTimeoutSeconds,
        // The output ceiling too, and for the same reason as the timeout: a reviewer runs
        // the same `npm test` in the same worktree with the same window to spend, and it is
        // this shell that has already demonstrated it will do so (§6.4).
        output: outputCeiling({
          maxLines: config.limits.commandOutputMaxLines,
          maxBytes: config.limits.commandOutputMaxBytes,
        }),
        // Keyed by the TASK, not by `plan.cwd`: the sabotage reviewer works in a private
        // copy that is deleted when the round ends, and a spill written inside it would go
        // with it while the note in the transcript still pointed there.
        overflowDir: join(config.paths.tasks, spec.id, ".caterpillar", "output"),
        logger,
        task: spec.id,
      };
      const execContext: ExecContext = {
        env:
          plan.maxCommands === undefined
            ? new BoundedExecutionEnv(envOptions)
            : new SabotageExecutionEnv({ ...envOptions, maxCommands: plan.maxCommands }),
      };
      // Selected by `plan.toolNames`, in the order the plan lists them, so the tools the
      // plan says a lens gets and the tools it actually holds cannot drift apart — which is
      // what makes testing the plan worth anything.
      const writable = plan.toolNames.includes("write");
      const tools: AgentTool[] = [
        bindTool(createReadTool<ExecContext>(), execContext) as AgentTool,
        bindTool(createBashTool<ExecContext>(), execContext) as AgentTool,
        ...(writable
          ? [
              bindTool(createWriteTool<ExecContext>(), execContext) as AgentTool,
              bindTool(createEditTool<ExecContext>(), execContext) as AgentTool,
            ]
          : []),
        submitVerdictTool(sink, control) as AgentTool,
      ];

      const result = await runSession({
        // A reviewer is a session and gets a session's ceiling. Nothing bounded this
        // before, and the reviewers run concurrently under `Promise.all` — so one
        // request that never returned held the runner, and every other lens with it.
        timeoutSeconds: this.options.config.limits.maxSessionSeconds,
        models: llm.models,
        model: llm.model,
        // `plan.cwd`, not `worktree`: a sabotage reviewer told the shared path would `cd`
        // out of its copy and edit the checkout the other four are reading.
        systemPrompt: `${lens.prompt}\n\nYour working directory is ${plan.cwd}.`,
        initialPrompt: prompt,
        tools,
        budget: new ContextBudget({
          contextWindow: llm.model.contextWindow,
          thresholdFraction: config.handoff.thresholdFraction,
        }),
        control,
        // A reviewer cut off by the council deadline reaches the `sink.decision ===
        // undefined` branch below and is recorded as an ABSTENTION, which is the honest
        // reading: it did not decide. It is deliberately not an outage, so the runner
        // does not back off from a provider that was answering fine.
        ...(signal === undefined ? {} : { signal }),
      });

      if (sink.decision === undefined) {
        // Ran to a stop without deciding: the provider refused, it ran out of context,
        // or it simply narrated a review and never called the tool. Nothing was approved
        // in any of those cases; only the first is worth backing the runner off for.
        const outage = result.outcome.outage;
        logger.warn("council.abstained", {
          task: spec.id,
          lens: lens.key,
          outage: outage?.kind,
          reason: result.outcome.error ?? "no verdict submitted",
        });
        return {
          verdict: abstention(lens, result.outcome.error ?? "the reviewer ended without submitting a verdict"),
          usage: result.outcome.usage,
          ...(outage === undefined ? {} : { outage }),
        };
      }

      return {
        verdict: {
          lens: lens.key,
          title: lens.title,
          decision: sink.decision,
          blocking: sink.blocking ?? false,
          summary: sink.summary ?? "",
          findings: sink.findings ?? [],
        },
        usage: result.outcome.usage,
      };
    } catch (error) {
      // Reachable for a failure OUTSIDE the session — a worktree that would not check
      // out, say. Classified all the same: whatever threw, if the provider is the reason
      // then the next two reviewers and the next task will meet it too.
      const message = error instanceof Error ? error.message : String(error);
      const outage = classifyProviderFailure(message);
      logger.error("council.failed", { task: spec.id, lens: lens.key, ...errorFields(error) });
      return {
        verdict: abstention(lens, message),
        usage: EMPTY_USAGE,
        ...(outage === undefined ? {} : { outage }),
      };
    }
  }
}

const abstention = (lens: Lens, reason: string): ReviewerVerdict => ({
  lens: lens.key,
  title: lens.title,
  // Recorded as `changes` so that a council where EVERY reviewer abstained cannot read
  // as approval further down. `decide` counts abstentions separately regardless.
  decision: "changes",
  blocking: false,
  summary: `Could not complete this review: ${reason}`,
  findings: [],
  abstained: true,
});

/**
 * What every reviewer is told about the change. Identical for all of them — the lenses
 * differ in the system prompt, not in what they are shown, so a finding one makes and
 * another misses is a difference of attention rather than of information.
 */
export const reviewPrompt = (
  spec: TaskSpec,
  state: TaskState,
  base: string | undefined,
  commits: readonly Commit[] = [],
): string => {
  const diff =
    base === undefined
      ? "`git diff $(git merge-base HEAD @{upstream} 2>/dev/null || echo HEAD~1)...HEAD`"
      : `\`git diff ${base}...HEAD\``;

  return [
    `# Review ${spec.id}`,
    "",
    `Branch: \`agent/${spec.id}\` · Sessions: ${state.sessions}`,
    ...(state.pr === undefined ? [] : [`Pull request: ${state.pr.url}`]),
    "",
    "## The change",
    "",
    `The diff under review is ${diff}.`,
    "",
    "## Test-first evidence",
    "",
    // Given to every lens, not only to `tests`. It is the cheapest possible statement of
    // how the change was arrived at, and a correctness reviewer reading "the fix landed
    // three commits before anything tested it" is better informed for it. Only one lens
    // is asked to reach a verdict on it.
    renderEvidence(testFirstEvidence(commits)),
    "",
    "## What the task was asked to do",
    "",
    spec.goal,
    "",
    "## Acceptance criteria (already verified as passing)",
    "",
    ...spec.acceptance.map((command) => `- \`${command}\``),
    "",
    "Review the diff through your lens, then call `submit_verdict`.",
  ].join("\n");
};

/**
 * What every plan reviewer is shown.
 *
 * The plan is rendered in full rather than summarised. It is the entire artefact under
 * review, and a reviewer asked to judge whether a goal stands alone cannot do it from a
 * summary of that goal.
 */
export const planPrompt = (spec: TaskSpec, plan: ProposedPlan): string => {
  const tasks = plan.tasks.flatMap((task) => [
    `### \`${task.localId}\` — ${task.title}`,
    "",
    task.goal.trim(),
    "",
    `- **repos:** ${task.repos.length === 0 ? "(inherits the brainstorm's)" : task.repos.join(", ")}`,
    `- **requires:** ${task.requires.length === 0 ? "(none)" : task.requires.join(", ")}`,
    `- **acceptance:** ${task.acceptance.map((a) => `\`${a}\``).join(", ") || "(none)"}`,
    `- **depends on:** ${task.dependsOn.length === 0 ? "(nothing — may start immediately)" : task.dependsOn.join(", ")}`,
    "",
  ]);

  return [
    `# Review the plan for ${spec.id}`,
    "",
    `Repos in scope: ${spec.repos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
    "",
    "## The idea it came from",
    "",
    spec.goal,
    "",
    `## The plan: ${plan.title}`,
    "",
    plan.summary.trim(),
    "",
    `## The ${plan.tasks.length} proposed task(s)`,
    "",
    ...tasks,
    "Review it through your lens, then call `submit_verdict`.",
  ].join("\n");
};
