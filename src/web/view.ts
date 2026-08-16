/**
 * Read models for the web view. See DESIGN.md §18.
 *
 * Everything here READS. Nothing in this file, or anything it calls, writes to the state
 * repo, pushes a ref, or touches a forge — that is the whole security argument for
 * exposing it at all, and it is a property of the code rather than of the routing.
 *
 * The fleet is assembled from the state repo rather than from `supervisor/snapshot.ts`.
 * The snapshot exists to answer a Discord interaction inside three seconds and is one
 * poll stale by design; a page has no such budget, and git is authoritative. The cost is
 * two small file reads per task, on a request a human made.
 */
import type { RunnerConfig } from "../config/types.ts";
import type {
  Capability,
  TaskId,
  TaskKind,
  TaskOwner,
  TaskPhase,
  TaskSpec,
  TaskState,
  TaskStatus,
  UsageTotals,
} from "../domain/task.ts";
import type { LiveSession } from "../obs/live.ts";
import type { StateStore } from "../state/store.ts";
import { entriesOf, type TranscriptEntry } from "./transcript.ts";

export interface TaskRow {
  readonly id: TaskId;
  /** The spec's heading, or the id when the spec is missing or unreadable. */
  readonly title: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  readonly sessions: number;
  readonly maxSessions: number;
  readonly usage: UsageTotals;
  readonly requires: readonly Capability[];
  readonly noProgressStreak: number;
  /**
   * The mirrored lease record (§4.2). Present on any task that has ever run — the
   * supervisor stamps it on every transition and never clears it, so on a task that is
   * not `running` this names the runner that worked it LAST, not one holding it now.
   */
  readonly owner?: TaskOwner;
  /** True when `owner` means "is holding this" rather than "was the last to hold it". */
  readonly held: boolean;
  readonly prUrl?: string;
  readonly wave?: number;
  readonly blockedBy: readonly TaskId[];
  readonly updatedAt: string;
}

/** A runner seen in the state repo — this one, plus whoever else holds a lease. */
export interface RunnerRow {
  readonly id: string;
  /** True for the runner serving this page. Only it can show live logs and messages. */
  readonly self: boolean;
  readonly tasks: readonly TaskId[];
  /** When it took the oldest task it currently holds. */
  readonly since?: string;
}

export interface LiveSummary {
  readonly task: TaskId;
  readonly session: number;
  readonly model: string;
  readonly startedAt: string;
  readonly messages: number;
}

export interface FleetView {
  readonly tasks: readonly TaskRow[];
  readonly counts: Readonly<Partial<Record<TaskStatus, number>>>;
  readonly runners: readonly RunnerRow[];
  /** What this runner is doing right now, if anything. */
  readonly live?: LiveSummary;
}

export interface LiveDetail extends LiveSummary {
  readonly entries: readonly TranscriptEntry[];
}

export interface TaskDetail {
  readonly id: TaskId;
  readonly title: string;
  readonly state: TaskState;
  /** Absent when `spec.md` is missing or will not parse — the task is shown regardless. */
  readonly spec?: TaskSpec;
  readonly specError?: string;
  readonly journal?: string;
  readonly handoff?: string;
  readonly questions: readonly { readonly index: number; readonly question: string; readonly answer?: string }[];
  readonly verdicts: readonly { readonly index: number; readonly body: string }[];
  readonly artifacts: readonly string[];
  readonly sessions: readonly number[];
  /** Present only when THIS runner is the one executing the task right now. */
  readonly live?: LiveDetail;
}

export interface FleetOptions {
  readonly store: StateStore;
  readonly live: LiveSession;
  readonly runnerId: string;
}

