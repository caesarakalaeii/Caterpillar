/**
 * Supervisor-mediated tools. See DESIGN.md §13.
 *
 * These are the control-plane verbs. They are TOOLS rather than parsed prose so
 * every state transition is typed and auditable, and so the agent can act on the
 * forge and tracker without ever holding a credential.
 *
 * Note what the agent cannot do here:
 *   - it cannot mark a task done, only *claim* completion (`done`), which triggers
 *     independent verification of acceptance criteria and CI (DESIGN.md §12)
 *   - it cannot close a tracker item (DESIGN.md §9.5)
 *   - it cannot push to the state repo (DESIGN.md §9.3)
 *
 * `handoff` is intentionally available to the agent as well as being triggered
 * automatically: an agent that knows it has reached a natural boundary produces a
 * better handoff document than one cut off at an arbitrary token count.
 *
 * The three `cluster_*` reads at the bottom are the same idea applied to the cluster
 * (DESIGN.md §20): supervisor-mediated, so the ServiceAccount token stays here, and bound
 * only for `kind: remediation` — see `toolsForKind`, which is where that is decided and the
 * only place it is decided.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  repoSlug,
  type Capability,
  type ProposedPlan,
  type RepoRef,
  type SessionExitReason,
  type TaskKind,
  type TaskPullRequest,
} from "../domain/task.ts";
import { MAX_OUTPUT_LINES } from "./budget.ts";
import type { ClusterReader } from "../cluster/client.ts";
import { NamespaceNotAllowedError } from "../cluster/guard.ts";
import { DESCRIBABLE_KINDS } from "../cluster/redact.ts";
import type { Forge, PrResult } from "../forge/types.ts";
import type { EffectVerb } from "../state/effects.ts";
import type { Tracker } from "../tracker/types.ts";
import type { TrackerRef } from "../domain/task.ts";

/** Set by a control-plane tool to tell the session loop why it is stopping. */
export interface ControlSignal {
  readonly reason: SessionExitReason;
  readonly summary: string;
  readonly question?: string;
  /**
   * The enumerated choices an `ask_human` question offers, when it is a choice (DESIGN.md §7).
   *
   * Each one becomes a button a human presses instead of retyping it. Capped at
   * `MAX_QUESTION_OPTIONS` by the tool, because a Discord action row holds five buttons.
   */
  readonly questionOptions?: readonly string[];
  readonly requires?: readonly Capability[];
}

/** Mutable sink the tools write their decision into. */
export interface ControlSink {
  signal?: ControlSignal;
  /**
   * Set by `open_pr` so the supervisor can verify CI against them later — one per repo.
   *
   * A list because a task may span several repos and the completion gate has to see all of
   * them; re-opening against a repo already here REPLACES its entry rather than appending, so
   * a session that retries a failed call does not leave the gate two numbers for one repo.
   */
  prs?: TaskPullRequest[];
  /** Set by `submit_plan` on a brainstorm session (DESIGN.md §14.3). */
  plan?: ProposedPlan;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: null });

/**
 * What `publish` did, and what to tell the agent about it.
 *
 * `stored` exists because every refusal here comes back as PROSE rather than a throw — a
 * file too big for §17's cap is a prompt to summarise, and an exception would end the
 * session over something the agent could fix in its next turn. Without the flag the tool
 * cannot tell a refusal from a success, and it recorded the refusal as the effect's result:
 * a replay then handed that refusal back forever and the file could never be stored.
 */
export interface PublishResult {
  readonly stored: boolean;
  /** What the agent is told, in either case. */
  readonly message: string;
}

/**
 * The task's effect record, as a tool may reach it (DESIGN.md §4.4).
 *
 * A narrow pair of callbacks rather than the store, for `publish`'s reason one field down:
 * the record lives in the state repo, which no task credential can reach (§9.3), so it is
 * the SUPERVISOR that reads and writes it. A tool gets exactly "has this already landed"
 * and "note that it has", bound to one task, and cannot name another.
 *
 * `landed` answers a wrapper rather than the result itself because `undefined` is a legal
 * result: a verb whose only outcome is that it happened records `null`, and "not recorded"
 * and "recorded as nothing" must not collapse into one answer.
 */
