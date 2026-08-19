/**
 * Which Discord thread belongs to which task. See DESIGN.md §14.3.
 *
 * A message posted in a thread arrives as an ordinary `MESSAGE_CREATE` whose `channel_id`
 * is the THREAD's id, and the payload says nothing about the parent channel. The gateway
 * filter therefore cannot tell "a reply in one of our threads" from "a message in some
 * unrelated channel" without knowing which threads are ours — which is what this is.
 *
 * In memory, and deliberately so. The durable copy is `state.chat.threadId` in the state
 * repo; this is a derived index, rebuilt at boot by reading it back. Keeping it in memory
 * is what lets the gateway consult it synchronously, on every message, without touching
 * git — which the bridge is forbidden from doing anyway (§7).
 */
import type { TaskId, TaskStatus } from "../domain/task.ts";

/** What the index needs to know about a task to decide whether its thread is live. */
export interface ThreadOwner {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly threadId?: string;
}

/**
 * Which threads are still worth listening to, and which task owns each. Pure.
 *
 * Three rules, all learned the hard way:
 *
 *   A thread is bound unless the only thing behind it is `done`. The rule this replaced
 *   dropped every TERMINAL task, and the argument for it was that a bound thread with
 *   nothing behind it swallows what is typed into it — the loop answered `not-waiting` and
 *   the bridge, correctly, said nothing. That argument was about SWALLOWING and not about
 *   terminality, and `parked` is where it broke: a park notification asks for guidance
 *   "here in this thread" and offers `/resume`, and unbinding the thread made both
 *   impossible in the same instant. Every one of those messages was addressed to a thread
 *   this function had just dropped. A message in a `parked` or `failed` task's thread is
 *   now guidance the loop acts on, so nothing is swallowed and there is nothing left to
 *   unbind for. `done` alone stays out: it is the one status `/resume` refuses, so there is
 *   genuinely nothing a message there could ask for.
 *
 *   Several tasks can share one thread: a plan's children inherit their brainstorm's. So
 *   the parent going `done` must not close the thread its children still talk in.
 *
 *   When more than one shares it, `rank` decides. The task AWAITING AN ANSWER owns it —
 *   that is the task a human replying is replying to — and below that a task that can
 *   still move on its own outranks one that needs a human to restart it, so guidance meant
 *   for a running child is not filed against a parked sibling. Ties break on id, so every
 *   runner sorting the same set agrees.
 */
export const threadBindings = (
  tasks: readonly ThreadOwner[],
): readonly (readonly [string, TaskId])[] => {
  const live = tasks.filter((t) => t.threadId !== undefined && t.status !== "done");

  const owners = new Map<string, ThreadOwner>();
  for (const task of live) {
    const threadId = task.threadId ?? "";
    const held = owners.get(threadId);
    if (held === undefined || betterOwner(task, held)) owners.set(threadId, task);
  }

  return [...owners].map(([threadId, task]) => [threadId, task.id] as const);
};

/**
 * Who a message in a shared thread is most likely for. Lower wins.
 *
 * Ordered by what the human's next message can achieve, not by how healthy the task is: a
 * question is answerable now, a live task will read the journal at its next session, and a
 * terminal one does nothing at all until somebody resumes it.
 */
const rank = (task: ThreadOwner): number => {
  switch (task.status) {
    case "awaiting-human":
      return 0;
    case "running":
    case "ready":
      return 1;
    case "parked":
    case "failed":
      return 2;
    case "done":
      // Filtered out above; here so the switch stays exhaustive as statuses are added.
      return 3;
  }
};

const betterOwner = (candidate: ThreadOwner, held: ThreadOwner): boolean => {
  const byRank = rank(candidate) - rank(held);
  return byRank !== 0 ? byRank < 0 : candidate.id.localeCompare(held.id) < 0;
};

