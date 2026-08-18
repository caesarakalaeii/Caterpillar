/**
 * What the bot advertises it is doing, as a Discord presence. See DESIGN.md §7.2.
 *
 * The question this answers is "is Caterpillar working, and on what", asked by someone who
 * is already looking at Discord and does not want to open the web view to find out. The
 * member list is the cheapest possible place to put that: no channel message, nothing to
 * scroll past, and it is correct or absent rather than a log of things that used to be
 * true.
 *
 * Three decisions worth stating, because none of them is the obvious default.
 *
 * **It is rendered from the SURVEY, not from this process's live session.** `obs/live.ts`
 * knows what THIS runner is doing and nothing about the other three, so a presence built
 * from it would say "idle" on three replicas out of four and race to overwrite whichever
 * one was right. The survey is every task's committed state, which is the same on every
 * replica because it comes out of the state repo — so all four render the SAME string and
 * it does not matter which one Discord's presence ends up reflecting. Redis presence
 * (`redis/presence.ts`) would also work, but it is off in the deployment this was written
 * for, and a feature that silently shows one runner's view when it is off is worse than one
 * that never needed it.
 *
 * **Every replica publishes, rather than only the chat holder.** The holder is the replica
 * allowed to ACT on Discord (`leadership.ts`), and the reason is that four replicas acting
 * on one `!answer` did real damage. Presence is not an action: it is idempotent, carries no
 * state, and four replicas sending the identical payload converge on the identical result.
 * Holder-only would be strictly worse — the presence would go stale for as long as a claim
 * handover takes, and a bot whose status says `idle` while a session runs is the exact
 * thing this exists to prevent.
 *
 * **Activity type 3, `Watching`.** Discord renders it as "Watching <name>", so the strings
 * below are written to read as English after that word — "Watching ALERT-6155db · planning",
 * "Watching for work · 4 ready". Type 4 (`Custom`) would drop the verb and read better
 * still, and is deliberately not used: its support for BOTS has changed more than once, and
 * the failure mode is a presence that silently renders as nothing at all. A slightly clumsy
 * status that is definitely visible beats an elegant one that might not be.
 */
import type { TaskId, TaskPhase, TaskStatus } from "../domain/task.ts";

/** Discord's `ActivityType`. Only the one we send. */
export const WATCHING = 3;

/**
 * Discord's presence `status`. `online` whenever this process is up.
 *
 * Not `idle` when the fleet is idle, tempting as the symmetry is: Discord's `idle` renders
 * as the yellow "away" dot, which means "this client is not being used" and would read as
 * the bot being unreachable. A runner with nothing to do is still answering `/tasks`.
 */
const ONLINE = "online";

/** The activity object Discord expects inside a presence update. */
export interface Activity {
  readonly name: string;
  readonly type: number;
}

/** The `d` of an opcode 3, and of `identify`'s optional `presence`. */
export interface PresencePayload {
  readonly activities: readonly Activity[];
  readonly status: string;
  /** Epoch millis this presence began, or null. Discord shows it as elapsed time. */
  readonly since: number | null;
  readonly afk: boolean;
}

/**
 * The part of a task this needs. Structural, so `TaskRecord` satisfies it without
 * `supervisor/loop.ts` having to export its shape or this module having to import it.
 */
export interface ActivityTask {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
}

/**
 * Discord truncates a long activity name without saying so, so it is truncated here where
 * the ellipsis can be deliberate. 128 is the documented ceiling; this stays well under it
 * because the useful reading happens in a narrow member-list column.
 */
const MAX_NAME = 96;

const clamp = (text: string): string =>
  text.length <= MAX_NAME ? text : `${text.slice(0, MAX_NAME - 1)}…`;

/**
 * One line describing what the fleet is doing.
 *
 * Ordered by what a human would act on, which is not the same as by count:
 *
 *   1. something running — the answer to "is it working";
 *   2. nothing running but something waiting on a human — the answer to "is it stuck on
 *      me", which is the only state where reading this should change what you do next;
 *   3. neither — say so, and say whether there is a backlog, because "idle with 4 ready"
 *      and "idle with nothing to do" are different problems and only one is a problem.
 *
 * A task that is running AND another awaiting a human both matter, so the waiting count is
 * appended rather than allowed to displace the running task.
 */
