/**
 * The bot's REST half. See DESIGN.md §7.
 *
 * Deliberately not the webhook, for two reasons that have both been paid for:
 *
 *   - a bridge that can read commands should be able to answer them without a second
 *     secret, and a reply arriving under the bot's own name is the one a human expects;
 *   - **only this transport can carry buttons.** Discord refuses interactive components
 *     from a webhook an application does not own, and `webhook-url` is a webhook created
 *     in the channel's settings, not by the application. Every message with a component
 *     on it comes from here.
 *
 * The two halves stay independent: an unsealed webhook costs notifications, not replies,
 * and a missing bot token costs buttons, not the channel.
 */
import {
  messagePayload,
  type MessageOptions,
  type Notification,
  type Notifier,
  type NotifyTarget,
  renderParts,
} from "./discord.ts";
import { type FetchLike, postJson } from "./http.ts";
import type { ThreadIndex } from "./threads.ts";

export const API_BASE = "https://discord.com/api/v10";

/**
 * How long a brainstorm thread stays visible after the last message, in minutes.
 * A day: long enough that an overnight question is still in the sidebar in the morning,
 * short enough that abandoned threads fall out of it on their own.
 */
const THREAD_ARCHIVE_MINUTES = 1440;

export interface BotOptions {
  readonly token: string;
  /** The channel the bot reads and writes. Everything else in the guild is ignored. */
  readonly channelId: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly apiBase?: string;
}

export interface PostedMessage {
  readonly id: string;
  readonly channelId: string;
}

export class DiscordBot {
  private readonly options: BotOptions;
  private readonly apiBase: string;

  constructor(options: BotOptions) {
    this.options = options;
    this.apiBase = options.apiBase ?? API_BASE;
  }

  get channelId(): string {
    return this.options.channelId;
  }

  /**
   * The bot token, for the gateway's IDENTIFY.
   *
   * Both halves of §7 authenticate with the same credential, so the composition root
   * reads it back off the bot rather than threading it separately. It is never logged
   * and never reaches a subprocess — unlike a forge token (§9.2), it does not go near
   * an agent, a worktree, or `argv`.
   */
  get token(): string {
    return this.options.token;
  }

  /**
   * Send a message as the bot. Returns its id, which is what a thread is opened on.
   *
   * `channelId` overrides the configured channel — a thread IS a channel, so posting
   * into one is the same call with a different id.
   */
  async postMessage(options: {
    readonly content: string;
    readonly channelId?: string;
    readonly components?: MessageOptions["components"];
    readonly flags?: number;
  }): Promise<PostedMessage> {
    const channelId = options.channelId ?? this.options.channelId;
    const response = await this.post(
      `/channels/${channelId}/messages`,
      messagePayload(options.content, {
        ...(options.components === undefined ? {} : { components: options.components }),
        ...(options.flags === undefined ? {} : { flags: options.flags }),
      }),
      "bot message",
    );

    const body = (await response.json().catch(() => ({}))) as { readonly id?: string };
    return { id: body.id ?? "", channelId };
  }

  /**
   * Show the typing indicator in a channel. Discord keeps it up for ~10 seconds.
   *
   * Best-effort and deliberately silent on failure: it is a comfort signal, and a
   * rate-limited one must never surface as an error next to real work.
   */
  async typing(channelId?: string): Promise<void> {
    await this.post(`/channels/${channelId ?? this.options.channelId}/typing`, "{}", "typing")
      .catch(() => undefined);
  }

  /**
   * The parent channel of `channelId`, or undefined if it has none or cannot be read.
   *
   * `MESSAGE_CREATE` names no parent (see `threads.ts`), so this is the only way to tell
   * "a reply in a thread of our channel whose binding has not arrived yet" from "a message
   * in an unrelated channel". The standalone bot needs that distinction to answer honestly
   * instead of dropping the message — see `ThreadRouter` in `threads.ts`.
   *
   * Best-effort: a failure resolves to undefined rather than throwing, because the caller's
   * fallback (treat it as not ours) is the same as it was before this existed.
   */
  async parentChannel(channelId: string): Promise<string | undefined> {
    const response = await postJson({
      url: `${this.apiBase}/channels/${channelId}`,
      body: "",
      what: "channel lookup",
      method: "GET",
      headers: { authorization: `Bot ${this.options.token}` },
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    }).catch(() => undefined);
    if (response === undefined) return undefined;

    const body = (await response.json().catch(() => ({}))) as { readonly parent_id?: string | null };
    return body.parent_id ?? undefined;
  }

