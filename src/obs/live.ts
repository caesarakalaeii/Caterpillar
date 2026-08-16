/**
 * The session this runner is executing right now. See DESIGN.md §18.
 *
 * A transcript is written to `sessions/NNN.jsonl.gz` when a session ENDS, and pushed
 * later still. That is the right durability story and the wrong latency one: a session
 * runs for tens of minutes, and for all of them the state repo says only that the task is
 * `running`. This holds the messages as they arrive so the web view can show the session
 * in progress; once the session ends the file exists and this is cleared.
 *
 * It costs almost nothing: pi already holds these messages in `agent.state.messages` for
 * the length of the session, so this keeps references to objects that are alive anyway.
 * Clearing at the end is what stops it becoming a second, unbounded copy of every
 * transcript the runner has ever produced.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskId } from "../domain/task.ts";

export interface LiveSessionStart {
  readonly task: TaskId;
  /** Ordinal of the session being run, i.e. `state.sessions + 1`. */
  readonly session: number;
  readonly model: string;
  /** Stamped by the caller — the clock belongs to the supervisor (see cooldown.ts). */
  readonly startedAt: string;
}

export interface LiveSessionView extends LiveSessionStart {
  readonly messages: readonly AgentMessage[];
}

export class LiveSession {
  private active: LiveSessionStart | undefined;
  private messages: AgentMessage[] = [];

  begin(start: LiveSessionStart): void {
    this.active = start;
    this.messages = [];
  }

  /**
   * Dropped when no session is in flight. pi settles its `subscribe` listeners after the
   * run returns, so a `message_end` can land just after `end()` — attributing it to
   * whichever session starts next would put one task's message under another's heading.
   */
  record(message: AgentMessage): void {
    if (this.active === undefined) return;
    this.messages.push(message);
  }

  end(): void {
    this.active = undefined;
    this.messages = [];
  }

  /** A snapshot. The array is copied so a page cannot change while it is being rendered. */
  current(): LiveSessionView | undefined {
    if (this.active === undefined) return undefined;
    return { ...this.active, messages: [...this.messages] };
  }
}
