/**
 * Minimal Prometheus text-exposition registry. See DESIGN.md §11.
 *
 * Hand-rolled rather than pulling prom-client: the metric set is small and fixed,
 * and this keeps the dependency surface (and therefore the supply-chain review
 * burden) down. Scraped by a ServiceMonitor.
 */
import type { AttributionReport } from "../digest/attribution.ts";
import type { WorkspaceUsage } from "../workspace/usage.ts";
export type LabelValues = Readonly<Record<string, string>>;

interface Sample {
  readonly labels: LabelValues;
  value: number;
}

type MetricKind = "counter" | "gauge";

/**
 * A label value, escaped the way the text exposition format requires.
 *
 * All THREE of the format's escapes, in this order — backslash first, or the escapes
 * escape each other, exactly as in `web/html.ts`. It used to be `"` alone, which was
 * enough while every label value was a task id (a validated `[A-Za-z0-9._-]+`) or a
 * literal from this file.
 *
 * It stopped being enough when `caterpillar_work_bytes` started taking label values from
 * the FILESYSTEM: a directory under `tasks/` is whatever is on the disk, and a name
 * containing a newline would end the sample line early and hand the scraper a line of the
 * exporter's own choosing. Escaping here rather than at the call site because this is the
 * only place that knows it is writing exposition format, and a second producer of
 * world-derived labels must not have to remember.
 */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

class Metric {
  private readonly samples = new Map<string, Sample>();

  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;

  constructor(name: string, kind: MetricKind, help: string) {
    this.name = name;
    this.kind = kind;
    this.help = help;
  }

  private key(labels: LabelValues): string {
    return Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k] ?? ""}`)
      .join(",");
  }

  set(labels: LabelValues, value: number): void {
    this.samples.set(this.key(labels), { labels, value });
  }

  /**
   * Forget every sample. Only ever right for a gauge whose LABEL SET is derived from the
   * world rather than fixed — today that is the per-task and per-mirror breakdown, where
   * a task that has dropped out of the top N would otherwise keep reporting the size it
   * had when it last made the cut, forever, because nothing here expires.
   *
   * Never call this on a counter: a counter that goes back to zero reads to Prometheus as
   * a process restart, and every `rate()` over it produces a spike that did not happen.
   */
  clear(): void {
    this.samples.clear();
  }

  /**
   * Forget ONE label set, leaving the rest reporting.
   *
   * For the same absence of expiry `clear` exists for, where the dead label set is one
   * among many live ones rather than a whole breakdown being replaced:
   * `caterpillar_no_progress_streak{task=...}` is per-task, tasks end, and a task that
   * parked or finished never gets another `set`. `clear` cannot be used for it because it
   * would drop every other task's live streak too.
   *
   * Removing rather than zeroing, deliberately. A no-progress streak of 0 is a real and
   * meaningful reading — a task that is making progress — so publishing it for a task
   * that has stopped running would be a claim about a session that does not exist. Absent
   * is the honest answer, and it is the one `absent()` and staleness handling in
   * Prometheus are built for.
   *
   * Silent on a label set that was never reported: the caller is a status transition,
   * which fires for tasks that never published a streak at all.
   */
  remove(labels: LabelValues): void {
    this.samples.delete(this.key(labels));
  }

  inc(labels: LabelValues, delta = 1): void {
    const key = this.key(labels);
    const existing = this.samples.get(key);
    if (existing === undefined) this.samples.set(key, { labels, value: delta });
    else existing.value += delta;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.kind}`];
    for (const sample of this.samples.values()) {
      const labels = Object.entries(sample.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      lines.push(labels.length > 0 ? `${this.name}{${labels}} ${sample.value}` : `${this.name} ${sample.value}`);
    }
    return lines.join("\n");
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();

  private metric(name: string, kind: MetricKind, help: string): Metric {
    const existing = this.metrics.get(name);
    if (existing !== undefined) return existing;
    const created = new Metric(name, kind, help);
    this.metrics.set(name, created);
    return created;
  }

  counter(name: string, help: string): Metric {
    return this.metric(name, "counter", help);
  }

  gauge(name: string, help: string): Metric {
    return this.metric(name, "gauge", help);
  }

  render(): string {
    return `${[...this.metrics.values()].map((m) => m.render()).join("\n")}\n`;
  }
}

