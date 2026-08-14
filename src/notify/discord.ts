/**
 * Discord notifications. See DESIGN.md §11.
 *
 * Discord is a SIGNAL channel, not a log stream: questions, parks, verdicts and terminal
 * outcomes only. Everything else goes to Prometheus. Handoffs are deliberately silent —
 * a multi-hour task would otherwise produce twenty messages of noise.
 *
 * There are two transports and they are not equivalent. The incoming **webhook** is what
 * §11.2 shipped and it cannot carry components at all: Discord refuses interactive
 * components from a webhook an application does not own, and `webhook-url` is a webhook
 * created in the channel's settings. So a notification renders TWICE — a plain form that
 * ends with the `!answer` instruction, and an interactive form where a button replaces
 * that instruction. `src/notify/bot.ts` sends the second; this file sends the first.
 *
 * Traps encoded below, all of them ways a notification is silently LOST rather than
 * loudly broken:
 *   - `content` over 2000 code points is a 400 and the message never appears. An
 *     agent-authored question is exactly the payload that blows the limit.
 *   - **a QUESTION is never truncated — it is SPLIT.** Truncating one is not a smaller
 *     notification, it is an unanswerable one: the first real question to exceed the
 *     limit came in at 3785 code points, offered four options, and arrived cut in the
 *     middle of option A with B, C and D missing entirely. There was nothing to reply
 *     to. Everything else here is informational and still truncates, because a park
 *     reason cut short still says a task parked.
 *   - mentions in that prose are parsed by default. The agent quotes files it read,
 *     so `@everyone` reaching Discord unsuppressed pages the server.
 *   - the URL's last path segment IS the credential. It must not reach an error
 *     message, because the supervisor logs those verbatim.
 */
import type { TaskId } from "../domain/task.ts";
import { button, BUTTON_STYLE, linkButton, row, rows, type ActionRow } from "./components.ts";
import { type FetchLike, postJson } from "./http.ts";

export type Notification =
  | { readonly kind: "question"; readonly task: TaskId; readonly question: string; readonly phase: string }
  | { readonly kind: "parked"; readonly task: TaskId; readonly reason: string }
  | {
      readonly kind: "done";
      readonly task: TaskId;
      readonly prUrl: string;
      /** What became of the PR — merged by the reviewer identity, or left for a human. */
      readonly note?: string;
    }
  /** The council sent a change back. Informational: the task returns to the agent by itself. */
  | {
      readonly kind: "verdict";
      readonly task: TaskId;
      readonly summary: string;
      readonly prUrl?: string;
    }
  /**
   * The council and the agent could not converge (DESIGN.md §12.1). The one place a
   * human is genuinely in the loop, so it is the one notification that offers a merge.
   */
  | {
      readonly kind: "review-stalled";
      readonly task: TaskId;
      readonly rounds: number;
      readonly summary: string;
      readonly prUrl?: string;
      /**
       * Whether a Merge button would actually work. False without a reviewer identity:
       * branch protection refuses a merge from the App that authored the PR, so the
       * button would fail every time it was pressed (§9.1).
       */
      readonly canMerge: boolean;
    }
  /** A brainstorm's plan cleared the council and became real tasks (DESIGN.md §14.3). */
  | {
      readonly kind: "plan-ready";
      readonly task: TaskId;
      readonly title: string;
      readonly tasks: readonly { readonly id: TaskId; readonly wave: number }[];
    }
  /** Implementation moved a plan's dependency edges. */
  | {
      readonly kind: "plan-revised";
      readonly task: TaskId;
      readonly changed: number;
      readonly note: string;
    }
  | { readonly kind: "failed"; readonly task: TaskId; readonly error: string };

/** Where a notification goes. A task with a thread talks in it rather than the channel. */
export interface NotifyTarget {
  readonly threadId?: string;
}

export interface Notifier {
  notify(notification: Notification, target?: NotifyTarget): Promise<void>;
}

export type { FetchLike };

export interface DiscordOptions {
  /** Webhook URL, resolved from the mounted SOPS secret. Never logged. */
  readonly webhookUrl: string;
  readonly fetch?: FetchLike;
  /** Injection seam for tests; production waits for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts after the first, for 429 and 5xx only. */
  readonly maxRetries?: number;
}

/** Discord's hard limit on a message body, counted in code points. */
export const CONTENT_LIMIT = 2000;

/** Marks prose the frame had to cut; the full text is in the task's state repo. */
const TRUNCATED = "… (truncated)";

export class DiscordNotifier implements Notifier {
  private readonly options: DiscordOptions;

  constructor(options: DiscordOptions) {
    this.options = options;
  }

  async notify(notification: Notification, target: NotifyTarget = {}): Promise<void> {
    // Sequential, not concurrent: Discord does not order simultaneous posts, and a
    // question whose parts arrive shuffled is barely better than a truncated one.
    for (const part of renderParts(notification, { interactive: false })) {
      await postJson({
        // A webhook posts into a thread by query parameter — no other way to say so.
        url:
          target.threadId === undefined
            ? this.options.webhookUrl
            : `${this.options.webhookUrl}?thread_id=${target.threadId}`,
        what: "webhook message",
        body: messagePayload(part.content),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
      });
    }
  }
}

