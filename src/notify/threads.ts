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
import type { TaskId } from "../domain/task.ts";

export class ThreadIndex {
  private readonly byThread = new Map<string, TaskId>();

  bind(threadId: string, task: TaskId): void {
    this.byThread.set(threadId, task);
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
