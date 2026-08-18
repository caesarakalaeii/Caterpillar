/**
 * The chat inbox, across processes.
 *
 * `supervisor/inbox.ts` describes the contract this implements, and that docstring is the
 * one to read first: the bridge submits, the loop drains, and the SUBMITTER is told what
 * happened — possibly much later, because the loop may be mid-session for hours. The
 * `ChatIntent`/`ChatOutcome` union lives there and is not touched here; every distinction
 * in it (`parked` vs `cancelling`, `not-resumable` vs `not-parkable`) is a message-quality
 * decision that survives serialisation unchanged.
 *
 * What changes over Redis is only WHERE the queue is. In one process the submitter's
 * `resolve` is captured in a closure and the loop calls it. Across processes there is no
 * closure to call: the standalone bot pushes an intent onto a list, the supervisor pops
 * it, and the outcome comes back over a reply channel keyed by a request id the submitter
 * generated. So:
 *
 *   list  `chat:inbox`              — JSON `{id, intent}`, drained atomically by the loop
 *   chan  `chat:reply:<request id>` — the `ChatOutcome`, published once
 *   key   `chat:reply:<request id>` — the same outcome with a short TTL
 *
 * Both a channel AND a key, because pub/sub in Redis is fire-and-forget: a subscriber
 * that reconnects one millisecond after the outcome was published never sees it. The key
 * is the catch-up path — the submitter reads it once on subscribe and once more on
 * timeout — and its TTL is what stops a bot that died mid-request from leaving a reply
 * behind forever.
 *
 * `takeWhere` and `some` are NOT here. Read `ChatInbox.takeWhere`: it exists so a session
 * in flight can see a `/cancel` without draining requests that would write the state repo.
 * Over Redis that selective take is a Lua script over a list, and it is unnecessary —
 * cancels have their own channel (`cancel.ts`), which is faster and cannot take an intent
 * with it. The interface below therefore keeps them as an in-process concern of whatever
 * is holding the queue, and the Redis inbox serves the drain half.
 */
import { asTaskId, type TaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { ChatIntent, ChatOutcome, ChatRequest } from "../supervisor/inbox.ts";
import { ChatInbox } from "../supervisor/inbox.ts";
import type { RedisClient } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

/** `chat:inbox`, the list every submitting process pushes onto. */
export const INBOX_KEY = "chat:inbox";

/** Prefix for one request's reply key and channel. */
export const REPLY_PREFIX = "chat:reply:";

/**
 * Most intents that may be queued at once.
 *
 * Generous — a human cannot type this many — and bounded anyway, because the list is the
 * one structure a crash-looping bridge could grow without limit. See `rpush`'s `cap`.
 */
export const INBOX_CAP = 1000;

/**
 * Seconds a published outcome stays readable.
 *
 * Long enough for a submitter to reconnect and catch up, short enough that a bot which
 * died before reading its reply leaves nothing behind by the time anyone looks. Discord's
 * own deferred-interaction window is 15 minutes, so anything past that has no reader.
 */
export const REPLY_TTL_SECONDS = 15 * 60;

/**
 * How long a submitter waits before giving up on an outcome.
 *
 * A ceiling, not an expectation. The loop can be mid-session for hours (`limits.
 * maxSessionSeconds` is four), but Discord stops caring at 15 minutes, so waiting past
 * that would be waiting for a reply nobody can be told about.
 */
export const SUBMIT_TIMEOUT_MS = 15 * 60 * 1000;

/** The half of the inbox a submitting process needs. */
export interface ChatSubmitter {
  /** Resolves when the outcome arrives, or with `failed` when it does not. */
  submit(intent: ChatIntent): Promise<ChatOutcome>;
}

/** The half the poll loop needs. Deliberately identical to `ChatInbox`'s shape. */
export interface ChatDrainer {
  drain(): Promise<readonly ChatRequest[]>;
  takeWhere(select: (request: ChatRequest) => boolean): Promise<readonly ChatRequest[]>;
  some(select: (request: ChatRequest) => boolean): Promise<boolean>;
}

export type ChatQueue = ChatSubmitter & ChatDrainer;

/**
 * `ChatInbox` presented as a `ChatQueue`.
 *
 * The fallback when Redis is unconfigured, and byte-for-byte the behaviour that was there
 * before: the same object, the same closures, the same ordering. Only the method
 * signatures gain a promise, which the loop was already awaiting.
 */
export class InMemoryChatQueue implements ChatQueue {
  private readonly inbox: ChatInbox;

  constructor(inbox: ChatInbox = new ChatInbox()) {
    this.inbox = inbox;
  }

  submit(intent: ChatIntent): Promise<ChatOutcome> {
    return this.inbox.submit(intent);
  }

  drain(): Promise<readonly ChatRequest[]> {
    return Promise.resolve(this.inbox.drain());
  }

  takeWhere(select: (request: ChatRequest) => boolean): Promise<readonly ChatRequest[]> {
    return Promise.resolve(this.inbox.takeWhere(select));
  }

  some(select: (request: ChatRequest) => boolean): Promise<boolean> {
    return Promise.resolve(this.inbox.some(select));
  }

  get size(): number {
    return this.inbox.size;
  }
}

/** What travels on the list. The id is the submitter's; the loop only echoes it back. */
interface QueuedRequest {
  readonly id: string;
  readonly intent: ChatIntent;
}

export interface RedisChatQueueOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  /** Overridable so a test does not wait fifteen minutes for the give-up path. */
  readonly submitTimeoutMs?: number;
  readonly newId?: () => string;
}

