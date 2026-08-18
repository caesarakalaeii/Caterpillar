/**
 * The reviewer's only control-plane verb. See DESIGN.md §12.1 and §13.
 *
 * A reviewer gets `read` and `bash` and this. It has no `write`, no `edit`, and none of
 * the implementation agent's control tools: it cannot open a PR, cannot claim done,
 * cannot ask a human, and cannot hand off. Its entire output is one call to
 * `submit_verdict`, which is what makes a review auditable — the verdict is a typed
 * record rather than prose the supervisor has to interpret.
 *
 * `bash` is present because reviewing means reading `git diff` and `git log`. It is the
 * same trust level as the implementation session it is reviewing, in the same worktree —
 * this is not a sandbox boundary and is not pretending to be one. What it is is a tool
 * surface that cannot accidentally commit.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ControlSink } from "../agent/tools.ts";
import type { Decision, Finding } from "./decide.ts";

/** Mutable sink the verdict tool writes into, mirroring `agent/tools.ts`'s ControlSink. */
export interface VerdictSink {
  decision?: Decision;
  blocking?: boolean;
  summary?: string;
  findings?: readonly Finding[];
}

const VerdictParams = Type.Object({
  decision: Type.Union([Type.Literal("pass"), Type.Literal("changes")], {
    description: "`pass` if nothing here should stop this merging, `changes` otherwise.",
  }),
  blocking: Type.Boolean({
    description:
      "True only if this must NOT merge as it stands. A blocking objection costs the " +
      "task another full session, so a preference or a nit is false.",
  }),
  summary: Type.String({
    description: "Your verdict in a few sentences. This is what the next session reads first.",
  }),
  findings: Type.Array(
    Type.Object({
      where: Type.String({ description: "file:line, or the closest you can point to." }),
      what: Type.String({ description: "What is wrong, and what would be right." }),
    }),
    { description: "Specific findings. Empty when you are passing with nothing to say." },
  ),
});

export const submitVerdictTool = (
  sink: VerdictSink,
  /**
   * Stop signal, shared with the session loop.
   *
   * Its `reason` is never read: the council discards the `SessionOutcome` entirely and
   * takes its answer from the sink. Setting it exists only to reuse
   * `shouldStopAfterTurn`, so a reviewer that has submitted its verdict stops there
   * rather than carrying on reading the repository at cost.
   */
  control: ControlSink,
): AgentTool<typeof VerdictParams, null> => ({
  name: "submit_verdict",
  label: "Submit verdict",
  description:
    "Record your review and END it. Call this exactly once, as the last thing you do. " +
    "A review that ends without it is recorded as an abstention, which is not an approval.",
  parameters: VerdictParams,
  execute: async (_id, params: Static<typeof VerdictParams>) => {
    sink.decision = params.decision;
    sink.blocking = params.blocking;
    sink.summary = params.summary;
    sink.findings = params.findings;
    control.signal = { reason: "done-claimed", summary: params.summary };

    return {
      content: [{ type: "text" as const, text: "Verdict recorded. Your review is complete." }],
      details: null,
    };
  },
});