export interface MessageOptions {
  readonly components?: readonly ActionRow[];
  readonly flags?: number;
}

/**
 * The JSON body for any message this bot sends, by webhook or as itself.
 *
 * Shared so every path gets the same two guarantees: content inside the 2000 code-point
 * limit (over it is a 400 and the message never appears), and mentions suppressed —
 * Discord parses them by default and this text quotes agent prose.
 */
export const messageBody = (
  content: string,
  options: MessageOptions = {},
): Record<string, unknown> => ({
  // render() already fits the limit around its frame; this backstop covers the case
  // the frame ITSELF is oversized, which a long task id is enough to do.
  content: take(content, CONTENT_LIMIT),
  allowed_mentions: { parse: [] },
  ...(options.components === undefined ? {} : { components: options.components }),
  ...(options.flags === undefined ? {} : { flags: options.flags }),
});

export const messagePayload = (content: string, options: MessageOptions = {}): string =>
  JSON.stringify(messageBody(content, options));

/** A notification rendered for a transport that can carry components. */
export interface Rendered {
  readonly content: string;
  readonly components?: readonly ActionRow[];
}

/**
 * Message body for a transport with no components — the webhook.
 *
 * Pure function so it is testable without a webhook. Ends with the typed reply
 * instruction, which on this transport is the only way to answer.
 */
export const render = (notification: Notification): string => frame(notification, true);

/**
 * Message body for the bot transport, with buttons instead of typing instructions.
 *
 * Falls back to the plain form whenever no component could be built — a task id long
 * enough to blow the 100-character `custom_id` budget is rare but not impossible, and a
 * message with neither a button nor an instruction would be a dead end.
 */
export const renderInteractive = (notification: Notification): Rendered => {
  const components = componentsFor(notification);
  return components === undefined
    ? { content: frame(notification, true) }
    : { content: frame(notification, false), components };
};

/**
 * Parts a notification is sent as, in order. One for everything except a QUESTION.
 *
 * A question is split rather than truncated, because a truncated question is not a
 * shorter notification — it is an unanswerable one. Any button goes on the LAST part,
 * where a reader has arrived having seen the whole thing; putting it on the first would
 * invite an answer to the half that fitted.
 */
export const renderParts = (
  notification: Notification,
  options: { readonly interactive: boolean },
): readonly Rendered[] => {
  const components = options.interactive ? componentsFor(notification) : undefined;
  const hint = components === undefined;

  if (notification.kind !== "question") {
    const content = frame(notification, hint);
    return [{ content, ...(components === undefined ? {} : { components }) }];
  }

  const { task, phase, question } = notification;
  const head = [`**${task}** needs input`, `Phase: ${phase}`, ""].join("\n");
  const tail = hint ? `\n\nReply: \`!answer ${task} <your answer>\`` : "";

  // One budget for every part, sized against the LARGEST frame any of them can take.
  // A few dozen wasted characters buys chunking that cannot depend on the part count,
  // which is not known until after the split.
  const overhead = Math.max(size(head), size(`**${task}** (99/99)\n`)) + size(tail);
  const chunks = chunkProse(question, Math.max(CONTENT_LIMIT - overhead, MIN_CHUNK));

  const kept = chunks.slice(0, MAX_PARTS);
  // A question this long is itself a bug; the cap stops one pathological session from
  // posting fifty messages, and says where the rest is rather than dropping it silently.
  const clipped =
    chunks.length > MAX_PARTS
      ? `\n\n… ${chunks.length - MAX_PARTS} more part(s) not shown — read \`tasks/${task}/questions/\` in the state repo.`
      : "";

  return kept.map((chunk, index) => {
    const last = index === kept.length - 1;
    const prefix = index === 0 ? head : `**${task}** (${index + 1}/${kept.length})\n`;
    const suffix = last ? clipped + tail : "";

    // The PROSE gives way to the frame, never the other way round. Clipping the tail of
    // the assembled string would take the reply instruction with it — and, on a capped
    // question, the very notice saying more exists. Both are the parts a reader needs
    // most, and both sit at the end.
    const room = Math.max(CONTENT_LIMIT - size(prefix) - size(suffix), 0);
    return {
      content: `${prefix}${take(chunk, room)}${suffix}`,
      ...(last && components !== undefined ? { components } : {}),
    };
  });
};

/** Most parts a question is ever split into, before it points at the state repo instead. */
const MAX_PARTS = 6;
/** Floor on a part's prose budget, so a pathological task id cannot drive it to zero. */
const MIN_CHUNK = 200;

/**
 * Split prose into pieces that each fit `budget` code points.
 *
 * Line boundaries first: agent prose is markdown, and a split mid-bullet reads as two
 * broken bullets rather than one continued list. A single line longer than the budget —
 * a pasted stack trace, a one-paragraph wall — is hard-split, because the alternative is
 * a part that does not fit and a 400 from Discord.
 */
