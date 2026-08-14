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
  /** List tasks, optionally filtered. Served from the snapshot, never from git. */
  | { readonly kind: "list"; readonly status?: TaskStatus }
  | { readonly kind: "show"; readonly task: TaskId }
  /** Stop working a task and leave it parked for a human. */
  | { readonly kind: "park"; readonly task: TaskId }
  /** Recognised prefix, unusable content — worth replying to rather than ignoring. */
  | { readonly kind: "malformed"; readonly reason: string };

export const HELP = "Usage: `!answer <task-id> <your answer>` — or use `/answer`.";

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
