/**
 * Session prompt assembly. See DESIGN.md §6.
 *
 * A fresh session's entire understanding comes from three files. The order matters:
 * the immutable goal first, then what has already happened, then what to do next —
 * so the most actionable content sits closest to the model's most recent attention.
 *
 * The transcript is NOT replayed. The journal is the source of truth on resume,
 * which is what makes crash recovery cheap and keeps a handoff bounded.
 */
import type { TaskSpec, TaskState } from "../domain/task.ts";

export interface PromptParts {
  readonly spec: TaskSpec;
  readonly state: TaskState;
  readonly journal?: string;
  readonly handoff?: string;
  /** Answer to a question this task parked on, if it was just unparked. */
  readonly answer?: string;
  /** Note about an interrupted previous session, if recovering. */
  readonly recoveryNote?: string;
}

export const SYSTEM_PROMPT = `You are a long-running autonomous coding agent.

You work on ONE task across MANY sessions. Your context window is finite and smaller
than the task, so you will be handed off to a fresh session before you fill it. That is
normal and expected, not a failure.

Because of this, the durable record is what matters, not your memory:

- Write down what you learn as you learn it, via the journal summary you provide when
  handing off. A discovery you do not record is a discovery the next session must
  repeat.
- Prefer many small commits over one large one. Uncommitted work is lost work.
- When you reach a natural boundary, call \`handoff\` with a summary that tells the next
  session precisely what to do first. Be concrete: file paths, command names, the exact
  next step.

Control-plane rules:

- \`done\` CLAIMS completion; it does not grant it. The supervisor independently runs the
  acceptance criteria and checks CI. Do not claim completion speculatively — a false
  claim costs a full session round-trip.
- \`ask_human\` ends your session and parks the task. Use it when you genuinely cannot
  proceed, and put everything the operator needs in the question.
- If work needs a machine you are not on (GPU, hardware, a human present), call
  \`handoff\` with \`requires\`.
- You have no credentials. Pushes work through a credential helper and PRs through
  \`open_pr\`. Do not attempt to authenticate to anything yourself.`;

const section = (title: string, body: string | undefined): string =>
  body === undefined || body.trim().length === 0 ? "" : `\n## ${title}\n\n${body.trim()}\n`;

/** Build the opening user message for a session. */
export const buildPrompt = (parts: PromptParts): string => {
  const { spec, state } = parts;

  const header = [
    `# Task ${spec.id}`,
    "",
    `Workspace: ${spec.workspace}`,
    `Session: ${state.sessions + 1}`,
    `Phase: ${state.phase}`,
    `Repos in scope: ${spec.repos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
    "",
    "## Goal",
    "",
    spec.goal,
    "",
    "## Acceptance criteria",
    "",
    "These are run by the supervisor, not by you. All must exit 0 before the task is done:",
    "",
    ...spec.acceptance.map((command) => `- \`${command}\``),
  ].join("\n");

  const body = [
    section("Recovery note", parts.recoveryNote),
    section("Answer from the operator", parts.answer),
    section("Journal so far", parts.journal),
    section("Handoff from the previous session", parts.handoff),
  ].join("");

  const closing =
    parts.handoff === undefined && parts.journal === undefined
      ? "\nThis is the first session. Start by orienting yourself in the repo, then begin.\n"
      : "\nContinue from the handoff above. Verify its assumptions before trusting them.\n";

  return `${header}\n${body}${closing}`;
};
