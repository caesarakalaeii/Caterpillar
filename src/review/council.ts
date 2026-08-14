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
import { addUsage, EMPTY_USAGE, type TaskSpec, type TaskState, type UsageTotals } from "../domain/task.ts";
import { ContextBudget } from "../agent/limits.ts";
import { runSession } from "../agent/session.ts";
import type { ControlSink } from "../agent/tools.ts";
import type { LlmRuntime } from "../llm/models.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { decide, type CouncilVerdict, type ReviewerVerdict } from "./decide.ts";
import { PR_LENSES, type Lens } from "./lenses.ts";
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
}

export interface Council {
  review(spec: TaskSpec, state: TaskState): Promise<CouncilResult>;
}

export interface ReviewCouncilOptions {
  readonly config: RunnerConfig;
  readonly worktrees: WorktreeManager;
  readonly llm: LlmRuntime;
  readonly logger: Logger;
  /** Overridable so a future plan council can supply its own (DESIGN.md §12.1). */
  readonly lenses?: readonly Lens[];
}

export class ReviewCouncil implements Council {
  private readonly options: ReviewCouncilOptions;

  constructor(options: ReviewCouncilOptions) {
    this.options = options;
  }

  async review(spec: TaskSpec, state: TaskState): Promise<CouncilResult> {
    const { worktrees, logger } = this.options;
    const lenses = this.options.lenses ?? PR_LENSES;

    const checkout = await worktrees.ensureTaskCheckout(spec.repos, spec.id);
    const worktree = checkout.root;
    const base = await worktrees.branchPoint(worktree);

    const prompt = reviewPrompt(spec, state, base);

    logger.info("council.start", {
      task: spec.id,
      session: state.sessions,
      lenses: lenses.map((l) => l.key).join(","),
      base: base ?? "(unknown)",
    });

    const results = await Promise.all(
      lenses.map((lens) => this.runReviewer(lens, worktree, prompt, spec)),
    );

    const verdict = decide(results.map((r) => r.verdict));
    const usage = results.reduce<UsageTotals>((total, r) => addUsage(total, r.usage), EMPTY_USAGE);

    logger.info("council.verdict", {
      task: spec.id,
      decision: verdict.decision,
      blockers: verdict.blockers.map((b) => b.lens).join(",") || undefined,
      abstentions: verdict.abstentions.length,
      costUsd: usage.costUsd,
    });

    return { verdict, usage };
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
  ): Promise<{ readonly verdict: ReviewerVerdict; readonly usage: UsageTotals }> {
    const { llm, config, logger } = this.options;

    const sink: VerdictSink = {};
    // The session's own exit reason is discarded — the council reads the sink, not the
    // outcome. This exists only to reuse `shouldStopAfterTurn`, so a reviewer that has
    // submitted its verdict stops immediately instead of continuing to read the repo.
    const control: ControlSink = {};

    const execContext: ExecContext = { env: new NodeExecutionEnv({ cwd: worktree }) };
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
        // Ran to a stop without deciding: out of context, or it simply narrated a review
        // and never called the tool. Either way nothing was approved.
        logger.warn("council.abstained", {
          task: spec.id,
          lens: lens.key,
          reason: result.outcome.error ?? "no verdict submitted",
        });
        return {
          verdict: abstention(lens, result.outcome.error ?? "the reviewer ended without submitting a verdict"),
          usage: result.outcome.usage,
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
      logger.error("council.failed", { task: spec.id, lens: lens.key, ...errorFields(error) });
      return {
        verdict: abstention(lens, error instanceof Error ? error.message : String(error)),
        usage: EMPTY_USAGE,
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
