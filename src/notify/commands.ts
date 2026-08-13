/**
 * Parsing the inbound half of the Discord channel. See DESIGN.md §7.
 *
 * Pure: a string in, a decision out. Everything that can go wrong with a human typing
 * into a chat box is decided here, where it can be tested without a socket, a token, or
 * a Discord account.
 *
 * Only `!answer` exists so far. `!task` (§14 path 3) is deliberately not implemented —
 * a spec with no machine-checkable acceptance criteria can never satisfy §12, and
 * `!task <repo> <goal>` as written in the design has nowhere to put them. Intake covers
 * the tracker path, and a hand-committed spec covers the rest.
 */
import { asTaskId, type TaskId } from "../domain/task.ts";

export type Command =
  | { readonly kind: "answer"; readonly task: TaskId; readonly text: string }
  /** Recognised prefix, unusable content — worth replying to rather than ignoring. */
  | { readonly kind: "malformed"; readonly reason: string };

/** A task id is a path segment in the state repo; anything else escapes it. */
const TASK_ID = /^[A-Za-z0-9._-]+$/;

export const HELP = "Usage: `!answer <task-id> <your answer>`";

/**
 * Decide what a chat message asks for, if anything.
 *
 * Returns undefined for "not for us", which is the overwhelmingly common case: this
 * runs on every message in the channel, including the supervisor's own notifications.
 */
export const parseCommand = (content: string): Command | undefined => {
  const trimmed = content.trim();
  if (!trimmed.startsWith("!")) return undefined;

  const [word = "", ...rest] = trimmed.split(/\s+/);
  if (word.toLowerCase() !== "!answer") return undefined;

  const task = rest[0];
  if (task === undefined) return { kind: "malformed", reason: `Which task? ${HELP}` };
  if (!TASK_ID.test(task)) {
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
