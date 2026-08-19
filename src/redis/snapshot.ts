/**
 * The task snapshot, shared across processes.
 *
 * `supervisor/snapshot.ts` is the contract, and its docstring is the constraint: Discord
 * gives an interaction **3 seconds** to be acknowledged and an autocomplete suggestion
 * must be inside that on every keystroke. Everything below follows from that one number.
 *
 *   - The whole `TaskSummary[]` is ONE key. Not a key per task, not a hash field per
 *     task: an autocomplete that has to issue N round trips has spent its budget on
 *     latency before it has ranked anything, and there is no version of a per-task layout
 *     where a fleet of a hundred tasks stays inside 3 seconds on a bad network.
 *   - The read is CACHED in process for `CACHE_TTL_MS`. A user typing a task id produces
 *     an interaction per keystroke; without the cache that is one Redis round trip per
 *     character for data the supervisor only rewrites once per poll.
 *   - A failed read serves the LAST GOOD value rather than nothing. A slightly stale
 *     suggestion list is a working autocomplete; an empty one looks to the human like the
 *     fleet has no tasks.
 *
 * `summarise()` and `suggest()` are imported from `supervisor/snapshot.ts` unchanged —
 * the awaiting-human-first ranking and the cap of 25 are Discord's rules, not this
 * layer's, and duplicating them here is how they would drift.
 */
import type { ReviewRecord, TaskId, TaskStatus } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import { TaskSnapshot, type TaskSummary } from "../supervisor/snapshot.ts";
import type { RedisClient } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

/** One key holding the serialised summaries. See the docstring for why it is one. */
export const SNAPSHOT_KEY = "chat:snapshot";

/**
 * How long a fetched snapshot is served without asking Redis again.
 *
 * Comfortably under the poll interval that rewrites it (30s by default) so a reader is
 * never more than one refresh behind, and long enough that a burst of autocomplete
 * keystrokes costs one round trip rather than one per character.
 */
export const CACHE_TTL_MS = 2000;

/**
 * Redis-side expiry on the key.
 *
 * Several poll intervals, so an ordinary slow poll never blanks the bot, but finite: a
 * fleet that has been shut down should stop advertising a task list it is no longer
 * maintaining, rather than leaving one behind forever for whoever looks next.
 */
export const SNAPSHOT_TTL_SECONDS = 300;

/** Reading half — the bridge, the web view, anything answering a human. */
export interface SnapshotReader {
  all(): Promise<readonly TaskSummary[]>;
  withStatus(status: TaskStatus): Promise<readonly TaskSummary[]>;
  find(id: TaskId): Promise<TaskSummary | undefined>;
  suggest(query: string): Promise<readonly TaskSummary[]>;
}

/** Writing half — the poll loop, once per pass. */
export interface SnapshotWriter {
  replace(tasks: readonly TaskSummary[]): Promise<void>;
}

export type SnapshotStore = SnapshotReader & SnapshotWriter;

