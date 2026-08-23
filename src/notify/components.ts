/**
 * Message components — buttons and modals. See DESIGN.md §7.
 *
 * Pure: structures in, structures out. Everything about Discord's component model that
 * can be got wrong is decided here, where it is testable without a socket, a token, or
 * a guild.
 *
 * Classic action rows deliberately, NOT Components V2. The V2 flag (1 << 15) buys
 * containers and separators and costs `content` and `embeds` entirely — every existing
 * render path would have to be rewritten to gain layout nobody asked for. A button next
 * to ordinary markdown is the whole requirement.
 *
 * Traps encoded below:
 *   - `custom_id` is capped at 100 characters and is the ONLY channel a button has to
 *     say what it is about. It carries a task id, which is tracker-derived and can be
 *     long, so encoding has to be able to FAIL rather than truncate: a clipped task id
 *     decodes to a different task, or to one that does not exist.
 *   - a decoded `custom_id` is untrusted input that becomes a path segment under
 *     `tasks/`, exactly like a chat command. It gets the same validation.
 *   - five buttons per row and five rows per message are hard limits; over either is a
 *     400 and the message never appears.
 */
import { isTaskId, type TaskId } from "../domain/task.ts";

/** Discord component type discriminators. */
export const COMPONENT = {
  actionRow: 1,
  button: 2,
  textInput: 4,
} as const;

/** Button styles. `link` carries a url instead of a custom_id and emits no interaction. */
export const BUTTON_STYLE = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
} as const;

/** Text input styles: short is one line, paragraph is a box. */
export const TEXT_INPUT_STYLE = {
  short: 1,
  paragraph: 2,
} as const;

/** Only this user sees the message. Used for command acknowledgements. */
export const EPHEMERAL = 1 << 6;

export const CUSTOM_ID_LIMIT = 100;
/** Exported because a caller building a row from a list has to bound the list itself. */
export const BUTTONS_PER_ROW = 5;
const ROWS_PER_MESSAGE = 5;
/** Discord's limits on the modal frame. Over either is a 400. */
const MODAL_TITLE_LIMIT = 45;
const LABEL_LIMIT = 45;
/**
 * Discord's cap on a text input's `value` and `max_length`.
 *
 * Exported because a caller that PRE-FILLS a box has to bound what it puts in it, and the
 * only honest answer above the cap is to refuse — see `amendModal`.
 */
export const TEXT_INPUT_LIMIT = 4000;

export interface Button {
  readonly type: typeof COMPONENT.button;
  readonly style: number;
  readonly label: string;
  readonly custom_id?: string;
  readonly url?: string;
  readonly disabled?: boolean;
}

export interface TextInput {
  readonly type: typeof COMPONENT.textInput;
  readonly custom_id: string;
  readonly label: string;
  readonly style: number;
  readonly required: boolean;
  readonly max_length: number;
  readonly placeholder?: string;
  readonly value?: string;
}

export interface ActionRow {
  readonly type: typeof COMPONENT.actionRow;
  readonly components: readonly (Button | TextInput)[];
}

export interface Modal {
  readonly custom_id: string;
  readonly title: string;
  readonly components: readonly ActionRow[];
}

/**
 * What a button asks the supervisor to do.
 *
 * Kept short deliberately — every character spends the 100 a `custom_id` has, and the
 * task id needs most of them. `res` is `/resume`: a park notification is the one message
 * whose entire content is "a human has to act", and the act is always the same one.
 *
 * `opt` is one enumerated answer to a question, and its `arg` is the option's INDEX rather
 * than its text — the text is stored beside the question in the state repo, because an
 * option long enough to be worth a button is long enough to break the 100.
 *
 * `amd` is `/amend`: replace a task's acceptance criteria (§12.3). Abbreviated for the same
 * reason the rest are — the criteria themselves never travel in a `custom_id`, they are
 * pre-filled into the modal the press opens.
 */
export type Verb =
  | "ans"
  | "opt"
  | "park"
  | "merge"
  | "res"
  | "back"
  | "plan-ok"
  | "plan-no"
  | "done"
  | "amd";

export interface ButtonAction {
  readonly verb: Verb;
  readonly task: TaskId;
  /** Free-form second argument, e.g. a question index. Must not contain `:`. */
  readonly arg?: string;
}

