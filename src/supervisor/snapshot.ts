/**
 * A read-only view of every task, kept in memory for the chat interface.
 *
 * It exists because of one hard number: Discord gives an interaction **3 seconds** to be
 * acknowledged, and an autocomplete suggestion has to be inside that budget every
 * keystroke. Going through the inbox instead would mean waiting for the poll loop, which
 * can be mid-session for hours — the suggestion would arrive after the interaction had
 * already been declared failed.
 *
 * Refreshed by the loop once per poll, from the same pass that decides what to claim, so
 * it costs no extra IO. It is a VIEW and may be one poll stale; git remains
 * authoritative, exactly as the tracker and Discord are (README invariant 6). Nothing is
 * ever written from it.
 */
import type { TaskId, TaskPhase, TaskState, TaskStatus } from "../domain/task.ts";

export interface TaskSummary {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  readonly sessions: number;
  readonly costUsd: number;
  readonly prUrl?: string;
  readonly updatedAt: string;
}

export const summarise = (state: TaskState): TaskSummary => ({
  id: state.id,
  status: state.status,
  phase: state.phase,
  sessions: state.sessions,
  costUsd: state.usage.costUsd,
  ...(state.pr === undefined ? {} : { prUrl: state.pr.url }),
  updatedAt: state.updatedAt,
});

/** Suggestions Discord will render at most; more is a 400. */
const MAX_SUGGESTIONS = 25;

/**
 * Newest first, by `updatedAt`.
 *
 * The order is load-bearing rather than cosmetic, because a listing is CAPPED and the cap
 * decides what a human sees. `survey` builds its records by walking `tasks/`, so the
 * incoming order is whatever the filesystem gives — effectively alphabetical by task id,
 * which for ids like `BS-<snowflake>` and `BS-<snowflake>-07` means *oldest brainstorm
 * first*. On a fleet with 39 tasks and a 25-line cap that put 23 finished tasks on the
 * screen and elided the one that was RUNNING: the command that answers "what is it doing"
 * showed everything except that.
 *
 * `updatedAt` and not a status ranking. A status order would need a policy about which
 * status outranks which, and the policy would be wrong for somebody — where "most recently
 * touched" needs no policy and gets the same result anyway, because the task a runner is
 * working is the task whose state is being rewritten. Old finished work sinks on its own.
 *
 * Tie-broken by id so the order is total: several tasks cut from one plan are created in
 * the same tick and share a timestamp to the millisecond, and a listing that shuffled them
 * between two invocations of the same command reads as a bug.
 */
const byRecency = (a: TaskSummary, b: TaskSummary): number =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

export class TaskSnapshot {
  private tasks: readonly TaskSummary[] = [];

  /**
   * Sorted here, once per poll, rather than in each reader. `all`, `withStatus` and the
   * pagination in `notify/replies.ts` must agree about what "the first 25" means — page 2
   * of a differently-ordered list can repeat or skip a task — and one sorted field is the
   * cheapest way to make that true by construction.
   */
  replace(tasks: readonly TaskSummary[]): void {
    this.tasks = [...tasks].sort(byRecency);
  }

  all(): readonly TaskSummary[] {
    return this.tasks;
  }

  withStatus(status: TaskStatus): readonly TaskSummary[] {
    return this.tasks.filter((task) => task.status === status);
  }

  find(id: TaskId): TaskSummary | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  /**
   * Task ids matching what the user has typed so far.
   *
   * Tasks needing a human sort first: autocomplete exists mostly to fill in `/answer`,
   * and the task being answered is by definition one that is waiting.
   */
  suggest(query: string): readonly TaskSummary[] {
    const needle = query.trim().toLowerCase();
    const matched = this.tasks.filter((task) => task.id.toLowerCase().includes(needle));
    const rank = (task: TaskSummary): number => (task.status === "awaiting-human" ? 0 : 1);
    return [...matched]
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
      .slice(0, MAX_SUGGESTIONS);
  }
}
