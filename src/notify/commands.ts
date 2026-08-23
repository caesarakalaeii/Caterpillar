/**
 * Parsing the inbound half of the Discord channel. See DESIGN.md §7.
 *
 * Pure: a string in, a decision out. Everything that can go wrong with a human typing
 * into a chat box is decided here, where it can be tested without a socket, a token, or
 * a Discord account.
 *
 * `Command` is the shared vocabulary of every inbound path — a typed `!answer`, a slash
 * command, a button click, a modal submission. They converge here so the supervisor has
 * one handler rather than one per transport, and so a new transport cannot quietly grow
 * its own semantics.
 *
 * The TEXT surface stays deliberately small: `!answer` and nothing else. It exists as
 * the fallback for a client that cannot render components, and every other verb is a
 * slash command (`src/notify/slash.ts`), where Discord does the parsing and validation.
 *
 * `!task` (§14 path 3) is still not implemented — a spec with no machine-checkable
 * acceptance criteria can never satisfy §12, and `!task <repo> <goal>` as written in the
 * design has nowhere to put them. `/brainstorm` is the answer to that, and it produces
 * acceptance criteria by refining them with a human first.
 */
import { asTaskId, isTaskId, type TaskId, type TaskStatus } from "../domain/task.ts";

export type Command =
  | { readonly kind: "answer"; readonly task: TaskId; readonly text: string }
  /**
   * One of the choices the open question offered, pressed as a button (DESIGN.md §7).
   *
   * Carries the option's INDEX, because that is all a `custom_id` has room for once the
   * task id is in it. The supervisor resolves it against the options stored beside the
   * question and answers with the text the agent wrote.
   */
  | { readonly kind: "answer-option"; readonly task: TaskId; readonly option: number }
  /** List tasks, optionally filtered. Served from the snapshot, never from git. */
  | { readonly kind: "list"; readonly status?: TaskStatus; readonly page?: number }
  | { readonly kind: "show"; readonly task: TaskId }
  /** Stop working a task and leave it parked for a human. */
  | { readonly kind: "park"; readonly task: TaskId }
  /** Put a parked task back in the queue. The inverse of `park`. */
  | { readonly kind: "resume"; readonly task: TaskId }
  /** Approve and merge a task's PR despite the council (DESIGN.md §12.1). */
  | { readonly kind: "merge"; readonly task: TaskId }
  /**
   * Mark a task `done` by hand, with both §12 gates bypassed — `/done`.
   *
   * Not a variant of `merge`: nothing is merged and no PR need exist, because the case it
   * serves is a task that is OBSOLETE rather than finished. `reason` is required for that
   * same reason — the only thing standing between this and an unauditable `done` is a
   * human saying why.
   */
  | { readonly kind: "force-done"; readonly task: TaskId; readonly reason: string }
  /**
   * Open a refinement conversation (DESIGN.md §14.3).
   *
   * Carries no task id: it CREATES one, in a thread that does not exist until the bridge
   * has opened it. That is why it is the one command the bridge does IO for before the
   * loop ever sees it.
   *
   * `repos` is a list because a brainstorm may span several repos in ONE workspace
   * (§9.4.1, §14.3) — the plan children then inherit the whole list. Crossing workspaces
   * is refused by the loop.
   */
  | { readonly kind: "brainstorm"; readonly topic: string; readonly repos: readonly string[] }
  /** Recognised prefix, unusable content — worth replying to rather than ignoring. */
  | { readonly kind: "malformed"; readonly reason: string };

export const HELP = "Usage: `!answer <task-id> <your answer>` — or use `/answer`.";

/**
 * Decide what a chat message asks for, if anything.
 *
 * Returns undefined for "not for us", which is the overwhelmingly common case: this
 * runs on every message in the channel, including the supervisor's own notifications.
 */
export const parseCommand = (content: string, thread?: TaskId): Command | undefined => {
  const trimmed = content.trim();

  /**
   * In a task's own thread there is no command language: the conversation IS the answer.
   *
   * Requiring `!answer` here was wrong twice over. It is friction in the one place the
   * whole point was to remove it — refining an idea is many short replies — and it made
   * a plausible first word into a task id: `!answer we want B` was read as an answer to
   * a task called `we`, and the reply was "No task we in the state repo."
   *
   * So everything typed in a bound thread is the answer, verbatim. A leading `!answer`
   * is stripped rather than obeyed, because people type it out of habit, and so is the
   * thread's own id if they repeat it.
   */
  if (thread !== undefined) {
    const text = stripAnswerPrefix(trimmed, thread);
    return text.length === 0 ? undefined : { kind: "answer", task: thread, text };
  }

  if (!trimmed.startsWith("!")) return undefined;

  const [word = "", ...rest] = trimmed.split(/\s+/);
  if (word.toLowerCase() !== "!answer") return undefined;

  const task = rest[0];
  if (task === undefined) return { kind: "malformed", reason: `Which task? ${HELP}` };
  if (!isTaskId(task)) {
    // The id becomes a directory name under `tasks/`. A `../` in it would write
    // outside the task, and a task that does not exist is a better error than a
    // traversal that half-works.
    return { kind: "malformed", reason: `\`${task}\` is not a task id. ${HELP}` };
  }

  // Everything after the id, with the ORIGINAL spacing: an answer can be a code block,
  // a list, or a paragraph, and re-joining on single spaces would flatten all of it.
  const text = trimmed.slice(trimmed.indexOf(task) + task.length).trim();
  if (text.length === 0) {
    return { kind: "malformed", reason: `An answer for \`${task}\` cannot be empty. ${HELP}` };
  }

  return { kind: "answer", task: asTaskId(task), text };
};

/**
 * Drop a `!answer` a human typed out of habit, and the thread's own id after it.
 *
 * Sliced rather than re-joined on whitespace, so the answer keeps its original shape —
 * it can be a code block, a list, or a paragraph, and a thread is where the long ones
 * get typed.
 */
const stripAnswerPrefix = (trimmed: string, thread: TaskId): string => {
  const [word = "", next] = trimmed.split(/\s+/);
  if (word.toLowerCase() !== "!answer") return trimmed;

  let rest = trimmed.slice(word.length).trimStart();
  if (next === thread) rest = rest.slice(next.length).trimStart();
  return rest.trim();
};
