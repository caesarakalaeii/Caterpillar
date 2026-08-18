/**
 * The one HTTP client every Discord path shares. See DESIGN.md §11.2.
 *
 * It exists because the retry policy was written once, for the webhook, and the bot's
 * REST calls did not have it — they threw on the first 429. That was survivable while
 * the bot only ever answered a typed command. It is not survivable once buttons exist:
 * components cannot ride the incoming webhook at all (Discord refuses them from a
 * webhook an application does not own), so every interactive message goes out over the
 * bot, and the bot is now the hot path.
 *
 * Traps encoded here:
 *   - Discord answers a 429 with the wait in SECONDS, in the `retry-after` header and,
 *     more precisely, as a fractional `retry_after` in the JSON body. Treating either as
 *     milliseconds retries instantly and earns a second rate limit.
 *   - an obedient wait on a long rate limit stalls the caller. This runs inside the task
 *     loop, so the wait is capped and the message is allowed to fail instead.
 *   - a URL can BE a credential (the webhook's last path segment is its token). Nothing
 *     here puts a URL in an error, because the supervisor logs errors verbatim.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** Injection seam for tests. Production uses the global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Ceiling on an honoured `retry_after`. Callers await this inside the task loop, so an
 * obedient wait on a long rate limit stops the runner working on anything at all. Past
 * this the request is retried early and may fail — losing a signal message is cheaper
 * than stalling the supervisor.
 */
const MAX_RETRY_DELAY_MS = 10_000;

const BASE_BACKOFF_MS = 500;

export const DEFAULT_MAX_RETRIES = 3;

/** Status and body only — never the URL, which may carry a token. */
export class DiscordHttpError extends Error {
  readonly status: number;

  constructor(what: string, status: number, body: string) {
    super(`Discord rejected the ${what} with ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.name = "DiscordHttpError";
  }
}

export interface PostOptions {
  readonly url: string;
  readonly body: string;
  /** Named in errors instead of the URL, e.g. "webhook message". */
  readonly what: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  /** Injection seam for tests; production waits for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts after the first, for 429 and 5xx only. */
  readonly maxRetries?: number;
  readonly method?: string;
}

/**
 * POST JSON, retrying only what retrying can fix. Resolves with the successful response.
 *
 * Everything outside 429 and 5xx is permanent: a 404 is a webhook deleted in the UI, a
 * 400 is a body Discord will reject identically forever. Retrying those buys nothing and
 * delays the operator seeing the one error that needs them.
 */
export const postJson = async (options: PostOptions): Promise<Response> => {
  const http = options.fetch ?? ((input, init) => fetch(input, init));
  const pause = options.sleep ?? ((ms: number) => sleep(ms));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    const response = await http(options.url, {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: options.body,
    });

    if (response.ok) return response;

    const detail = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new DiscordHttpError(options.what, response.status, detail);
    }

    await pause(retryDelayMs(response, detail, attempt));
  }
};

/**
 * How long to wait before retrying.
 *
 * Discord answers a 429 with the wait in SECONDS. Treating it as milliseconds retries
 * instantly and earns a second rate limit.
 */
export const retryDelayMs = (response: Response, body: string, attempt: number): number => {
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