export class ThreadIndex {
  private readonly byThread = new Map<string, TaskId>();
  /**
   * Threads bound by THIS process rather than by a rebuild. See `replace`.
   *
   * Only ever a handful of entries — a brainstorm thread lives here for the seconds
   * between the bot creating it and the supervisor's next housekeeping pass publishing it.
   */
  private readonly local = new Map<string, number>();

  /**
   * How long a pin lasts, as a DURATION rather than a count of `replace` calls.
   *
   * A pin covers ONE window: the gap between this process binding a thread and the first
   * published mapping that mentions it. The unit matters, and getting it wrong is the bug
   * this constant replaced. The window is set by the SUPERVISOR's publishing cadence —
   * `housekeepingSeconds`, which defaults to `pollSeconds` (30s), and only then a git
   * pull, an inbox drain and a survey before `publish` runs. The bot's own refresh
   * interval is unrelated to it (5s, `bot.ts:THREAD_REFRESH_MS`). Counting refreshes
   * therefore measured the wrong clock: three of them is 15s, so on default config the
   * pin routinely expired BEFORE the first mapping naming the thread could arrive, and a
   * human typing in a fresh `/brainstorm` thread got "I do not know which task this thread
   * belongs to yet" instead of having their answer queued. Their text is not requeued
   * later; it is lost.
   *
   * Two minutes comfortably exceeds one housekeeping interval plus that tail, with room
   * for a slow pull, and it does not depend on how often the bot happens to refresh.
   *
   * It stays FINITE because the mapping might never mention the thread at all — a
   * brainstorm whose task is `done` before the survey that would have published it is
   * never named by any mapping, and a permanent pin would leave that dead thread bound for
   * the life of the process, reading every message typed there as an answer to a finished
   * task. That is the silent-swallowing failure `threadBindings` keeps `done` out for, so
   * the pin must not be able to reintroduce it.
   */
  private static readonly PIN_MS = 120_000;

  /** Injection seam: tests move the pin's clock instead of waiting two real minutes. */
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? ((): number => Date.now());
  }

  /**
   * Bind a thread this process knows about first-hand.
   *
   * The binding is PINNED: it survives the next few `replace` calls that do not mention the
   * thread — a few, not forever, for the reason on `PIN_GENERATIONS`. The
   * bot creates a brainstorm's thread and binds it locally before the task exists
   * (`bridge.ts:startBrainstorm`), so for one refresh interval the supervisor's published
   * mapping legitimately has nothing to say about it. Without the pin, the 5-second
   * refresh would unbind the thread a human was just invited to type in, and an unbound
   * thread is dropped by the gateway filter before it can even be answered honestly.
   */
  bind(threadId: string, task: TaskId): void {
    this.byThread.set(threadId, task);
    this.local.set(threadId, this.now() + ThreadIndex.PIN_MS);
  }

  /** Stop listening to a thread. Takes effect immediately, before the next poll. */
  unbind(threadId: string): void {
    this.byThread.delete(threadId);
    this.local.delete(threadId);
  }

  /**
   * Replace the whole index from an authoritative mapping — the state repo at boot, or the
   * supervisor's published bindings in the standalone bot.
   *
   * Locally bound threads (see `bind`) are kept when the incoming mapping does not mention
   * them, because it not mentioning them means "I have not heard of this yet", not "this
   * is over". The moment it DOES mention one the incoming value wins and the pin is
   * dropped: from then on the publisher is the authority, so a `done` task's thread still
   * unbinds on the pass after it disappears from the mapping. That is the property
   * `threadBindings` keeps `done` out for — a bound thread with nothing behind it swallows
   * everything typed into it in silence — and pinning must not cost it.
   */
  replace(entries: readonly (readonly [string, TaskId])[]): void {
    const incoming = new Map(entries);
    for (const threadId of [...this.byThread.keys()]) {
      if (incoming.has(threadId)) continue;

      // Never mentioned, and ours: keep it until the pin expires. A pin that never
      // expired would strand a thread no mapping will ever name — see `PIN_MS`.
      const until = this.local.get(threadId);
      if (until !== undefined && this.now() < until) continue;

      this.local.delete(threadId);
      this.byThread.delete(threadId);
    }
    for (const [threadId, task] of incoming) {
      this.byThread.set(threadId, task);
      // Now spoken for by the publisher, so it no longer needs — or gets — the pin.
      this.local.delete(threadId);
    }
  }

  taskFor(threadId: string): TaskId | undefined {
    return this.byThread.get(threadId);
  }

  knows(channelId: string): boolean {
    return this.byThread.has(channelId);
  }

  get size(): number {
    return this.byThread.size;
  }
}

