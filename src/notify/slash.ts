/**
 * Slash commands and what an interaction means. See DESIGN.md §7.
 *
 * Pure: an interaction payload in, an intent out. No socket, no token, no HTTP — which
 * is what lets every branch of a click be tested, including the ones that only happen
 * when someone presses a button on a message left over from an older deploy.
 *
 * Everything converges on the `Command` union in `commands.ts`, deliberately. A slash
 * command, a button and a typed `!answer` are three ways to say the same thing, and the
 * supervisor should not be able to tell which one it was serving.
 *
 * Commands are registered per GUILD rather than globally: guild registration takes
 * effect instantly, global registration is eventually-consistent and there is exactly
 * one guild.
 */
import { asTaskId, isTaskId, type TaskId, type TaskStatus } from "../domain/task.ts";
import { parseRepo } from "../plan/brainstorm.ts";
import type { Command } from "./commands.ts";
import { decodeCustomId } from "./components.ts";
import {
  INTERACTION,
  focusedOption,
  modalValue,
  optionValue,
  type Interaction,
} from "./interactions.ts";

/** Discord's application-command option types. Only strings are used here. */
const OPTION_STRING = 3;

/** The modal's single field. Its id is ours to choose and must round-trip on submit. */
export const ANSWER_FIELD = "text";

const STATUSES: readonly TaskStatus[] = [
  "ready",
  "running",
  "awaiting-human",
  "parked",
  "done",
  "failed",
];

/**
 * The exact command set registered with Discord. Registration is a full replace, so
 * this array IS the surface — a command removed from here disappears from the client.
 */
