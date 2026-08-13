/**
 * Discord notifications. See DESIGN.md §11.
 *
 * Discord is a SIGNAL channel, not a log stream: questions, parks, and terminal
 * outcomes only. Everything else goes to Prometheus. Handoffs are deliberately
 * silent — a multi-hour task would otherwise produce twenty messages of noise.
 *
 * Traps encoded below, all of them ways a notification is silently LOST rather than
 * loudly broken:
 *   - `content` over 2000 code points is a 400 and the message never appears. An
 *     agent-authored question is exactly the payload that blows the limit, and it is
 *     the one where silence costs the most, so prose is truncated inside the frame.
 *   - mentions in that prose are parsed by default. The agent quotes files it read,
 *     so `@everyone` reaching Discord unsuppressed pages the server.
 *   - a webhook is rate limited per webhook, not per bot, and answers 429 with the
 *     wait in SECONDS. Dropping a park because two tasks finished together defeats
 *     the point of the channel; honouring an hour-long wait blocks the task loop.
 *   - the URL's last path segment IS the credential. It must not reach an error
 *     message, because the supervisor logs those verbatim.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { TaskId } from "../domain/task.ts";

export type Notification =
  | { readonly kind: "question"; readonly task: TaskId; readonly question: string; readonly phase: string }
  | { readonly kind: "parked"; readonly task: TaskId; readonly reason: string }
  | { readonly kind: "done"; readonly task: TaskId; readonly prUrl: string }
  | { readonly kind: "failed"; readonly task: TaskId; readonly error: string };

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

/** Injection seam for tests. Production uses the global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

/**
 * Ceiling on an honoured `retry_after`. notify() is awaited inside the task loop, so
 * an obedient wait on a long rate limit stops the runner working on anything at all.
 * Past this the notification is retried early and may fail — losing a signal message
 * is cheaper than stalling the supervisor.
 */
const MAX_RETRY_DELAY_MS = 10_000;

const BASE_BACKOFF_MS = 500;

const DEFAULT_MAX_RETRIES = 3;

/** Status and body only — never the URL, which carries the webhook token. */
export class DiscordWebhookError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Discord webhook rejected the message with ${status}: ${body.slice(0, 400)}`);
    this.name = "DiscordWebhookError";
  }
}

export class DiscordNotifier implements Notifier {
  private readonly http: FetchLike;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(private readonly options: DiscordOptions) {
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
    this.pause = options.sleep ?? ((ms) => sleep(ms));
  }

  async notify(notification: Notification): Promise<void> {
    const body = JSON.stringify({
      // render() already fits the limit around its frame; this backstop covers the
      // case the frame ITSELF is oversized, which a long task id is enough to do.
      content: take(render(notification), CONTENT_LIMIT),
      // Explicit, because Discord's default is to parse every mention in the text.
      allowed_mentions: { parse: [] },
    });
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;

    for (let attempt = 0; ; attempt++) {
      const response = await this.http(this.options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      // 204 No Content is the success case; there is nothing to parse.
      if (response.ok) return;

      const detail = await response.text();
      // Everything else is permanent: a 404 is a webhook deleted in the UI, a 400 is a
      // body Discord will reject identically forever. Retrying those buys nothing and
      // delays the operator seeing the one error that needs them.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new DiscordWebhookError(response.status, detail);
      }

      await this.pause(retryDelayMs(response, detail, attempt));
    }
  }
}

/** Message body. Pure function so it is testable without a webhook. */
export const render = (notification: Notification): string => {
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
          "",
          `Reply: \`!answer ${task} <your answer>\``,
        ].join("\n"),
      );
    }
    case "parked":
      return fit(notification.reason, (text) => `**${task}** parked — ${text}`);
    case "done":
      return fit(notification.prUrl, (text) => `**${task}** done — ${text}`);
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
 * How long to wait before retrying.
 *
 * Discord answers a 429 with the wait in SECONDS — in the `retry-after` header and,
 * more precisely, as a fractional `retry_after` in the JSON body. Treating either as
 * milliseconds retries instantly and earns a second rate limit.
 */
const retryDelayMs = (response: Response, body: string, attempt: number): number => {
  const advertised = retryAfterSeconds(response, body);
  const wanted =
    advertised === undefined ? BASE_BACKOFF_MS * 2 ** attempt : Math.ceil(advertised * 1000);

  return Math.min(Math.max(wanted, BASE_BACKOFF_MS), MAX_RETRY_DELAY_MS);
};

const retryAfterSeconds = (response: Response, body: string): number | undefined => {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "retry_after" in parsed) {
      const value = (parsed as { readonly retry_after: unknown }).retry_after;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  } catch {
    // Not JSON — a proxy's HTML error page, most likely. Fall back to backoff.
  }
  return undefined;
};

/**
 * Code points, not UTF-16 units: Discord counts the former, and slicing the latter
 * can split a surrogate pair into a lone surrogate that JSON.stringify happily encodes
 * and Discord then rejects as invalid — a 400 that only ever appears for emoji.
 */
const size = (text: string): number => [...text].length;

const take = (text: string, limit: number): string => {
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join("");
};

/** No-op notifier for local runs and tests. */
export class NullNotifier implements Notifier {
  async notify(): Promise<void> {
    // intentionally silent
  }
}
