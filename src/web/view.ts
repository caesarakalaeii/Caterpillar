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
import { goalHeadline } from "../domain/task.ts";
import type {
  Capability,
  TrackerRef,
  TaskId,
  TaskKind,
  TaskOwner,
  TaskPhase,
  TaskSpec,
  TaskState,
  TaskStatus,
  UsageTotals,
} from "../domain/task.ts";
import type { IntakeStatusView } from "../intake/status.ts";
import type { LiveSession } from "../obs/live.ts";
import { PolicyParseError, type AlertPolicyEntry } from "../remediation/policy.ts";
import type { AlertRefusal, IntakeRejectionRecord, StateStore } from "../state/store.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";
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
  /** Where this task came from. Absent only when the spec could not be read at all. */
  readonly origin?: TaskOrigin;
}

/**
 * Where a task came from (DESIGN.md §14).
 *
 * There are four ways a task can exist and until this existed the view showed none of
 * them: a labelled tracker item, a brainstorm's plan, a firing alert, and a spec someone
 * committed by hand. `spec.tracker` has carried the first since intake shipped and no page
 * rendered it, so the fleet page could not distinguish work a human asked for from work
 * the fleet proposed to itself.
 *
 * `url` is best-effort and its absence is normal rather than an error. A `TrackerRef` is
 * `{kind, id, container}` and carries no URL — the item's web address is written into the
 * GOAL by `renderSpec` ("Tracker item: …") and that is where this recovers it from, with a
 * GitHub-shaped fallback built from the ref. A Vikunja task ingested before this existed
 * legitimately has neither, and a row with a source and no link is still worth more than
 * no source at all.
 */
