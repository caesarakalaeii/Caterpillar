/**
 * Which Discord thread belongs to which task, across processes. See DESIGN.md §7 and §14.3.
 *
 * `notify/threads.ts` is the contract, and its docstring is the one to read first: a
 * message in a thread arrives as an ordinary `MESSAGE_CREATE` whose `channel_id` is the
 * THREAD's, with nothing in the payload naming the parent, so a process that does not
 * know which threads are ours cannot tell a reply to a task from a message in an
 * unrelated channel. In one process that index is rebuilt at boot by reading the state
 * repo (`index.ts`'s `hydrateThreads`).
 *
 * The standalone bot has no state repo, which is the entire point of it (§7). So the
 * binding has to travel: the SUPERVISOR publishes what it derives from task state on
 * every housekeeping pass, and the BOT consumes it. This is that channel.
 *
 * Three properties, each of which is a failure that happened to the in-process index and
 * would happen again here:
 *
 *   ONE KEY, like the snapshot's, for the same 3-second reason. The bot consults this on
 *   every inbound message and the gateway filter is synchronous; a key per thread would
 *   be a `SCAN` on a hot path.
 *
 *   ABSENT IS NOT EMPTY. The key expires, and a bot that starts before any supervisor has
 *   published sees nothing there. Replacing a known-good index with `[]` on a failed read
 *   would unbind every live thread at once — and an unbound thread does not error, it
 *   silently stops being a thread we listen to. The cache is therefore last-good, and
 *   `everFetched` is what distinguishes "no supervisor has spoken yet" from "the fleet
 *   has no threads".
 *
 *   STALENESS IS ORDINARY AND MUST BE HONEST. A brainstorm's thread is created by the bot
 *   and its binding is only durable once the supervisor has written the task, so there is
 *   always a window where a human can type in a thread the published mapping does not
 *   mention yet. The bot binds such a thread LOCALLY the moment it creates it (the bridge
 *   already does), and for anything else `TASK_UNKNOWN` in `notify/replies.ts` is what
 *   gets said. Silence is the one unacceptable answer.
 */
import type { TaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { RedisClient } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

/** `chat:threads`, one key holding every live binding. See the docstring for why one. */
export const THREADS_KEY = "chat:threads";

/**
 * How long a fetched mapping is served without asking Redis again.
 *
 * The same reasoning as the snapshot's cache, one notch tighter: this is read on every
 * message rather than every interaction, and a binding published for a brand-new
 * brainstorm thread should reach the bot within a message or two of being written.
 */
export const CACHE_TTL_MS = 2000;

/**
 * Redis-side expiry on the key.
 *
 * Several housekeeping intervals, so an ordinary slow pass never unbinds the fleet's
 * threads, but finite — a fleet that has been shut down should stop advertising bindings
 * nobody is maintaining. Matches the snapshot's TTL deliberately: the two are written by
 * the same pass and there is no reading of the pair that is improved by them disagreeing.
 */
export const THREADS_TTL_SECONDS = 300;

/** One thread, and the task that owns it. */
export interface ThreadBinding {
  readonly threadId: string;
  readonly task: TaskId;
}

/** The half the bot needs. */
export interface ThreadBindingReader {
  /** Every live binding. Never throws; never blanks the last good answer. */
  read(): Promise<readonly ThreadBinding[]>;
}

/** The half the supervisor needs, called once per housekeeping pass. */
export interface ThreadBindingWriter {
  publish(bindings: readonly ThreadBinding[]): Promise<void>;
}

export type ThreadBindingStore = ThreadBindingReader & ThreadBindingWriter;

/**
 * The fallback when Redis is unconfigured.
 *
 * A supervisor running the bot in-process publishes to itself and reads back what it
 * wrote. Not a degraded mode: with one process the in-memory `ThreadIndex` is already the
 * whole truth, and this exists so the wiring is identical on both paths rather than
 * conditional at every call site.
 */
export class InMemoryThreadBindings implements ThreadBindingStore {
  private bindings: readonly ThreadBinding[] = [];

  publish(bindings: readonly ThreadBinding[]): Promise<void> {
    this.bindings = [...bindings];
    return Promise.resolve();
  }

  read(): Promise<readonly ThreadBinding[]> {
    return Promise.resolve(this.bindings);
  }
}

export interface RedisThreadBindingsOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export class RedisThreadBindings implements ThreadBindingStore {
  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly logger: Logger;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  /** The cache and the last-good value in one — see the module docstring. */
  private cached: readonly ThreadBinding[] = [];
  private fetchedAt = 0;
  private everFetched = false;
  /** In-flight fetch, shared: a burst of messages must not be a burst of round trips. */
  private inflight: Promise<void> | undefined;

  constructor(options: RedisThreadBindingsOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.guard = new RedisGuard({ logger: options.logger });
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async publish(bindings: readonly ThreadBinding[]): Promise<void> {
    // The local copy first and unconditionally, like the snapshot's: a supervisor that
    // also runs the bot must not depend on a round trip it just made, and a failed write
    // must not cost this process its own view.
    this.cached = [...bindings];
    this.fetchedAt = this.now();
    this.everFetched = true;

    await this.guard.attempt("threads.write", () =>
      this.redis.set(THREADS_KEY, serialise(bindings), THREADS_TTL_SECONDS),
    );
  }

  async read(): Promise<readonly ThreadBinding[]> {
    await this.fresh();
    return this.cached;
  }

  private async fresh(): Promise<void> {
    if (this.everFetched && this.now() - this.fetchedAt < this.cacheTtlMs) return;
    if (this.inflight !== undefined) return this.inflight;

    this.inflight = this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetch(): Promise<void> {
    const raw = await this.guard.run("threads.read", () => this.redis.get(THREADS_KEY), undefined);

    // The clock advances either way, so a Redis that is down does not turn every message
    // into a fresh failing round trip.
    this.fetchedAt = this.now();

    if (raw === undefined) {
      // Absent is not empty. On a cold start no supervisor has published yet; serving []
      // is right there and serving it FOREVER is not, which is what `everFetched` records.
      this.everFetched = true;
      return;
    }

    const parsed = deserialise(raw);
    if (parsed === undefined) {
      this.logger.warn("threads.unparseable", { bytes: raw.length });
      return;
    }

    this.cached = parsed;
    this.everFetched = true;
  }
}

export const serialise = (bindings: readonly ThreadBinding[]): string => JSON.stringify(bindings);

/**
 * Parse the key back, dropping any entry that is not a binding.
 *
 * Per entry rather than all-or-nothing, for the snapshot's reason: a fleet mid-upgrade may
 * write a field this build does not know, and losing one thread from the index is better
 * than losing every thread.
 */
export const deserialise = (raw: string): readonly ThreadBinding[] | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const bindings: ThreadBinding[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const { threadId, task } = entry as Record<string, unknown>;
    if (typeof threadId !== "string" || typeof task !== "string") continue;
    if (threadId.length === 0 || task.length === 0) continue;
    bindings.push({ threadId, task: task as TaskId });
  }
  return bindings;
};