export interface EffectLedger {
  landed<T>(verb: EffectVerb, args: unknown): Promise<{ readonly result: T } | undefined>;
  record<T>(verb: EffectVerb, args: unknown, result: T): Promise<void>;
}

/**
 * The recorded result of this verb, or nothing — and never a throw.
 *
 * A ledger failure means the state repo could not be read, which says nothing about whether
 * the effect landed. Treating that as "not landed" costs at worst a repeated side effect;
 * treating it as an error would fail a verb over bookkeeping, which is the one outcome that
 * is worse than acting twice.
 */
const alreadyLanded = async <T>(
  effects: EffectLedger | undefined,
  verb: EffectVerb,
  args: unknown,
): Promise<{ readonly result: T } | undefined> => {
  if (effects === undefined) return undefined;
  return effects.landed<T>(verb, args).catch(() => undefined);
};

/** Note that this verb landed. Swallows a ledger failure, for `alreadyLanded`'s reason. */
const noteLanded = async <T>(
  effects: EffectLedger | undefined,
  verb: EffectVerb,
  args: unknown,
  result: T,
): Promise<void> => {
  if (effects === undefined) return;
  await effects.record(verb, args, result).catch(() => undefined);
};

const OpenPrParams = Type.Object({
  title: Type.String({ description: "Pull request title" }),
  body: Type.String({ description: "Pull request description, markdown" }),
  head: Type.String({ description: "Branch containing the work" }),
  base: Type.String({ description: "Branch to merge into" }),
  repo: Type.Optional(
    Type.String({
      description:
        "owner/name of the repo to open it in. One of the task's own repos. " +
        "Omit for the primary repo, which is where your working directory is.",
    }),
  ),
});

/**
 * Options a question may offer, and why the number is this one.
 *
 * A Discord action row holds five buttons and `row` throws above that (`notify/components.ts`),
 * and the free-text Answer button rides in a row of its own — so five is what fits without
 * spilling into a second row of choices, which would read as two questions.
 */
export const MAX_QUESTION_OPTIONS = 5;

const AskHumanParams = Type.Object({
  question: Type.String({
    description: "The question. Be specific and include the options you see.",
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description:
        `The answers to offer as one-press buttons, at most ${MAX_QUESTION_OPTIONS}. Set this ` +
        "whenever the question is genuinely a choice between named alternatives, so the " +
        "human presses one instead of retyping it. Leave it out for anything open-ended — " +
        "prose belongs in `question`, not in a button label.",
    }),
  ),
});

const HandoffParams = Type.Object({
  summary: Type.String({
    description: "What you completed, and precisely what the next session should do first.",
  }),
  requires: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Capabilities the task now needs (e.g. gpu, usb, human-present). Set this " +
        "only when the work cannot continue on the current machine.",
    }),
  ),
});

const DoneParams = Type.Object({
  summary: Type.String({ description: "What was accomplished." }),
});

const TaskNoteParams = Type.Object({
  text: Type.String({ description: "Progress note to append to the tracker item." }),
});