/** The metric set from DESIGN.md §11. */
export class AgentMetrics {
  readonly registry = new Registry();

  readonly taskStatus = this.registry.gauge("caterpillar_task_status", "Tasks by status");
  readonly sessions = this.registry.counter("caterpillar_sessions_total", "Sessions started");
  readonly tokens = this.registry.counter("caterpillar_tokens_total", "Tokens consumed");
  readonly cost = this.registry.counter("caterpillar_cost_usd_total", "Cost in USD");
  readonly handoffs = this.registry.counter("caterpillar_handoffs_total", "Session exits by reason");
  readonly leaseAge = this.registry.gauge("caterpillar_lease_age_seconds", "Age of the held lease");
  readonly noProgress = this.registry.gauge("caterpillar_no_progress_streak", "Consecutive sessions without progress");
  readonly council = this.registry.counter("caterpillar_council_total", "Review council verdicts by decision");

  /**
   * Sessions that ended past the safe context point. Must stay 0: it means the
   * handoff threshold fired too late, and the next request risks a context-length
   * error from the provider. Alert on this (DESIGN.md §6.1).
   */
  readonly contextOverruns = this.registry.counter(
    "caterpillar_context_overrun_total",
    "sessions ending past the safe context point — must stay 0",
  );

  /**
   * Sessions cut short because the model provider stopped answering (§6.3), by kind.
   *
   * Labelled by kind rather than by task deliberately: an outage is a property of the
   * account, and a per-task series would suggest the task had something to do with it.
   */
  readonly providerOutages = this.registry.counter(
    "caterpillar_provider_outage_total",
    "sessions ended by a provider outage, by kind",
  );

  /**
   * Seconds this runner is still refusing to start a session. 0 when healthy.
   *
   * The one series that says "nothing is being worked on, and that is on purpose" —
   * without it a runner sitting out a spend limit is indistinguishable from an idle one.
   */
  readonly providerCooldown = this.registry.gauge(
    "caterpillar_provider_cooldown_seconds",
    "seconds until this runner will start a session again — 0 when healthy",
  );

  /**
   * Tasks this runner has a session open for RIGHT NOW (DESIGN.md §6.4).
   *
   * Labelled `runner` and not `task`, because the question it answers is about the runner:
   * is this replica doing one thing, four things, or nothing? A per-task series would be
   * `caterpillar_task_status` with extra steps, and would leave one stale sample per task
   * this runner has ever worked — gauges here never expire.
   */
  readonly tasksInFlight = this.registry.gauge(
    "caterpillar_tasks_in_flight",
    "tasks this runner has a session open for right now",
  );

  /**
   * Slots this runner could still fill — `concurrency` minus `tasksInFlight`.
   *
   * Derivable from the two gauges above and published anyway, because the alert an
   * operator actually wants is "this runner has been at zero free slots for an hour", and
   * expressing that as a subtraction across two series is how a dashboard ends up
   * silently comparing samples from different scrapes. It also states `concurrency`
   * itself: with no in-flight tasks this reads the configured N, so the configuration is
   * legible from the metrics without anyone reading a ConfigMap.
   */
  readonly slotsFree = this.registry.gauge(
    "caterpillar_slots_free",
    "task slots this runner could still fill",
  );

