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
  /** Files left by the tasks this one is blocked by (DESIGN.md §17). */
  readonly artifacts?: string;
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

/**
 * The brainstorm system prompt (DESIGN.md §14.3).
 *
 * A different job from implementing, so a different prompt rather than a paragraph
 * bolted onto the one above. Two things about it are load-bearing:
 *
 *   It asks ONE question at a time. Each `ask_human` parks the task and releases the
 *   lease, so a question costs nothing while a human thinks — but a wall of six questions
 *   gets one answer that addresses two of them.
 *
 *   The goals it writes are read by agents that never saw this conversation. That is the
 *   single most common way a plan produces useless tasks, so it is said plainly.
 */
export const BRAINSTORM_SYSTEM_PROMPT = `You are refining a rough idea into a plan that
other autonomous agents will implement.

You are NOT writing code. Do not edit files, do not commit, do not open a pull request.
Read the repository as much as you need — that is what makes a plan concrete rather than
plausible — but your only output is the plan.

How to work:

- Read first. A plan that names real files, real commands and real conventions is worth
  ten that describe an ideal codebase.
- Then ask. Use \`ask_human\` for anything that would change the shape of the plan: an
  ambiguous requirement, a choice between approaches, a constraint you cannot infer.
  ONE question at a time — each one parks the task until it is answered, which costs
  nothing while someone thinks, and a list of six questions gets one answer covering two.
- Do not ask what you can find out. A question whose answer is in the repository is a
  round trip you spent instead of reading.
- When the shape is settled, call \`submit_plan\`.

Writing the tasks:

- Each task gets its own agent, its own session, and its own pull request. Size them so
  one is a coherent piece of work — not "change one line", not "implement the feature".
- **The agent implementing a task will never see this conversation.** It gets the goal
  you write and nothing else. Name the files, the commands, the constraints and the
  reason, every time, even when it feels repetitive.
- Every task needs \`acceptance\`: commands that must exit 0. A task without them can
  never be verified as done and the plan will be refused.
- \`dependsOn\` is for REAL ordering constraints only — where one task cannot start until
  another has landed. Everything you do not list may run at the same time, on different
  machines. Over-declaring dependencies turns a plan into a queue.

The plan goes to a review council before anything is created. It may come back with
changes; that is ordinary, and you will be told exactly what to fix.`;

const section = (title: string, body: string | undefined): string =>
  body === undefined || body.trim().length === 0 ? "" : `\n## ${title}\n\n${body.trim()}\n`;

/** Build the opening user message for a session. */
export const buildPrompt = (parts: PromptParts): string => {
  const { spec, state } = parts;
  const brainstorm = spec.kind === "brainstorm";

  const header = [
    `# ${brainstorm ? "Brainstorm" : "Task"} ${spec.id}`,
    "",
    `Workspace: ${spec.workspace}`,
    `Session: ${state.sessions + 1}`,
    `Phase: ${state.phase}`,
    `Repos in scope: ${spec.repos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
    "",
    brainstorm ? "## The idea" : "## Goal",
    "",
    spec.goal,
    ...(brainstorm
      ? []
      : [
          "",
          "## Acceptance criteria",
          "",
          "These are run by the supervisor, not by you. All must exit 0 before the task is done:",
          "",
          ...spec.acceptance.map((command) => `- \`${command}\``),
        ]),
  ].join("\n");

  const body = [
    section("Recovery note", parts.recoveryNote),
    section("Artifacts from upstream tasks", parts.artifacts),
    section("Answer from the operator", parts.answer),
    section("Journal so far", parts.journal),
    section("Handoff from the previous session", parts.handoff),
  ].join("");

  const first = parts.handoff === undefined && parts.journal === undefined;
  const closing = brainstorm
    ? first
      ? "\nStart by reading enough of the repository to make this concrete. Then ask your first question.\n"
      : "\nContinue refining. When the shape is settled, call `submit_plan`.\n"
    : first
      ? "\nThis is the first session. Start by orienting yourself in the repo, then begin.\n"
      : "\nContinue from the handoff above. Verify its assumptions before trusting them.\n";

  return `${header}\n${body}${closing}`;
};