export interface ToolContext {
  readonly forge: Forge;
  readonly tracker?: Tracker;
  readonly trackerRef?: TrackerRef;
  /**
   * Every repo this task spans, primary first (DESIGN.md §9.4.1).
   *
   * A list rather than the primary alone, and that is the fix rather than a generalisation:
   * `open_pr` took `repo` and posted to it unconditionally, so on a task spanning two repos the
   * second half of the work could be committed and pushed and then had nowhere to go. The
   * session's only remaining move was `ask_human`.
   *
   * It is also the SCOPE. `open_pr` refuses a repo that is not in here, for `materialise`'s
   * reason one layer down (§9.1): the argument is agent-authored text, and a tool that opened a
   * pull request against any repo the credential could reach would be a session naming its own
   * blast radius.
   */
  readonly repos: readonly RepoRef[];
  readonly control: ControlSink;
  /**
   * Stores a small artifact and returns what to tell the agent (DESIGN.md §17).
   *
   * A callback rather than the store itself: the tool must not be able to reach any task
   * but its own, and a bound function is the narrowest thing that expresses that.
   */
  readonly publish?: (name: string, path: string, note: string) => Promise<PublishResult>;
  /**
   * This task's effect record, when the supervisor gave the session one (DESIGN.md §4.4).
   *
   * Optional because a context without one must behave exactly as it did before: the CLI
   * verifiers build a `ToolContext` with no state repo behind it, and an idempotency record
   * that becomes a precondition is an outage rather than a safety net.
   */
  readonly effects?: EffectLedger;
  /**
   * Read-only cluster access for a `remediation` session (DESIGN.md §20).
   *
   * Optional, and absent is the ORDINARY case: a runner with no cluster configuration, and
   * every task that is not a remediation, leaves this undefined and `clusterTools` is then
   * simply not constructible. There is no degraded mode in between — a tool that existed
   * and answered "not configured" would invite the model to keep asking.
   */
  readonly cluster?: ClusterReader;
  /**
   * Records one cluster read for metrics (DESIGN.md §11). Optional like `publish`.
   *
   * A callback rather than the registry, for the same reason: the tool needs to count its
   * own calls and nothing else, and `AgentMetrics` is the whole metric set.
   */
  readonly recordClusterRead?: (tool: string, outcome: ClusterReadOutcome, seconds: number) => void;
}

/** `denied` is a refused namespace or kind; `error` is everything the cluster got wrong. */
export type ClusterReadOutcome = "ok" | "denied" | "error";

/**
 * `details` is nullable because a refusal is a RESULT, not a throw.
 *
 * A repo the task does not have is the agent asking for something outside its bound, and §20's
 * cluster tools already answer that class in prose — the model can read it and correct itself
 * inside the same turn. A throw would end the turn with an error it has to interpret, which is
 * what the raw 422 did.
 */
export const openPrTool = (ctx: ToolContext): AgentTool<typeof OpenPrParams, PrResult | null> => ({
  name: "open_pr",
  label: "Open PR",
  description:
    "Open a pull request. You never handle credentials — the supervisor performs " +
    "the call on your behalf. On a task spanning several repos, call it once per repo " +
    "that has work to land, naming each in `repo`.",
  parameters: OpenPrParams,
  execute: async (_id, params: Static<typeof OpenPrParams>) => {
    const repo = resolveTaskRepo(ctx.repos, params.repo);
    // A refusal the agent can act on, not a throw. It names what IS allowed, because the
    // failure this replaces was a raw 422 from a repository the agent had not asked for —
    // twice, on `GH-acme-all-chat-543`, and neither told it what the tool could do.
    if (repo === undefined) {
      return text(
        `\`${params.repo ?? ""}\` is not one of this task's repos. Open pull requests ` +
          `against: ${ctx.repos.map(repoSlug).join(", ")}.`,
      );
    }

    // The forge is asked even when the effect is on record, and that is the CONSTRAINT
    // rather than an oversight (§4.4): a record must never be the authority on its own, and
    // if it says a pull request exists and the forge says otherwise the forge wins. Asking
    // is cheap here because `Forge.openPr` is already idempotent — it adopts the open PR for
    // the branch — so this verb records for the audit trail and skips nothing.
    const pr = await ctx.forge.openPr(repo, params);
    await noteLanded(ctx.effects, "open_pr", params, pr);
    const opened: TaskPullRequest = { ...pr, repo };
    // Replaced rather than appended, keyed on the repo: a session that retries after a failed
    // call must not leave the completion gate two numbers for one repository.
    const existing = ctx.control.prs ?? [];
    ctx.control.prs = [...existing.filter((p) => !sameRepo(p.repo, repo)), opened];

    return {
      content: [
        { type: "text" as const, text: `Opened PR #${pr.number} in ${repoSlug(repo)}: ${pr.url}` },
      ],
      details: pr,
    };
  },
});