/**
 * `TaskSnapshot` presented as a `SnapshotStore`.
 *
 * The fallback when Redis is unconfigured. Every answer comes from the same in-process
 * array it did before, through the same `suggest()`; only the signatures gained a promise.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshot: TaskSnapshot;

  constructor(snapshot: TaskSnapshot = new TaskSnapshot()) {
    this.snapshot = snapshot;
  }

  replace(tasks: readonly TaskSummary[]): Promise<void> {
    this.snapshot.replace(tasks);
    return Promise.resolve();
  }

  all(): Promise<readonly TaskSummary[]> {
    return Promise.resolve(this.snapshot.all());
  }

  withStatus(status: TaskStatus): Promise<readonly TaskSummary[]> {
    return Promise.resolve(this.snapshot.withStatus(status));
  }

  find(id: TaskId): Promise<TaskSummary | undefined> {
    return Promise.resolve(this.snapshot.find(id));
  }

  suggest(query: string): Promise<readonly TaskSummary[]> {
    return Promise.resolve(this.snapshot.suggest(query));
  }
}

export interface RedisSnapshotStoreOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export class RedisSnapshotStore implements SnapshotStore {
  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  /**
   * The in-process cache, and the last-good value in one.
   *
   * A `TaskSnapshot` rather than a bare array so `suggest` is literally the same code
   * path it is without Redis — the ranking cannot drift if there is only one of it.
   */
  private readonly cached = new TaskSnapshot();
  private fetchedAt = 0;
  private everFetched = false;
  /** In-flight fetch, shared: ten keystrokes in one tick must not be ten round trips. */
  private inflight: Promise<void> | undefined;

  constructor(options: RedisSnapshotStoreOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.guard = new RedisGuard({ logger: options.logger });
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async replace(tasks: readonly TaskSummary[]): Promise<void> {
    // The local copy first and unconditionally: this process's own reads must not depend
    // on a Redis round trip it just made, and if the write fails the loop's own view of
    // the fleet stays correct.
    this.cached.replace(tasks);
    this.fetchedAt = this.now();
    this.everFetched = true;

    await this.guard.attempt("snapshot.write", () =>
      this.redis.set(SNAPSHOT_KEY, serialise(tasks), SNAPSHOT_TTL_SECONDS),
    );
  }

  async all(): Promise<readonly TaskSummary[]> {
    await this.fresh();
    return this.cached.all();
  }

  async withStatus(status: TaskStatus): Promise<readonly TaskSummary[]> {
    await this.fresh();
    return this.cached.withStatus(status);
  }

  async find(id: TaskId): Promise<TaskSummary | undefined> {
    await this.fresh();
    return this.cached.find(id);
  }

  async suggest(query: string): Promise<readonly TaskSummary[]> {
    await this.fresh();
    return this.cached.suggest(query);
  }

  /** Refresh the cache if it has aged out. Never throws; never blanks what it has. */
  private async fresh(): Promise<void> {
    if (this.everFetched && this.now() - this.fetchedAt < this.cacheTtlMs) return;
    if (this.inflight !== undefined) return this.inflight;

    this.inflight = this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetch(): Promise<void> {
    const raw = await this.guard.run("snapshot.read", () => this.redis.get(SNAPSHOT_KEY), undefined);

    // The clock advances either way. A Redis that is down must not turn every keystroke
    // into a fresh failing round trip on top of a 3-second budget.
    this.fetchedAt = this.now();

    if (raw === undefined) {
      // Absent is not empty. The key expires, and a rollout has a window where no
      // supervisor has written one yet — serving [] there would tell a human the fleet
      // had lost every task.
      this.everFetched = true;
      return;
    }

    const parsed = deserialise(raw);
    if (parsed === undefined) {
      this.logger.warn("snapshot.unparseable", { bytes: raw.length });
      return;
    }

    this.cached.replace(parsed);
    this.everFetched = true;
  }
}

export const serialise = (tasks: readonly TaskSummary[]): string => JSON.stringify(tasks);

/**
 * Parse the key back into summaries, dropping any entry that is not one.
 *
 * Per entry rather than all-or-nothing: a fleet mid-upgrade may have written a field this
 * build does not know, and losing one task from an autocomplete list is better than
 * losing the list.
 */
export const deserialise = (raw: string): readonly TaskSummary[] | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const tasks: TaskSummary[] = [];
  for (const entry of parsed) {
    const task = parseSummary(entry);
    if (task !== undefined) tasks.push(task);
  }
  return tasks;
};

const parseSummary = (value: unknown): TaskSummary | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  const { id, status, phase, sessions, costUsd, prUrl, review, updatedAt } = raw;
  if (
    typeof id !== "string" ||
    typeof status !== "string" ||
    typeof phase !== "string" ||
    typeof sessions !== "number" ||
    typeof costUsd !== "number" ||
    typeof updatedAt !== "string"
  ) {
    return undefined;
  }

  const parsedReview = parseReview(review);

  return {
    id: id as TaskId,
    status: status as TaskStatus,
    phase: phase as TaskSummary["phase"],
    sessions,
    costUsd,
    ...(typeof prUrl === "string" ? { prUrl } : {}),
    ...(parsedReview === undefined ? {} : { review: parsedReview }),
    updatedAt,
  };
};

/**
 * The review record, rebuilt field by field like everything else here.
 *
 * This function is why `/task` says why a task keeps being sent back on a FLEET and not
 * only on a single runner. Every field of a summary is reconstructed explicitly, so a field
 * this misses is dropped in silence — and with Redis configured the process answering
 * `/task` is the standalone bot, which has no state repo and knows only what it reads from
 * this key. The failure mode is the worst kind: correct in a one-replica dev run, and
 * quietly back to `rounds`-and-nothing in production.
 *
 * A malformed record yields undefined rather than dropping the whole task: the review
 * history is the least important thing a summary carries, and losing the task from an
 * autocomplete list to save it would be the wrong trade.
 */
const parseReview = (value: unknown): ReviewRecord | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  const { rounds, last, reason } = raw;
  if (typeof rounds !== "number") return undefined;

  return {
    rounds,
    ...(last === "pass" || last === "changes" ? { last } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
};