export interface TaskOrigin {
  readonly kind: "tracker" | "brainstorm" | "alert" | "spec";
  /** Human-facing name of the source: `github-issues #724`, `alert CaterpillarContextOverrun`. */
  readonly label: string;
  /** The tracker item, the alert's rule in Prometheus — scheme-checked before rendering. */
  readonly url?: string;
  readonly tracker?: TrackerRef;
  /** For an alert task: recovered from `alerts/refusals/`, which is the only record of it. */
  readonly alertname?: string;
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

/** A live session, tagged with the process that is running it. */
export interface RunnerLive extends LiveSummary {
  readonly runner: string;
}

export interface FleetView {
  readonly tasks: readonly TaskRow[];
  readonly counts: Readonly<Partial<Record<TaskStatus, number>>>;
  readonly runners: readonly RunnerRow[];
  /**
   * Sessions in flight, one entry per process that is running one.
   *
   * A LIST, and that is the shape change the fleet of four forced. `live?: LiveSummary`
   * was correct while the view ran inside the one supervisor that could answer for itself;
   * behind a load-balancing Service it became "whichever pod answered this request", and a
   * refresh showed a different one. An aggregating viewer asks every replica, so the
   * honest answer is N sessions rather than one at random — and a single runner serving
   * this from its own memory simply reports a list of at most one.
   */
  readonly live: readonly RunnerLive[];
  /**
   * When intake last ran HERE and what it found (§14, §18).
   *
   * Absent until the first pass completes on this runner, which on a fleet of four is a
   * genuinely different fact from "the pass found nothing": three replicas per interval
   * lose the `refs/intake/<bucket>` claim, and one that has just booted has not yet had a
   * turn. The page says which of those it is rather than rendering a zero.
   */
  readonly intake?: IntakeStatusView;
}

/* ------------------------------------------------------------------ intake */

/**
 * Everything the fourth and fifth intake paths have decided, as one page (§14, §18, §20).
 *
 * The point of gathering these four things in one read model is that they answer ONE
 * question between them and none of them answers it alone: "I labelled an issue / an alert
 * fired, and nothing happened — why?". The refusal record says the item was seen and
 * declined; the ledger says the same for an alert; the policy says whether the alert was
 * ever opted in; and the receiver's state says whether anything was listening at all. An
 * operator with three of the four still has to read a pod's stdout.
 */
export interface IntakeView {
  /** The last pass on THIS runner (§14). Absent until one has completed here. */
  readonly pass?: IntakeStatusView;
  /** Tracker items intake has refused, newest first. */
  readonly rejections: readonly IntakeRejectionRecord[];
  /** Every decision the alert receiver has recorded, newest first — including successes. */
  readonly alerts: readonly AlertRefusal[];
  /** The operator's opt-in list. Empty is the common case and is stated, not implied. */
  readonly policy: readonly AlertPolicyEntry[];
  /**
   * Present when `alerts/policy.yaml` exists and does not parse.
   *
   * Rendered rather than thrown, because this is the page an operator opens to find out
   * why an alert produced nothing, and "the policy file has a typo in it" is the single
   * most likely answer that a working supervisor cannot otherwise tell them: the poll loop
   * catches this error every cycle and writes it to a log they are not reading.
   */
  readonly policyError?: string;
  /** True when `alerts/policy.yaml` is absent entirely, as opposed to empty. */
  readonly policyMissing: boolean;
  /** Whether the alert receiver is listening on this runner, and why not if it is not. */
  readonly receiver: ReceiverView;
}

/**
 * The alert half of the runner's configuration, as the page needs it.
 *
 * A disabled receiver is the single most likely reason an alert produced nothing, and
 * until this existed it was invisible: `/runner` showed `web` and `cluster` and said
 * nothing about `remediation`. `cluster` is here too because a remediation SESSION with no
 * namespaces may read nothing — the task is created and then cannot investigate, which
 * looks like a stuck agent rather than a missing list.
 */
export interface ReceiverView {
  readonly enabled: boolean;
  readonly port: number;
  readonly clusterEnabled: boolean;
  readonly namespaces: readonly string[];
}

export interface IntakeOptions {
  readonly store: StateStore;
  readonly config: RunnerConfig;
  readonly intake?: { current(): IntakeStatusView | undefined };
}

/**
 * Assemble `/intake`. Reads four things and never throws.
 *
 * A `PolicyParseError` is turned into a rendered message rather than propagated: every
 * other section of this page is still true and still useful when the policy file has a
 * typo in it, and a 500 here would hide the refusal record that says what happened.
 */
export const intakeView = async (options: IntakeOptions): Promise<IntakeView> => {
  const { store, config } = options;

  let policy: readonly AlertPolicyEntry[] = [];
  let policyError: string | undefined;
  try {
    policy = (await store.readAlertPolicy()).entries;
  } catch (error: unknown) {
    policyError =
      error instanceof PolicyParseError || error instanceof Error
        ? error.message
        : String(error);
  }

  const pass = options.intake?.current();

  return {
    ...(pass === undefined ? {} : { pass }),
    rejections: [...(await store.listIntakeRejections().catch(() => []))].sort(byRecency),
    alerts: [...(await store.listAlertRefusals().catch(() => []))].sort(byRecency),
    policy,
    ...(policyError === undefined ? {} : { policyError }),
    policyMissing: policyError === undefined && !(await store.hasAlertPolicy()),
    receiver: {
      enabled: config.remediation.enabled,
      port: config.remediation.port,
      clusterEnabled: config.cluster.enabled,
      namespaces: config.cluster.namespaces,
    },
  };
};

/**
 * Newest first, with undated records last.
 *
 * `at` is optional on both record shapes because records written before it was stamped
 * have none; sorting them to the END rather than to the start is deliberate, since an
 * undated record is by construction an old one.
 */
const byRecency = (a: { readonly at?: string }, b: { readonly at?: string }): number => {
  if (a.at === undefined && b.at === undefined) return 0;
  if (a.at === undefined) return 1;
  if (b.at === undefined) return -1;
  return b.at.localeCompare(a.at);
};

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
  /** Which of the four intake paths produced this task, and a link back to it (§14). */
  readonly origin?: TaskOrigin;
}

/**
 * One published digest, and the dates either side of it (DESIGN.md §19).
 *
 * The document is served verbatim rather than re-rendered from the state repo's history.
 * It is the record of what was ANNOUNCED, and a page that recomputed it would quietly
 * disagree with the message that went to Discord the moment either renderer changed.
 */
export interface DigestView {
  readonly date: string;
  readonly body: string;
  /** Every published date, newest first. */
  readonly dates: readonly string[];
}

export const digests = (store: StateStore): Promise<readonly string[]> => store.listDigests();

