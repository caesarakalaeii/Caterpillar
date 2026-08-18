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
import { isTerminal, type TaskId, type TaskStatus } from "../domain/task.ts";

/** What the index needs to know about a task to decide whether its thread is live. */
export interface ThreadOwner {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly threadId?: string;
}

/**
 * Which threads are still worth listening to, and which task owns each. Pure.
 *
 * Two rules, both learned the hard way:
 *
 *   A TERMINAL task's thread is not bound. Its conversation is over, and since a message
 *   in a bound thread is now an answer, leaving it bound means an abandoned thread
 *   silently swallows everything typed into it — the loop answers `not-waiting` and the
 *   bridge, correctly, says nothing.
 *
 *   Several tasks can share one thread: a plan's children inherit their brainstorm's.
 *   So the parent going `done` must not close the thread its children still talk in, and
 *   when more than one is live the one AWAITING AN ANSWER owns it — that is the task a
 *   human replying is replying to. Ties break on id, so every runner agrees.
 */
export const threadBindings = (
  tasks: readonly ThreadOwner[],
): readonly (readonly [string, TaskId])[] => {
  const live = tasks.filter((t) => t.threadId !== undefined && !isTerminal(t.status));

  const owners = new Map<string, ThreadOwner>();
  for (const task of live) {
    const threadId = task.threadId ?? "";
    const held = owners.get(threadId);
    if (held === undefined || betterOwner(task, held)) owners.set(threadId, task);
  }

  return [...owners].map(([threadId, task]) => [threadId, task.id] as const);
};

const betterOwner = (candidate: ThreadOwner, held: ThreadOwner): boolean => {
  const waiting = (t: ThreadOwner): number => (t.status === "awaiting-human" ? 0 : 1);
  const byWaiting = waiting(candidate) - waiting(held);
  return byWaiting !== 0 ? byWaiting < 0 : candidate.id.localeCompare(held.id) < 0;
};

export class ThreadIndex {
  private readonly byThread = new Map<string, TaskId>();
  /**
   * Threads bound by THIS process rather than by a rebuild. See `replace`.
   *
   * Only ever a handful of entries — a brainstorm thread lives here for the seconds
   * between the bot creating it and the supervisor's next housekeeping pass publishing it.
   */
  private readonly local = new Set<string>();

  /**
   * Bind a thread this process knows about first-hand.
   *
   * The binding is PINNED: it survives a `replace` that does not mention the thread. The
   * bot creates a brainstorm's thread and binds it locally before the task exists
   * (`bridge.ts:startBrainstorm`), so for one refresh interval the supervisor's published
   * mapping legitimately has nothing to say about it. Without the pin, the 5-second
   * refresh would unbind the thread a human was just invited to type in, and an unbound
   * thread is dropped by the gateway filter before it can even be answered honestly.
   */
  bind(threadId: string, task: TaskId): void {
    this.byThread.set(threadId, task);
    this.local.add(threadId);
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
   * dropped: from then on the publisher is the authority, so a terminal task's thread
   * still unbinds on the pass after it disappears from the mapping. That is the property
   * `threadBindings` unbinds terminal tasks for — a bound thread with nothing behind it
   * swallows everything typed into it in silence — and pinning must not cost it.
   */
  replace(entries: readonly (readonly [string, TaskId])[]): void {
    const incoming = new Map(entries);
    for (const threadId of [...this.byThread.keys()]) {
      if (incoming.has(threadId)) continue;
      // Never mentioned, and ours: keep it, still pinned.
      if (this.local.has(threadId)) continue;
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