/**
 * The repo an `open_pr` call names, or undefined when it names one the task does not have.
 *
 * Matched on `owner/name` and not on the host: `spec.repos` is one workspace, so one forge and
 * one host (§3.1), and requiring the agent to type `github.com/` in front of what every other
 * surface calls `owner/name` is friction with nothing behind it.
 */
const resolveTaskRepo = (
  repos: readonly RepoRef[],
  named: string | undefined,
): RepoRef | undefined => {
  if (named === undefined || named.trim().length === 0) return repos[0];
  const wanted = named.trim().toLowerCase();
  return repos.find(
    (repo) => repoSlug(repo).toLowerCase() === wanted || repo.name.toLowerCase() === wanted,
  );
};

const sameRepo = (a: RepoRef, b: RepoRef): boolean =>
  a.host === b.host && a.owner === b.owner && a.name === b.name;

export const askHumanTool = (ctx: ToolContext): AgentTool<typeof AskHumanParams, null> => ({
  name: "ask_human",
  label: "Ask human",
  description:
    "Ask the operator a question. This ENDS your session: the task parks, the lease " +
    "is released, and a fresh session resumes once the answer arrives. Record " +
    "everything the next session needs in your question. When the question is a choice " +
    `between named alternatives, list them in \`options\` (at most ${MAX_QUESTION_OPTIONS}) ` +
    "so the human answers with one press; keep prose in `question` for everything else.",
  parameters: AskHumanParams,
  execute: async (_id, params: Static<typeof AskHumanParams>) => {
    const options = params.options;
    // A refusal the agent can act on rather than a truncation, for `open_pr`'s reason: the
    // sixth option cannot be rendered at all, and dropping it silently would take a choice
    // away from the human without either of us knowing which one.
    if (options !== undefined && options.length > MAX_QUESTION_OPTIONS) {
      return text(
        `A question offers at most ${MAX_QUESTION_OPTIONS} options and this one offered ` +
          `${options.length}. Narrow them down, or ask for prose instead.`,
      );
    }
    // The signal is set whether or not this is a replay. It lives in memory and the record
    // does not, so a resumed session that already asked must still STOP — one that recorded
    // the verb and then declined to signal would keep running with nothing left to do.
    //
    // So the record here is write-only: nothing reads it back, and it is kept for the audit
    // trail — which verbs a session actually reached, when the transcript is gone. The
    // tracker comment and the `needs-human` label are made idempotent separately, by
    // `mirrorTransition`'s own `tracker.question` record (§9.5); it does not consult this
    // one.
    ctx.control.signal = {
      reason: "ask-human",
      summary: `asked: ${params.question}`,
      question: params.question,
      ...(options === undefined || options.length === 0 ? {} : { questionOptions: options }),
    };
    await noteLanded(ctx.effects, "ask_human", params, null);
    return text("Question recorded. The session will now end and the task will park.");
  },
});

export const handoffTool = (ctx: ToolContext): AgentTool<typeof HandoffParams, null> => ({
  name: "handoff",
  label: "Hand off",
  description:
    "End this session and hand the task to a fresh one. Use when you have reached a " +
    "natural boundary, or when the work needs a machine with different capabilities.",
  parameters: HandoffParams,
  execute: async (_id, params: Static<typeof HandoffParams>) => {
    const requires = params.requires as readonly Capability[] | undefined;
    ctx.control.signal = {
      reason: requires !== undefined && requires.length > 0 ? "blocked" : "handoff",
      summary: params.summary,
      ...(requires !== undefined && requires.length > 0 ? { requires } : {}),
    };
    await noteLanded(ctx.effects, "handoff", params, null);
    return text("Handoff recorded. Write anything else the next session needs first.");
  },
});

export const doneTool = (ctx: ToolContext): AgentTool<typeof DoneParams, null> => ({
  name: "done",
  label: "Claim done",
  description:
    "Claim the task is complete. The supervisor then independently runs the " +
    "acceptance criteria and checks CI. If either fails the task comes back to you, " +
    "so do not claim completion speculatively.",
  parameters: DoneParams,
  execute: async (_id, params: Static<typeof DoneParams>) => {
    ctx.control.signal = { reason: "done-claimed", summary: params.summary };
    await noteLanded(ctx.effects, "done", params, null);
    return text("Completion claimed. The supervisor will now verify it.");
  },
});

