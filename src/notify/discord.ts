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
import type { ReportSource, TaskId } from "../domain/task.ts";
import {
  button,
  BUTTON_STYLE,
  BUTTONS_PER_ROW,
  encodeReport,
  linkButton,
  row,
  rows,
  type ActionRow,
  type Button,
} from "./components.ts";
import { type FetchLike, postJson } from "./http.ts";

export type Notification =
  | {
      readonly kind: "question";
      readonly task: TaskId;
      readonly question: string;
      readonly phase: string;
      /**
       * The enumerated choices the agent offered, each of which becomes a button (§7).
       *
       * Absent for an open-ended question, which is the ordinary case and renders exactly
       * as it always has. The prose is unaffected either way: the options are already in
       * the question text, written by the agent, and repeating them under it would say the
       * same thing twice on the surface where space is scarcest.
       */
      readonly options?: readonly string[];
    }
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
      /** The one-line form — which lenses objected. */
      readonly summary: string;
      /**
       * WHAT they objected to. Required, not optional, because this notification without it
       * is the thing that made a rejection unreadable: `blocked by feasibility` names a
       * lens and nothing to act on, and a reader watching the same task come back three
       * times had no way to tell whether the objection was even the same one twice.
       */
      readonly detail: string;
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
      /** The blocking objections themselves — see `verdict.detail`. */
      readonly detail: string;
      readonly prUrl?: string;
      /**
       * Whether a Merge button would actually work. False without a reviewer identity:
       * branch protection refuses a merge from the App that authored the PR, so the
       * button would fail every time it was pressed (§9.1).
       */
      readonly canMerge: boolean;
    }
  /**
   * A brainstorm's plan was refused often enough to stop trying (DESIGN.md §14.3).
   *
   * `review-stalled`'s counterpart for the plan path, and separate from it because the two
   * offer different things. A stalled implementation has a PR, so the human's option is to
   * merge it anyway; a stalled brainstorm has produced no change at all, so the only way
   * forward is to tell it what to do differently and resume it. Sending the implementation
   * notification here offered a Merge button for a pull request that does not exist.
   */
  | {
      readonly kind: "plan-stalled";
      readonly task: TaskId;
      readonly rounds: number;
      readonly summary: string;
      readonly detail: string;
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
  | { readonly kind: "failed"; readonly task: TaskId; readonly error: string }
  /**
   * A firing alert became a task (DESIGN.md §20). The intake notification of the fifth
   * intake path: an operator who is looking at the alert should be able to see, in the same
   * channel, that the fleet has already picked it up.
   */
  | {
      readonly kind: "alert-task";
      readonly task: TaskId;
      readonly alertname: string;
      readonly severity?: string;
    }
  /**
   * A schedule's occurrence became a task (DESIGN.md §22). The intake notification of the
   * sixth path onto the channel: work nobody typed appeared, so the channel is where anyone
   * finds out it did.
   *
   * A SKIPPED occurrence is deliberately not notified. A precheck that says "nothing to
   * audit" is the normal case for a schedule worth having, and a message per occurrence per
   * schedule would make the channel a cron log — which is what the ledger under
   * `schedules/occurrences/` and the `/intake` page are for.
   */
  | {
      readonly kind: "schedule-task";
      readonly task: TaskId;
      readonly schedule: string;
      /** `YYYY-MM-DDTHHMMZ`, so a reader can tell which morning this is about. */
      readonly occurrence: string;
    }
  /**
   * A firing alert was declined, and this is the ONE message about it.
   *
   * Sent once per alert per reason, never once per delivery: Alertmanager re-sends a firing
   * alert every few minutes, and the durable record under `alerts/refusals/` is what makes
   * the second delivery silent (§20). The `detail` is supervisor-authored prose, not
   * anything from the payload.
   */
  | {
      readonly kind: "alert-refused";
      readonly alertname: string;
      readonly fingerprint: string;
      readonly detail: string;
    }
  /**
   * A merged remediation fix was re-checked against the alert it was for (§20).
   *
   * Sent for BOTH outcomes, which is the whole point of it: before this, a fix that ended
   * the incident and a fix that changed nothing produced the same silence, and the only
   * signal was a human noticing the alert was still there weeks later.
   *
   * `cleared` is the verdict and `detail` is the one-line sentence `describeVerdict` wrote,
   * so Discord, the journal and the digest all quote the same words.
   */
  | {
      readonly kind: "alert-reverified";
      readonly task: TaskId;
      readonly alertname: string;
      /** True only on positive evidence that the alert stopped. Never on silence. */
      readonly cleared: boolean;
      readonly detail: string;
    }
  /**
   * The model provider stopped answering and this runner is sitting it out (§6.3).
   *
   * Sent ONCE per incident, not once per attempt: the runner keeps re-checking on a
   * back-off, and a message each time would be the notification equivalent of the retry
   * storm this whole path exists to stop. The task named is the one that met the wall —
   * it is not at fault and is left claimable.
   */
  | {
      readonly kind: "provider-unavailable";
      readonly task: TaskId;
      readonly detail: string;
      readonly retryInSeconds: number;
    }
  /** ...and once when it answers again, so the silence has an end a human can see. */
  | { readonly kind: "provider-recovered"; readonly task: TaskId }
  /**
   * The day's digest (DESIGN.md §19). The only notification about the FLEET rather than
   * about one task, which is why it is the only one with no `task`.
   *
   * `body` is a whole document and routinely exceeds Discord's limit, so it is split
   * exactly as a question is: a digest cut off mid-task is a digest that is silent about
   * whatever came after the cut, and the reader cannot tell that anything was.
   */
  | {
      readonly kind: "digest";
      /** `YYYY-MM-DD` of the day it covers. */
      readonly date: string;
      /** The one-line count. Repeated as the header of every part after the first. */
      readonly summary: string;
      readonly body: string;
    };

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
  options: { readonly interactive: boolean; readonly inThread?: boolean },
): readonly Rendered[] => {
  const components = options.interactive
    ? componentsFor(notification, { inThread: options.inThread === true })
    : undefined;
  const hint = components === undefined;

  if (notification.kind === "digest") return digestParts(notification);

  if (notification.kind !== "question") {
    const content = frame(notification, hint);
    return [{ content, ...(components === undefined ? {} : { components }) }];
  }

  const { task, phase, question } = notification;
  const head = [`**${task}** needs input`, `Phase: ${phase}`, ""].join("\n");
  // In its own thread the answer is just the next message, so the instruction says so.
  // Elsewhere the task has to be named, because the channel carries every task at once.
  const tail =
    options.inThread === true
      ? "\n\nReply in this thread — no command needed."
      : hint
        ? `\n\nReply: \`!answer ${task} <your answer>\``
        : "";

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

/**
 * A digest, split across as many messages as it takes.
 *
 * The document already opens with its own heading, so only the continuation parts carry
 * one — and they carry the day and the counts, because a reader scrolling into part three
 * of a message that arrived while they were away has no other way to tell what it belongs
 * to. Past the cap it stops and says where the whole thing is: a digest is a summary of a
 * record that is in git either way, so pointing at the record beats posting fifteen
 * messages into a channel.
 */
const digestParts = (
  notification: Notification & { readonly kind: "digest" },
): readonly Rendered[] => {
  const { date, summary, body } = notification;

  const header = `**Daily digest — ${date}** · ${summary}\n`;
  const overhead = size(header) + size(DIGEST_TAIL(date));
  const chunks = chunkProse(body, Math.max(CONTENT_LIMIT - overhead, MIN_CHUNK));
  const kept = chunks.slice(0, MAX_DIGEST_PARTS);
  const clipped = chunks.length > MAX_DIGEST_PARTS ? DIGEST_TAIL(date) : "";

  return kept.map((chunk, index) => {
    const prefix = index === 0 ? "" : `${header}(${index + 1}/${kept.length})\n\n`;
    const suffix = index === kept.length - 1 ? clipped : "";
    const room = Math.max(CONTENT_LIMIT - size(prefix) - size(suffix), 0);
    return { content: `${prefix}${take(chunk, room)}${suffix}` };
  });
};

const DIGEST_TAIL = (date: string): string =>
  `\n\n… the rest is in \`digests/${date}.md\` in the state repo.`;

/** Messages one digest may occupy. Four is a scroll; fifteen is a channel nobody reads. */
const MAX_DIGEST_PARTS = 4;

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
  let current: string[] = [];

  const used = (): number => size(current.join("\n"));
  const flush = (): void => {
    if (current.length > 0) parts.push(current.join("\n"));
    current = [];
  };
  const fits = (block: string): boolean =>
    used() + (current.length === 0 ? 0 : 1) + size(block) <= budget;

  for (const segment of segments(text)) {
    if (segment.kind === "text") {
      for (const line of segment.lines) {
        if (size(line) > budget) {
          flush();
          for (const piece of hardSplit(line, budget)) parts.push(piece);
          continue;
        }
        if (!fits(line)) flush();
        current.push(line);
      }
      continue;
    }

    // A FENCED BLOCK IS ATOMIC while it can be. Split across two messages it leaves the
    // first with an unterminated fence — Discord renders the whole tail as code — and the
    // second opening a block that was never meant to start. Everything after it in the
    // conversation is then formatted wrong.
    const whole = fence(segment.open, segment.lines);
    if (fits(whole)) {
      current.push(whole);
      continue;
    }
    if (size(whole) <= budget) {
      // It does not fit HERE but fits in a message of its own. Move it whole.
      flush();
      current.push(whole);
      continue;
    }

    // Genuinely too big for one message. Now it must be split — so each piece closes its
    // own fence and the next reopens it, carrying the language so highlighting survives.
    flush();
    for (const piece of splitFence(segment, budget)) parts.push(piece);
  }
  flush();

  return parts.length === 0 ? [""] : parts;
};

