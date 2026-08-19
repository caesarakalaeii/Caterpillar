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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import type { ClusterReader } from "../cluster/client.ts";
import { stateRepoRef, workspaceScopeOf } from "../config/scope.ts";
import type { RunnerConfig } from "../config/types.ts";
import type { CredentialService } from "../credential/service.ts";
import { repoSlug } from "../domain/task.ts";
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
import type { Logger } from "../obs/log.ts";
import type { LiveSession } from "../obs/live.ts";
import { BoundedExecutionEnv } from "./exec.ts";
import type { StateStore } from "../state/store.ts";
import type { Tracker } from "../tracker/types.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import type { ToolchainResolver } from "../workspace/toolchain.ts";
import { journalBudgetChars, journalForPrompt } from "./journal.ts";
import { ContextBudget } from "./limits.ts";
import { buildPrompt, systemPromptFor } from "./prompt.ts";
import { runSession } from "./session.ts";
import type { SteeringFeed } from "./steering.ts";
import { toolsForKind, type ControlSink, type ToolContext } from "./tools.ts";

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
  readonly toolchain: ToolchainResolver;
  /**
   * Required, unlike `live`: the only evidence a command was cut off for running too long
   * is the line this emits (DESIGN.md §6.4). A silent default would make the hang
   * detector and a genuinely failing test indistinguishable, which is the state this was
   * built to get out of.
   */
  readonly logger: Logger;
  /**
   * Where the in-flight session is published for the web view (DESIGN.md §18). Optional:
   * a runner with no web view has nothing to publish to, and the session runs identically
   * either way.
   */
  readonly live?: LiveSession;
  /**
   * Read-only cluster access, offered to `remediation` sessions only (DESIGN.md §20).
   *
   * Optional, and absent is the ordinary case — a runner outside the cluster, or one whose
   * operator has not turned `cluster.enabled` on, has nothing to hand over. A remediation
   * task then runs with the ordinary bundle: it does not crash, and it does not quietly
   * acquire privileges either.
   */
  readonly cluster?: ClusterReader;
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

  async run(
    spec: TaskSpec,
    state: TaskState,
    signal?: AbortSignal,
    steering?: SteeringFeed,
  ): Promise<SessionOutcome> {
    const { credentials, worktrees, store, llm, metrics, live } = this.options;

    const forgeFactory = this.options.bindings.forges.get(spec.workspace);
    if (forgeFactory === undefined) throw new WorkspaceNotConfiguredError(spec.workspace);

    const repo = spec.repos[0];
    if (repo === undefined) throw new Error(`task ${spec.id} declares no repos`);

    const profile = this.options.config.workspaces.get(spec.workspace);
    if (profile === undefined) throw new WorkspaceNotConfiguredError(spec.workspace);

    const forge = await forgeFactory.forTask(spec);
    // Keyed by THIS task and handed back as a lease. Nothing here names another task's
    // credential, and nothing here can revoke one: the pairing is this `activate` and the
    // `lease.close()` in the `finally` below, and the two cannot drift apart (§9.2).
    const lease = await credentials.activate(spec.id, {
      forge,
      repos: spec.repos,
      scope: workspaceScopeOf(profile, stateRepoRef(this.options.config.stateRepo)),
    });

    try {
      // repos[0] is the workspace repo and becomes cwd; the rest land under repos/.
      const checkout = await worktrees.ensureTaskCheckout(spec.repos, spec.id);
      const worktree = checkout.root;
      const recoveryNote = await this.recoverInterrupted(worktree);

      const control: ControlSink = {};
      const tracker = this.options.bindings.trackers.get(spec.workspace);
      // The cluster reader is offered to the tool context for a REMEDIATION task and no
      // other kind (§20). By kind, not by capability and not by config alone: a runner with
      // `k8s` in its capabilities and a configured reader still gives an `implement` task no
      // way to read the cluster, because the binding is decided here and nowhere else.
      const cluster = spec.kind === "remediation" ? this.options.cluster : undefined;
      const toolContext: ToolContext = {
        forge,
        // Every repo, primary first — `open_pr` needs to reach the siblings and needs to refuse
        // anything else (§9.4.1). The credential activated above already covers exactly this
        // list, so the tool's bound and the token's bound are the same list by construction.
        repos: spec.repos,
        control,
        publish: (name, path, note) => this.publishArtifact(spec, worktree, name, path, note),
        ...(tracker !== undefined ? { tracker } : {}),
        ...(spec.tracker !== undefined ? { trackerRef: spec.tracker } : {}),
        ...(cluster === undefined
          ? {}
          : {
              cluster,
              recordClusterRead: (tool, outcome, seconds) => {
                const labels = { tool, outcome };
                metrics.clusterReads.inc(labels);
                metrics.clusterReadSeconds.inc(labels, seconds);
              },
            }),
      };

      // The agent's shell, the review council's, the plan maintainer's and the acceptance
      // gate's all come from here. Resolved once per session rather than per command:
      // wrapping each command would put quoting between the model and its own shell.
      const toolchain = await this.options.toolchain.resolve(spec, worktree);
      const execContext: ExecContext = {
        // Bounded, not bare. pi's bash tool leaves the timeout to the model and defaults
        // to none, so this is where a command that never returns stops being able to hold
        // the lease for hours (DESIGN.md §6.4). It covers all four spawn sites for the
        // same reason the toolchain does — they resolve through here.
        env: new BoundedExecutionEnv({
          cwd: worktree,
          shellPath: toolchain.shell,
          shellEnv: toolchain.env,
          timeoutSeconds: this.options.config.limits.commandTimeoutSeconds,
          logger: this.options.logger,
          task: spec.id,
        }),
      };
      // A brainstorm reads and asks; it does not write. Withholding `write` and `edit`
      // is not a sandbox — `bash` is still there and a determined session could use it —
      // but it is the difference between a tool the model reaches for by habit and one
      // it has to decide to misuse.
      //
      // This tests for `brainstorm` rather than for "not implement" on purpose:
      // `remediation` is a WRITING kind (§20) and must fall in with `implement`, getting
      // `write`, `edit` and the full control verbs — an alert-driven task that could not
      // edit a file or call `open_pr` would be a session with nowhere to put its fix.
      const brainstorm = spec.kind === "brainstorm";
      const tools: AgentTool[] = [
        bindTool(createReadTool<ExecContext>(), execContext) as AgentTool,
        ...(brainstorm
          ? []
          : [
              bindTool(createWriteTool<ExecContext>(), execContext) as AgentTool,
              bindTool(createEditTool<ExecContext>(), execContext) as AgentTool,
            ]),
        bindTool(createBashTool<ExecContext>(), execContext) as AgentTool,
        // Which control verbs a kind gets is decided in `tools.ts`, so the binding can be
        // tested without running a session (§20).
        ...toolsForKind(spec.kind, toolContext),
      ];

      const budget = new ContextBudget({
        contextWindow: llm.model.contextWindow,
        thresholdFraction: this.options.config.handoff.thresholdFraction,
      });

      const prompt = buildPrompt({
        spec,
        state,
        ...(await this.promptContext(spec, recoveryNote)),
        ...(await this.stagedSection(spec, state)),
      });

      // The last line is not decoration. `open_pr` defaults to the primary repo, so an agent
      // that does not know a sibling PR is a thing it can ask for will finish the work, push the
      // branch, and then have nowhere to put it — which is what `GH-caesarakalaeii-all-chat-543`
      // did before the tool grew a `repo` argument, and it cost a park and a hand-opened PR.
      const layout =
        checkout.siblings.size === 0
          ? ""
          : `\n\nSibling repositories are checked out inside it:\n${[...checkout.siblings]
              .map(([slug, path]) => `- ${slug} → ${path}`)
              .join("\n")}\nEach is its own git repository on branch agent/${spec.id}. Commit and ` +
            `push in each one that you change, and call \`open_pr\` once per repo — pass ` +
            `\`repo\` to open one anywhere but ${repoSlug(repo)}. Completion checks CI in every ` +
            `repo you opened a pull request in, so a repo you changed and did not open one for ` +
            `will not merge.`;

      // Said out loud, because a model that does not know its environment was prepared
      // reaches for `apt install` or `pip install --user` the moment something is missing,
      // and both fail slowly inside the container. It also names WHERE the environment
      // came from, so the fix for a missing tool lands in the right file.
      const environment =
        toolchain.source === "inherited"
          ? ""
          : `\n\nYour shell already has the dev environment from ${toolchain.source}. Do not install toolchains yourself — if something is missing, add it there.`;

      // The resolver only speaks up when it has something the agent cannot see for itself
      // — today, that its branch predates the repo's nix expression. Said in the system
      // prompt rather than logged, because the log is not where the agent is looking when
      // its tools turn out to be missing.
      const environmentNote =
        toolchain.note === undefined ? "" : `\n\n${toolchain.note}`;

      // The session is announced BEFORE the first request, not after the first message:
      // model resolution and the opening request can take a while, and a runner that has
      // started work must not read as idle for any of it.
      live?.begin({
        task: spec.id,
        session: state.sessions + 1,
        model: llm.model.id,
        startedAt: new Date().toISOString(),
      });

      const result = await runSession({
        // Also armed by the supervisor around this whole call (`maxSessionSeconds`).
        // Both, deliberately: the outer one covers the worktree setup and the prompt
        // assembly either side of this, the inner one is what makes an unbounded
        // session impossible to write at all.
        timeoutSeconds: this.options.config.limits.maxSessionSeconds,
        models: llm.models,
        model: llm.model,
        systemPrompt: `${systemPromptFor(spec.kind)}\n\nYour working directory is ${worktree}.${layout}${environment}${environmentNote}`,
        initialPrompt: prompt,
        tools,
        budget,
        control,
        ...(signal === undefined ? {} : { signal }),
        ...(steering === undefined ? {} : { steering }),
        ...(live === undefined ? {} : { onMessage: (message) => live.record(message) }),
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

      // Only the pull requests are lifted off the sink here. A proposed plan is not, because
      // unlike a PR it is not consumed by a later gate — `buildOutcome` carries it directly.
      //
      // BOTH shapes are returned. `prs` is what the completion gate and the merge read, and
      // `pr` is the PRIMARY repo's — the one field every display reader already reads, and the
      // one a state written by an older deploy has. Deriving the primary here rather than
      // trusting call order means a session that opened the sibling's PR first still records
      // the right one.
      const prs = control.prs ?? [];
      const primary = prs.find(
        (opened) => opened.repo.owner === repo.owner && opened.repo.name === repo.name,
      );
      return {
        ...result.outcome,
        ...(prs.length > 0 ? { prs } : {}),
        ...(primary !== undefined ? { pr: { number: primary.number, url: primary.url } } : {}),
      };
    } finally {
      // Cleared on every exit, including a throw: the transcript is on disk by now, and a
      // live view that outlived its session would show the last thing that ran as the
      // thing running.
      live?.end();
      await lease.close().catch(() => undefined);
      await forge.revoke().catch(() => undefined);
    }
  }

  /**
   * Store one artifact for this task (DESIGN.md §17).
   *
   * Every refusal comes back as TEXT the agent can act on rather than as a thrown error:
   * a file that is too big is a prompt to summarise, and an exception here would end the
   * session over something the agent could have fixed in its next turn.
   *
   * The path is resolved inside the worktree and checked, because it is model-authored.
   */
  private async publishArtifact(
    spec: TaskSpec,
    worktree: string,
    name: string,
    path: string,
    note: string,
  ): Promise<string> {
    const resolved = resolve(worktree, path);
    if (!resolved.startsWith(`${resolve(worktree)}/`)) {
      return `\`${path}\` is outside your working directory; nothing was stored.`;
    }

    let contents: Buffer;
    try {
      contents = await readFile(resolved);
    } catch {
      return `Could not read \`${path}\`; nothing was stored.`;
    }

    try {
      await this.options.store.writeArtifact(spec.id, name, contents);
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}. Nothing was stored — summarise it instead.`;
    }

    await this.options.store.appendJournal(
      spec.id,
      // Attributed to the session that produced it, which is the one about to be written.
      0,
      `**Artifact:** \`${name}\` (${contents.byteLength} bytes) — ${note}`,
    );
    return `Stored \`${name}\` (${contents.byteLength} bytes). Tasks that declare this one as a blocker will find it in their artifacts directory.`;
  }

  /**
   * Stage upstream artifacts where the agent can read them (DESIGN.md §17).
   *
   * Upstream means `blockedBy` — a task's declared blockers ARE the tasks whose output it
   * waits on, so the dependency graph a plan already carries decides artifact flow. There
   * is deliberately no second notion of "which task feeds which" to keep in step with it.
   *
   * Staged OUTSIDE the repo checkout: dropping files into the worktree would put them in
   * `git status`, and the first agent to run `git add -A` would commit another task's
   * output into a pull request.
   */
  private async stageArtifacts(spec: TaskSpec, state: TaskState): Promise<string | undefined> {
    const { store } = this.options;
    const upstream = state.plan?.blockedBy ?? [];
    if (upstream.length === 0) return undefined;

    const root = join(this.options.config.paths.tasks, spec.id, "artifacts-in");
    const lines: string[] = [];

    for (const producer of upstream) {
      for (const name of await store.listArtifacts(producer)) {
        const contents = await store.readArtifact(producer, name);
        if (contents === undefined) continue;
        const dir = join(root, producer);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), contents);
        lines.push(`- \`${join(dir, name)}\` — from ${producer}`);
      }
    }

    return lines.length === 0
      ? undefined
      : ["Tasks you depend on left these for you:", "", ...lines].join("\n");
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

  private async stagedSection(
    spec: TaskSpec,
    state: TaskState,
  ): Promise<{ readonly artifacts?: string }> {
    const staged = await this.stageArtifacts(spec, state).catch(() => undefined);
    return staged === undefined ? {} : { artifacts: staged };
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
    const { store, llm } = this.options;
    // The whole history, shards and legacy file alike: the journal is the source of
    // truth on resume (§4.1), so a resumed session must not see only the entries that
    // happen to be in one format.
    const raw = await store.readJournal(spec.id);
    // The FILE keeps every entry (invariant 5); the PROMPT gets a bounded view of it.
    // Unbounded, a long task pays for its whole history at the start of every session —
    // SMOKE-1's journal reached 347KB, nearly all of it one repeated park entry.
    const journal =
      raw === undefined
        ? undefined
        : journalForPrompt(raw, journalBudgetChars(llm.model.contextWindow));
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