export const digestView = async (
  store: StateStore,
  date: string,
): Promise<DigestView | undefined> => {
  const body = await store.readDigest(date);
  if (body === undefined) return undefined;

  return { date, body, dates: await store.listDigests() };
};

export interface FleetOptions {
  readonly store: StateStore;
  readonly live: LiveSession;
  readonly runnerId: string;
  /** The last intake pass, if this runner remembers one. */
  readonly intake?: { current(): IntakeStatusView | undefined };
}

export const fleet = async (options: FleetOptions): Promise<FleetView> => {
  const { store, live, runnerId } = options;
  const pass = options.intake?.current();

  // One listing for the whole page rather than one read per remediation task: the ledger
  // is the only record of which alertname a task called `ALERT-<hash>` belongs to.
  const alerts = await alertsByTask(store);

  const rows: TaskRow[] = [];
  for (const id of await store.listTasks()) {
    const row = await taskRow(store, id, alerts);
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
    ...(pass === undefined ? {} : { intake: pass }),
    live:
      current === undefined
        ? []
        : [
            {
              runner: runnerId,
              task: current.task,
              session: current.session,
              model: current.model,
              startedAt: current.startedAt,
              messages: current.messages.length,
            },
          ],
  };
};

/**
 * One row, or nothing.
 *
 * `state.json` is the control record and is what makes a directory a task; `spec.md` is
 * prose. A task whose spec will not parse is precisely the one an operator needs to see,
 * so a broken spec costs the title and nothing else.
 */
