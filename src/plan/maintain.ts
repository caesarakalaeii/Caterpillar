/**
 * Keeping a plan honest as it is implemented. See DESIGN.md §14.3.
 *
 * A plan is written before any of it exists, so its dependency edges are a prediction.
 * Implementation is what falsifies them: the task that turned out to need the migration
 * first, the two tasks nobody realised touch the same file. This runs when a task from a
 * plan reaches `done` and asks one question — given what that task actually did, are its
 * siblings' blockers still right?
 *
 * The answer it can give is deliberately narrow: **edges between tasks that already
 * exist**, and nothing else. It cannot create a task, because creating one means writing
 * a goal and acceptance criteria that a human never saw, and that is a brainstorm's job
 * with a council in front of it. When the finished work implies genuinely new work, it
 * says so in a note and a human runs `/brainstorm` — one sentence in Discord rather than
 * a second, unreviewed path into the task queue.
 *
 * Everything it proposes is applied by the SUPERVISOR, under guards it cannot reach: only
 * siblings of the same plan, never a task that has already run, and never a change that
 * introduces a cycle.
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
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { RunnerConfig } from "../config/types.ts";
import { EMPTY_USAGE, type TaskId, type TaskSpec, type TaskState, type UsageTotals } from "../domain/task.ts";
import { ContextBudget } from "../agent/limits.ts";
import { runSession } from "../agent/session.ts";
import type { ControlSink } from "../agent/tools.ts";
import type { LlmRuntime } from "../llm/models.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";

interface ExecContext {
  readonly env: NodeExecutionEnv;
}

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

/** One sibling, as the maintainer is shown it. */
export interface PlanSibling {
  readonly id: TaskId;
  readonly status: string;
  readonly wave: number;
  readonly blockedBy: readonly TaskId[];
  readonly goal: string;
}

export interface PlanRevision {
  /** Full replacement edge sets, by task id. Anything not listed is left alone. */
  readonly updates: readonly { readonly task: string; readonly blockedBy: readonly string[] }[];
  readonly note: string;
}

export interface MaintainResult {
  readonly revision?: PlanRevision;
  readonly usage: UsageTotals;
}

export interface Maintainer {
  revise(
    finished: TaskSpec,
    state: TaskState,
    siblings: readonly PlanSibling[],
  ): Promise<MaintainResult>;
}

const ReviseParams = Type.Object({
  updates: Type.Array(
    Type.Object({
      task: Type.String({ description: "Task id, exactly as listed." }),
      blockedBy: Type.Array(Type.String(), {
        description:
          "The COMPLETE set of task ids that must be done first. This replaces the " +
          "existing set, so include the blockers you are keeping as well as any you add.",
      }),
    }),
    { description: "Only tasks whose blockers should change. Empty when nothing should." },
  ),
  note: Type.String({
    description:
      "What you found and why, in a sentence or two. Say here if the finished work " +
      "implies NEW tasks — you cannot create them, and a human will read this.",
  }),
});

const SYSTEM_PROMPT = `You are checking whether a plan's dependency graph is still correct
after one of its tasks has been completed.

You are not implementing anything and not reviewing the code. You have one question: given
what the finished task actually did, can each remaining task still start when the plan says
it can?

Look for:
- a task that can no longer start where it was scheduled to, because the finished work
  moved, renamed or reshaped something it depended on;
- two tasks that will now edit the same code at the same time, because nothing orders them;
- a blocker that is no longer real, and is holding a task back for nothing. Removing one is
  as valuable as adding one — an over-constrained plan runs strictly sequentially.

Read the finished task's diff and journal before deciding. \`git log\` and \`git diff\` are
available.

You can ONLY change which tasks block which. You cannot create, delete or rewrite a task.
If the finished work implies genuinely new work, say so in your note — a human reads it.

Call \`revise_plan\` exactly once, with an empty \`updates\` list if nothing should change.
That is the common and expected outcome; do not invent a dependency to look useful.`;

export interface PlanMaintainerOptions {
  readonly config: RunnerConfig;
  readonly worktrees: WorktreeManager;
  readonly llm: LlmRuntime;
  readonly logger: Logger;
}

export class PlanMaintainer implements Maintainer {
  private readonly options: PlanMaintainerOptions;

  constructor(options: PlanMaintainerOptions) {
    this.options = options;
  }

  /** Never throws. A maintenance pass that fails leaves the plan exactly as it was. */
  async revise(
    finished: TaskSpec,
    state: TaskState,
    siblings: readonly PlanSibling[],
  ): Promise<MaintainResult> {
    const { worktrees, llm, config, logger } = this.options;

    if (siblings.length === 0) return { usage: EMPTY_USAGE };

    let revision: PlanRevision | undefined;
    const control: ControlSink = {};

    try {
      const checkout = await worktrees.ensureTaskCheckout(finished.repos, finished.id);
      const execContext: ExecContext = { env: new NodeExecutionEnv({ cwd: checkout.root }) };

      const result = await runSession({
        models: llm.models,
        model: llm.model,
        systemPrompt: `${SYSTEM_PROMPT}\n\nYour working directory is ${checkout.root}.`,
        initialPrompt: maintainPrompt(finished, state, siblings),
        tools: [
          bindTool(createReadTool<ExecContext>(), execContext) as AgentTool,
          bindTool(createBashTool<ExecContext>(), execContext) as AgentTool,
          {
            name: "revise_plan",
            label: "Revise plan",
            description:
              "Record which tasks' blockers should change, and end this pass. Call it " +
              "once, with an empty list if nothing should change.",
            parameters: ReviseParams,
            execute: async (_id: string, params: Static<typeof ReviseParams>) => {
              revision = params;
              control.signal = { reason: "done-claimed", summary: params.note };
              return {
                content: [{ type: "text" as const, text: "Recorded." }],
                details: null,
              };
            },
          } as AgentTool,
        ],
        budget: new ContextBudget({
          contextWindow: llm.model.contextWindow,
          thresholdFraction: config.handoff.thresholdFraction,
        }),
        control,
      });

      if (revision === undefined) {
        logger.info("plan.maintain-inconclusive", {
          task: finished.id,
          reason: result.outcome.error ?? "no revision submitted",
        });
      }

      return { ...(revision === undefined ? {} : { revision }), usage: result.outcome.usage };
    } catch (error) {
      logger.warn("plan.maintain-failed", { task: finished.id, ...errorFields(error) });
      return { usage: EMPTY_USAGE };
    }
  }
}

export const maintainPrompt = (
  finished: TaskSpec,
  state: TaskState,
  siblings: readonly PlanSibling[],
): string =>
  [
    `# ${finished.id} is done`,
    "",
    `It took ${state.sessions} session(s) on branch \`agent/${finished.id}\`.`,
    ...(state.pr === undefined ? [] : [`Its pull request: ${state.pr.url}`]),
    "",
    "## What it was asked to do",
    "",
    finished.goal,
    "",
    "## The rest of the plan",
    "",
    ...siblings.flatMap((sibling) => [
      `### \`${sibling.id}\` — ${sibling.status}, wave ${sibling.wave}`,
      `Blocked by: ${sibling.blockedBy.length === 0 ? "(nothing)" : sibling.blockedBy.join(", ")}`,
      "",
      sibling.goal.trim(),
      "",
    ]),
    "Check the finished work, then call `revise_plan`.",
  ].join("\n");