export const renderActivity = (tasks: readonly ActivityTask[]): Activity => {
  const running = tasks.filter((task) => task.status === "running");
  const waiting = tasks.filter((task) => task.status === "awaiting-human");
  const ready = tasks.filter((task) => task.status === "ready");

  // "needs you" rather than a status name: this is the one line in the product read by
  // someone who has not read DESIGN.md, and `awaiting-human` is jargon.
  const needsYou = waiting.length === 0 ? "" : ` · ${waiting.length} needs you`;

  if (running.length === 1) {
    // The phase and not the session count: `phase` is what the task is DOING, and the
    // ordinal of a session is only meaningful next to a limit nobody has in their head.
    const only = running[0];
    if (only !== undefined) return { name: clamp(`${only.id} · ${only.phase}${needsYou}`), type: WATCHING };
  }

  if (running.length > 1) {
    // Ids are dropped rather than listed. Two ids already overflow the column this is read
    // in, and the honest summary of a fleet working on several things is the count — the
    // web view is where you go to find out which.
    return { name: clamp(`${running.length} tasks running${needsYou}`), type: WATCHING };
  }

  if (waiting.length > 0) {
    // Nothing running and something waiting: promote it out of the suffix, because now it
    // is the whole story and the fleet is stopped until somebody answers.
    return { name: clamp(`${waiting.length} waiting for you`), type: WATCHING };
  }

  // Reads as "Watching for work". The ready count is what distinguishes a fleet that has
  // nothing to do from one that has work queued and is not taking it — the second is a bug
  // and looks identical to the first without this number.
  return {
    name: ready.length === 0 ? "for work · nothing queued" : `for work · ${ready.length} ready`,
    type: WATCHING,
  };
};

/**
 * Holds the current activity, and pushes it to a connected gateway.
 *
 * A tiny mailbox between two things with different lifetimes: the supervisor's survey runs
 * on a timer and outlives any one websocket, while a socket comes and goes with every
 * reconnect. Neither can hold the other, so both hold this.
 *
 * The stored payload is what makes a reconnect seamless — `attach` replays it immediately,
 * and `payload()` is read by IDENTIFY so a fresh connection is never briefly blank.
 *
 * Nothing here throws and nothing awaits. A presence is a comfort signal, exactly like the
 * typing indicator in `bot.ts`: it must never be the reason a survey fails or a poll is
 * slow, and a send that fails is corrected by the next survey a minute later.
 */
export class FleetActivity {
  private activity: Activity | undefined;
  private since: number | null = null;
  private send: ((payload: PresencePayload) => void) | undefined;
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Record what the fleet is doing, and tell Discord if it CHANGED.
   *
   * Compared by rendered name, and that comparison is the point rather than an
   * optimisation. Discord rate-limits presence updates per connection, the survey runs
   * every poll, and an idle fleet renders the identical string every time — so a runner
   * that sent unconditionally would spend its whole idle life burning the allowance it
   * needs at the moment the state actually changes.
   */
  publish(tasks: readonly ActivityTask[]): void {
    const next = renderActivity(tasks);
    if (this.activity?.name === next.name) return;

    this.activity = next;
    // Restamped only on a real change, so Discord's elapsed timer measures how long the
    // fleet has been in THIS state rather than how long the process has been up.
    this.since = this.now();
    this.push();
  }

  /**
   * A gateway connection is ready. Later changes go to it; nothing is sent now.
   *
   * Deliberately silent, because on a fresh connection the IDENTIFY has ALREADY carried
   * `payload()` — replaying here would spend a second presence update, out of a
   * per-connection allowance, to tell Discord what it was just told. The one case that does
   * need a push is a RESUME, which carries no IDENTIFY; that is `resend`'s job, so the two
   * situations are named rather than collapsed into one call that is half redundant.
   */
  attach(send: (payload: PresencePayload) => void): void {
    this.send = send;
  }

  /**
   * Push the current presence at the attached connection, if there is one of each.
   *
   * For a RESUMED session. A resume replays missed events but does not re-IDENTIFY, so
   * Discord still holds the presence from before the disconnect — which, for a runner whose
   * outage outlived a state change, is wrong for as long as the fleet stays in its new
   * state. Without this the runners with the longest outage are the ones lying hardest.
   */
  resend(): void {
    this.push();
  }

  /** The socket is gone. Stops sends until the next `attach`. */
  detach(): void {
    this.send = undefined;
  }

  /** The presence for an IDENTIFY, or undefined before the first survey. */
  payload(): PresencePayload | undefined {
    if (this.activity === undefined) return undefined;
    return { activities: [this.activity], status: ONLINE, since: this.since, afk: false };
  }

  private push(): void {
    const payload = this.payload();
    if (payload === undefined || this.send === undefined) return;
    this.send(payload);
  }
}
