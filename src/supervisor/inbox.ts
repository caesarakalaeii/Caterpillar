/**
 * The queue between an inbound chat message and the supervisor's poll loop.
 *
 * The loop OWNS the state repo: it pulls, writes, commits and pushes on one thread of
 * control. A websocket event handler doing the same thing concurrently would interleave
 * two git invocations in one working copy — `index.lock` at best, a half-staged commit
 * at worst. So the bridge does not touch git at all. It submits, the loop drains, and
 * the submitter is told what happened.
 *
 * That also means an answer lands at a defined point in the cycle: before claiming, so
 * a task unparked by an answer is claimable on the same pass rather than the next one.
 */
import type { TaskId } from "../domain/task.ts";

export type AnswerOutcome =
  | { readonly kind: "applied"; readonly index: number }
  | { readonly kind: "unknown-task" }
  | { readonly kind: "not-waiting"; readonly status: string }
  | { readonly kind: "failed"; readonly error: string };

export interface AnswerRequest {
  readonly task: TaskId;
  readonly text: string;
  /** Settled by the loop once the answer has been pushed, or has failed to be. */
  readonly settle: (outcome: AnswerOutcome) => void;
}

export class AnswerInbox {
  private queue: AnswerRequest[] = [];

  /** Called from the bridge. Resolves when the LOOP has dealt with it, not before. */
  submit(task: TaskId, text: string): Promise<AnswerOutcome> {
    return new Promise<AnswerOutcome>((resolve) => {
      this.queue.push({ task, text, settle: resolve });
    });
  }

  /**
   * Take everything queued so far.
   *
   * Swapped rather than emptied in place, so a submission arriving mid-drain waits for
   * the next pass instead of being processed by a loop that has moved on.
   */
  drain(): readonly AnswerRequest[] {
    const taken = this.queue;
    this.queue = [];
    return taken;
  }

  get size(): number {
    return this.queue.length;
  }
}
