/**
 * Four runners' answers, merged into one page. See DESIGN.md §18.
 *
 * The split that makes this work:
 *
 *   TASK DATA is identical everywhere. The state repo is the fleet's shared surface and
 *   every replica keeps a checkout of it, so a task list, a task's documents and a stored
 *   transcript come from the FIRST healthy responder. Asking four for the same bytes would
 *   be four times the work for one answer.
 *
 *   PER-PROCESS DATA exists in exactly one memory each. The live session and the log ring
 *   are the two things §18 said a separate viewer could never show; they are shown by
 *   asking every replica for its own, which turns the weakness into the feature \u2014 N live
 *   sessions and a merged log, instead of one at random.
 *
 * A runner that fails is carried through as an `unreachable` entry rather than dropped. The
 * page renders it next to its name, because a silently dropped replica reads as an idle
 * one.
 */
import type { TaskId } from "../domain/task.ts";
import type { LogRecord } from "../obs/ring.ts";
import type { FleetView, RunnerLive, RunnerRow, TaskRow } from "../web/view.ts";
import type { Discovery, RunnerEndpoint } from "./discovery.ts";
import type { Fanout, FanoutRequest, RunnerReply } from "./fanout.ts";

/** A runner that did not answer, and what it said instead. */
export interface Unreachable {
  readonly runner: string;
  readonly base: string;
  readonly error: string;
}

/** A log line, tagged with the process whose ring it came out of. */
export interface TaggedLog extends LogRecord {
  readonly runner: string;
}

/** The fleet, as the viewer renders it. */
export interface AggregateFleet {
  readonly view: FleetView;
  /** Runners that did not answer this refresh. */
  readonly unreachable: readonly Unreachable[];
  /** Which runner the task list came from, when one answered. */
  readonly source?: string;
}

export interface AggregateLogs {
  readonly records: readonly TaggedLog[];
  readonly unreachable: readonly Unreachable[];
  /** Runners that did answer, so "0 lines" is distinguishable from "nobody answered". */
  readonly answered: readonly string[];
}

export interface AggregatorOptions {
  readonly discovery: Discovery;
  readonly fanout: Fanout;
}

export class Aggregator {
  private readonly options: AggregatorOptions;

  constructor(options: AggregatorOptions) {
    this.options = options;
  }

  runners(): Promise<readonly RunnerEndpoint[]> {
    return this.options.discovery.runners();
  }

  /**
   * The fleet page's data: one runner's task list, everyone's live sessions.
   *
   * The runner rows are rebuilt rather than taken from whichever replica answered, because
   * that replica's own `runners` array marks ITSELF as `self` and derives membership from
   * task ownership \u2014 which is precisely the half-blindness this process exists to fix. Here
   * every discovered runner gets a row whether or not it holds a lease, so an idle runner
   * stops being invisible without the registry in git that \u00a718 rejected twice.
   */
  async fleet(request: FanoutRequest): Promise<AggregateFleet> {
    const runners = await this.runners();
    const replies = await this.options.fanout.all<FleetView>(runners, {
      ...request,
      path: "/api/fleet",
    });

    const unreachable = failures(replies);
    const first = replies.find((reply) => reply.ok);
    const pass = lastIntakePass(replies);

    const tasks: readonly TaskRow[] = first?.ok === true ? first.value.tasks : [];
    const counts = first?.ok === true ? first.value.counts : {};

    // Unioned across replicas, each entry already carrying the runner that reported it.
    // The name is overwritten with the DISCOVERED one: a runner's `runnerId` is set in its
    // own ConfigMap and the pod name is what the operator will `kubectl logs`.
    const live: RunnerLive[] = [];
    for (const reply of replies) {
      if (!reply.ok) continue;
      for (const session of reply.value.live) live.push({ ...session, runner: reply.runner.name });
    }

    return {
      view: {
        tasks,
        counts,
        runners: rows(runners, tasks, live),
        live: live.sort((a, b) => a.runner.localeCompare(b.runner)),
        ...(pass === undefined ? {} : { intake: pass }),
      },
      unreachable,
      ...(first === undefined ? {} : { source: first.runner.name }),
    };
  }

  /**
   * Anything else the runners serve as JSON, from the first one that answers.
   *
   * `/api/tasks/<id>`, `/api/intake`, `/api/digests`, `/api/runner` \u2014 all of them read the
   * state repo or this runner's own configuration, and the state repo is identical
   * everywhere. A 404 from every runner is a 404: `value` is absent and the caller renders
   * "no such thing" rather than "the fleet is down", which is why the failures come back
   * too.
   */
  async fromAny<T>(
    request: FanoutRequest,
  ): Promise<{ readonly value?: T; readonly unreachable: readonly Unreachable[]; readonly source?: string }> {
    const runners = await this.runners();
    const { value, failures: failed, from } = await this.options.fanout.first<T>(runners, request);
    return {
      ...(value === undefined ? {} : { value }),
      unreachable: failures(failed),
      ...(from === undefined ? {} : { source: from.name }),
    };
  }

