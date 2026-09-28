/**
 * The agent chat room: per-task, nothing drains it. See DESIGN.md §21, "Agent chat rooms".
 *
 * The same two halves every ephemeral-plane structure has (§21): a LIST for the
 * durable one and a pub/sub channel for the live one. The difference from
 * `steering.ts` is the reader. A steer is an inbox — one session consumes it, which
 * is the whole point of "read once, never again". A room is a SHORTHAND for peers:
 * every session that works the task should see what agents before it learned, so
 * the read is `lrange`, never `drain`. Nothing here removes an element; the room
 * sheds history at the front (`ROOM_CAP`) and whole (`ROOM_TTL_SECONDS`), and by
 * nothing else.
 *
 * `crossesProcesses` is declared, not inferred, for the same reason it is on the
 * steering inbox: a supervisor that cannot reach another machine's runner must not
 * pretend a message reached it.
 */
import type { TaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { RedisClient, RedisSubscription } from "./client.ts";
import { RedisGuard } from "./guarded.ts";

/** One room message, as stored in the list and as delivered to a watcher. */
export interface RoomMessage {
  readonly from: TaskId;
  readonly text: string;
  /** ISO timestamp, stamped by the sender, for the durable record. */
  readonly at: string;
}

export interface RoomWatch {
  close(): Promise<void>;
}

export interface ChatRooms {
  /** Whether this implementation can reach agents in ANOTHER process. */
  readonly crossesProcesses: boolean;
  /** Append `message` to `task`'s room. Returns whether it was recorded anywhere. */
  post(task: TaskId, message: RoomMessage): Promise<boolean>;
  /** The last `limit` messages, oldest first. NEVER consuming. */
  history(task: TaskId, limit: number): Promise<readonly RoomMessage[]>;
  /** Be told the moment a message is posted to `task`'s room. */
  watch(task: TaskId, onMessage: (message: RoomMessage) => void): Promise<RoomWatch>;
}

/**
 * The per-run carrier the supervisor hands the runner (§21, "Agent chat rooms"). One task's view of
 * the rooms: `post` is validated against the allowed set the supervisor computed,
 * `history` is this task's own room and nothing else. The runner is a pure
 * consumer and never sees the `ChatRooms` object itself.
 */
export interface RoomChat {
  /** Validated against the allowed set; false = out of bounds. */
  post(to: TaskId, text: string): Promise<boolean>;
  /** This task's own room, newest last, bounded by ROOM_HISTORY_LIMIT. */
  history(): Promise<readonly RoomMessage[]>;
}

/**
 * The list key, and the channel name: `steer:`'s discipline of one name for both
 * halves, so there is no mapping to keep in sync.
 */
export const ROOM_PREFIX = "room:";

/**
 * Messages per room. A room nobody drains can grow without bound — the same
 * `maxmemory` argument every list here makes — and the oldest are the ones to drop:
 * the newest note is the one that reflects where the task actually is. Fifty kept,
 * twenty shown (`ROOM_HISTORY_LIMIT`): the store keeps the depth a catch-up may
 * need, the prompt pays only what its bound allows.
 */
export const ROOM_CAP = 50;

/** Silence, not age, as everywhere: a busy room is never cut off mid-conversation. */
export const ROOM_TTL_SECONDS = 4 * 60 * 60;

/** How much history the opening prompt shows. Bounded context, newest included. */
export const ROOM_HISTORY_LIMIT = 20;

/**
 * The fallback when Redis is unconfigured: one process, so the agents that can hear
 * each other are already in the same heap.
 */
export class InMemoryChatRooms implements ChatRooms {
  readonly crossesProcesses = false;

  private readonly rooms = new Map<TaskId, RoomMessage[]>();
  private readonly watchers = new Map<TaskId, Set<(message: RoomMessage) => void>>();

  post(task: TaskId, message: RoomMessage): Promise<boolean> {
    const room = this.rooms.get(task) ?? [];
    room.push(message);
    if (room.length > ROOM_CAP) room.splice(0, room.length - ROOM_CAP);
    this.rooms.set(task, room);
    // Over a copy: a watcher that closes itself in the callback would otherwise
    // mutate the set being iterated.
    for (const watcher of [...(this.watchers.get(task) ?? [])]) watcher(message);
    return Promise.resolve(true);
  }

  history(task: TaskId, limit: number): Promise<readonly RoomMessage[]> {
    const room = this.rooms.get(task) ?? [];
    return Promise.resolve(room.slice(Math.max(0, room.length - limit)));
  }

  watch(task: TaskId, onMessage: (message: RoomMessage) => void): Promise<RoomWatch> {
    const watchers = this.watchers.get(task) ?? new Set<(message: RoomMessage) => void>();
    watchers.add(onMessage);
    this.watchers.set(task, watchers);

    return Promise.resolve({
      close: (): Promise<void> => {
        watchers.delete(onMessage);
        if (watchers.size === 0) this.watchers.delete(task);
        return Promise.resolve();
      },
    });
  }
}

export interface RedisChatRoomsOptions {
  readonly redis: RedisClient;
  readonly logger: Logger;
}

export class RedisChatRooms implements ChatRooms {
  readonly crossesProcesses = true;

  private readonly redis: RedisClient;
  private readonly guard: RedisGuard;

  constructor(options: RedisChatRoomsOptions) {
    this.redis = options.redis;
    this.guard = new RedisGuard({ logger: options.logger });
  }

  /**
   * List first, then publish — the same order the steering inbox uses: a subscriber
   * racing the write must not be woken, read an empty history, and conclude the room
   * is quiet when the message has simply not landed yet.
   *
   * The channel carries only "look". The message itself travels in the list, so a
   * publish delivered twice — a reconnect, two subscribers — costs a wasted read, not
   * a duplicated sentence in an agent's context.
   */
  async post(task: TaskId, message: RoomMessage): Promise<boolean> {
    const stored = await this.guard.attempt("room.write", () =>
      this.redis.rpush(key(task), JSON.stringify(message), ROOM_CAP, ROOM_TTL_SECONDS),
    );
    const published = await this.guard.attempt("room.publish", () =>
      this.redis.publish(key(task), "room"),
    );
    return stored || published;
  }

  /** Empty on failure. An unreachable Redis is not "the room was always silent". */
  history(task: TaskId, limit: number): Promise<readonly RoomMessage[]> {
    return this.guard
      .run<readonly string[]>("room.history", () => this.redis.lrange(key(task), -limit, -1), [])
      .then(parseMessages);
  }

  async watch(task: TaskId, onMessage: (message: RoomMessage) => void): Promise<RoomWatch> {
    // No replay at subscribe. A steer is an inbox — subscribe-time drain is how a
    // message from before the session started gets delivered — but a room's history
    // is in the opening prompt, and replaying it here would hand a second watcher
    // the same old sentence as "new". The cost is the in-session gap: a message
    // posted between session start and subscribe lands on neither path, and waits
    // for the next session's history read (§21, accepted loss).
    const subscription = await this.guard.run<RedisSubscription | undefined>(
      "room.subscribe",
      () =>
        this.redis.subscribe(key(task), () => {
          void this.deliverLatest(task, onMessage);
        }),
      undefined,
    );

    return {
      close: async (): Promise<void> => {
        await subscription?.close().catch(() => undefined);
      },
    };
  }

  /**
   * Deliver the newest message in the room. The channel says only "look" — the list is
   * the record — and the room is never drained, so the reader takes the tail. Two
   * messages landing between two wakes cost one live delivery; the other is in the
   * history the next session reads.
   */
  private async deliverLatest(
    task: TaskId,
    onMessage: (message: RoomMessage) => void,
  ): Promise<void> {
    const messages = await this.history(task, 1);
    const latest = messages.at(-1);
    if (latest !== undefined) onMessage(latest);
  }
}

const key = (task: TaskId): string => `${ROOM_PREFIX}${task}`;

/** Field by field, like every parser here: half a message is worse than none. */
const parseMessage = (value: unknown): RoomMessage | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const { from, text, at } = raw;
  if (typeof from !== "string" || typeof text !== "string" || typeof at !== "string") {
    return undefined;
  }
  return { from: from as TaskId, text, at };
};

/** Per entry: one poison line between two good ones must not cost the whole room. */
const parseMessages = (raw: readonly string[]): readonly RoomMessage[] => {
  const messages: RoomMessage[] = [];
  for (const line of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = parseMessage(parsed);
    if (message !== undefined) messages.push(message);
  }
  return messages;
};