/** An opening fence line: ``` optionally followed by a language. */
const FENCE = /^[ \t]*```/;

type Segment =
  | { readonly kind: "text"; readonly lines: readonly string[] }
  | { readonly kind: "fence"; readonly open: string; readonly lines: readonly string[] };

/**
 * Split prose into fenced blocks and the text between them.
 *
 * A fence left unclosed at the end of the text is treated as running to the end and is
 * closed on the way out. Agent prose is generated, and a dropped closing fence is a
 * realistic thing for a model to do — repairing it here costs nothing and stops one
 * missing line from formatting the rest of the message as code.
 */
const segments = (text: string): readonly Segment[] => {
  const out: Segment[] = [];
  let text_: string[] = [];
  let open: string | undefined;
  let body: string[] = [];

  for (const line of text.split("\n")) {
    if (open === undefined) {
      if (FENCE.test(line)) {
        if (text_.length > 0) out.push({ kind: "text", lines: text_ });
        text_ = [];
        open = line.trim();
      } else {
        text_.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      out.push({ kind: "fence", open, lines: body });
      open = undefined;
      body = [];
      continue;
    }
    body.push(line);
  }

  if (open !== undefined) out.push({ kind: "fence", open, lines: body });
  if (text_.length > 0) out.push({ kind: "text", lines: text_ });
  return out;
};

const fence = (open: string, lines: readonly string[]): string =>
  [open, ...lines, "```"].join("\n");