export const taskNoteTool = (ctx: ToolContext): AgentTool<typeof TaskNoteParams, null> => ({
  name: "task_note",
  label: "Tracker note",
  description:
    "Append a progress note to the tracker item. Cannot change status — completion " +
    "is determined by verification, not by you.",
  parameters: TaskNoteParams,
  execute: async (_id, params: Static<typeof TaskNoteParams>) => {
    const { tracker, trackerRef } = ctx;
    if (tracker === undefined || trackerRef === undefined) {
      return text("No tracker is configured for this task; note not recorded.");
    }

    // A comment IS the side effect, and a duplicate one is permanent: the tracker item is
    // what a human reads, and two identical notes on it are indistinguishable from an agent
    // that has lost track of what it has said. So this verb skips on a replay, unlike
    // `open_pr` — there is no equivalent of "ask the forge" for a comment.
    const landed = await alreadyLanded(ctx.effects, "task_note", params);
    if (landed !== undefined) {
      return text("That note is already on the tracker item; nothing was posted again.");
    }

    await tracker.comment(trackerRef, params.text);
    await noteLanded(ctx.effects, "task_note", params, null);
    return text("Note added to the tracker item.");
  },
});

const SubmitPlanParams = Type.Object({
  title: Type.String({ description: "Short name for the whole plan." }),
  summary: Type.String({
    description: "What the plan does and why this shape. A few paragraphs, not an essay.",
  }),
  tasks: Type.Array(
    Type.Object({
      localId: Type.String({
        description: "Short id, unique within this plan, e.g. `schema`. Referenced by dependsOn.",
      }),
      title: Type.String({ description: "One line." }),
      goal: Type.String({
        description:
          "Everything the implementing agent needs. It will NOT see this conversation — " +
          "only this text, so name files, commands and constraints explicitly.",
      }),
      repos: Type.Array(Type.String(), {
        description: "`owner/name` or `host/owner/name`. Empty inherits this brainstorm's repos.",
      }),
      requires: Type.Array(Type.String(), {
        description: "Capabilities (linux, k8s, net, gpu, usb, human-present). Usually empty.",
      }),
      acceptance: Type.Array(Type.String(), {
        description:
          "Commands that must exit 0. REQUIRED — a task with none can never be verified " +
          "as done, and the plan is refused.",
      }),
      dependsOn: Type.Array(Type.String(), {
        description:
          "localIds that must be DONE before this can start. List only real ordering " +
          "constraints: everything unlisted may run in parallel with everything else.",
      }),
    }),
    { description: "The decomposition. Each becomes its own task with its own agent." },
  ),
});

export const submitPlanTool = (ctx: ToolContext): AgentTool<typeof SubmitPlanParams, null> => ({
  name: "submit_plan",
  label: "Submit plan",
  description:
    "Propose the plan and END this session. The review council reads it and either " +
    "sends it back with changes or cuts it into real tasks. You cannot create tasks " +
    "yourself, and nothing is created until the council passes it.",
  parameters: SubmitPlanParams,
  execute: async (_id, params: Static<typeof SubmitPlanParams>) => {
    ctx.control.plan = params;
    ctx.control.signal = {
      reason: "plan-proposed",
      summary: `proposed ${params.tasks.length} task(s): ${params.title}`,
    };
    await noteLanded(ctx.effects, "submit_plan", params, null);
    return text("Plan recorded. The session will end and the review council will read it.");
  },
});

const PublishArtifactParams = Type.Object({
  name: Type.String({
    description:
      "File name to store it under, e.g. `sublevel-scan.json`. Letters, digits, dot, " +
      "dash and underscore only — no directories.",
  }),
  path: Type.String({
    description: "Path to the file, relative to your working directory.",
  }),
  note: Type.String({
    description: "One line on what it is and why the next task will want it.",
  }),
});

