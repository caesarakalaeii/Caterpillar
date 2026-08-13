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
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Capability, RepoRef, SessionExitReason } from "../domain/task.ts";
import type { Forge, PrResult } from "../forge/types.ts";
import type { Tracker } from "../tracker/types.ts";
import type { TrackerRef } from "../domain/task.ts";

/** Set by a control-plane tool to tell the session loop why it is stopping. */
export interface ControlSignal {
  readonly reason: SessionExitReason;
  readonly summary: string;
  readonly question?: string;
  readonly requires?: readonly Capability[];
}

/** Mutable sink the tools write their decision into. */
export interface ControlSink {
  signal?: ControlSignal;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: null });

const OpenPrParams = Type.Object({
  title: Type.String({ description: "Pull request title" }),
  body: Type.String({ description: "Pull request description, markdown" }),
  head: Type.String({ description: "Branch containing the work" }),
  base: Type.String({ description: "Branch to merge into" }),
});

const AskHumanParams = Type.Object({
  question: Type.String({
    description: "The question. Be specific and include the options you see.",
  }),
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
  /** Repo PRs are opened against — always the task's primary repo. */
  readonly repo: RepoRef;
  readonly control: ControlSink;
}

export const openPrTool = (ctx: ToolContext): AgentTool<typeof OpenPrParams, PrResult> => ({
  name: "open_pr",
  label: "Open PR",
  description:
    "Open a pull request. You never handle credentials — the supervisor performs " +
    "the call on your behalf.",
  parameters: OpenPrParams,
  execute: async (_id, params: Static<typeof OpenPrParams>) => {
    const pr = await ctx.forge.openPr(ctx.repo, params);
    return {
      content: [{ type: "text" as const, text: `Opened PR #${pr.number}: ${pr.url}` }],
      details: pr,
    };
  },
});

export const askHumanTool = (ctx: ToolContext): AgentTool<typeof AskHumanParams, null> => ({
  name: "ask_human",
  label: "Ask human",
  description:
    "Ask the operator a question. This ENDS your session: the task parks, the lease " +
    "is released, and a fresh session resumes once the answer arrives. Record " +
    "everything the next session needs in your question.",
  parameters: AskHumanParams,
  execute: async (_id, params: Static<typeof AskHumanParams>) => {
    ctx.control.signal = {
      reason: "ask-human",
      summary: `asked: ${params.question}`,
      question: params.question,
    };
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
    await tracker.comment(trackerRef, params.text);
    return text("Note added to the tracker item.");
  },
});

/** All control-plane tools for a session. */
export const controlTools = (ctx: ToolContext): readonly AgentTool[] => [
  openPrTool(ctx) as AgentTool,
  askHumanTool(ctx) as AgentTool,
  handoffTool(ctx) as AgentTool,
  doneTool(ctx) as AgentTool,
  taskNoteTool(ctx) as AgentTool,
];