  /**
   * Claimable tasks this runner walked past because every slot was full.
   *
   * The series that distinguishes "the fleet has nothing to do" from "the fleet is
   * saturated", which look identical from every other metric: in both cases nothing new
   * starts. A rate that is persistently non-zero is the signal to raise `concurrency` or
   * add a replica, and a rate that is flat at zero while tasks sit `ready` says the
   * bottleneck is somewhere else entirely.
   *
   * A counter and not a gauge: it counts events, and a gauge that went back to zero the
   * moment a slot freed would be invisible to any scrape that did not land inside the
   * window.
   */
  readonly claimsRejectedFull = this.registry.counter(
    "caterpillar_claims_rejected_full_total",
    "claim attempts skipped because every task slot on this runner was busy",
  );

  /**
   * Local commits this runner could not rebase and had to move to `refs/salvaged/`
   * (DESIGN.md §4.3).
   *
   * **This series must stay at zero.** It used to have one cause — two runners appending
   * to the same single-file `journal.md` — and that cause has been eliminated by giving
   * the journal one file per entry (§4.1), so anything it counts now is a conflict the
   * fleet has never seen before: a hand-edited file, a `state.json` two runners wrote, a
   * format that forgot the lesson. The salvage itself is the backstop and stays; this is
   * how an operator finds out it fired, because the runner recovers and carries on and
   * nothing else would raise it.
   */
  readonly salvagedCommits = this.registry.counter(
    "caterpillar_salvaged_commits_total",
    "local state commits set aside because they could not rebase — must stay 0",
  );

  /**
   * Daily digests this runner published (DESIGN.md §19).
   *
   * Labelled by whether the day was quiet, because the two failures look identical
   * otherwise: a fleet that did nothing and a collector that stopped seeing what it did
   * both produce a digest a day. One series that never leaves `quiet="true"` is the
   * second one.
   */
  readonly digests = this.registry.counter(
    "caterpillar_digests_total",
    "daily digests published by this runner",
  );

  /**
   * Supervisor-mediated cluster reads, by tool and outcome (DESIGN.md §20).
   *
   * `outcome="denied"` is the series that earns this metric its place. A namespace
   * allowlist that is wrong looks, from every other angle, like a session that simply did
   * not diagnose anything: the agent is told no, writes something else, and nothing
   * anywhere records that the fleet is being refused. A denial is a configuration bug and
   * has to be visible as one.
   */
  readonly clusterReads = this.registry.counter(
    "caterpillar_cluster_reads_total",
    "supervisor-mediated cluster reads by tool and outcome",
  );

  /**
   * Cumulative seconds spent in those reads, same labels.
   *
   * A counter of seconds rather than a histogram, because this registry has counters and
   * gauges and nothing else (see `MetricKind`), and buckets are not worth a new metric type
   * for a call that either answers in milliseconds or has already failed. Divided by
   * `caterpillar_cluster_reads_total` it gives the mean, which is the only question anyone
   * has asked of it: whether Loki is answering at all.
   */
  readonly clusterReadSeconds = this.registry.counter(
    "caterpillar_cluster_read_seconds",
    "cumulative seconds spent in supervisor-mediated cluster reads",
  );

  /**
   * Alertmanager deliveries, by alertname and by what the receiver did (DESIGN.md §20).
   *
   * The `outcome` label is deliberately NOT collapsed into ok/error. The failure this whole
   * feature exists to prevent is an alert that nobody notices has been declined four
   * hundred times, and `outcome="refused-no-policy"` is the series that says so without
   * anyone reading a log line. `refused-max-open` is a different fact — the fleet is
   * already working on it — and merging the two would hide the one that needs a commit.
   *
   * `alertname` is empty for an unauthenticated or unparseable delivery, because there is no
   * alertname to attribute it to and taking one from a body that failed authentication
   * would let a stranger choose a label value.
   */
  readonly alerts = this.registry.counter(
    "caterpillar_alerts_received_total",
    "Alertmanager deliveries by alertname and outcome",
  );