/**
 * Hand a small derived output to the tasks that come after this one (DESIGN.md §17).
 *
 * Supervisor-mediated for the same reason `open_pr` is: the agent cannot write the state
 * repo (§9.3), and this writes into it. The cap is deliberately tight and the tool says
 * so in its own description, because the useful reaction to hitting it is to summarise —
 * which is nearly always what the next task actually needed.
 */
export const publishArtifactTool = (
  ctx: ToolContext,
): AgentTool<typeof PublishArtifactParams, null> => ({
  name: "publish_artifact",
  label: "Publish artifact",
  description:
    "Store a small file where the tasks that depend on THIS one will find it — a " +
    "manifest, a scan result, a golden file. Max 1 MiB and 10 per task: it is carried " +
    "in the state repo that every runner clones, so summarise rather than dumping. Only " +
    "tasks that declare this one as a blocker receive it.",
  parameters: PublishArtifactParams,
  execute: async (_id, params: Static<typeof PublishArtifactParams>) => {
    const publish = ctx.publish;
    if (publish === undefined) {
      return text("Artifacts are not available for this task; nothing was stored.");
    }

    // Skipped on a replay, and the reason is the CAP rather than the write: a task may hold
    // ten artifacts (§17), and a replayed publish of a file the agent has since deleted from
    // its worktree would fail the verb over work that already landed.
    const landed = await alreadyLanded<string>(ctx.effects, "publish_artifact", params);
    if (landed !== undefined) return text(landed.result);

    const result = await publish(params.name, params.path, params.note);
    // Only a stored artifact is an effect. A refusal has to stay retryable, or the agent
    // that summarises the file it was told to summarise is handed the old refusal again.
    if (result.stored) {
      await noteLanded(ctx.effects, "publish_artifact", params, result.message);
    }
    return text(result.message);
  },
});

/** All control-plane tools for an implementation session. */
export const controlTools = (ctx: ToolContext): readonly AgentTool[] => [
  openPrTool(ctx) as AgentTool,
  askHumanTool(ctx) as AgentTool,
  handoffTool(ctx) as AgentTool,
  doneTool(ctx) as AgentTool,
  taskNoteTool(ctx) as AgentTool,
  publishArtifactTool(ctx) as AgentTool,
];

const ClusterLogsParams = Type.Object({
  namespace: Type.String({
    description: "Namespace to read. Only the operator's allowlisted namespaces are reachable.",
  }),
  pod: Type.Optional(
    Type.String({
      description:
        "Pod name, or a prefix with a trailing `.*` to cover a replica set's changing " +
        "suffix (e.g. `caterpillar-7d9f-.*`). Omit for the whole namespace. No other " +
        "pattern syntax is accepted.",
    }),
  ),
  sinceMinutes: Type.Optional(
    Type.Number({ description: "How far back to look. Default 30, maximum 1440 (24h)." }),
  ),
  limit: Type.Optional(
    Type.Number({
      // Derived from the constant rather than written out, so raising the general output
      // ceiling cannot leave this sentence claiming the old one (§6.4). An operator who
      // LOWERS it in config is not reflected here — the client clamps regardless, and the
      // description is a schema built once per process rather than per session.
      description: `Maximum lines returned. Default 200, maximum ${MAX_OUTPUT_LINES}.`,
    }),
  ),
});

const ClusterEventsParams = Type.Object({
  namespace: Type.String({
    description: "Namespace to read. Only the operator's allowlisted namespaces are reachable.",
  }),
  involvedObject: Type.Optional(
    Type.String({
      description:
        "Narrow to one object: `name`, or `Kind/name` (e.g. `Pod/caterpillar-0`). " +
        "Omit for every event in the namespace.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum events returned, newest first. Default 50, maximum 200." }),
  ),
});

const ClusterDescribeParams = Type.Object({
  kind: Type.String({
    description: `One of: ${DESCRIBABLE_KINDS.join(", ")}. No other kind can be read.`,
  }),
  name: Type.String({ description: "Object name, exact." }),
  namespace: Type.String({
    description: "Namespace to read. Only the operator's allowlisted namespaces are reachable.",
  }),
});

