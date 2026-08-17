/**
 * Minimal Prometheus text-exposition registry. See DESIGN.md §11.
 *
 * Hand-rolled rather than pulling prom-client: the metric set is small and fixed,
 * and this keeps the dependency surface (and therefore the supply-chain review
 * burden) down. Scraped by a ServiceMonitor.
 */
export type LabelValues = Readonly<Record<string, string>>;

interface Sample {
  readonly labels: LabelValues;
  value: number;
}

type MetricKind = "counter" | "gauge";

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
        .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
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

  render(): string {
    return this.registry.render();
  }
}
