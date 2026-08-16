/**
 * The review council. See DESIGN.md §12.1.
 *
 * Runs AFTER the §12 gates, never instead of them. By the time this is reached the
 * supervisor has already established, independently of any agent, that the acceptance
 * commands exit 0 and that CI is green. The council is the third gate, and the only one
 * that reads the change rather than its outcome.
 *
 * Three reviewers run CONCURRENTLY in the task's existing worktree. They share it, which
 * is safe because none of them can write: the tool surface is `read`, `bash` and
 * `submit_verdict`, with no `write`, no `edit`, and none of the implementation agent's
 * control verbs. A reviewer cannot open a PR, cannot claim completion, and cannot hand
 * off; its whole output is one typed verdict.
 *
 * Nothing here decides anything. It gathers three verdicts and hands them to `decide`,
 * which is pure and is where the rule actually lives.
 */
import {
  createBashTool,
  createReadTool,
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
import type { ResolvedEnv, ToolchainResolver } from "../workspace/toolchain.ts";
import { decide, type CouncilVerdict, type ReviewerVerdict } from "./decide.ts";
import { PLAN_LENSES, PR_LENSES, type Lens } from "./lenses.ts";
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

export interface CouncilResult {
  readonly verdict: CouncilVerdict;
  /** Tokens and cost the council itself spent. Added to the task's totals. */
  readonly usage: UsageTotals;
  /**
   * Set when a reviewer abstained because the PROVIDER stopped answering (§6.3).
   *
   * Carried out rather than folded into the verdict because it is not a review outcome
   * at all: the supervisor must back off and convene again later, not record that the
   * council had reservations. A verdict written from three unreachable reviewers would
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
}

export class ReviewCouncil implements Council {
  private readonly options: ReviewCouncilOptions;

  constructor(options: ReviewCouncilOptions) {
    this.options = options;
  }

  async review(spec: TaskSpec, state: TaskState): Promise<CouncilResult> {
    const checkout = await this.options.worktrees.ensureTaskCheckout(spec.repos, spec.id);
    const base = await this.options.worktrees.branchPoint(checkout.root);

    return this.convene(
      this.options.lenses ?? PR_LENSES,
      checkout.root,
      reviewPrompt(spec, state, base),
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
    const { logger } = this.options;

    logger.info("council.start", {
      task: spec.id,
      session: state.sessions,
      lenses: lenses.map((l) => l.key).join(","),
    });

    // Resolved once and shared by all three reviewers. They read the same worktree, so
    // three resolves would be three identical answers — and a reviewer judging the code
    // in a different environment from the one that produced it is the failure this
    // module exists to prevent (see `workspace/toolchain.ts`).
    const toolchain = await this.options.toolchain.resolve(spec, worktree);

    const results = await Promise.all(
      lenses.map((lens) => this.runReviewer(lens, worktree, prompt, spec, toolchain)),
    );

    const verdict = decide(results.map((r) => r.verdict));
    const usage = results.reduce<UsageTotals>((total, r) => addUsage(total, r.usage), EMPTY_USAGE);
    // Any of them is enough: the three reviewers share one account, so one that could
    // not reach the provider is a statement about all three.
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
    prompt: string,
    spec: TaskSpec,
    toolchain: ResolvedEnv,
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

    const execContext: ExecContext = {
      env: new NodeExecutionEnv({
        cwd: worktree,
        shellPath: toolchain.shell,
        shellEnv: toolchain.env,
      }),
    };
    const tools: AgentTool[] = [
      bindTool(createReadTool<ExecContext>(), execContext) as AgentTool,
      bindTool(createBashTool<ExecContext>(), execContext) as AgentTool,
      submitVerdictTool(sink, control) as AgentTool,
    ];

    try {
      const result = await runSession({
        models: llm.models,
        model: llm.model,
        systemPrompt: `${lens.prompt}\n\nYour working directory is ${worktree}.`,
        initialPrompt: prompt,
        tools,
        budget: new ContextBudget({
          contextWindow: llm.model.contextWindow,
          thresholdFraction: config.handoff.thresholdFraction,
        }),
        control,
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
 * What every reviewer is told about the change. Identical for all three — the lenses
 * differ in the system prompt, not in what they are shown, so a finding one makes and
 * another misses is a difference of attention rather than of information.
 */
export const reviewPrompt = (
  spec: TaskSpec,
  state: TaskState,
  base: string | undefined,
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