  /**
   * Occurrences this runner settled, by schedule and outcome (DESIGN.md §22).
   *
   * `outcome="skipped"` is the series this metric is worth having for. A schedule whose
   * precheck never passes creates no tasks — and neither does a schedule nobody is polling,
   * or one whose cron expression fires at an hour the fleet is always down. Counting the
   * skips is what separates a gate doing its job from a scheduler that has stopped.
   *
   * Not collapsed into fired/other, for `caterpillar_alerts_received_total`'s reason:
   * `refused` means the fleet already has an open task for this schedule and is a fact about
   * throughput, while `skipped` means there was nothing to do and is the healthy case.
   */
  readonly schedules = this.registry.counter(
    "caterpillar_schedule_occurrences_total",
    "scheduled occurrences settled by this runner, by schedule and outcome",
  );

  /**
   * Task worktrees this runner threw away, by which removal did it (DESIGN.md §3.1).
   *
   * `kind="targeted"` is a task finishing cleanly and being tidied up after; `kind="swept"`
   * is the periodic sweep finding a directory no task claims. The label is the whole value
   * of the metric: a healthy runner reaps almost everything targeted, so a `swept` series
   * that keeps climbing says the supervisor's terminal paths are not reaching the removal
   * — pods being killed mid-session, or a branch nobody wired up — and the volume is only
   * staying under its limit because a timer is cleaning up after a bug.
   */
  readonly worktreesReaped = this.registry.counter(
    "caterpillar_worktrees_reaped_total",
    "task worktrees removed from this runner's volume, by which removal did it",
  );

  /**
   * Bytes those removals reclaimed, same labels.
   *
   * A counter rather than a gauge of free space, because free space is the node exporter's
   * to report and this is the only series that attributes a change in it to the fleet. It
   * is the number that answers "is reaping worth anything" — the question this whole path
   * exists to answer — and, divided by `caterpillar_worktrees_reaped_total`, says what one
   * task actually costs on disk.
   *
   * Apparent size summed over regular files, so it under-reports a sparse file and
   * over-reports a hard-linked one. Neither is worth a `du` before every removal.
   */
  readonly worktreeBytesReaped = this.registry.counter(
    "caterpillar_worktree_bytes_reaped_total",
    "approximate bytes reclaimed by removing task worktrees",
  );

  /**
   * What intake did with each item it saw, by workspace (DESIGN.md §14).
   *
   * Intake had no metric at all until this existed, which made the fourth intake path the
   * only one Grafana could not answer a question about: an alert delivery has
   * `caterpillar_alerts_received_total`, a session has `caterpillar_sessions_total`, and a
   * labelled issue that never became a task had a warn line in one pod's stdout.
   *
   * `outcome` is `created|rejected|skipped` — the three answers `Ingester.ingestItem`
   * returns, verbatim, rather than a collapsed ok/error. `skipped` is overwhelmingly the
   * normal case (the item is already a task) and `rejected` is the one that needs a human,
   * so merging them would hide the series this was added for.
   *
   * `workspace` rather than `tracker`, because the workspace is the unit an operator
   * configures and the unit a repo bound is set on; two workspaces on the same tracker
   * kind are two different questions.
   */
  readonly intake = this.registry.counter(
    "caterpillar_intake_total",
    "tracker items by workspace and what intake did with them",
  );

  /**
   * Items the trackers returned in the last pass, before any were skipped or refused.
   *
   * A GAUGE and not a counter, and the distinction is the whole point of the series:
   * `caterpillar_intake_total` counts decisions and only ever grows, so a fleet whose
   * tracker has gone quiet looks identical to one nobody is polling. This is the standing
   * size of the labelled backlog — `seen` from `IntakePass` — and it goes back to zero
   * when the last labelled item becomes a task, which is exactly the transition an
   * operator wants a graph of.
   *
   * Set only by the runner that WON the interval's claim (`intakeRef`), so on a fleet of
   * four this is published by whichever pod ingested and stays stale on the other three
   * until their turn. Aggregate it with `max` rather than `sum`.
   */
  readonly intakeItems = this.registry.gauge(
    "caterpillar_intake_items",
    "items the trackers returned in the last intake pass, by workspace",
  );

