/**
 * The queue between an inbound chat message and the supervisor's poll loop.
 *
 * The loop OWNS the state repo: it pulls, writes, commits and pushes on one thread of
 * control. A websocket event handler doing the same thing concurrently would interleave
 * two git invocations in one working copy — `index.lock` at best, a half-staged commit
 * at worst. So the bridge does not touch git at all. It submits, the loop drains, and
 * the submitter is told what happened.
 *
 * That also means a request lands at a defined point in the cycle: before claiming, so
 * a task unparked by an answer is claimable on the same pass rather than the next one.
 *
 * Nothing that can be served WITHOUT git comes through here. Listing tasks and showing
 * one are answered from the snapshot (`snapshot.ts`) inside Discord's 3-second
 * acknowledgement budget; this queue is only for things that must be written.
 */
import type { TaskId } from "../domain/task.ts";

export type ChatOutcome =
  | { readonly kind: "applied"; readonly index: number }
  | { readonly kind: "parked" }
  | { readonly kind: "merged"; readonly prUrl: string }
  | { readonly kind: "started"; readonly task: TaskId }
  | { readonly kind: "unknown-task" }
  /** The request was well-formed but could not be acted on — a repo nothing owns, say. */
  | { readonly kind: "refused"; readonly reason: string }
  /** Answering a task that is not waiting on a question. */
  | { readonly kind: "not-waiting"; readonly status: string }
  /** Parking a task that is already terminal. */
  | { readonly kind: "not-parkable"; readonly status: string }
  /** Merging was possible in principle but refused — no PR, or no reviewer identity. */
  | { readonly kind: "not-mergeable"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

/** What the bridge asks the loop to do. Everything here writes the state repo. */
export type ChatIntent =
  | { readonly kind: "answer"; readonly task: TaskId; readonly text: string }
  | { readonly kind: "park"; readonly task: TaskId }
  | { readonly kind: "merge"; readonly task: TaskId }
  /**
   * Create a brainstorm task (DESIGN.md §14.3).
   *
   * The thread already exists by the time this arrives — the bridge opened it, because
   * the task's id is derived from it. This is the one request that carries no task id:
   * it is the one that mints one.
   */
  | {
      readonly kind: "brainstorm";
      readonly topic: string;
      readonly repo: string;
      readonly threadId: string;
      readonly author: string;
    };

export type ChatRequest = ChatIntent & {
  /** Settled by the loop once the write has been pushed, or has failed to be. */
  readonly settle: (outcome: ChatOutcome) => void;
};

export class ChatInbox {
  private queue: ChatRequest[] = [];

  /** Called from the bridge. Resolves when the LOOP has dealt with it, not before. */
  submit(intent: ChatIntent): Promise<ChatOutcome> {
    return new Promise<ChatOutcome>((resolve) => {
      this.queue.push({ ...intent, settle: resolve });
    });
  }

  /**
   * Take everything queued so far.
   *
   * Swapped rather than emptied in place, so a submission arriving mid-drain waits for
   * the next pass instead of being processed by a loop that has moved on.
   */
  drain(): readonly ChatRequest[] {
    const taken = this.queue;
    this.queue = [];
    return taken;
  }

  get size(): number {
    return this.queue.length;
  }
}
