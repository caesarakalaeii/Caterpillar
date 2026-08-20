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
import type { TaskKind, TaskSpec, TaskState } from "../domain/task.ts";

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
  \`open_pr\`. Do not attempt to authenticate to anything yourself.

Attribution:

- **You are Caterpillar.** That is the only name that belongs on anything you write.
  Not the model you are, not the vendor that trained it, not the harness you resemble.
- **Never sign your work.** No \`Co-Authored-By\` trailer, no "Generated with", no
  "Created by", no 🤖, no tool or model name — in commit messages, pull request titles
  and bodies, review comments, issue comments, journal entries, code comments, or
  documentation. A commit message ends at its last line of substance.
- This is not modesty. The identity the fleet commits as is configured by the operator
  and is already stamped on every commit; a second name in the message body contradicts
  it, and the history then carries two authors for one actor.
- If a template or an existing file asks you for one anyway, leave it out.
- **Never invent a git identity.** Yours is already configured, in every checkout and in
  your shell, and it wins over anything you pass. An email address is not a label — a
  forge resolves it to an ACCOUNT, and \`caterpillar@users.noreply.github.com\` belongs to
  a stranger, not to this project.`;

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

/**
 * The remediation system prompt (DESIGN.md §20).
 *
 * The same job as an implementation task — it writes code, it opens a pull request, §12
 * grades it — so this is `SYSTEM_PROMPT` plus the three things that are true only of a
 * task an alert created, each of which the session gets wrong by default:
 *
 *   The cluster is EVIDENCE, not a workspace. A model told an alert is firing reaches for
 *   `kubectl rollout restart` within a turn or two, because that is what fixes an alert
 *   in the world it learned from. Saying it cannot is cheaper than discovering it tried.
 *
 *   A manual-only fix is a real answer. The alternative is a session that invents a code
 *   change because it was asked for one, which is the worst possible outcome here: a
 *   plausible patch attached to a real incident that nobody has diagnosed.
 *
 *   The alert is a symptom and the task is the cause. Silencing the alert is not the
 *   work.
 */
export const REMEDIATION_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

This task was created by a FIRING ALERT rather than by a human writing an issue. Three
things follow from that, and they are not negotiable:

- **You must not change the cluster.** Not a restart, not a scale, not an edit, not a
  delete, not a silence in Alertmanager. Anything you can see of the cluster is read-only
  evidence, gathered for you, and there is no path from this session to a write. If the
  only fix is an operational one, say so — do not go looking for a way to apply it.
- **A fix that is not code is a legitimate outcome.** Plenty of alerts are configuration,
  capacity, a dependency that is down, or a threshold that is wrong. If that is what you
  find, write up the diagnosis and call \`ask_human\` with it, or \`handoff\` if a
  different machine is needed. Do NOT invent a code change to have something to open a
  pull request with: a plausible patch on a real incident is worse than no patch, because
  it looks like the incident was handled.
- **The alert is the symptom.** Fix what made it fire. Widening a threshold, deleting the
  assertion, or making the check no longer run are all ways of making the alert stop
  without making anything better, and the review council reads for exactly that.

If you do change code, everything else is unchanged: the supervisor runs the acceptance
criteria, the pull request and CI are the other half of the gate, and \`done\` is still
only a claim.`;

/** The system prompt for a task of this kind. `implement` is the default and the base. */
export const systemPromptFor = (kind: TaskKind | undefined): string => {
  switch (kind) {
    case "brainstorm":
      return BRAINSTORM_SYSTEM_PROMPT;
    case "remediation":
      return REMEDIATION_SYSTEM_PROMPT;
    default:
      return SYSTEM_PROMPT;
  }
};

const section = (title: string, body: string | undefined): string =>
  body === undefined || body.trim().length === 0 ? "" : `\n## ${title}\n\n${body.trim()}\n`;

/** Build the opening user message for a session. */
export const buildPrompt = (parts: PromptParts): string => {
  const { spec, state } = parts;
  const brainstorm = spec.kind === "brainstorm";
  const remediation = spec.kind === "remediation";

  const header = [
    `# ${brainstorm ? "Brainstorm" : remediation ? "Alert" : "Task"} ${spec.id}`,
    "",
    `Workspace: ${spec.workspace}`,
    `Session: ${state.sessions + 1}`,
    `Phase: ${state.phase}`,
    `Repos in scope: ${spec.repos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
    "",
    brainstorm ? "## The idea" : remediation ? "## The alert" : "## Goal",
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
    : remediation && first
      ? // Said explicitly on the first session because the default move on an alert is to
        // start patching, and the diagnosis is the part that is worth anything: a fix
        // written before the cause is understood is a guess with a pull request attached.
        "\nThis is the first session. Diagnose before you change anything: establish what " +
        "is actually failing and why, from the evidence and the code, and only then decide " +
        "whether there is a code change to make.\n"
      : first
        ? "\nThis is the first session. Start by orienting yourself in the repo, then begin.\n"
        : "\nContinue from the handoff above. Verify its assumptions before trusting them.\n";

  return `${header}\n${body}${closing}`;
};