export const chunkProse = (text: string, budget: number): readonly string[] => {
  const parts: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = "";
  };

  for (const line of text.split("\n")) {
    if (size(line) > budget) {
      flush();
      for (const piece of hardSplit(line, budget)) parts.push(piece);
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (size(candidate) > budget) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  return parts.length === 0 ? [""] : parts;
};

/** Code-point-aware split of one over-long line. Never produces a lone surrogate. */
const hardSplit = (line: string, budget: number): readonly string[] => {
  const points = [...line];
  const pieces: string[] = [];
  for (let at = 0; at < points.length; at += budget) {
    pieces.push(points.slice(at, at + budget).join(""));
  }
  return pieces;
};

/** The buttons a notification carries, if any. Pure; undefined means "none fit". */
export const componentsFor = (notification: Notification): readonly ActionRow[] | undefined => {
  switch (notification.kind) {
    case "question":
      return rows(
        row(
          button({
            action: { verb: "ans", task: notification.task },
            label: "Answer",
            style: BUTTON_STYLE.primary,
          }),
        ),
      );
    case "done":
      return rows(row(linkButton("View PR", notification.prUrl)));
    case "verdict":
      return notification.prUrl === undefined
        ? undefined
        : rows(row(linkButton("View PR", notification.prUrl)));
    case "review-stalled":
      return rows(
        row(
          notification.canMerge
            ? button({
                action: { verb: "merge", task: notification.task },
                label: "Merge anyway",
                style: BUTTON_STYLE.danger,
              })
            : undefined,
          notification.prUrl === undefined ? undefined : linkButton("View PR", notification.prUrl),
        ),
      );
    case "parked":
    case "failed":
    case "plan-ready":
    case "plan-revised":
      return undefined;
  }
};

const frame = (notification: Notification, hint: boolean): string => {
  const task = notification.task;

  switch (notification.kind) {
    case "question": {
      const { phase, question } = notification;
      return fit(question, (text) =>
        [
          `**${task}** needs input`,
          `Phase: ${phase}`,
          "",
          text,
          ...(hint ? ["", `Reply: \`!answer ${task} <your answer>\``] : []),
        ].join("\n"),
      );
    }
    case "parked":
      return fit(notification.reason, (text) => `**${task}** parked — ${text}`);
    case "done": {
      const note = notification.note;
      return fit(notification.prUrl, (text) =>
        `**${task}** done — ${text}${note === undefined ? "" : `\n${note}`}`,
      );
    }
    case "verdict":
      return fit(
        notification.summary,
        (text) => `**${task}** — review council requested changes.\n${text}\nBack to the agent.`,
      );
    case "review-stalled":
      return fit(
        notification.summary,
        (text) =>
          [
            `**${task}** parked — the review council requested changes ${notification.rounds} times.`,
            "",
            text,
            "",
            notification.canMerge
              ? "Merge it as it stands, or leave it parked and pick it up by hand."
              : "No reviewer identity is configured, so merging is yours to do.",
          ].join("\n"),
      );
    case "plan-ready": {
      const waves = new Map<number, TaskId[]>();
      for (const child of notification.tasks) {
        waves.set(child.wave, [...(waves.get(child.wave) ?? []), child.id]);
      }
      const lines = [...waves.entries()]
        .sort(([a], [b]) => a - b)
        .map(([wave, ids]) => `**Wave ${wave}:** ${ids.map((id) => `\`${id}\``).join(", ")}`);

      return fit(lines.join("\n"), (text) =>
        [
          `**${task}** — plan accepted: ${notification.title}`,
          `${notification.tasks.length} task(s) created.`,
          "",
          text,
          "",
          "Wave 0 is claimable now. Later waves unblock as their blockers finish.",
        ].join("\n"),
      );
    }
    case "plan-revised":
      return fit(
        notification.note,
        (text) =>
          `**${task}** — plan graph revised, ${notification.changed} task(s) rescheduled.\n${text}`,
      );
    case "failed":
      return fit(notification.error, (text) => `**${task}** failed — ${text}`);
  }
};

/**
 * Assemble a message, truncating the PROSE rather than the finished string.
 *
 * Clipping the tail of the assembled message would take the reply instruction with
 * it — the one part of a question notification that tells a human what to do next.
 * The budget is measured against the real frame, so the result is at the limit rather
 * than at a guess about how big the frame might be.
 */
const fit = (prose: string, assemble: (text: string) => string): string => {
  const full = assemble(prose);
  if (size(full) <= CONTENT_LIMIT) return full;

  const budget = CONTENT_LIMIT - size(assemble("")) - size(TRUNCATED);
  return assemble(take(prose, Math.max(budget, 0)) + TRUNCATED);
};

/**
 * Code points, not UTF-16 units: Discord counts the former, and slicing the latter
 * can split a surrogate pair into a lone surrogate that JSON.stringify happily encodes
 * and Discord then rejects as invalid — a 400 that only ever appears for emoji.
 */
const size = (text: string): number => [...text].length;

export const take = (text: string, limit: number): string => {
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join("");
};

/** No-op notifier for local runs and tests. */
export class NullNotifier implements Notifier {
  async notify(_notification: Notification, _target?: NotifyTarget): Promise<void> {
    // intentionally silent
  }
}
