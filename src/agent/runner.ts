/**
 * SessionRunner — assembles and runs one agent session. See DESIGN.md §6.
 *
 * Everything a session needs is built here and torn down here: the forge credential
 * is activated for exactly the duration of the session, the worktree is prepared, and
 * the transcript is persisted even when the session fails.
 *
 * This class holds NO task state. It returns a SessionOutcome and lets the supervisor
 * decide what that means, so a crash here cannot leave state half-written.
 */
import { gzipSync as _gzipSync } from "node:zlib";
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
import type { CredentialService } from "../credential/service.ts";
import type {
  RepoRef,
  SessionOutcome,
  TaskSpec,
  TaskState,
  WorkspaceName,
} from "../domain/task.ts";
import type { ForgeFactory } from "../forge/types.ts";
import type { LlmRuntime } from "../llm/models.ts";
import type { AgentMetrics } from "../metrics/registry.ts";
import type { StateStore } from "../state/store.ts";
import type { Tracker } from "../tracker/types.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import { ContextBudget } from "./limits.ts";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import { runSession } from "./session.ts";
import { controlTools, type ControlSink, type ToolContext } from "./tools.ts";

void _gzipSync;

/** Context the built-in pi tools require. */
interface ExecContext {
  readonly env: NodeExecutionEnv;
}

/**
 * Bind a harness tool's context so it satisfies the plain `AgentTool` shape the base
 * `Agent` consumes. pi's built-ins take context as a trailing execute() argument; the
 * base agent does not supply one, so we close over it here.
 */
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

export interface WorkspaceBindings {
  readonly forges: ReadonlyMap<WorkspaceName, ForgeFactory>;
  readonly trackers: ReadonlyMap<WorkspaceName, Tracker>;
}

export interface AgentSessionRunnerOptions {
  readonly config: RunnerConfig;
  readonly store: StateStore;
  readonly worktrees: WorktreeManager;
  readonly credentials: CredentialService;
  readonly llm: LlmRuntime;
  readonly bindings: WorkspaceBindings;
  readonly metrics: AgentMetrics;
}

export class WorkspaceNotConfiguredError extends Error {
  constructor(workspace: WorkspaceName) {
    super(`no forge is configured for workspace '${workspace}'`);
    this.name = "WorkspaceNotConfiguredError";
  }
}

export class AgentSessionRunner {
  private readonly options: AgentSessionRunnerOptions;

  constructor(options: AgentSessionRunnerOptions) {
    this.options = options;
  }

  async run(spec: TaskSpec, state: TaskState): Promise<SessionOutcome> {
    const { credentials, worktrees, store, llm, metrics } = this.options;

    const forgeFactory = this.options.bindings.forges.get(spec.workspace);
    if (forgeFactory === undefined) throw new WorkspaceNotConfiguredError(spec.workspace);

    const repo = spec.repos[0];
    if (repo === undefined) throw new Error(`task ${spec.id} declares no repos`);

    const forge = await forgeFactory.forTask(spec);
    credentials.setActive({ forge, repos: spec.repos });

    try {
      // repos[0] is the workspace repo and becomes cwd; the rest land under repos/.
      const checkout = await worktrees.ensureTaskCheckout(spec.repos, spec.id);
      const worktree = checkout.root;
      const recoveryNote = await this.recoverInterrupted(worktree);

      const control: ControlSink = {};
      const tracker = this.options.bindings.trackers.get(spec.workspace);
      const toolContext: ToolContext = {
        forge,
        repo,
        control,
        ...(tracker !== undefined ? { tracker } : {}),
        ...(spec.tracker !== undefined ? { trackerRef: spec.tracker } : {}),
      };

      const execContext: ExecContext = { env: new NodeExecutionEnv({ cwd: worktree }) };
      const tools: AgentTool[] = [
        bindTool(createReadTool<ExecContext>(), execContext) as AgentTool,
        bindTool(createWriteTool<ExecContext>(), execContext) as AgentTool,
        bindTool(createEditTool<ExecContext>(), execContext) as AgentTool,
        bindTool(createBashTool<ExecContext>(), execContext) as AgentTool,
        ...controlTools(toolContext),
      ];

      const budget = new ContextBudget({
        contextWindow: llm.model.contextWindow,
        thresholdFraction: this.options.config.handoff.thresholdFraction,
      });

      const prompt = buildPrompt({
        spec,
        state,
        ...(await this.promptContext(spec, recoveryNote)),
      });

      const layout =
        checkout.siblings.size === 0
          ? ""
          : `\n\nSibling repositories are checked out inside it:\n${[...checkout.siblings]
              .map(([slug, path]) => `- ${slug} → ${path}`)
              .join("\n")}\nEach is its own git repository on branch agent/${spec.id}.`;

      const result = await runSession({
        models: llm.models,
        model: llm.model,
        systemPrompt: `${SYSTEM_PROMPT}\n\nYour working directory is ${worktree}.${layout}`,
        initialPrompt: prompt,
        tools,
        budget,
        control,
      });

      await store.writeSessionTranscript(
        spec.id,
        state.sessions + 1,
        result.messages.map((message) => JSON.stringify(message)).join("\n"),
      );

      if (result.contextOverrun) {
        // The handoff threshold fired too late; the next request risked a
        // context-length error. Alerted on — see DESIGN.md §6.1.
        metrics.contextOverruns.inc({ task: spec.id });
      }

      const pr = control.pr;
      return {
        ...result.outcome,
        ...(pr !== undefined ? { pr: { number: pr.number, url: pr.url } } : {}),
      };
    } finally {
      credentials.clearActive();
      await forge.revoke().catch(() => undefined);
    }
  }

  /**
   * Commit anything a crashed session left behind. See DESIGN.md §6.2.
   *
   * Uncommitted work is preserved rather than discarded — the previous session may
   * have died mid-edit, and throwing that away silently would make a pod restart
   * lossy in exactly the way this design promises it is not.
   */
  private async recoverInterrupted(worktree: string): Promise<string | undefined> {
    const git = this.options.worktrees.gitAt(worktree);
    if (!(await git.hasUncommittedChanges())) return undefined;

    await git.run("add", "-A");
    await git.run("commit", "-m", "wip: recovered from interrupted session");

    return (
      "The previous session was interrupted before it could finish. Its uncommitted " +
      "changes have been committed as `wip: recovered from interrupted session`. " +
      "Review that commit before continuing — it may be incomplete."
    );
  }

  /** Journal, handoff and any operator answer that unparked this task. */
  private async promptContext(
    spec: TaskSpec,
    recoveryNote: string | undefined,
  ): Promise<{
    readonly journal?: string;
    readonly handoff?: string;
    readonly answer?: string;
    readonly recoveryNote?: string;
  }> {
    const { store } = this.options;
    const journal = await store.readIfPresent(spec.id, "journal.md");
    const handoff = await store.readIfPresent(spec.id, "handoff.md");
    const answer = await store.latestAnswer(spec.id);

    return {
      ...(journal !== undefined ? { journal } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...(recoveryNote !== undefined ? { recoveryNote } : {}),
    };
  }
}

export type { RepoRef };
