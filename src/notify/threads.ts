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

  bind(threadId: string, task: TaskId): void {
    this.byThread.set(threadId, task);
  }

  /** Stop listening to a thread. Takes effect immediately, before the next poll. */
  unbind(threadId: string): void {
    this.byThread.delete(threadId);
  }

  /** Replace the whole index — used to rebuild it from the state repo at boot. */
  replace(entries: readonly (readonly [string, TaskId])[]): void {
    this.byThread.clear();
    for (const [threadId, task] of entries) this.byThread.set(threadId, task);
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