export const COMMANDS: readonly Record<string, unknown>[] = [
  {
    name: "answer",
    description: "Answer the question a task is waiting on",
    options: [
      {
        name: "task",
        description: "Task id",
        type: OPTION_STRING,
        required: true,
        autocomplete: true,
      },
      { name: "text", description: "Your answer", type: OPTION_STRING, required: true },
    ],
  },
  {
    name: "tasks",
    description: "List tasks and their status",
    options: [
      {
        name: "status",
        description: "Only tasks in this status",
        type: OPTION_STRING,
        required: false,
        choices: STATUSES.map((status) => ({ name: status, value: status })),
      },
    ],
  },
  {
    name: "task",
    description: "Show one task in detail",
    options: [
      {
        name: "id",
        description: "Task id",
        type: OPTION_STRING,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "brainstorm",
    description: "Refine an idea into a plan, in a thread, then cut it into tasks",
    options: [
      {
        name: "topic",
        description: "What you want to build or change. Rough is fine — that is the point.",
        type: OPTION_STRING,
        required: true,
      },
      {
        name: "repo",
        description: "owner/name — one repo, or several separated by commas or spaces",
        type: OPTION_STRING,
        required: true,
      },
    ],
  },
  {
    name: "cancel",
    description: "Stop working a task and park it for a human",
    options: [
      {
        name: "task",
        description: "Task id",
        type: OPTION_STRING,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "resume",
    description: "Put a parked task back in the queue",
    options: [
      {
        name: "task",
        description: "Task id",
        type: OPTION_STRING,
        required: true,
        autocomplete: true,
      },
    ],
  },
];

/**
 * What an interaction asks for.
 *
 * `run` needs the supervisor and therefore an acknowledgement first; the others are
 * answered entirely by the interaction response and never reach the state repo.
 */
export type Intent =
  | { readonly kind: "run"; readonly command: Command }
  | { readonly kind: "open-answer-modal"; readonly task: TaskId }
  | { readonly kind: "autocomplete"; readonly query: string }
  /** Not ours, or no longer ours. Acknowledged and dropped. */
  | { readonly kind: "ignored"; readonly reason: string };

export const parseInteraction = (interaction: Interaction): Intent => {
  switch (interaction.type) {
    case INTERACTION.command:
      return fromCommand(interaction);
    case INTERACTION.component:
      return fromComponent(interaction);
    case INTERACTION.modalSubmit:
      return fromModal(interaction);
    case INTERACTION.autocomplete: {
      const focused = focusedOption(interaction);
      return focused === undefined
        ? { kind: "ignored", reason: "no focused option" }
        : { kind: "autocomplete", query: focused.value };
    }
    default:
      return { kind: "ignored", reason: `interaction type ${interaction.type}` };
  }
};

const malformed = (reason: string): Intent => ({ kind: "run", command: { kind: "malformed", reason } });

/** The decoration `bridge.ts` puts on an autocomplete suggestion: `<id> — <status>`. */
const SUGGESTION_LABEL = / — ([^ ]+)$/;

/**
 * Undo our own autocomplete label when a client submits it in place of the choice value.
 *
 * The suggestion carries `value: task.id` and only renders `<id> — <status>` for the
 * human, but some Discord clients commit the LABEL when the choice is taken by keyboard
 * rather than clicked. `/resume` felt all of it: every task it can suggest is parked, so
 * the suffix was always present and the command refused its own autocompletion.
 *
 * Deliberately narrow. Only a suffix that is a real status is removed, so this cannot
 * decay into "take everything before a dash" and start accepting a pasted sentence — and
 * a task id can never contain a space anyway (`TASK_ID`), so nothing legal is lost.
 */
const unlabelled = (value: string): string => {
  const match = SUGGESTION_LABEL.exec(value);
  const status = match?.[1];
  return match !== null && status !== undefined && isStatus(status)
    ? value.slice(0, match.index)
    : value;
};

/**
 * Read a task id from a command option.
 *
 * Validated even though the option is autocompleted: autocomplete is a suggestion, not a
 * constraint, and Discord submits whatever was typed. The id becomes a directory name
 * under `tasks/`, so a `../` reaching the store is the failure this prevents.
 */
const taskOption = (interaction: Interaction, name: string): TaskId | string => {
  const raw = optionValue(interaction, name);
  if (raw === undefined || raw.trim().length === 0) return `\`${name}\` is required.`;
  const trimmed = unlabelled(raw.trim());
  return isTaskId(trimmed) ? asTaskId(trimmed) : `\`${trimmed}\` is not a task id.`;
};

/**
 * The repo list, as typed.
 *
 * Commas AND whitespace, because Discord's single-line option box invites both and
 * neither is wrong. Splitting on either means `owner/a, owner/b` and `owner/a owner/b`
 * are the same command, which is the only behaviour a human would predict.
 */
const splitRepos = (raw: string): readonly string[] =>
  raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const fromCommand = (interaction: Interaction): Intent => {
  const name = interaction.data?.name;

  switch (name) {
    case "answer": {
      const task = taskOption(interaction, "task");
      if (!isTaskId(task)) return malformed(task);
      const text = optionValue(interaction, "text")?.trim() ?? "";
      if (text.length === 0) return malformed(`An answer for \`${task}\` cannot be empty.`);
      return { kind: "run", command: { kind: "answer", task, text } };
    }
    case "tasks": {
      const status = optionValue(interaction, "status");
      return {
        kind: "run",
        command: {
          kind: "list",
          ...(status !== undefined && isStatus(status) ? { status } : {}),
        },
      };
    }
    case "task": {
      const task = taskOption(interaction, "id");
      return isTaskId(task) ? { kind: "run", command: { kind: "show", task } } : malformed(task);
    }
    case "cancel": {
      const task = taskOption(interaction, "task");
      return isTaskId(task) ? { kind: "run", command: { kind: "park", task } } : malformed(task);
    }
    case "resume": {
      const task = taskOption(interaction, "task");
      return isTaskId(task) ? { kind: "run", command: { kind: "resume", task } } : malformed(task);
    }
    case "brainstorm": {
      const topic = optionValue(interaction, "topic")?.trim() ?? "";
      const repo = optionValue(interaction, "repo")?.trim() ?? "";
      if (topic.length === 0) return malformed("A brainstorm needs a topic.");
      const repos = splitRepos(repo);
      if (repos.length === 0) {
        // Required rather than inferred: a brainstorm that cannot read the code produces
        // a plan about an imaginary codebase, which is the expensive kind of wrong.
        return malformed(
          "A brainstorm needs at least one repo to read — `owner/name`, or several " +
            "separated by commas or spaces.",
        );
      }
      const bad = repos.find((entry) => parseRepo(entry) === undefined);
      if (bad !== undefined) {
        return malformed(`\`${bad}\` is not a repo — use \`owner/name\` or \`host/owner/name\`.`);
      }
      return { kind: "run", command: { kind: "brainstorm", topic, repos } };
    }
    default:
      return { kind: "ignored", reason: `unknown command ${name ?? "(none)"}` };
  }
};

const fromComponent = (interaction: Interaction): Intent => {
  const customId = interaction.data?.custom_id;
  if (customId === undefined) return { kind: "ignored", reason: "component without a custom_id" };

  const action = decodeCustomId(customId);
  // Discord keeps message history forever, so a button from a deploy that predates the
  // current encoding is not a bug — it is a message someone scrolled back to. Refusing
  // it is correct; guessing what it used to mean is not.
  if (action === undefined) return { kind: "ignored", reason: "unrecognised button" };

  switch (action.verb) {
    case "ans":
      return { kind: "open-answer-modal", task: action.task };
    case "park":
      return { kind: "run", command: { kind: "park", task: action.task } };
    case "merge":
      return { kind: "run", command: { kind: "merge", task: action.task } };
    default:
      return { kind: "ignored", reason: `button ${action.verb} is not handled yet` };
  }
};

const fromModal = (interaction: Interaction): Intent => {
  const customId = interaction.data?.custom_id;
  const action = customId === undefined ? undefined : decodeCustomId(customId);
  if (action === undefined || action.verb !== "ans") {
    return { kind: "ignored", reason: "unrecognised modal" };
  }

  const text = modalValue(interaction, ANSWER_FIELD)?.trim() ?? "";
  if (text.length === 0) return malformed(`An answer for \`${action.task}\` cannot be empty.`);
  return { kind: "run", command: { kind: "answer", task: action.task, text } };
};

const isStatus = (value: string): value is TaskStatus =>
  (STATUSES as readonly string[]).includes(value);
