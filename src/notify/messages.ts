/**
 * Which Discord message belongs to which task. See DESIGN.md §7.3.
 *
 * The thread↔task index (`threads.ts`) cannot answer this on its own, and the gap is a
 * bug rather than a nicety: a plan's children INHERIT their brainstorm's thread, so one
 * thread names several tasks and `threadBindings` has to pick between them by rank. A
 * human replying to child `-03`'s question therefore had their answer filed against
 * whichever sibling ranked highest, silently.
 *
 * A Discord reply carries `message_reference.message_id`, and the message it names is one
 * the bot posted about exactly one task. That is the missing fact, and this is where it is
 * kept.
 *
 * In memory and DELIBERATELY lossy. Two tiers read it (`bridge.ts:targetOf`) precisely
 * because neither is sufficient alone: this index loses everything on a restart, and a
 * REST fetch of an old message cannot recover targeting for a thread whose notifications
 * the running process posted. What this tier buys is the common case — a live thread, a
 * reply within minutes — at no request cost.
 */
import { isTaskId, type TaskId } from "../domain/task.ts";

/**
 * Messages remembered before the oldest is dropped.
 *
 * Bounded because the id space is not: this grows by one per task-scoped message the bot
 * posts, forever, in a process that is meant to run for weeks. Four thousand is far more
 * than any thread's live conversation and costs a few hundred kilobytes.
 *
 * Evicted OLDEST-FIRST rather than cleared wholesale, which is what `ThreadRouter` does
 * with its parent cache. The two are not alike: a router entry is worth microseconds and
 * re-earned by one lookup, while an entry here cannot be re-earned at all once the message
 * has scrolled out of the index — the fallback is a REST fetch that may fail. Dropping the
 * four thousand most recent to save the oldest would be the wrong way round, since a reply
 * targets a recent message.
 */
export const MAX_REMEMBERED_MESSAGES = 4096;

export class MessageIndex {
  /**
   * message id → task. A `Map` iterates in insertion order, which is what makes the
   * oldest entry findable without a second structure.
   */
  private readonly byMessage = new Map<string, TaskId>();

  /** Remember that `messageId` is about `task`. */
  record(messageId: string, task: TaskId): void {
    // Deleted first so a re-recorded id moves to the END of the insertion order. Without
    // it an edited or re-posted message would keep the eviction age of its first sighting.
    this.byMessage.delete(messageId);
    this.byMessage.set(messageId, task);

    while (this.byMessage.size > MAX_REMEMBERED_MESSAGES) {
      const oldest = this.byMessage.keys().next();
      if (oldest.done === true) return;
      this.byMessage.delete(oldest.value);
    }
  }

  taskFor(messageId: string): TaskId | undefined {
    return this.byMessage.get(messageId);
  }

  get size(): number {
    return this.byMessage.size;
  }
}

/**
 * The task a bot message is about, read from its own text.
 *
 * The fallback for a message this process never posted — one from before a restart, or one
 * the SUPERVISOR posted in the split deployment (§7), where the process holding the index
 * is not the process that sends notifications. Every task-scoped message the bot writes
 * opens with the id in bold: `discord.ts:renderParts` heads a question with
 * `**<task>** needs input`, and `replies.ts:describeOutcome` puts it in the first sentence.
 *
 * Only a LEADING `**…**` counts. A task id appearing later in the prose is as likely to be
 * a human quoting a sibling as it is to be the subject, and guessing wrong here is the
 * failure this whole path exists to remove.
 */
export const taskFromContent = (content: string): TaskId | undefined => {
  const match = /^\s*\*\*([^*\s]+)\*\*/.exec(content);
  const candidate = match?.[1];
  if (candidate === undefined || !isTaskId(candidate)) return undefined;
  return candidate;
};