  /**
   * Every runner's log ring, merged newest-first and tagged.
   *
   * `/logs` used to show one process's thousand lines out of four thousand, and nothing on
   * the page said so. Merged, the ordering is by the record's own timestamp: the rings are
   * each already newest-first, but four of them interleaved by arrival order would be four
   * separate logs stacked, which is not a log.
   *
   * A record with no timestamp \u2014 `log.unparsed`, something writing past the logger \u2014 sorts
   * last rather than being dropped. That is exactly the line worth seeing.
   */
  async logs(request: FanoutRequest): Promise<AggregateLogs> {
    const runners = await this.runners();
    const replies = await this.options.fanout.all<{ readonly records: readonly LogRecord[] }>(
      runners,
      { ...request, path: "/api/logs" },
    );

    const records: TaggedLog[] = [];
    const answered: string[] = [];
    for (const reply of replies) {
      if (!reply.ok) continue;
      answered.push(reply.runner.name);
      for (const record of reply.value.records) records.push({ ...record, runner: reply.runner.name });
    }

    records.sort((a, b) => {
      if (a.ts === b.ts) return a.runner.localeCompare(b.runner);
      if (a.ts === "") return 1;
      if (b.ts === "") return -1;
      return b.ts.localeCompare(a.ts);
    });

    return { records, unreachable: failures(replies), answered };
  }

  /** A raw transcript or an artifact: bytes, from the first runner that has them. */
  async bytes(request: FanoutRequest): ReturnType<Fanout["bytes"]> {
    return this.options.fanout.bytes(await this.runners(), request);
  }
}

/**
 * The most recent intake pass ANY runner remembers.
 *
 * One runner serves each interval and the other three record that they skipped it, so
 * taking the first responder's copy would report "another runner served this interval" on
 * three refreshes out of four — true of that pod, and useless as a statement about the
 * fleet. The newest `ingested` pass is what an operator is asking for; a fleet where every
 * runner has only ever skipped falls back to the newest record of any kind, which is how a
 * fleet that has not ingested since boot still says something.
 */
const lastIntakePass = (
  replies: readonly RunnerReply<FleetView>[],
): FleetView["intake"] => {
  const passes = replies
    .filter((reply): reply is Extract<RunnerReply<FleetView>, { ok: true }> => reply.ok)
    .map((reply) => reply.value.intake)
    .filter((pass): pass is NonNullable<FleetView["intake"]> => pass !== undefined)
    .sort((a, b) => b.at.localeCompare(a.at));

  return passes.find((pass) => pass.outcome === "ingested") ?? passes[0];
};

const failures = <T>(replies: readonly RunnerReply<T>[]): readonly Unreachable[] =>
  replies
    .filter((reply): reply is Extract<RunnerReply<T>, { ok: false }> => !reply.ok)
    .map((reply) => ({ runner: reply.runner.name, base: reply.runner.base, error: reply.error }));

/**
 * One row per DISCOVERED runner, not per runner that happens to hold a lease.
 *
 * This is the half of \u00a718's "there is no runner registry" that changes: the objection was
 * to a heartbeat file committed to git every poll, and it still stands. Asking each pod
 * what it is doing costs one HTTP GET per refresh and nothing durable, so an idle runner is
 * named because DNS says it is ready \u2014 not because it wrote a file saying so.
 *
 * A task is attributed to a runner by its lease mirror, exactly as before, and only while
 * it is `running`: `state.owner` outlives the lease by design, so counting a finished task
 * would report a runner as busy forever.
 */
const rows = (
  runners: readonly RunnerEndpoint[],
  tasks: readonly TaskRow[],
  live: readonly RunnerLive[],
): readonly RunnerRow[] => {
  const held = new Map<string, TaskId[]>(runners.map((runner) => [runner.name, []]));
  const since = new Map<string, string>();

  for (const task of tasks) {
    const owner = task.owner;
    if (owner === undefined || !task.held) continue;
    held.set(owner.runner, [...(held.get(owner.runner) ?? []), task.id]);
    const earliest = since.get(owner.runner);
    if (earliest === undefined || owner.since < earliest) since.set(owner.runner, owner.since);
  }

  // A runner that reports a live session but owns no `running` task in git is still busy:
  // the lease mirror is a commit behind the memory, and the whole reason to ask each pod
  // directly is that it knows first.
  for (const session of live) {
    if (!held.has(session.runner)) held.set(session.runner, []);
  }

  return [...held.entries()]
    .map(([id, ids]) => ({
      id,
      // Nothing here is "this one": the viewer is not a runner, and marking a row as self
      // would be the aggregation claiming to be one of the things it aggregates.
      self: false,
      tasks: ids,
      ...(since.get(id) === undefined ? {} : { since: since.get(id) as string }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
};