/**
 * Whether the gateway should deliver a message from a channel it does not have bound.
 *
 * The gap this closes. The bridge has an honest answer for "a message in a thread I have
 * no binding for" (`bridge.ts:handleMessage`) — but it was unreachable through the real
 * wiring, because the gateway dropped exactly those messages first: its filter asked the
 * SAME index the bridge would ask, so a thread the bridge would call unbound is a thread
 * the gateway had already discarded. The result was the failure the split exists to
 * remove, arriving by a different door: on a cold start, before any supervisor has
 * published, a human typing in a task thread got silence.
 *
 * Fixing it needs one fact the payload does not carry — is this channel a thread of OUR
 * channel? — so it takes a REST lookup (`bot.ts:parentChannel`). That cannot go on the
 * gateway's synchronous hot path unmemoised, so this caches per channel, permanently and
 * both ways: a channel's parent never changes, so a "no" is as durable as a "yes", and the
 * negative cache is what stops an unrelated busy channel costing one lookup per message.
 *
 * Bounded, because the id space is not: an attacker-adjacent channel cannot grow this
 * without limit. On overflow the cache is cleared rather than evicted one-by-one — the
 * entries are worth microseconds each and re-earning them costs one lookup.
 */
export const MAX_ROUTER_CACHE = 1024;

export class ThreadRouter {
  private readonly channelId: string;
  private readonly parentOf: (channelId: string) => Promise<string | undefined>;
  private readonly index: { knows(channelId: string): boolean };
  /** channel id → is it a thread of ours. Both answers cached; see the docstring. */
  private readonly ours = new Map<string, boolean>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(options: {
    readonly channelId: string;
    readonly index: { knows(channelId: string): boolean };
    readonly parentOf: (channelId: string) => Promise<string | undefined>;
  }) {
    this.channelId = options.channelId;
    this.index = options.index;
    this.parentOf = options.parentOf;
  }

  /**
   * Synchronous fast path, for a channel already known to be ours.
   *
   * Keeps the common case — a bound thread, or the main channel — free of any await, which
   * is what the gateway filter was shaped for.
   */
  knows(channelId: string): boolean {
    return this.index.knows(channelId) || this.ours.get(channelId) === true;
  }

  /**
   * Should this message reach the bridge?
   *
   * True for the main channel, for any bound thread, and — the point of this class — for an
   * UNBOUND thread whose parent is our channel, so the bridge can say it does not know the
   * binding yet instead of the message vanishing.
   */
  async deliverable(channelId: string): Promise<boolean> {
    if (channelId === this.channelId) return true;
    if (this.knows(channelId)) return true;

    const cached = this.ours.get(channelId);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(channelId);
    if (pending !== undefined) return pending;

    // Shared, so a burst in one thread is one lookup rather than one per message.
    const lookup = this.parentOf(channelId)
      .then((parent) => parent === this.channelId)
      .catch(() => false)
      .then((isOurs) => {
        if (this.ours.size >= MAX_ROUTER_CACHE) this.ours.clear();
        this.ours.set(channelId, isOurs);
        return isOurs;
      })
      .finally(() => this.inflight.delete(channelId));

    this.inflight.set(channelId, lookup);
    return lookup;
  }
}