export class RedisChatQueue implements ChatQueue {
  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly logger: Logger;
  private readonly submitTimeoutMs: number;
  private readonly newId: () => string;

  /**
   * Requests this process has drained but not yet settled.
   *
   * `drain` is destructive — it has to be, or two supervisors would work the same intent
   * — so the outcome has to be publishable after the entry is gone from the list. Holding
   * the id here is what makes `settle` a plain publish rather than a second lookup.
   */
  private readonly pending = new Map<string, string>();

  constructor(options: RedisChatQueueOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.guard = new RedisGuard({ logger: options.logger });
    this.submitTimeoutMs = options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
    this.newId = options.newId ?? ((): string => crypto.randomUUID());
  }

  /**
   * Push an intent and wait for its outcome.
   *
   * Subscribing BEFORE pushing, not after: the loop can drain and reply within a
   * millisecond of the push, and a subscription opened afterwards would miss the
   * publish. The key read that follows covers the remaining window.
   */
  async submit(intent: ChatIntent): Promise<ChatOutcome> {
    const id = this.newId();
    const channel = `${REPLY_PREFIX}${id}`;

    let settle: ((outcome: ChatOutcome) => void) | undefined;
    const outcome = new Promise<ChatOutcome>((resolve) => {
      settle = resolve;
    });

    const subscription = await this.guard.run(
      "inbox.subscribe",
      () =>
        this.redis.subscribe(channel, (message) => {
          const parsed = parseOutcome(message);
          if (parsed !== undefined) settle?.(parsed);
        }),
      undefined,
    );

    try {
      const pushed = await this.guard.attempt("inbox.push", () =>
        this.redis.rpush(INBOX_KEY, JSON.stringify({ id, intent } satisfies QueuedRequest), INBOX_CAP),
      );

      // The submitter is told, rather than left hanging. A `/park` that never reached the
      // queue and a `/park` that reached it and was refused look identical from a Discord
      // thread, and the first is the one where retrying is the right advice.
      if (!pushed) {
        return { kind: "failed", error: "the request queue is unreachable — try again shortly" };
      }

      // The catch-up read. Covers the case where the loop replied between the push and
      // the subscription actually being established on the server.
      const early = await this.guard.run("inbox.reply-read", () => this.redis.get(channel), undefined);
      const parsedEarly = early === undefined ? undefined : parseOutcome(early);
      if (parsedEarly !== undefined) return parsedEarly;

      return await this.await(outcome, channel);
    } finally {
      await subscription?.close().catch(() => undefined);
    }
  }

