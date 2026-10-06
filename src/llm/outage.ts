/**
 * Telling a provider outage apart from a task failure. See DESIGN.md §6.3.
 *
 * pi does not throw when a provider request fails. The failure comes back as an
 * assistant message with `stopReason: "error"` and an `errorMessage` string. Its
 * shape depends on the API: the Anthropic SDK emits `"<status> <json body>"`,
 * pi's openai-completions path composes `"<status>: <body>"` — which is what the
 * coding gateway's refusals arrive as. The headers are gone by the time it
 * reaches us, so the string is all we get — this reads it.
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
 * A "the provider is busy" refusal is the intended steady state against the coding
 * gateway: it serves hobby traffic only when production load allows, so a 429 is a
 * normal operating condition, not an incident — rate-limited, cooldown, retry at the
 * capped interval, same as a burst limit on a paid API.
 *
 * Written after 2026-08-15, when the account's monthly spend limit was reached and
 * the supervisor read the resulting 429 as a clean handoff: five sessions in nine
 * seconds, three of them without a single token, and a task parked citing "no
 * measurable progress" — a verdict about the agent, for something the agent never
 * saw. The colon shape made the same failure reappear against the gateway in 2026-09.
 */
import type { ProviderOutage } from "../domain/task.ts";

/**
 * `"<status> <json body>"` — the Anthropic SDK's `APIError.message`. The openai API
 * implementations in pi compose `"<status>: <body>"` instead (utils/error-body.ts's
 * `formatProviderError`), which is what the coding gateway's 429 arrives as, so both
 * separators match.
 */
const STATUS = /^(\d{3})\s?:?\s/;

/**
 * pi's own refusal to sit out a long wait: it fails the request instead, naming the
 * delay the server asked for, and appends the provider's message after it.
 */
const REQUESTED_DELAY = /^Server requested (\d+(?:\.\d+)?)s retry delay \([^)]*\)\.\s*/;

/** The account is out of budget rather than merely going too fast. */
const EXHAUSTED = /spend limit|usage limit|credit balance|out of credits|quota/i;

/** No HTTP status ever arrived, because no HTTP response did. */
const NETWORK = /fetch failed|connection error|timed out|socket hang up|network|ECONN|ETIMEDOUT|EAI_AGAIN/i;
/** The coding gateway's wording for a model alias it no longer serves. */
const UNKNOWN_ALIAS = /unknown alias/i;

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
  // A 404 "unknown alias" is a gateway that retired the model the runner pinned at
  // boot — a mid-run swap, not a misconfiguration. Distinguished from a genuinely
  // wrong model id by the gateway's own wording: Anthropic says "model: <id>" in a
  // not_found_error, the coding gateway says "unknown alias". Backing the runner off
  // stops a stampede; restarting the pod re-runs discovery and picks up the new id.
  if (code === 404 && UNKNOWN_ALIAS.test(message)) return { kind: "model-retired", ...base };

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
      const inner = unwrapError(body);
      if (typeof inner === "string" && inner.length > 0) return clip(inner);
    } catch {
      // Not JSON — an HTML error page from something in front of the provider, most
      // likely. The raw prefix is still the best description available.
    }
  }

  return clip(message);
};

/**
 * The human-readable sentence inside an error body, wherever the provider's SDK put
 * it. Anthropic nests it under `error.message`; the openai-completions path carries
 * the openai body flat (`{"message": "...", "type": "..."}`), which is what the
 * coding gateway sends.
 */
const unwrapError = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  if ("message" in body && typeof body.message === "string") return body.message;
  if ("error" in body && typeof body.error === "object" && body.error !== null) {
    const nested = body.error;
    if ("message" in nested && typeof nested.message === "string") return nested.message;
  }
  return undefined;
};

const clip = (text: string): string =>
  text.length <= MAX_DETAIL ? text.trim() : `${text.slice(0, MAX_DETAIL).trim()}…`;