/**
 * Split one over-large fenced block, keeping every piece a well-formed block.
 *
 * The budget each piece has for CONTENT is what is left after its own opening and
 * closing fences — the reason a naive line-splitter cannot be reused here.
 */
const splitFence = (segment: Segment & { readonly kind: "fence" }, budget: number): readonly string[] => {
  const overhead = size(segment.open) + size("```") + 2;
  const inner = Math.max(budget - overhead, 1);

  const pieces: string[] = [];
  let body: string[] = [];
  const flush = (): void => {
    if (body.length > 0) pieces.push(fence(segment.open, body));
    body = [];
  };

  for (const line of segment.lines) {
    for (const bit of size(line) > inner ? hardSplit(line, inner) : [line]) {
      if (size([...body, bit].join("\n")) > inner) flush();
      body.push(bit);
    }
  }
  flush();

  return pieces;
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

/**
 * The buttons a notification carries, if any. Pure; undefined means "none fit".
 *
 * The Answer button exists to spare a human retyping a task id in a busy channel. In the
 * task's OWN thread there is no id to retype — the next message is the answer — so the
 * button is pure friction there: a modal to open, for something a keystroke already does.
 */
/**
 * The way back from a park, as a button.
 *
 * Undefined when the task id will not fit a `custom_id` — one missing button, never a message
 * that fails to send (`row` drops it). Which is why the prose of every notification carrying
 * this also names `/resume <id>`: a tracker-derived id can be long enough to lose the button,
 * and a park whose only stated way forward has silently vanished is the failure this whole
 * section is about.
 */
const resumeButton = (task: TaskId): Button | undefined =>
  button({ action: { verb: "res", task }, label: "Resume", style: BUTTON_STYLE.primary });

/**
 * The other answer to a park, as a button.
 *
 * Every notification that offers Resume is asking a human to decide, and the decision has
 * two answers: the task can be OBSOLETE rather than stuck, in which case resuming it buys
 * a session nobody wants. Secondary styling and second position, because that is the rarer
 * answer. Pressing it writes nothing on its own — it opens the modal that asks why.
 */
const doneButton = (task: TaskId): Button | undefined =>
  button({ action: { verb: "done", task }, label: "Mark done", style: BUTTON_STYLE.secondary });

/**
 * The third answer to a rejection: the CRITERION is wrong, not the work (DESIGN.md §12.3).
 *
 * On the three notifications a human reads at the moment they discover that — a verdict
 * naming an impossible criterion, a review that stalled on the same one, and a park — because
 * that is where they are standing, and until amendments existed the only lever was to
 * hand-edit an immutable file in the state repo.
 *
 * Pressing it writes nothing. It opens the modal, pre-filled with the criteria as they stand.
 */
const amendButton = (task: TaskId): Button | undefined =>
  button({ action: { verb: "amd", task }, label: "Amend criteria", style: BUTTON_STYLE.secondary });

/**
 * The agent's own text, offered as a tracker item (DESIGN.md §7).
 *
 * On the three notifications that carry prose the AGENT wrote — a question, a park reason, a
 * verdict — because those are the ones that turn out to be reports. The text is not in the
 * button: the `custom_id` carries the task and a two-character code saying what to file and
 * which text to file it from, and the loop reads the text out of the state repo.
 *
 * Its OWN row, always. Every notification that gets these already carries buttons, `row`
 * throws above five, and a throw here costs the whole message on paths where silence means
 * nobody learns the task is waiting.
 */
const reportRow = (task: TaskId, source: ReportSource): ActionRow | undefined =>
  row(
    button({
      action: { verb: "file", task, arg: encodeReport({ report: "bug", source }) },
      label: "Report a bug",
      style: BUTTON_STYLE.secondary,
    }),
    button({
      action: { verb: "file", task, arg: encodeReport({ report: "feature", source }) },
      label: "Request a feature",
      style: BUTTON_STYLE.secondary,
    }),
  );

export const componentsFor = (
  notification: Notification,
  options: { readonly inThread?: boolean } = {},
): readonly ActionRow[] | undefined => {
  switch (notification.kind) {
    case "question": {
      if (options.inThread === true) return undefined;
      // Sliced rather than trusted. `ask_human` refuses a sixth option, but these arrive
      // from a file in the state repo that a human can edit, and `row` THROWS above five —
      // which would cost the whole notification, on the one path where silence means a
      // human never learns the task is waiting.
      const choices = (notification.options ?? []).slice(0, BUTTONS_PER_ROW);
      // The free-text button keeps its own row, and keeps its label when there is nothing
      // beside it: a question with no options must render exactly what it rendered before
      // options existed. With options it becomes "Answer…", because next to two named
      // choices a bare "Answer" reads as a third one.
      return rows(
        choices.length === 0
          ? undefined
          : row(
              ...choices.map((choice, at) =>
                button({
                  // The INDEX, not the text: `custom_id` holds 100 characters. The text is
                  // looked up from the question record when the press arrives.
                  action: { verb: "opt", task: notification.task, arg: String(at) },
                  // `button` clamps the label to Discord's 45; the stored option is what
                  // gets written as the answer, so nothing is lost by cutting it here.
                  label: choice,
                  style: BUTTON_STYLE.primary,
                }),
              ),
            ),
        row(
          button({
            action: { verb: "ans", task: notification.task },
            label: choices.length === 0 ? "Answer" : "Answer…",
            style: choices.length === 0 ? BUTTON_STYLE.primary : BUTTON_STYLE.secondary,
          }),
        ),
        reportRow(notification.task, "question"),
      );
    }
    case "done":
      return rows(row(linkButton("View PR", notification.prUrl)));
    case "verdict":
      return rows(
        row(
          notification.prUrl === undefined ? undefined : linkButton("View PR", notification.prUrl),
          amendButton(notification.task),
        ),
        reportRow(notification.task, "verdict"),
      );
    // The amend button gets a ROW OF ITS OWN here, and only here. This row already holds four
    // buttons when a merge is possible and a PR exists, and `row` THROWS above five — which
    // would cost the whole notification on the one path where silence means nobody learns the
    // review is stuck. A second row cannot be pushed over the limit by a fifth button
    // somebody adds to the first.
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
          resumeButton(notification.task),
          doneButton(notification.task),
          notification.prUrl === undefined ? undefined : linkButton("View PR", notification.prUrl),
        ),
        row(amendButton(notification.task)),
      );
    // A stalled plan has no PR to link and nothing to merge. What it needs is prose and then
    // a restart, and the restart is the one thing a message can carry: the notification is
    // posted in the thread the prose will be typed in, so the way back belongs in the same
    // place rather than as a command to be retyped underneath it.
    case "plan-stalled":
      return rows(row(resumeButton(notification.task), doneButton(notification.task)));
    // Every other park, for the same reason. `/resume` on something parked is the single most
    // predictable next act in the system, and until now it was the only one with no button.
    //
    // A park also offers to amend and a `failed` does NOT: `failed` is an environment that
    // would not build, which no acceptance list fixes, and a button offering a move that
    // cannot help is worse than no button.
    case "parked":
      return rows(
        row(
          resumeButton(notification.task),
          doneButton(notification.task),
          amendButton(notification.task),
        ),
        reportRow(notification.task, "parked"),
      );
    case "failed":
      return rows(row(resumeButton(notification.task), doneButton(notification.task)));
    // An alert notification is a statement, not a prompt. Creating the task has already
    // happened, and a refusal is fixed by committing a policy entry rather than by
    // pressing anything here.
    case "alert-task":
    case "alert-refused":
    // Nor is a scheduled task: nobody typed it, so there is nothing here anyone is waiting
    // to answer. It is claimed, sessioned and reviewed like every other task.
    case "schedule-task":
    // The failure case IS parked, so it gets the resume button every other park has: the
    // next act on it is a human deciding whether to send a session back at the incident.
    case "alert-reverified":
      return notification.kind === "alert-reverified" && !notification.cleared
        ? rows(row(resumeButton(notification.task)))
        : undefined;
    case "plan-ready":
    case "plan-revised":
    case "provider-unavailable":
    case "provider-recovered":
    // Nothing to press. Everything a digest offers is a link inside its own prose, and a
    // row of buttons on a four-part message would arrive attached to one arbitrary part.
    case "digest":
      return undefined;
  }
};