/**
 * Versioned so a button left in the channel by an older deploy is REFUSED rather than
 * misread. Discord keeps message history forever; the buttons in it outlive the code
 * that rendered them.
 */
const CUSTOM_ID_VERSION = "c1";

/**
 * Encode an action into a `custom_id`, or undefined when it would not fit.
 *
 * `:` is the separator because a task id cannot contain one — `isTaskId` allows only
 * alphanumerics, dot, underscore and hyphen — so the split is unambiguous without
 * escaping.
 *
 * Returning undefined rather than truncating is the whole point: a clipped task id is
 * still a valid-looking task id, and it addresses the wrong task.
 */
export const encodeCustomId = (action: ButtonAction): string | undefined => {
  if (action.arg !== undefined && action.arg.includes(":")) return undefined;
  const encoded = [CUSTOM_ID_VERSION, action.verb, action.task, ...(action.arg === undefined ? [] : [action.arg])].join(":");
  return encoded.length > CUSTOM_ID_LIMIT ? undefined : encoded;
};

/** Decode a `custom_id` from an interaction. Undefined for anything not ours. */
export const decodeCustomId = (raw: string): ButtonAction | undefined => {
  const parts = raw.split(":");
  const [version, verb, task, ...rest] = parts;
  if (version !== CUSTOM_ID_VERSION) return undefined;
  if (verb === undefined || task === undefined) return undefined;
  if (!isVerb(verb)) return undefined;
  // The id becomes a directory name under `tasks/`. A `../` in it would write outside
  // the task tree, and this string arrives from whatever Discord was told to send.
  if (!isTaskId(task)) return undefined;

  const arg = rest.length === 0 ? undefined : rest.join(":");
  return { verb, task, ...(arg === undefined ? {} : { arg }) };
};

// Parallel to `Verb` by hand, and it has to stay that way: `isVerb` is a runtime check and
// the union is erased, so a verb added to one and not the other type-checks and then decodes
// as "unrecognised button" in front of whoever pressed it.
const VERBS: readonly string[] = [
  "ans",
  "opt",
  "park",
  "merge",
  "res",
  "back",
  "plan-ok",
  "plan-no",
  "done",
  "amd",
];

const isVerb = (value: string): value is Verb => VERBS.includes(value);

const clamp = (text: string, limit: number): string =>
  [...text].length <= limit ? text : [...text].slice(0, limit).join("");

export const button = (options: {
  readonly action: ButtonAction;
  readonly label: string;
  readonly style?: number;
  readonly disabled?: boolean;
}): Button | undefined => {
  const customId = encodeCustomId(options.action);
  if (customId === undefined) return undefined;
  return {
    type: COMPONENT.button,
    style: options.style ?? BUTTON_STYLE.secondary,
    label: clamp(options.label, LABEL_LIMIT),
    custom_id: customId,
    ...(options.disabled === true ? { disabled: true } : {}),
  };
};

/** A link button. Emits no interaction, so it needs no custom_id and never fails. */
export const linkButton = (label: string, url: string): Button => ({
  type: COMPONENT.button,
  style: BUTTON_STYLE.link,
  label: clamp(label, LABEL_LIMIT),
  url,
});

/**
 * One action row from the buttons that could be built.
 *
 * Undefined entries are dropped rather than propagated: a button whose action did not
 * fit is one missing button, not a message that fails to send.
 */
export const row = (...buttons: readonly (Button | undefined)[]): ActionRow | undefined => {
  const present = buttons.filter((b): b is Button => b !== undefined);
  if (present.length === 0) return undefined;
  if (present.length > BUTTONS_PER_ROW) {
    throw new Error(`an action row holds at most ${BUTTONS_PER_ROW} buttons, got ${present.length}`);
  }
  return { type: COMPONENT.actionRow, components: present };
};

/** Assemble the rows a message carries. Undefined when there is nothing to attach. */
export const rows = (...candidates: readonly (ActionRow | undefined)[]): readonly ActionRow[] | undefined => {
  const present = candidates.filter((r): r is ActionRow => r !== undefined);
  if (present.length === 0) return undefined;
  if (present.length > ROWS_PER_MESSAGE) {
    throw new Error(`a message holds at most ${ROWS_PER_MESSAGE} action rows, got ${present.length}`);
  }
  return present;
};