  /** Open a public thread on a message. Returns the thread's channel id. */
  async createThread(messageId: string, name: string): Promise<string> {
    const response = await this.post(
      `/channels/${this.options.channelId}/messages/${messageId}/threads`,
      JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: THREAD_ARCHIVE_MINUTES }),
      "thread",
    );

    const body = (await response.json().catch(() => ({}))) as { readonly id?: string };
    if (body.id === undefined) throw new Error("Discord created a thread with no id");
    return body.id;
  }

  /**
   * Archive a thread — Discord's "this conversation is over".
   *
   * Not deletion: deleting needs Manage Threads, which this bot deliberately does not
   * have, and an archived thread keeps its history where a deleted one loses the
   * refinement that produced a plan. Posting in an archived thread un-archives it, so
   * this closes a conversation without locking anyone out of it.
   */
  async archiveThread(threadId: string): Promise<void> {
    await this.post(`/channels/${threadId}`, JSON.stringify({ archived: true }), "thread archive", "PATCH");
  }

  private post(path: string, body: string, what: string, method = "POST"): Promise<Response> {
    return postJson({
      url: `${this.apiBase}${path}`,
      body,
      what,
      method,
      headers: { authorization: `Bot ${this.options.token}` },
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    });
  }
}

/**
 * Ends a thread's conversation. See DESIGN.md §14.3.
 *
 * Order matters: say why FIRST, then archive. An archived thread that just stops, with
 * no last word, reads as the bot having died rather than having finished.
 */
export interface ThreadCloser {
  close(threadId: string, note: string): Promise<void>;
}

export class BotThreadCloser implements ThreadCloser {
  private readonly bot: DiscordBot;
  private readonly index: ThreadIndex;

  constructor(bot: DiscordBot, index: ThreadIndex) {
    this.bot = bot;
    this.index = index;
  }

  /** Never throws: a task is parked in git before this runs, and git is what counts. */
  async close(threadId: string, note: string): Promise<void> {
    // Unbound first, so a message racing the archive is dropped rather than queued as an
    // answer to a task that has just been parked.
    this.index.unbind(threadId);
    await this.bot.postMessage({ content: note, channelId: threadId }).catch(() => undefined);
    await this.bot.archiveThread(threadId).catch(() => undefined);
  }
}

/**
 * Notifications sent as the bot, with buttons.
 *
 * Preferred over `DiscordNotifier` whenever a bot token exists, because a question a
 * human can answer by clicking is the entire point of §7's second half. Falls back to
 * the plain frame per notification when no component fits — see `renderInteractive`.
 */
/**
 * Discord's typing indicator, held for as long as a session runs. See DESIGN.md §7.1.
 *
 * The channel is otherwise silent between a question and its answer — handoffs are
 * deliberately not notified (§11), so a task that has been thinking for forty minutes
 * looks identical to one that has died. "Caterpillar is typing…" costs one request every
 * eight seconds and answers the only question a human actually has while waiting.
 *
 * Eight, not ten: Discord holds the indicator for about ten seconds, and refreshing at
 * exactly that interval leaves a visible gap every cycle.
 */
const TYPING_REFRESH_MS = 8_000;

export interface Presence {
  /** Start showing activity in `channelId`. The returned function stops it. */
  working(channelId: string): () => void;
}

export class BotPresence implements Presence {
  private readonly bot: DiscordBot;

  constructor(bot: DiscordBot) {
    this.bot = bot;
  }

  working(channelId: string): () => void {
    void this.bot.typing(channelId);
    const timer = setInterval(() => void this.bot.typing(channelId), TYPING_REFRESH_MS);
    // Unref'd: a comfort signal must never be the reason the process will not exit.
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

export class BotNotifier implements Notifier {
  private readonly bot: DiscordBot;

  constructor(bot: DiscordBot) {
    this.bot = bot;
  }

  async notify(notification: Notification, target: NotifyTarget = {}): Promise<void> {
    // Sequential, not concurrent: Discord does not order simultaneous posts, and a
    // question whose parts arrive shuffled is barely better than a truncated one.
    for (const part of renderParts(notification, {
      interactive: true,
      inThread: target.threadId !== undefined,
    })) {
      await this.bot.postMessage({
        content: part.content,
        // A thread IS a channel, so posting into one is the same call with a different id.
        ...(target.threadId === undefined ? {} : { channelId: target.threadId }),
        ...(part.components === undefined ? {} : { components: part.components }),
      });
    }
  }
}