export const fleet = async (options: FleetOptions): Promise<FleetView> => {
  const { store, live, runnerId } = options;

  const rows: TaskRow[] = [];
  for (const id of await store.listTasks()) {
    const row = await taskRow(store, id);
    if (row !== undefined) rows.push(row);
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

  const current = live.current();

  return {
    tasks: rows,
    counts,
    runners: runnerRows(rows, runnerId),
    ...(current === undefined
      ? {}
      : {
          live: {
            task: current.task,
            session: current.session,
            model: current.model,
            startedAt: current.startedAt,
            messages: current.messages.length,
          },
        }),
  };
};

/**
 * One row, or nothing.
 *
 * `state.json` is the control record and is what makes a directory a task; `spec.md` is
 * prose. A task whose spec will not parse is precisely the one an operator needs to see,
 * so a broken spec costs the title and nothing else.
 */
const taskRow = async (store: StateStore, id: TaskId): Promise<TaskRow | undefined> => {
  const state = await store.tryReadState(id).catch(() => undefined);
  if (state === undefined) return undefined;

  const spec = await store.readSpec(id).catch(() => undefined);

  return {
    id,
    title: headline(spec?.goal) ?? id,
    kind: spec?.kind ?? "implement",
    status: state.status,
    phase: state.phase,
    sessions: state.sessions,
    maxSessions: state.limits.maxSessions,
    usage: state.usage,
    requires: state.requires,
    noProgressStreak: state.progress.noProgressStreak,
    blockedBy: state.plan?.blockedBy ?? [],
    held: state.status === "running",
    updatedAt: state.updatedAt,
    ...(state.owner === undefined ? {} : { owner: state.owner }),
    ...(state.pr === undefined ? {} : { prUrl: state.pr.url }),
    ...(state.plan === undefined ? {} : { wave: state.plan.wave }),
  };
};

/**
 * Which runner holds what.
 *
 * Derived from task ownership rather than from a registry, because there isn't one: a
 * runner heartbeat committed to the state repo every poll would be a commit per runner
 * per interval, forever, and leases already carry the fact. The cost is that an IDLE
 * runner other than this one is invisible — it owns nothing, so nothing names it.
 */
const runnerRows = (rows: readonly TaskRow[], runnerId: string): readonly RunnerRow[] => {
  const held = new Map<string, TaskId[]>([[runnerId, []]]);
  const since = new Map<string, string>();

  for (const row of rows) {
    const owner = row.owner;
    // Only a task that is RUNNING says where a runner is. `owner` outlives the lease by
    // design, so counting a finished task would report a runner as busy forever.
    if (owner === undefined || !row.held) continue;

    held.set(owner.runner, [...(held.get(owner.runner) ?? []), row.id]);
    const earliest = since.get(owner.runner);
    if (earliest === undefined || owner.since < earliest) since.set(owner.runner, owner.since);
  }

  return [...held.entries()]
    .map(([id, tasks]) => ({
      id,
      self: id === runnerId,
      tasks,
      ...(since.get(id) === undefined ? {} : { since: since.get(id) as string }),
    }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.id.localeCompare(b.id));
};

export const taskDetail = async (
  store: StateStore,
  id: TaskId,
  live: LiveSession,
): Promise<TaskDetail | undefined> => {
  const state = await store.tryReadState(id).catch(() => undefined);
  if (state === undefined) return undefined;

  let spec: TaskSpec | undefined;
  let specError: string | undefined;
  try {
    spec = await store.readSpec(id);
  } catch (error: unknown) {
    specError = error instanceof Error ? error.message : String(error);
  }

  const journal = await store.readIfPresent(id, "journal.md");
  const handoff = await store.readIfPresent(id, "handoff.md");
  const current = live.current();
  const running = current !== undefined && current.task === id ? current : undefined;

  return {
    id,
    title: headline(spec?.goal) ?? id,
    state,
    questions: await store.listQuestions(id),
    verdicts: await store.listVerdicts(id),
    artifacts: await store.listArtifacts(id),
    sessions: await store.listSessions(id),
    ...(spec === undefined ? {} : { spec }),
    ...(specError === undefined ? {} : { specError }),
    ...(journal === undefined ? {} : { journal }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(running === undefined
      ? {}
      : {
          live: {
            task: running.task,
            session: running.session,
            model: running.model,
            startedAt: running.startedAt,
            messages: running.messages.length,
            entries: entriesOf(running.messages),
          },
        }),
  };
};

/** The first heading or first non-blank line of a goal, as a one-line name. */
const headline = (goal: string | undefined): string | undefined => {
  if (goal === undefined) return undefined;
  for (const line of goal.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
};

/**
 * Everything this runner is willing to say about itself.
 *
 * An ALLOWLIST, not a redaction pass. Config carries no secrets by design (config/types.ts),
 * but the fields that POINT at one — `secretRef`, `secretsDir`, `credentialsPath` — are
 * exactly the ones most likely to grow a value later. Spreading the config and deleting
 * keys would export any field added upstream by default; naming each field means a new
 * one is invisible until someone decides it should be visible.
 */
export interface RunnerExport {
  readonly runnerId: string;
  readonly capabilities: readonly Capability[];
  readonly pollSeconds: number;
  readonly lease: { readonly heartbeatSeconds: number; readonly staleAfterSeconds: number };
  readonly handoff: { readonly thresholdFraction: number };
  readonly limits: {
    readonly maxSessionsPerTask: number;
    readonly noProgressLimit: number;
    readonly maxReviewRounds: number;
    readonly maxSessionSeconds: number;
  };
  readonly llm: {
    readonly auth: string;
    readonly modelId: string;
    readonly providerId: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly cooldown: { readonly initialSeconds: number; readonly maxSeconds: number };
  };
  readonly toolchain: {
    readonly nixpkgs: string;
    readonly timeoutSeconds: number;
    readonly gcIntervalHours: number;
    readonly gcKeepDays: number;
  };
  readonly stateRepo: { readonly url: string; readonly branch: string; readonly path: string };
  readonly paths: { readonly mirrors: string; readonly tasks: string };
  readonly intake: { readonly intervalSeconds: number };
  readonly log: { readonly level: string };
  readonly workspaces: readonly {
    readonly name: string;
    readonly forge: {
      readonly kind: string;
      readonly host: string;
      readonly owner: string;
      readonly apiBase: string;
    };
    readonly tracker?: {
      readonly kind: string;
      readonly apiBase: string;
      readonly ingestLabel: string;
    };
  }[];
}

export const runnerExport = (config: RunnerConfig): RunnerExport => ({
  runnerId: config.runnerId,
  capabilities: config.capabilities,
  pollSeconds: config.pollSeconds,
  lease: {
    heartbeatSeconds: config.lease.heartbeatSeconds,
    staleAfterSeconds: config.lease.staleAfterSeconds,
  },
  handoff: { thresholdFraction: config.handoff.thresholdFraction },
  limits: {
    maxSessionsPerTask: config.limits.maxSessionsPerTask,
    noProgressLimit: config.limits.noProgressLimit,
    maxReviewRounds: config.limits.maxReviewRounds,
    maxSessionSeconds: config.limits.maxSessionSeconds,
  },
  llm: {
    auth: config.llm.auth,
    modelId: config.llm.modelId,
    providerId: config.llm.providerId,
    contextWindow: config.llm.contextWindow,
    maxTokens: config.llm.maxTokens,
    cooldown: {
      initialSeconds: config.llm.cooldown.initialSeconds,
      maxSeconds: config.llm.cooldown.maxSeconds,
    },
  },
  toolchain: {
    nixpkgs: config.toolchain.nixpkgs,
    timeoutSeconds: config.toolchain.timeoutSeconds,
    gcIntervalHours: config.toolchain.gcIntervalHours,
    gcKeepDays: config.toolchain.gcKeepDays,
  },
  stateRepo: {
    url: config.stateRepo.url,
    branch: config.stateRepo.branch,
    path: config.stateRepo.path,
  },
  paths: { mirrors: config.paths.mirrors, tasks: config.paths.tasks },
  intake: { intervalSeconds: config.intake.intervalSeconds },
  log: { level: config.log.level },
  workspaces: [...config.workspaces.values()].map((profile) => ({
    name: profile.name,
    forge: {
      kind: profile.forge.kind,
      host: profile.forge.host,
      owner: profile.forge.owner,
      apiBase: profile.forge.apiBase,
    },
    ...(profile.tracker === undefined
      ? {}
      : {
          tracker: {
            kind: profile.tracker.kind,
            apiBase: profile.tracker.apiBase,
            ingestLabel: profile.tracker.ingestLabel,
          },
        }),
  })),
});