  /** Race the subscription against the give-up timer, re-reading the key before failing. */
  private async await(outcome: Promise<ChatOutcome>, channel: string): Promise<ChatOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.submitTimeoutMs);
      timer.unref();
    });

    try {
      const settled = await Promise.race([outcome, expiry]);
      if (settled !== undefined) return settled;

      // One last look before giving up: a publish that arrived while this process was
      // reconnecting left the key behind, and reporting a failure the operator can see
      // did not happen is worse than reporting nothing.
      const late = await this.guard.run("inbox.reply-read", () => this.redis.get(channel), undefined);
      const parsed = late === undefined ? undefined : parseOutcome(late);
      if (parsed !== undefined) return parsed;

      this.logger.warn("chat.reply-timeout", { channel });
      return {
        kind: "failed",
        error: "no runner answered in time — the request may still be queued",
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Take everything queued, as `ChatRequest`s whose `settle` publishes back.
   *
   * An entry that does not parse is DROPPED with a warn rather than throwing: it is one
   * request the fleet cannot serve, not a poll the runner cannot complete, and the
   * alternative is a single malformed push wedging the drain forever.
   */
  async drain(): Promise<readonly ChatRequest[]> {
    const raw = await this.guard.run<readonly string[]>(
      "inbox.drain",
      () => this.redis.drain(INBOX_KEY),
      [],
    );

    const requests: ChatRequest[] = [];
    for (const entry of raw) {
      const parsed = parseRequest(entry);
      if (parsed === undefined) {
        this.logger.warn("chat.unparseable-request", { bytes: entry.length });
        continue;
      }
      this.pending.set(parsed.id, parsed.id);
      requests.push({
        ...parsed.intent,
        settle: (outcome: ChatOutcome): void => void this.settle(parsed.id, outcome),
      });
    }
    return requests;
  }

  /**
   * Not served over Redis — see the module docstring.
   *
   * A session in flight watches `cancel.ts` instead, which reaches it in milliseconds
   * over pub/sub rather than at the next 2-second poll of a list, and cannot accidentally
   * remove an intent that writes the state repo. Returning empty is the honest answer:
   * this queue has no selective take.
   */
  takeWhere(): Promise<readonly ChatRequest[]> {
    return Promise.resolve([]);
  }

  /**
   * Likewise not served: peeking without consuming means reading the whole list and
   * putting it back, which races every other drainer.
   *
   * Its one caller — a session yielding to a waiting brainstorm — degrades to "no
   * brainstorm is waiting", which costs the human one extra poll interval and is exactly
   * what the pre-Redis single-replica runner did before the check existed.
   */
  some(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Publish the outcome and leave a copy behind for a submitter that was not listening. */
  private async settle(id: string, outcome: ChatOutcome): Promise<void> {
    this.pending.delete(id);
    const channel = `${REPLY_PREFIX}${id}`;
    const body = JSON.stringify(outcome);

    // The key FIRST. A publish arriving before the key exists is fine — the subscriber
    // has it — but a subscriber that reconnects in the gap would read a key that is not
    // there yet and give up on a reply that had in fact been sent.
    await this.guard.attempt("inbox.reply-write", () =>
      this.redis.set(channel, body, REPLY_TTL_SECONDS),
    );
    await this.guard.attempt("inbox.reply-publish", () => this.redis.publish(channel, body));
  }
}

/**
 * Parse one queued entry, rejecting anything that is not a recognised intent.
 *
 * Validated on the way OUT rather than trusted, because the writer is a different process
 * — the standalone bot — and a rolling upgrade means the two are briefly different
 * versions of this code. An intent kind the supervisor does not know is dropped, not
 * dispatched.
 */
const parseRequest = (raw: string): QueuedRequest | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;

  const { id, intent } = parsed as { readonly id?: unknown; readonly intent?: unknown };
  if (typeof id !== "string" || id.length === 0) return undefined;

  const checked = parseIntent(intent);
  return checked === undefined ? undefined : { id, intent: checked };
};

const parseIntent = (value: unknown): ChatIntent | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  const task = (): TaskId | undefined =>
    typeof raw["task"] === "string" && raw["task"].length > 0 ? asTaskId(raw["task"]) : undefined;

  switch (raw["kind"]) {
    case "answer": {
      const id = task();
      if (id === undefined || typeof raw["text"] !== "string") return undefined;
      return { kind: "answer", task: id, text: raw["text"] };
    }
    case "park":
    case "resume":
    case "merge": {
      const id = task();
      if (id === undefined) return undefined;
      return { kind: raw["kind"], task: id };
    }
    case "brainstorm": {
      const { topic, repos, threadId, author } = raw;
      if (
        typeof topic !== "string" ||
        !Array.isArray(repos) ||
        repos.some((repo) => typeof repo !== "string") ||
        typeof threadId !== "string" ||
        typeof author !== "string"
      ) {
        return undefined;
      }
      return { kind: "brainstorm", topic, repos: repos as readonly string[], threadId, author };
    }
    default:
      return undefined;
  }
};

/**
 * Parse an outcome, keeping only kinds this build knows.
 *
 * Same argument as `parseIntent` in the other direction, and it matters more here: an
 * unrecognised outcome rendered as a Discord message would be the human's only feedback,
 * so falling through to the give-up path — which says the request may still be queued —
 * is more honest than showing them `[object Object]`.
 */
const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  "applied",
  "parked",
  "resumed",
  "not-resumable",
  "merged",
  "started",
  "unknown-task",
  "refused",
  "not-waiting",
  "not-parkable",
  "cancelling",
  "not-mergeable",
  "failed",
]);

const parseOutcome = (raw: string): ChatOutcome | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;

  const kind = (parsed as { readonly kind?: unknown }).kind;
  if (typeof kind !== "string" || !OUTCOME_KINDS.has(kind)) return undefined;
  return parsed as ChatOutcome;
};