/**
 * Wrap one cluster read: time it, label its outcome, and turn a refusal into text.
 *
 * A denied namespace or an unreadable kind comes back as a normal tool RESULT rather than a
 * thrown error, because it is not a fault the session can fix by retrying and it is not a
 * fault at all from the supervisor's side. The message says which namespaces exist so the
 * next call can be right, and the counter says a denial happened so an operator can see
 * that their allowlist is the thing standing in the way.
 */
const clusterRead = async (
  ctx: ToolContext,
  tool: string,
  read: (cluster: ClusterReader) => Promise<string>,
) => {
  const cluster = ctx.cluster;
  // Unreachable: the tools are only constructed when a reader exists. Checked because the
  // alternative is a crash inside a session over a field TypeScript already made optional.
  if (cluster === undefined) return text("Cluster reads are not available for this task.");

  const started = Date.now();
  const finish = (outcome: ClusterReadOutcome): void => {
    ctx.recordClusterRead?.(tool, outcome, (Date.now() - started) / 1000);
  };

  try {
    const body = await read(cluster);
    finish("ok");
    return text(body);
  } catch (error) {
    // A namespace refusal and a validation refusal are both the agent asking for something
    // outside the bound, and both are answerable in prose. An HTTP failure is not: it means
    // the supervisor could not read what it was allowed to read, and the message is the
    // only place that distinction is visible.
    //
    // A 403 from the API server therefore counts as `error`, not `denied`. It is the same
    // word from a human's point of view and a different problem: `denied` is this runner's
    // allowlist, which an operator fixes in the ConfigMap, and a 403 is a missing Role,
    // which they fix in the deployment. Collapsing them would send them to the wrong file.
    const denied = error instanceof NamespaceNotAllowedError || isRefusal(error);
    finish(denied ? "denied" : "error");
    const detail = error instanceof Error ? error.message : String(error);
    return text(denied ? `Refused: ${detail}` : `The read failed: ${detail}`);
  }
};

/** Names of the typed refusals the cluster modules raise for input they will not accept. */
const isRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "InvalidNameError" || error.name === "UnsupportedKindError");

/**
 * Read-only cluster access for a remediation session (DESIGN.md §20).
 *
 * Bound ONLY for `kind: remediation`, in `runner.ts`. The point of these being tools rather
 * than `kubectl` in the agent's shell is that the ServiceAccount token stays with the
 * supervisor: were it the pod's ambient credential, every task that ever ran on this runner
 * would inherit cluster read access and the bound would be whatever the model chose to type
 * (§9.2).
 *
 * Each description says four things, because what the description does not say the model
 * does not know: that the tool is read-only, that the supervisor performs the call, that
 * only allowlisted namespaces are reachable, and — for `describe` — that a Secret's values
 * are never returned, so asking for them is a wasted turn.
 */