  /**
   * Lines the fleet and the humans wrote, by repo (DESIGN.md §19).
   *
   * The digest states the share in prose and nothing can graph prose. This is the same
   * measurement as a number, so a dashboard divides the two `author` series itself and gets
   * the trend from `rate()` over a fortnight rather than from one day's arrow.
   *
   * A COUNTER, so it accumulates over days. Publishing a gauge of one window's share would
   * be a series that goes back to zero on every quiet day and is invisible to any scrape
   * that did not land inside the window.
   *
   * `author` is `fleet|human` and nothing else. The interesting question is the split, not
   * who each person was, and a series per contributor would put an email address into
   * label cardinality that never expires.
   */
  readonly authoredLines = this.registry.counter(
    "caterpillar_digest_authored_lines_total",
    "lines written in a digest window by the fleet and by humans, per repo",
  );

  /**
   * The same split at commit level, same labels.
   *
   * Both, because they disagree in ways that matter: a fleet that rewrites a file moves
   * many lines in one commit, and a person fixing a typo moves one line in one commit. A
   * dashboard showing only lines would report a fleet that reformatted something as having
   * written the repository.
   */
  readonly authoredCommits = this.registry.counter(
    "caterpillar_digest_authored_commits_total",
    "commits made in a digest window by the fleet and by humans, per repo",
  );

  /**
   * Digest windows in which a repo's history could not be read at all (§19).
   *
   * Its own series, because the alternative is the failure this whole rule exists to stop:
   * a repo with no mirror on the publishing runner would otherwise report zero fleet lines
   * a day, which on a graph is indistinguishable from a repo the fleet genuinely stopped
   * working on. One is a mirror to go and look for; the other is nothing to do.
   */
  readonly authorshipUnreadable = this.registry.counter(
    "caterpillar_digest_authorship_unreadable_total",
    "digest windows in which a repo's history could not be read on this runner",
  );

  /**
   * Bytes on the work volume, by what is using them (`workspace/usage.ts`).
   *
   * The series the complaint that started this asked for: "the scaling mechanisms use so
   * much disk space" was, until this existed, unanswerable from anything the supervisor
   * emitted. `category` is `mirrors|tasks|nix|other` and the four are disjoint, so they
   * sum to what this runner is accountable for — which is NOT the same as what the volume
   * holds, because another process can be on it. `caterpillar_work_fs_bytes` is the
   * arbiter there.
   */
  readonly workBytes = this.registry.gauge(
    "caterpillar_work_bytes",
    "bytes on the work volume by category — mirrors, tasks, nix, other",
  );

  /**
   * What the filesystem says about itself: `kind="total"` and `kind="free"`.
   *
   * Separate from `caterpillar_work_bytes` because it is a different KIND of measurement —
   * one `statfs` rather than a walk — and because it is the only one that stays correct
   * when the walk is `partial`. Alert on this one; use the categories to find out who.
   */
  readonly workFsBytes = this.registry.gauge(
    "caterpillar_work_fs_bytes",
    "total and free bytes of the filesystem holding the work root",
  );

  /**
   * The largest tasks and mirrors individually, so a graph can name the culprit.
   *
   * CAPPED at `TOP_N` of each by `workspace/usage.ts`, with the remainder in a single
   * `name="other"` series. The cap is not tidiness: `name` is a task id, the fleet creates
   * tasks continuously, worktrees survive the sessions that made them, and this registry
   * has no expiry — so an uncapped breakdown grows one series per task the runner has ever
   * worked and never drops one.
   */
  readonly workEntryBytes = this.registry.gauge(
    "caterpillar_work_entry_bytes",
    "bytes for the largest individual tasks and mirrors, remainder bucketed as `other`",
  );

