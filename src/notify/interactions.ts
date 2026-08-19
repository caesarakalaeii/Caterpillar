/**
 * Interactions — slash commands, buttons and modals. See DESIGN.md §7.
 *
 * These arrive over the SAME gateway websocket the bridge already holds. Discord will
 * deliver `INTERACTION_CREATE` as an ordinary dispatch as long as the application has no
 * Interactions Endpoint URL configured; the two delivery methods are mutually exclusive
 * and this application has never had one. That is what keeps §7's central property
 * intact: the runner dials OUT, so a machine behind NAT needs no ingress, no TLS, and
 * has no URL to leak. An interactions endpoint would have cost all three.
 *
 * The timing rules are the whole design constraint here:
 *
 *   - an interaction must be acknowledged within **3 seconds** or Discord marks it
 *     failed, permanently, in front of the person who clicked;
 *   - the token then lives **15 minutes**, and no longer.
 *
 * The supervisor drains its inbox once per poll iteration, and an iteration can be a
 * multi-hour session. So nothing here waits for a real outcome. Every interaction is
 * acknowledged immediately with what is knowable at click time, and the actual result
 * arrives later as an ordinary channel message from the bot. A followup on the
 * interaction token would be the natural design and it would silently stop working the
 * first time a session ran long.
 */
import { API_BASE } from "./bot.ts";
import { EPHEMERAL, type ActionRow, type Modal } from "./components.ts";
import { messageBody } from "./discord.ts";
import { type FetchLike, postJson } from "./http.ts";

/** Interaction types — what Discord is telling us happened. */
export const INTERACTION = {
  ping: 1,
  command: 2,
  component: 3,
  autocomplete: 4,
  modalSubmit: 5,
} as const;

/** Response types — what we tell Discord to do about it. */
export const RESPONSE = {
  message: 4,
  deferredMessage: 5,
  deferredUpdate: 6,
  updateMessage: 7,
  autocomplete: 8,
  modal: 9,
} as const;

export interface InteractionOption {
  readonly name: string;
  readonly value?: unknown;
  /** Set on the option the user is currently typing, for autocomplete. */
  readonly focused?: boolean;
  readonly options?: readonly InteractionOption[];
}

export interface InteractionData {
  /** Command name, for `type: command` and `type: autocomplete`. */
  readonly name?: string;
  readonly options?: readonly InteractionOption[];
  /** Set for components and modal submissions. */
  readonly custom_id?: string;
  /** Modal submissions carry their fields here, wrapped in action rows. */
  readonly components?: readonly {
    readonly components?: readonly { readonly custom_id?: string; readonly value?: string }[];
  }[];
}

export interface Interaction {
  readonly id: string;
  readonly token: string;
  readonly type: number;
  readonly application_id?: string;
  readonly channel_id?: string;
  /**
   * The channel the interaction came from, as a partial object.
   *
   * `parent_id` is why this is modelled. `MESSAGE_CREATE` names no parent, which is what
   * `ThreadRouter` exists to work around with a REST lookup — but an INTERACTION does carry
   * one, so "is this a thread of our channel" is answerable from the payload, for free,
   * without a binding and without a round trip inside Discord's three-second budget. That
   * matters for the one command whose audience is a task the index has no binding for:
   * `/resume` on something parked.
   */
  readonly channel?: { readonly id?: string; readonly parent_id?: string };
  readonly guild_id?: string;
  readonly data?: InteractionData;
  /** Present for component interactions: the message the button is attached to. */
  readonly message?: {
    readonly id?: string;
    readonly content?: string;
    readonly components?: readonly ActionRow[];
  };
  /** In a guild the user is under `member`; in a DM it is at the top level. */
  readonly member?: { readonly user?: { readonly id?: string; readonly username?: string } };
  readonly user?: { readonly id?: string; readonly username?: string };
}

export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

export type InteractionResponse =
  | { readonly type: typeof RESPONSE.message; readonly data: Record<string, unknown> }
  | { readonly type: typeof RESPONSE.updateMessage; readonly data: Record<string, unknown> }
  | { readonly type: typeof RESPONSE.deferredUpdate }
  | { readonly type: typeof RESPONSE.autocomplete; readonly data: { readonly choices: readonly AutocompleteChoice[] } }
  | { readonly type: typeof RESPONSE.modal; readonly data: Modal };

/** Who clicked. Used for the audit line in the log, never for authorisation. */
export const interactionUser = (interaction: Interaction): string =>
  interaction.member?.user?.username ?? interaction.user?.username ?? "someone";

/** A named option's value as a string, or undefined when it was not supplied. */
export const optionValue = (interaction: Interaction, name: string): string | undefined => {
  const option = interaction.data?.options?.find((o) => o.name === name);
  if (option === undefined || option.value === undefined) return undefined;
  return typeof option.value === "string" ? option.value : String(option.value);
};

/** The option the user is typing into, for an autocomplete interaction. */
export const focusedOption = (
  interaction: Interaction,
): { readonly name: string; readonly value: string } | undefined => {
  const option = interaction.data?.options?.find((o) => o.focused === true);
  if (option === undefined) return undefined;
  return { name: option.name, value: typeof option.value === "string" ? option.value : "" };
};

/** A modal field's submitted text. */
export const modalValue = (interaction: Interaction, fieldId: string): string | undefined => {
  for (const row of interaction.data?.components ?? []) {
    for (const field of row.components ?? []) {
      if (field.custom_id === fieldId) return field.value;
    }
  }
  return undefined;
};

/** An immediate, visible reply. */
export const reply = (
  content: string,
  options: { readonly ephemeral?: boolean; readonly components?: readonly ActionRow[] } = {},
): InteractionResponse => ({
  type: RESPONSE.message,
  data: messageBody(content, {
    ...(options.components === undefined ? {} : { components: options.components }),
    ...(options.ephemeral === true ? { flags: EPHEMERAL } : {}),
  }),
});

/**
 * Rewrite the message the component is attached to.
 *
 * This is how a click is acknowledged: the same message comes back with its buttons
 * disabled, which is what makes a double-click harmless. That matters most for the one
 * button that merges.
 */
export const updateMessage = (
  content: string,
  components: readonly ActionRow[],
): InteractionResponse => ({
  type: RESPONSE.updateMessage,
  data: messageBody(content, { components }),
});

export const openModal = (modal: Modal): InteractionResponse => ({
  type: RESPONSE.modal,
  data: modal,
});

/** Discord shows at most 25 suggestions; more is a 400. */
export const autocomplete = (choices: readonly AutocompleteChoice[]): InteractionResponse => ({
  type: RESPONSE.autocomplete,
  data: { choices: choices.slice(0, 25) },
});

/**
 * Answer an interaction.
 *
 * Deliberately NOT retried. The callback is exempt from the global rate limit, and the
 * only failure it realistically produces is arriving after the 3-second deadline, by
 * which point the interaction no longer exists and every retry answers 404 forever.
 * The caller logs and moves on; the human sees Discord's own "interaction failed".
 */
export const respond = async (options: {
  readonly interaction: Interaction;
  readonly response: InteractionResponse;
  readonly fetch?: FetchLike;
  readonly apiBase?: string;
}): Promise<void> => {
  const base = options.apiBase ?? API_BASE;
  await postJson({
    url: `${base}/interactions/${options.interaction.id}/${options.interaction.token}/callback`,
    body: JSON.stringify(options.response),
    what: "interaction response",
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
};
