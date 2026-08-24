/**
 * The queue between an inbound chat message and the supervisor's housekeeping loop.
 *
 * The supervisor's loops OWN the state repo: they pull, write, commit and push, and every
 * git invocation among them is serialised by `Serial` (see `StateStore`). A websocket event
 * handler doing the same thing concurrently would be outside that discipline entirely and
 * would interleave two git invocations in one working copy — `index.lock` at best, a
 * half-staged commit at worst. So the bridge does not touch git at all. It submits, the
 * housekeeping loop drains, and the submitter is told what happened.
 *
 * That also means a request lands at a defined point in the cycle. Since housekeeping runs
 * on its own timer (DESIGN.md §6.4) that point no longer waits for a session to end: a
 * `/resume` or `/answer` submitted mid-session is drained on the next housekeeping tick,
 * and the work loop finds the task claimable when it next looks.
 *
 * Nothing that can be served WITHOUT git comes through here. Listing tasks and showing
 * one are answered from the snapshot (`snapshot.ts`) inside Discord's 3-second
 * acknowledgement budget; this queue is only for things that must be written.
 */
import type { ReportKind, ReportSource, TaskId, TrackerRef } from "../domain/task.ts";

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
  /**
   * The merge was carried out — which on a repo with a merge queue means ENQUEUED.
   *
   * `note` is what actually happened, in words, and it is what the reply renders when it
   * is there. A queued pull request has not landed and can still be rejected by the
   * queue's own checks, so calling it "merged" would stop a human watching something that
   * is not finished. Not a separate outcome kind: the request succeeded, and every caller
   * that branches on `merged` — the transition to `done`, the journal entry — does the
   * same thing either way.
   */
  | { readonly kind: "merged"; readonly prUrl: string; readonly note?: string }
  | { readonly kind: "started"; readonly task: TaskId }
  | { readonly kind: "unknown-task" }
  /** The request was well-formed but could not be acted on — a repo nothing owns, say. */
  | { readonly kind: "refused"; readonly reason: string }
  /**
   * Guidance recorded against a task that was not waiting on a question (DESIGN.md §7.3).
   *
   * What `not-waiting` used to be, and the difference is the whole point. `not-waiting` was
   * a refusal: the text was read, matched against `awaiting-human`, and DISCARDED — while
   * three separate notifications were telling the human to "say what to change in this
   * thread". Nothing carried it anywhere, and the bridge said nothing about that, so a
   * rejected plan could only ever be re-run unchanged.
   *
   * `notes` is how many pieces of guidance the task now carries; `resumable` says whether it
   * needs a human to restart it, which decides whether the reply offers a Resume button; and
   * `roundsCleared` reports the council budget being forgiven, because a resume that did not
   * forgive it buys exactly one more round before parking again.
   */
  | {
      readonly kind: "guided";
      readonly notes: number;
      readonly resumable: boolean;
      readonly roundsCleared: boolean;
    }
  /**
   * Guidance handed to a session that is running right now (DESIGN.md §7.3).
   *
   * Distinct from `guided` because nothing was written: the task's lease is held by the
   * session, so the state repo cannot be touched from here at all. The message travels on the
   * steering plane instead, the session injects it at its next turn boundary, and the journal
   * entry is written by that session's own `recordSession`.
   */
  | { readonly kind: "steered" }
  /** Talking to a task that is `done`. Nothing to steer, and `/resume` refuses it. */
  | { readonly kind: "finished" }
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
  /**
   * A task was marked `done` by hand, with both §12 gates bypassed — `/done`.
   *
   * Deliberately not `merged`: nothing was merged and no PR need have existed, and a reply
   * that said "merged" about a task nobody verified is the one reading this command must
   * never produce.
   */
  | { readonly kind: "forced-done" }
  /** Forcing was refused — a `running` task, which has to be cancelled first. */
  | { readonly kind: "not-forceable"; readonly reason: string }
  /**
   * A task's acceptance criteria were replaced — `/amend` (DESIGN.md §12.3).
   *
   * `removed` and `added` are the two ends of the diff, carried so the reply can say what
   * the human just changed rather than that something changed. An amendment can be as wrong
   * as the criterion it replaced, and re-amending is the only correction path, so the human
   * has to be able to see the mistake without opening the state repo.
   */
  | {
      readonly kind: "amended";
      /** The `NNN` of the record written, so the audit trail can be named. */
      readonly index: number;
      readonly removed: readonly string[];
      readonly added: readonly string[];
    }
  /** Amending was refused — a `running` task, which has to be cancelled first. */
  | { readonly kind: "not-amendable"; readonly reason: string }
  /**
   * A tracker item was filed from the agent's own text — a Report button (DESIGN.md §7).
   *
   * `ref` rather than a URL, because a ref is what the tracker returns and only some of them
   * have a derivable web address: Vikunja's depends on the instance's frontend, which a ref
   * does not carry. The reply renders a link when there is one and names the item when there
   * is not — a guessed URL that 404s is worse than an id.
   *
   * `note` is what actually happened when it was not simply "filed": a SECOND press of the
   * same button reports the item the first press filed, and a reply that did not say so
   * would read as a second item. Not a separate outcome kind, because every caller does the
   * same thing with both — the pair is `merged`'s, for the same reason.
   */
  | {
      readonly kind: "filed";
      readonly report: ReportKind;
      readonly ref: TrackerRef;
      readonly note?: string;
    }
  /** Filing was refused, or the tracker rejected it. The text is still only in Discord. */
  | { readonly kind: "not-filed"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

/** What the bridge asks the loop to do. Everything here writes the state repo. */
export type ChatIntent =
  | { readonly kind: "answer"; readonly task: TaskId; readonly text: string }
  /**
   * One of the enumerated choices the open question offered, pressed as a button (§7).
   *
   * Carries the option's INDEX and not its text, and that is not an economy — it is the
   * only thing it can carry. The button's `custom_id` holds 100 characters and the task id
   * has spent most of them, so the text is stored beside the question and looked up by the
   * loop, which is also what lets a press against a superseded question be REFUSED rather
   * than write a choice the agent never offered.
   */
  | { readonly kind: "answer-option"; readonly task: TaskId; readonly option: number }
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
   * Mark a task `done` by hand — `/done`.
   *
   * `author` and `reason` are both carried because both go in the journal, and the journal
   * is the only record that this `done` was a decision rather than a verification. Nothing
   * downstream can reconstruct either: the loop never sees Discord.
   */
  | {
      readonly kind: "force-done";
      readonly task: TaskId;
      readonly reason: string;
      readonly author: string;
    }
  /**
   * Create a brainstorm task (DESIGN.md §14.3).
   *
   * The thread already exists by the time this arrives — the bridge opened it, because
   * the task's id is derived from it. This is the one request that carries no task id:
   * it is the one that mints one.
   *
   * `repos` is raw, unparsed and plural: the loop parses it and enforces that every entry
   * resolves to ONE workspace (§14.3), because that refusal needs the config the bridge
   * does not have.
   */
  | {
      readonly kind: "brainstorm";
      readonly topic: string;
      readonly repos: readonly string[];
      readonly threadId: string;
      readonly author: string;
    }
  /**
   * File a tracker item from the agent's own text — a Report button (DESIGN.md §7).
   *
   * The text is deliberately NOT here. It is read from the state repo by the loop, which is
   * the side that owns it — and a long question is SPLIT across several Discord messages, so
   * the message the button sits on holds only the last part of it.
   *
   * `author` travels for `force-done`'s reason: the filed item says who asked for it, and
   * nothing downstream can reconstruct it because the loop never sees Discord.
   */
  | {
      readonly kind: "file-report";
      readonly task: TaskId;
      readonly report: ReportKind;
      readonly source: ReportSource;
      readonly author: string;
    }
  /**
   * Replace a task's acceptance criteria — `/amend` (DESIGN.md §12.3).
   *
   * `acceptance` is the WHOLE replacement list, which is what the amendment record holds:
   * a positional patch against an immutable file is unreadable six months later without
   * that file open beside it.
   *
   * `why` and `author` both travel for `force-done`'s reason — they go into the record and
   * into the journal, and nothing downstream can reconstruct either, because the loop never
   * sees Discord.
   */
  | {
      readonly kind: "amend";
      readonly task: TaskId;
      readonly acceptance: readonly string[];
      readonly why: string;
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
   * Exists for exactly one caller: the supervisor watching for a `/cancel` naming the task
   * THIS runner is currently running.
   *
   * Everything else is now drained by the housekeeping loop, which runs on its own timer
   * and no longer waits for a session (DESIGN.md §6.4). This one request cannot be, and the
   * reason is structural rather than about timing: parking a task takes its lease, and the
   * in-flight session already holds it. Only code inside the session can honour a cancel
   * for its own task — it aborts, and the write happens on the tick that follows.
   */
  takeWhere(select: (request: ChatRequest) => boolean): readonly ChatRequest[] {
    const taken = this.queue.filter(select);
    if (taken.length > 0) this.queue = this.queue.filter((request) => !select(request));
    return taken;
  }

  /**
   * Is anything matching `select` queued? Consumes nothing.
   *
   * The counterpart to `takeWhere`, for a caller that must NOT take the request: a
   * session in flight asking whether a human is waiting on a brainstorm. It cannot serve
   * one — creating the task writes the state repo, and this session holds the working
   * copy — so all it does is stop after the current session and hand back to the loop,
   * which drains properly on the very next poll. Taking the request to look at it would
   * strand the human the check exists for.
   */
  some(select: (request: ChatRequest) => boolean): boolean {
    return this.queue.some(select);
  }

  get size(): number {
    return this.queue.length;
  }
}