export const clusterLogsTool = (ctx: ToolContext): AgentTool<typeof ClusterLogsParams, null> => ({
  name: "cluster_logs",
  label: "Cluster logs",
  description:
    "READ-ONLY. Fetch container logs from Loki for a namespace, optionally one pod. The " +
    "supervisor performs the query and you never hold a credential; only the operator's " +
    "allowlisted namespaces are reachable, and nothing here can change the cluster. " +
    "Returns `timestamp  pod  line`, oldest first.",
  parameters: ClusterLogsParams,
  execute: async (_id, params: Static<typeof ClusterLogsParams>) =>
    clusterRead(ctx, "cluster_logs", (cluster) =>
      cluster.logs({
        namespace: params.namespace,
        ...(params.pod === undefined ? {} : { pod: params.pod }),
        ...(params.sinceMinutes === undefined ? {} : { sinceMinutes: params.sinceMinutes }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    ),
});

export const clusterEventsTool = (ctx: ToolContext): AgentTool<typeof ClusterEventsParams, null> => ({
  name: "cluster_events",
  label: "Cluster events",
  description:
    "READ-ONLY. List Kubernetes events in a namespace, newest first — the fastest way to " +
    "see scheduling failures, image pull errors, probe failures and OOM kills. The " +
    "supervisor performs the call and only the operator's allowlisted namespaces are " +
    "reachable. Kubernetes expires events after about an hour, so an empty result usually " +
    "means nothing happened recently rather than nothing happened.",
  parameters: ClusterEventsParams,
  execute: async (_id, params: Static<typeof ClusterEventsParams>) =>
    clusterRead(ctx, "cluster_events", (cluster) =>
      cluster.events({
        namespace: params.namespace,
        ...(params.involvedObject === undefined ? {} : { involvedObject: params.involvedObject }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    ),
});

export const clusterDescribeTool = (
  ctx: ToolContext,
): AgentTool<typeof ClusterDescribeParams, null> => ({
  name: "cluster_describe",
  label: "Cluster describe",
  description:
    "READ-ONLY. Fetch one Kubernetes object as YAML, with `spec` and `status` intact. The " +
    "supervisor performs the call and only the operator's allowlisted namespaces are " +
    `reachable. Kinds: ${DESCRIBABLE_KINDS.join(", ")}. A Secret comes back as key names ` +
    "and byte lengths only — the values are never returned to you, by any phrasing, so " +
    "asking for them is a wasted turn. ConfigMaps are returned in full.",
  parameters: ClusterDescribeParams,
  execute: async (_id, params: Static<typeof ClusterDescribeParams>) =>
    clusterRead(ctx, "cluster_describe", (cluster) =>
      cluster.describe({
        kind: params.kind,
        name: params.name,
        namespace: params.namespace,
      }),
    ),
});

/** The three cluster reads. Constructible only where `ctx.cluster` is present. */
export const clusterTools = (ctx: ToolContext): readonly AgentTool[] => [
  clusterLogsTool(ctx) as AgentTool,
  clusterEventsTool(ctx) as AgentTool,
  clusterDescribeTool(ctx) as AgentTool,
];

/**
 * Tools for a REMEDIATION session (DESIGN.md §20).
 *
 * A strict superset of `controlTools`: a remediation task is a writing kind, it ends in a
 * pull request, and §12 applies to it unchanged — so it needs every control verb an
 * `implement` task has, plus the evidence it was created to read. Nothing is taken away,
 * and in particular there is no cluster WRITE of any kind: the cluster is evidence, not a
 * workspace.
 */
export const remediationTools = (ctx: ToolContext): readonly AgentTool[] => [
  ...controlTools(ctx),
  ...clusterTools(ctx),
];

/**
 * Control-plane tools for a BRAINSTORM session (DESIGN.md §14.3).
 *
 * Deliberately not a superset. There is no `open_pr` and no `done`: a brainstorm does not
 * touch the code and cannot claim completion, because its gate is the council's verdict
 * on the plan rather than §12's acceptance commands. `ask_human` is the load-bearing one —
 * it is how refinement actually happens, one question at a time, in the thread.
 */
export const brainstormTools = (ctx: ToolContext): readonly AgentTool[] => [
  askHumanTool(ctx) as AgentTool,
  handoffTool(ctx) as AgentTool,
  submitPlanTool(ctx) as AgentTool,
];

/**
 * The control-plane bundle for a task KIND. One expression, one place to read.
 *
 * Exported and pure so the binding itself is testable: "an `implement` task never receives
 * the cluster tools" is the security property of §20, and a property enforced inline in
 * `runner.ts` could only be checked by running a whole session. `runner.ts` calls this and
 * decides nothing else.
 *
 * The cluster reads are gated on the KIND and on the reader both. A runner with a configured
 * reader still gives an `implement` or `brainstorm` task nothing — `ctx.cluster` is never
 * populated for them — and a remediation task on a runner with no cluster configuration gets
 * the ordinary control verbs rather than a crash.
 */
export const toolsForKind = (
  // Optional because `TaskSpec.kind` is: a spec that names no kind is an `implement` task,
  // and the default has to fall on the side with no cluster access.
  kind: TaskKind | undefined,
  ctx: ToolContext,
): readonly AgentTool[] => {
  if (kind === "brainstorm") return brainstormTools(ctx);
  if (kind === "remediation" && ctx.cluster !== undefined) return remediationTools(ctx);
  return controlTools(ctx);
};