/** Re-render rows with every button disabled — the acknowledgement of a click. */
export const disableAll = (attached: readonly ActionRow[]): readonly ActionRow[] =>
  attached.map((r) => ({
    ...r,
    components: r.components.map((c) =>
      c.type === COMPONENT.button ? { ...c, disabled: true } : c,
    ),
  }));

/** The single-field modal behind the Answer button. */
export const answerModal = (task: TaskId, fieldId: string): Modal | undefined =>
  singleFieldModal({
    verb: "ans",
    task,
    fieldId,
    title: `Answer ${task}`,
    label: "Your answer",
  });

/**
 * The modal behind the Mark done button.
 *
 * A button cannot carry prose and the reason is REQUIRED — a forced completion with no
 * stated cause is unauditable — so the click has to ask for one before anything is written.
 */
export const doneModal = (task: TaskId, fieldId: string): Modal | undefined =>
  singleFieldModal({
    verb: "done",
    task,
    fieldId,
    title: `Mark ${task} done`,
    label: "Why (the gates are skipped)",
  });

/**
 * The two-field modal behind `/amend` and the Amend criteria button (DESIGN.md §12.3).
 *
 * The PRE-FILL is the feature. The three hand-edits that motivated amendments were one bad
 * glob and two repo-wide gates, and in each case the other criteria were working commands
 * nobody would retype to fix the broken one. So the box arrives holding the task's current
 * EFFECTIVE criteria, one per line, and what comes back is the whole replacement list.
 *
 * Undefined rather than clipped when the criteria do not fit Discord's 4000-character
 * input, and that is the one refusal worth spelling out: this box is submitted as a WHOLE
 * replacement, so a truncated pre-fill would delete every criterion the box could not hold,
 * on behalf of a human who never saw them. `/amend` cannot serve a list that long, and
 * saying so is the only honest answer.
 */
export const amendModal = (options: {
  readonly task: TaskId;
  readonly acceptance: readonly string[];
  readonly criteriaFieldId: string;
  readonly whyFieldId: string;
}): Modal | undefined => {
  const customId = encodeCustomId({ verb: "amd", task: options.task });
  if (customId === undefined) return undefined;

  const prefill = options.acceptance.join("\n");
  if ([...prefill].length > TEXT_INPUT_LIMIT) return undefined;

  return {
    custom_id: customId,
    title: clamp(`Amend ${options.task}`, MODAL_TITLE_LIMIT),
    components: [
      {
        type: COMPONENT.actionRow,
        components: [
          {
            type: COMPONENT.textInput,
            custom_id: options.criteriaFieldId,
            label: clamp("Acceptance criteria, one per line", LABEL_LIMIT),
            style: TEXT_INPUT_STYLE.paragraph,
            required: true,
            max_length: TEXT_INPUT_LIMIT,
            value: prefill,
          },
        ],
      },
      {
        type: COMPONENT.actionRow,
        components: [
          {
            type: COMPONENT.textInput,
            custom_id: options.whyFieldId,
            label: clamp("Why the filed criteria cannot stand", LABEL_LIMIT),
            style: TEXT_INPUT_STYLE.paragraph,
            required: true,
            max_length: TEXT_INPUT_LIMIT,
          },
        ],
      },
    ],
  };
};

/**
 * The shape both single-field modals share: one required paragraph box, keyed to a verb and
 * a task.
 *
 * Factored out when the second one arrived rather than copied, because the part worth not
 * duplicating is not the literal — it is `required: true` and the `custom_id` round trip.
 * A modal whose field is optional accepts an empty submit, and both callers depend on it
 * being impossible.
 */
const singleFieldModal = (options: {
  readonly verb: Verb;
  readonly task: TaskId;
  readonly fieldId: string;
  readonly title: string;
  readonly label: string;
}): Modal | undefined => {
  const customId = encodeCustomId({ verb: options.verb, task: options.task });
  if (customId === undefined) return undefined;
  return {
    custom_id: customId,
    title: clamp(options.title, MODAL_TITLE_LIMIT),
    components: [
      {
        type: COMPONENT.actionRow,
        components: [
          {
            type: COMPONENT.textInput,
            custom_id: options.fieldId,
            label: clamp(options.label, LABEL_LIMIT),
            style: TEXT_INPUT_STYLE.paragraph,
            required: true,
            max_length: TEXT_INPUT_LIMIT,
          },
        ],
      },
    ],
  };
};
