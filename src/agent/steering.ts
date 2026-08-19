/**
 * Human input reaching a session that is already running. See DESIGN.md §7.3.
 *
 * Until this existed the only thing that could reach a live session was `/cancel`, and it
 * could only stop it. Everything else waited for a session boundary: the agent had to call
 * `ask_human`, which parks the task and releases the lease, and the answer was read by the
 * NEXT session out of a file. That is the right shape for a question the agent chose to
 * ask. It is the wrong shape for the case this file is for — a human watching a thread who
 * can already see the session going the wrong way.
 *
 * pi has the mechanism: `Agent.steer` queues a message and the loop drains it at the next
 * turn boundary, after the current assistant turn's tool calls finish. So a steer costs the
 * session nothing — no restart, no fresh context, no lost work — and lands within one turn.
 *
 * This is the seam between that mechanism and where the messages come from. `SteeringFeed`
 * is all `runSession` knows: something that has messages now, and will have more later. The
 * supervisor owns the other side (`SlotSteering`), because the thing a message crosses to
 * get here is a process boundary and only the supervisor has the transport (§21).
 *
 * Two rules are encoded below, and both are about a steer that does NOT get read:
 *
 *   Arriving is recorded, not consuming. `shouldStopAfterTurn` exits the loop BEFORE it
 *   polls the steering queue, so a message that lands in the same turn as an `ask_human`
 *   or a handoff is queued and never seen. `arrived()` is therefore what the journal is
 *   written from — the next session reads the journal, so a steer the model missed is
 *   still in front of it, which is the safe direction to be wrong in.
 *
 *   Nothing here throws. A feed is drained inside pi's event loop and from a Redis
 *   subscription callback; an exception in either tears down the session that was being
 *   steered, which is a strictly worse outcome than the steer being late.
 */

/** What `runSession` needs: the backlog, and a way to be told about the rest. */
export interface SteeringFeed {
  /**
   * Messages queued before this session started, taken exactly once.
   *
   * Ordinarily empty. It is non-empty when a previous session was interrupted between a
   * steer arriving and the turn boundary that would have read it — the message survived in
   * the transport, and the session that replaces it is the one that should act on it.
   */
  take(): readonly string[];
  /**
   * Be told about each message that arrives while this session runs.
   *
   * The returned function unsubscribes and must be called when the session ends, or a
   * long-lived runner accumulates one listener per session it has ever run.
   */
  subscribe(onSteer: (text: string) => void): () => void;
}

/**
 * One task's steering, for as long as a runner is working it.
 *
 * Its lifetime is the SLOT's, not the session's, which is the point: `workTask` drives one
 * task through as many sessions as it needs, and a message that arrives between two of them
 * has nowhere else to wait. With no session subscribed it buffers; when one subscribes it
 * hands over the buffer and then forwards.
 *
 * Single-subscriber deliberately. Two sessions of the same task never run at once — a slot
 * is one task and a lease is one slot — so a second subscriber would mean a bug somewhere
 * else, and splitting messages between two consumers would hide it.
 */
export class SlotSteering implements SteeringFeed {
  private buffered: string[] = [];
  private listener: ((text: string) => void) | undefined;
  private readonly seen: string[] = [];

  /**
   * A message from a human. Delivered to the live session, or held for the next one.
   *
   * Never throws: it is called from a Redis subscription callback, where nothing is
   * positioned to handle an exception (§21).
   */
  push(text: string): void {
    this.seen.push(text);
    const listener = this.listener;
    if (listener === undefined) {
      this.buffered.push(text);
      return;
    }
    try {
      listener(text);
    } catch {
      // The session's own queue refused it. Hold it instead, so the next session's `take`
      // finds it rather than it vanishing between the two.
      this.buffered.push(text);
    }
  }

  take(): readonly string[] {
    const pending = this.buffered;
    this.buffered = [];
    return pending;
  }

  subscribe(onSteer: (text: string) => void): () => void {
    this.listener = onSteer;
    return (): void => {
      if (this.listener === onSteer) this.listener = undefined;
    };
  }

  /**
   * Everything a human has said about this task since the slot opened.
   *
   * What the journal is written from — see the header. Reset by `clearArrived` once a
   * session has recorded them, so the same guidance is not appended again after every
   * subsequent session of a task that hands off five times.
   */
  arrived(): readonly string[] {
    return [...this.seen];
  }

  clearArrived(): void {
    this.seen.length = 0;
  }
}
