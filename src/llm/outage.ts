/**
 * Telling a provider outage apart from a task failure. See DESIGN.md §6.3.
 *
 * pi does not throw when a provider request fails. The failure comes back as an
 * assistant message with `stopReason: "error"` and an `errorMessage` string, which for
 * the Anthropic SDK is `"<status> <json body>"`. That string is all we get — the
 * response headers are gone by the time it reaches us — so this reads it.
 *
 * The distinction it draws is the one the supervisor acts on:
 *
 *   - an OUTAGE is about the account or the provider. No task caused it, no task can
 *     fix it, and every other task would hit it too. The runner backs off.
 *   - anything else belongs to the task — a prompt over the context window, a model id
 *     that does not exist — and keeps the existing path, where the task fails loudly
 *     and a human looks at it. Sweeping those into a cooldown would hide a real bug
 *     behind an hour of silence and then reproduce it exactly.
 *
 * Written after 2026-08-15, when the account's monthly spend limit was reached and the
 * supervisor read the resulting 429 as a clean handoff: five sessions in nine seconds,
 * three of them without a single token, and a task parked citing "no measurable
 * progress" — a verdict about the agent, for something the agent never saw.
 */
import type { ProviderOutage } from "../domain/task.ts";

/** `"429 {...}"` — the Anthropic SDK's `APIError.message`. */
const STATUS = /^(\d{3})\s/;

/**
 * pi's own refusal to sit out a long wait: it fails the request instead, naming the
 * delay the server asked for, and appends the provider's message after it.
 */
const REQUESTED_DELAY = /^Server requested (\d+(?:\.\d+)?)s retry delay \([^)]*\)\.\s*/;

/** The account is out of budget rather than merely going too fast. */
const EXHAUSTED = /spend limit|usage limit|credit balance|out of credits|quota/i;

/** No HTTP status ever arrived, because no HTTP response did. */
const NETWORK = /fetch failed|connection error|timed out|socket hang up|network|ECONN|ETIMEDOUT|EAI_AGAIN/i;

/** Longest provider prose that is worth carrying into a log line or a Discord message. */
const MAX_DETAIL = 200;

/**
 * Classify a provider failure, or return undefined when it is not one.
 *
 * Takes the message rather than an Error because that is the shape pi surfaces — see
 * the module note.
 */
export const classifyProviderFailure = (message: string): ProviderOutage | undefined => {
  const requested = REQUESTED_DELAY.exec(message);
  if (requested !== null) {
    const seconds = Number.parseFloat(requested[1] ?? "");
    const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
    const rest = message.slice(requested[0].length);

    // The wait is evidence in itself: pi only reports one for an error it considered
    // retryable, so even an unrecognisable remainder is an outage.
    const inner = classify(rest) ?? { kind: "rate-limited" as const, detail: detailOf(rest) };
    return { ...inner, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }

  return classify(message);
};

const classify = (message: string): ProviderOutage | undefined => {
  const status = STATUS.exec(message);
  const detail = detailOf(message);

  if (status === null) {
    return NETWORK.test(message) ? { kind: "network", detail } : undefined;
  }

  const code = Number(status[1]);
  const base = { status: code, detail };

  if (code === 429) {
    return EXHAUSTED.test(message)
      ? { kind: "exhausted", ...base }
      : { kind: "rate-limited", ...base };
  }
  if (code === 401 || code === 403) return { kind: "unauthorised", ...base };
  if (code === 408 || code >= 500) return { kind: "unavailable", ...base };
  // A 400 is normally the request's fault, but a spent balance is reported as one.
  if (EXHAUSTED.test(message)) return { kind: "exhausted", ...base };

  return undefined;
};

/**
 * The provider's own sentence, when it sent one.
 *
 * The raw string is a JSON body with a request id in it; a log line and a Discord
 * message both want the sentence a human can act on, not the envelope.
 */
const detailOf = (message: string): string => {
  const start = message.indexOf("{");
  if (start !== -1) {
    try {
      const body: unknown = JSON.parse(message.slice(start));
      const inner =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { readonly error: unknown }).error
          : undefined;
      const text =
        typeof inner === "object" && inner !== null && "message" in inner
          ? (inner as { readonly message: unknown }).message
          : undefined;
      if (typeof text === "string" && text.length > 0) return clip(text);
    } catch {
      // Not JSON — an HTML error page from something in front of the provider, most
      // likely. The raw prefix is still the best description available.
    }
  }

  return clip(message);
};

const clip = (text: string): string =>
  text.length <= MAX_DETAIL ? text.trim() : `${text.slice(0, MAX_DETAIL).trim()}…`;