  /**
   * 1 when the last measurement ran out of time before it saw everything.
   *
   * Its own series rather than a label on the byte gauges, because a label that changes
   * value starts a NEW time series: a walk that goes partial would break the continuity of
   * every byte graph at exactly the moment the volume got interesting enough to be slow.
   */
  readonly workPartial = this.registry.gauge(
    "caterpillar_work_partial",
    "1 when the last work-volume measurement hit its deadline before finishing",
  );

  /** Unix seconds of the last measurement. `time() - this` is how stale the bytes are. */
  readonly workMeasuredAt = this.registry.gauge(
    "caterpillar_work_measured_timestamp_seconds",
    "unix time of the last work-volume measurement",
  );

  /**
   * Publish one measurement. Called from the supervisor's idle branch, nowhere else.
   *
   * Here rather than at the call site so the label vocabulary is decided once: `category`
   * and `kind` are strings a dashboard hard-codes, and two call sites spelling them
   * differently is a dashboard that silently shows half the fleet.
   *
   * Every series is SET rather than incremented, including on a partial pass. A partial
   * pass under-counts, which is visible in `caterpillar_work_partial`; leaving the previous
   * value in place instead would be a number that looks fresh and is not.
   */
  recordUsage(runner: string, usage: WorkspaceUsage): void {
    this.workFsBytes.set({ runner, kind: "total" }, usage.fs.totalBytes);
    this.workFsBytes.set({ runner, kind: "free" }, usage.fs.freeBytes);

    this.workBytes.set({ runner, category: "mirrors" }, usage.mirrorBytes);
    this.workBytes.set({ runner, category: "tasks" }, usage.taskBytes);
    this.workBytes.set({ runner, category: "nix" }, usage.nixBytes);
    this.workBytes.set({ runner, category: "other" }, usage.otherBytes);

    // Cleared, not overwritten: the top N is recomputed every pass, and a task that has
    // dropped out of it must stop reporting rather than freeze at the last size it had.
    this.workEntryBytes.clear();
    for (const entry of usage.mirrors) {
      this.workEntryBytes.set({ runner, category: "mirrors", name: entry.name }, entry.bytes);
    }
    for (const entry of usage.tasks) {
      this.workEntryBytes.set({ runner, category: "tasks", name: entry.name }, entry.bytes);
    }

    this.workPartial.set({ runner }, usage.partial ? 1 : 0);
    this.workMeasuredAt.set({ runner }, Math.floor(Date.parse(usage.measuredAt) / 1000));
  }

  /**
   * Publish one window's authorship. Called from the digest's publish path, nowhere else.
   *
   * Here rather than at the call site for the same reason as `recordUsage`: `author` and
   * the metric names are strings a dashboard hard-codes, and two call sites spelling them
   * differently is a dashboard that silently shows half the fleet.
   *
   * Incremented, never set. These are counters and the report describes one window; adding
   * each window's figures is what makes `rate()` over them mean anything.
   *
   * A repo the runner could not read contributes to `authorshipUnreadable` and to NOTHING
   * else — not even a zero — because a zero-line series is a claim that the fleet wrote
   * none of it.
   */
  recordAttribution(runner: string, report: AttributionReport): void {
    for (const entry of report.repos) {
      const labels = { runner, repo: entry.repo };
      this.authoredLines.inc({ ...labels, author: "fleet" }, entry.fleet.lines);
      this.authoredLines.inc({ ...labels, author: "human" }, entry.human.lines);
      this.authoredCommits.inc({ ...labels, author: "fleet" }, entry.fleet.commits);
      this.authoredCommits.inc({ ...labels, author: "human" }, entry.human.commits);
    }

    for (const repo of report.unavailable) this.authorshipUnreadable.inc({ runner, repo });
  }

  render(): string {
    return this.registry.render();
  }
}