const frame = (notification: Notification, hint: boolean): string => {
  // Before `task` is read at all: the digest is the one notification about the fleet
  // rather than about a task, so it is the one that does not have one.
  if (notification.kind === "digest") {
    return fit(notification.body, (text) => text);
  }
  // The other notification with no task: the alert was refused, so no task was created and
  // there is nothing to name but the alert itself.
  if (notification.kind === "alert-refused") {
    return fit(notification.detail, (text) =>
      [
        `🔔 **${notification.alertname}** is firing and was NOT turned into a task.`,
        "",
        text,
        "",
        `Fingerprint \`${notification.fingerprint}\`. This is said once, not once per ` +
          `delivery — the decision is recorded in \`alerts/refusals/\` in the state repo.`,
      ].join("\n"),
    );
  }

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
    case "alert-reverified":
      return fit(notification.detail, (text) =>
        notification.cleared
          ? `✅ **${task}** — ${text}. \`${notification.alertname}\` stopped firing after the ` +
            `fix merged, so the task is done.`
          : `⚠️ **${task}** — ${text}. The change merged and passed every gate, but ` +
            `\`${notification.alertname}\` is not settled, so the task is **parked** rather ` +
            `than done. Its dedup record has been reset, freeing \`${notification.alertname}\`'s ` +
            `slot for other firings; \`/resume\` sends a session back at this one.`,
      );
    case "done": {
      const note = notification.note;
      return fit(notification.prUrl, (text) =>
        `**${task}** done — ${text}${note === undefined ? "" : `\n${note}`}`,
      );
    }
    // For all three review outcomes the objections are the PROSE and everything else is
    // the frame, which is what decides what survives Discord's limit: `fit` truncates only
    // what it is given, so the header saying which lenses objected and the footer saying
    // whose move it is are both safe from a verdict that runs long.
    case "verdict":
      return fit(notification.detail, (text) =>
        [
          `**${task}** — the review council requested changes (${notification.summary}).`,
          "",
          text,
          "",
          `Back to the agent by itself — no action needed. Or say what to change in this ` +
            `thread${hint ? ` or with \`!answer ${task} <what to change>\`` : ""}: the session ` +
            `reads it at the end of its current step, and the round count resets with it.`,
        ].join("\n"),
      );
    case "review-stalled":
      return fit(notification.detail, (text) =>
        [
          `**${task}** parked — the review council requested changes ${notification.rounds} times (${notification.summary}).`,
          "",
          text,
          "",
          notification.canMerge
            ? `Merge it as it stands, or say what to change here — then Resume, or ` +
              `\`/resume ${task}\`.`
            : `No reviewer identity is configured, so merging is yours to do. Otherwise say ` +
              `what to change here — then Resume, or \`/resume ${task}\`.`,
        ].join("\n"),
      );
    case "plan-stalled":
      return fit(notification.detail, (text) =>
        [
          `**${task}** parked — the plan was sent back ${notification.rounds} times (${notification.summary}).`,
          "",
          text,
          "",
          // Named explicitly, because this is the park where a human most reliably assumed
          // there was nothing they could do: no PR, no change, and a reason that used to
          // read "the plan was rejected 3 times" and stop there.
          //
          // And it has to be an instruction that WORKS. Every clause of the wording this
          // replaced was broken at once: the notification was posted in the channel rather
          // than the thread it pointed at, the thread was unbound the moment the task parked
          // so nothing typed there was read, and `/resume` in it was refused outright. Saying
          // it more clearly would not have helped. What follows is now true.
          `The council and the agent are not converging on their own — resuming on its own ` +
            `will not get past this. Say what to change here in this thread: I record it and ` +
            `reset the round count, then Resume — or \`/resume ${task}\` — tries again with it.`,
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
    case "alert-task":
      return (
        `🔔 **${notification.alertname}** is firing — created \`${task}\`` +
        `${notification.severity === undefined ? "" : ` (severity ${notification.severity})`}.\n` +
        `It is queued like any other task and ends in a pull request; nothing touches the cluster.`
      );
    case "schedule-task":
      return (
        `🗓️ Schedule **${notification.schedule}** fired for ${notification.occurrence} — ` +
        `created \`${task}\`.\n` +
        `Nobody typed it. It is claimed, sessioned and gated like any other task; if there ` +
        `turns out to be nothing to do, the session says so instead of opening a pull request.`
      );
    case "provider-unavailable":
      return fit(notification.detail, (text) =>
        [
          `⏸️ **Paused — the model provider stopped answering.**`,
          "",
          text,
          "",
          `\`${task}\` was released untouched and nothing is at fault. Retrying in ` +
            `${minutes(notification.retryInSeconds)}, and every ${minutes(notification.retryInSeconds)} ` +
            `after that until it answers.`,
        ].join("\n"),
      );
    case "provider-recovered":
      return `▶️ **The model provider is answering again.** Resumed on \`${task}\`.`;
  }
};

/** A wait, said the way a human reads one. */
const minutes = (seconds: number): string => {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  const value = Math.round(seconds / 60);
  return `${value} minute${value === 1 ? "" : "s"}`;
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