const taskRow = async (
  store: StateStore,
  id: TaskId,
  alerts: ReadonlyMap<TaskId, AlertRefusal>,
): Promise<TaskRow | undefined> => {
  const state = await store.tryReadState(id).catch(() => undefined);
  if (state === undefined) return undefined;

  const spec = await store.readSpec(id).catch(() => undefined);
  const origin = taskOrigin(spec, alerts.get(id));

  return {
    id,
    title: headline(spec?.goal) ?? id,
    ...(origin === undefined ? {} : { origin }),
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

/**
 * The alert ledger, indexed by the task each record produced.
 *
 * Only records that NAMED a task are in it: `alerts/refusals/` holds every decision the
 * receiver made, and the refusals — the majority, by design — have no task to key on.
 * Never throws: `listAlertRefusals` already swallows an unreadable record, and this is a
 * page's decoration rather than anything a decision rests on.
 */
const alertsByTask = async (store: StateStore): Promise<ReadonlyMap<TaskId, AlertRefusal>> => {
  const out = new Map<TaskId, AlertRefusal>();
  for (const record of await store.listAlertRefusals().catch(() => [])) {
    if (record.task !== undefined) out.set(record.task, record);
  }
  return out;
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

  // Every shard plus any legacy `journal.md`, concatenated — the page renders the
  // journal as one document, which is what it has always been to a reader.
  const journal = await store.readJournal(id);
  const handoff = await store.readIfPresent(id, "handoff.md");
  const current = live.current();
  const running = current !== undefined && current.task === id ? current : undefined;

  const alert =
    spec?.kind === "remediation" ? (await alertsByTask(store)).get(id) : undefined;
  const origin = taskOrigin(spec, alert);

  return {
    id,
    title: headline(spec?.goal) ?? id,
    state,
    ...(origin === undefined ? {} : { origin }),
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

/**
 * Which of the four intake paths produced this task, and what it points back at.
 *
 * Decided from the SPEC rather than from the id, with one exception: `kind` is the
 * authoritative statement for a brainstorm and a remediation task (both set it at
 * creation and nothing else does), while a tracker task is identified by `spec.tracker`
 * being present because `kind: implement` is also what a hand-committed spec defaults to.
 *
 * Pure and total: a spec that would not parse produces nothing rather than a guess, and
 * every string it returns is escaped by `html.ts` and scheme-checked by `safeUrl` on the
 * way to a page like any other agent-adjacent text.
 */
export const taskOrigin = (
  spec: TaskSpec | undefined,
  alert?: { readonly alertname: string },
): TaskOrigin | undefined => {
  if (spec === undefined) return undefined;

  if (spec.kind === "remediation") {
    const rule = goalUrl(spec.goal, "Rule");
    return {
      kind: "alert",
      // The alertname is not recoverable from the task id — `ALERT-<fingerprint>` is a
      // hash — so without the ledger record all this page can honestly say is "an alert".
      label: alert === undefined ? "a firing alert" : `alert ${alert.alertname}`,
      ...(alert === undefined ? {} : { alertname: alert.alertname }),
      ...(rule === undefined ? {} : { url: rule }),
    };
  }

  if (spec.kind === "brainstorm") return { kind: "brainstorm", label: "a brainstorm" };

  const tracker = spec.tracker;
  if (tracker === undefined) return { kind: "spec", label: "a hand-committed spec" };

  const url = goalUrl(spec.goal, "Tracker item") ?? trackerUrl(tracker);
  return {
    kind: "tracker",
    label: `${tracker.kind} ${tracker.container === undefined ? "" : `${tracker.container} `}#${tracker.id}`.trim(),
    tracker,
    ...(url === undefined ? {} : { url }),
  };
};

/**
 * A URL from one of the goal's `- Label: <url>` or `Label: <url>` lines.
 *
 * Intake and the alert path both write the source's address into the goal as prose and
 * nowhere else, so this reads back what they wrote. Anchored on the label and on `http`
 * so an arbitrary link inside agent-quoted prose cannot become the row's source link;
 * `safeUrl` still checks the scheme at render time, because two checks on a URL that
 * arrives from a forge is the standing rule here (§18).
 */
const goalUrl = (goal: string, label: string): string | undefined => {
  const pattern = new RegExp(`^-?\\s*${label}:\\s*(https?://\\S+)\\s*$`, "m");
  return pattern.exec(goal)?.[1];
};

/**
 * The web address of a tracker item, when its ref is enough to build one.
 *
 * GitHub only, and deliberately: `container` there IS `owner/repo` and the issue path is
 * fixed. Vikunja's web URL depends on the instance's frontend address, which a `TrackerRef`
 * does not carry — inventing one would produce a link that 404s, which is worse than the
 * plain text this falls back to.
 */
const trackerUrl = (ref: TrackerRef): string | undefined => {
  if (ref.kind !== "github-issues" || ref.container === undefined) return undefined;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ref.container)) return undefined;
  if (!/^\d+$/.test(ref.id)) return undefined;
  return `https://github.com/${ref.container}/issues/${ref.id}`;
};

/** The first heading or first non-blank line of a goal, as a one-line name. */
const headline = (goal: string | undefined): string | undefined =>
  goal === undefined ? undefined : goalHeadline(goal);

/* --------------------------------------------------------------------- disk */

/**
 * The work volume, as the runner page shows it (`workspace/usage.ts`).
 *
 * A read model of a measurement rather than the measurement itself, because the page and
 * `/api/runner` want two things the walk deliberately does not produce: the categories in
 * ONE ordered list (a page renders rows, not four named fields) and a percentage of the
 * volume for each. Computing them here keeps the numbers a human reads and the numbers
 * Prometheus scrapes derived from the same snapshot, rather than from two arithmetics
 * that can drift.
 *
 * Absent entirely until the first measurement completes. Measuring is idle-only and
 * hourly, so a runner that has been busy since boot legitimately has nothing to say here,
 * and a page that showed zeroes instead would read as "the disk is empty" rather than
 * "nobody has looked yet".
 */
export interface DiskView {
  readonly measuredAt: string;
  readonly durationMs: number;
  /** True when the deadline stopped the walk early, so every byte below is a floor. */
  readonly partial: boolean;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  /** `mirrors`, `tasks`, `nix`, `other` — largest first. */
  readonly categories: readonly DiskCategory[];
  /** Largest mirrors, capped by the walk's `TOP_N` with a remainder row. */
  readonly mirrors: readonly DiskEntry[];
  /** Largest task worktrees, capped the same way. */
  readonly tasks: readonly DiskEntry[];
}

export interface DiskEntry {
  readonly name: string;
  readonly bytes: number;
}

export interface DiskCategory extends DiskEntry {
  /**
   * Share of the volume's total size, 0–1. Of the TOTAL rather than of the sum of the
   * categories: the point of the row is "how much of the disk is this", and a share of
   * the categories would read as 100% on a nearly empty volume.
   */
  readonly fraction: number;
}

/**
 * Turn one measurement into the page's read model. Pure, and never throws.
 *
 * `usedBytes` comes from `statfs` (total minus free) rather than from summing the
 * categories. They answer different questions and the difference is the point: the sum is
 * what THIS runner can account for, `usedBytes` is what is actually gone, and a volume
 * shared with another process makes the second larger. A page that showed only the sum
 * would say the disk is fine while it fills.
 */
export const diskView = (usage: WorkspaceUsage): DiskView => {
  const { totalBytes, freeBytes } = usage.fs;
  const share = (bytes: number): number => (totalBytes > 0 ? bytes / totalBytes : 0);

  const categories: readonly DiskCategory[] = [
    { name: "mirrors", bytes: usage.mirrorBytes },
    { name: "tasks", bytes: usage.taskBytes },
    { name: "nix", bytes: usage.nixBytes },
    { name: "other", bytes: usage.otherBytes },
  ]
    .map((category) => ({ ...category, fraction: share(category.bytes) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return {
    measuredAt: usage.measuredAt,
    durationMs: usage.durationMs,
    partial: usage.partial,
    totalBytes,
    freeBytes,
    // Clamped: a `statfs` that failed reports zeroes, and a negative "used" on a page is a
    // measurement bug to whoever reads it rather than the missing answer it actually is.
    usedBytes: Math.max(0, totalBytes - freeBytes),
    categories,
    mirrors: usage.mirrors.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
    tasks: usage.tasks.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
  };
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
  /**
   * Next to the toolchain's numbers deliberately: they are two halves of one janitor, and
   * an operator looking at a full volume needs to see both without knowing which of the
   * two collectors they are looking for.
   *
   * OPTIONAL only because of who reads it. `exportRunner` on a live runner always sets it,
   * but the aggregating viewer (§18) renders a REMOTE runner's export with this same
   * template, and a replica still on the previous image has no `workspace` key at all —
   * reaping is newer than the viewer. `asList` in `view/aggregate.ts` accepts two vintages
   * of `live` for exactly this reason. Required here would mean a rollout in which the
   * viewer answers `/runner` with an error page for every pod it has not yet reached.
   */
  readonly workspace?: {
    readonly reap: { readonly intervalHours: number; readonly keepHours: number };
  };
  readonly stateRepo: { readonly url: string; readonly branch: string; readonly path: string };
  readonly paths: { readonly mirrors: string; readonly tasks: string; readonly root: string };
  readonly usage: { readonly intervalHours: number; readonly deadlineSeconds: number };
  readonly intake: { readonly intervalSeconds: number };
  /**
   * The alert half (§20), which this page said nothing about until `/intake` needed it.
   *
   * No token and no URL: `remediation` carries neither by design (the webhook token is a
   * mounted secret), and `cluster` contributes only the two bounds an operator sets —
   * whether reads are allowed at all and which namespaces. The Loki and kube API addresses
   * stay out, on the allowlist principle this whole export is built on.
   */
  readonly remediation: { readonly enabled: boolean; readonly port: number };
  readonly cluster: {
    readonly enabled: boolean;
    readonly namespaces: readonly string[];
    readonly maxLogLines: number;
  };
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
  workspace: {
    reap: {
      intervalHours: config.workspace.reap.intervalHours,
      keepHours: config.workspace.reap.keepHours,
    },
  },
  stateRepo: {
    url: config.stateRepo.url,
    branch: config.stateRepo.branch,
    path: config.stateRepo.path,
  },
  paths: { mirrors: config.paths.mirrors, tasks: config.paths.tasks, root: config.paths.root },
  // Exported so the disk section can say how often the numbers above it are refreshed. An
  // hourly measurement with no interval shown is a page whose staleness looks like a bug.
  usage: {
    intervalHours: config.usage.intervalHours,
    deadlineSeconds: config.usage.deadlineSeconds,
  },
  intake: { intervalSeconds: config.intake.intervalSeconds },
  remediation: { enabled: config.remediation.enabled, port: config.remediation.port },
  cluster: {
    enabled: config.cluster.enabled,
    namespaces: config.cluster.namespaces,
    maxLogLines: config.cluster.maxLogLines,
  },
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
