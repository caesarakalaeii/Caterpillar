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
import type { TaskId } from "../domain/task.ts";
import {
  messagePayload,
  type MessageOptions,
  type Notification,
  type Notifier,
  type NotifyTarget,
  renderParts,
} from "./discord.ts";
import { type FetchLike, postJson } from "./http.ts";
import { MessageIndex, taskFromContent } from "./messages.ts";
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
  /**
   * Where a task-scoped message this bot posts is remembered, for reply targeting (§7.3).
   *
   * Absent is the production shape: one is created here, and every reader goes through
   * `taskForMessage` on this same instance — the notifier and the bridge share one
   * `DiscordBot` (`index.ts:loadDiscord`), so they share the index without wiring. It is
   * injectable only so a test can seed it and assert on what was recorded.
   */
  readonly messages?: MessageIndex;
}

export interface PostedMessage {
  readonly id: string;
  readonly channelId: string;
}

export class DiscordBot {
  private readonly options: BotOptions;
  private readonly apiBase: string;
  private readonly messages: MessageIndex;

  constructor(options: BotOptions) {
    this.options = options;
    this.apiBase = options.apiBase ?? API_BASE;
    this.messages = options.messages ?? new MessageIndex();
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
   *
   * `task` names what the message is ABOUT, and is what makes a later reply to it
   * placeable (§7.3). Every caller that knows a task passes it; the brainstorm's opening
   * message and the honest "I cannot place this thread" reply do not, because neither is
   * about a task that exists yet.
   */
  async postMessage(options: {
    readonly content: string;
    readonly channelId?: string;
    readonly components?: MessageOptions["components"];
    readonly flags?: number;
    readonly task?: TaskId;
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
    const id = body.id ?? "";
    // An empty id means Discord accepted the post and told us nothing useful about it.
    // Recording it would make every such message collide on one key.
    if (options.task !== undefined && id.length > 0) this.messages.record(id, options.task);
    return { id, channelId };
  }

  /**
   * The task a message is about, from the in-memory index alone. Costs nothing.
   *
   * The first tier of reply targeting (§7.3). Undefined for a message this process did not
   * post, one posted before a restart, or one evicted — `taskForFetchedMessage` is the
   * fallback for all three, and rank is the fallback for that.
   */
  taskForMessage(messageId: string): TaskId | undefined {
    return this.messages.taskFor(messageId);
  }

  /**
   * The task a message is about, by reading the message back from Discord.
   *
   * The second tier, and the one that survives a restart: a live thread whose question was
   * posted by a previous process — or, in the split deployment (§7), by the supervisor
   * rather than by the process holding the index — is still placeable, because every
   * task-scoped message opens with its id in bold.
   *
   * Best-effort, like `parentChannel`: a message the bot cannot see, a malformed body and a
   * body whose text names no task all resolve to undefined, because the caller's fallback
   * is the same for all three.
   */
  async taskForFetchedMessage(channelId: string, messageId: string): Promise<TaskId | undefined> {
    const response = await postJson({
      url: `${this.apiBase}/channels/${channelId}/messages/${messageId}`,
      // Never sent: `postJson` drops the body for a GET, because `fetch` refuses one with a
      // synchronous throw (`http.ts:BODILESS_METHODS`). Written as `""` to match
      // `parentChannel`, the call that taught that lesson.
      body: "",
      what: "message lookup",
      method: "GET",
      headers: { authorization: `Bot ${this.options.token}` },
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    }).catch(() => undefined);
    if (response === undefined) return undefined;

    const body = (await response.json().catch(() => ({}))) as { readonly content?: string };
    return body.content === undefined ? undefined : taskFromContent(body.content);
  }

  /**
   * React to a message as the bot. Returns whether the reaction landed.
   *
   * The acknowledgement for a steer (DESIGN.md §7.3), and a reaction rather than a reply
   * because of what a thread is used for: refining an idea is many short messages (§14.3),
   * and a line of confirmation under each one turns a conversation into a wall of receipts.
   * §7.1 chose SILENCE over that, and was right about the noise and wrong about the silence —
   * a human could not tell "delivered to the session" from "discarded", and for a long time
   * it was discarded.
   *
   * The boolean is the point. Reactions need `ADD_REACTIONS`, which an existing installation
   * may not have granted, and an ack that silently does not happen is the failure this is
   * fixing. The caller falls back to saying it in words.
   */
  async react(channelId: string, messageId: string, emoji: string): Promise<boolean> {
    // Percent-encoded whole: the emoji is a path segment, and `@me` after it is Discord's
    // way of saying "the current user" rather than a user id.
    const encoded = encodeURIComponent(emoji);
    const response = await postJson({
      url: `${this.apiBase}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
      // `{}` and not `""`. The endpoint takes no body, but every request from this client
      // carries `content-type: application/json`, and Discord answers an empty body under
      // that header with a 400 rather than ignoring it.
      body: "{}",
      what: "reaction",
      method: "PUT",
      headers: { authorization: `Bot ${this.options.token}` },
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    }).catch(() => undefined);
    return response !== undefined;
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
        // What makes a reply to this notification placeable (§7.3). Tested with `in` rather
        // than against a list of kinds, because two of them — a digest, which is about the
        // fleet, and a refused alert, which never became a task — legitimately name none,
        // and a list would have to be revisited every time a kind is added.
        ...("task" in notification ? { task: notification.task } : {}),
      });
    }
  }
}
