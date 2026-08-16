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
  /**
   * A parked task is back in the queue.
   *
   * `exhausted` is set when the task will meet a limit again almost immediately — it has
   * used its sessions, or its no-progress streak is already at the threshold. Resuming
   * deliberately does not reset those counters, so saying nothing would let the human
   * discover it when the task parks itself thirty seconds later.
   */
  | { readonly kind: "resumed"; readonly from: string; readonly exhausted?: string }
  /**
   * Resuming a task that is not parked.
   *
   * Separate from `not-parkable` rather than sharing it: the two refusals are opposites
   * ("already terminal" vs "not terminal yet"), and one message that tried to cover both
   * would have to be vague about which.
   */
  | { readonly kind: "not-resumable"; readonly status: string }
  | { readonly kind: "merged"; readonly prUrl: string }
  | { readonly kind: "started"; readonly task: TaskId }
  | { readonly kind: "unknown-task" }
  /** The request was well-formed but could not be acted on — a repo nothing owns, say. */
  | { readonly kind: "refused"; readonly reason: string }
  /** Answering a task that is not waiting on a question. */
  | { readonly kind: "not-waiting"; readonly status: string }
  /** Parking a task that is already terminal. */
  | { readonly kind: "not-parkable"; readonly status: string }
  /**
   * A running session on THIS runner was asked to stop.
   *
   * Distinct from `parked`: the session stops at the next turn boundary and the park
   * lands on the poll after that, so saying "parked" here would be a second or two
   * early — and the difference is visible, because the thread keeps showing the typing
   * indicator until the session actually unwinds.
   */
  | { readonly kind: "cancelling" }
  /** Merging was possible in principle but refused — no PR, or no reviewer identity. */
  | { readonly kind: "not-mergeable"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

/** What the bridge asks the loop to do. Everything here writes the state repo. */
export type ChatIntent =
  | { readonly kind: "answer"; readonly task: TaskId; readonly text: string }
  | { readonly kind: "park"; readonly task: TaskId }
  /**
   * Put a parked task back in the queue — `/resume`.
   *
   * The inverse of `park`, and it exists because `parked` is TERMINAL (`isTerminal`):
   * nothing in the loop moves a task out of it, so without this the only way back is an
   * operator editing `state.json` in the state repo by hand. That is not a smaller
   * version of this command, it is a race — the loop owns the state repo working copy,
   * and an out-of-band push lands between its pull and its push, rejecting the latter.
   * Observed, not theorised: it cost a task a session and then failed its park too.
   */
  | { readonly kind: "resume"; readonly task: TaskId }
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

  /**
   * Take just the requests matching `select`, leaving the rest queued.
   *
   * Exists for exactly one caller: the supervisor watching for a `/cancel` while a
   * session is in flight. The normal `drain` runs in the poll loop, which is BLOCKED for
   * the whole duration of a session — so a cancel submitted while the agent is working
   * sat in the queue until the session it was meant to stop had already finished, and
   * the operator's Discord reply hung until then too.
   *
   * Deliberately not a general "process requests during a session": everything else in
   * the queue writes the state repo, and the running session holds the lease those
   * writes would have to fence against. A cancel is safe because it writes nothing — it
   * aborts, and the write happens on the poll that follows.
   */
  takeWhere(select: (request: ChatRequest) => boolean): readonly ChatRequest[] {
    const taken = this.queue.filter(select);
    if (taken.length > 0) this.queue = this.queue.filter((request) => !select(request));
    return taken;
  }

  get size(): number {
    return this.queue.length;
  }
}
