/**
 * Runner and workspace configuration. See DESIGN.md §3.1 (workspaces).
 *
 * Config carries NO secrets. Every credential is referenced indirectly via
 * `secretRef` and resolved from the mounted SOPS secret at use time, so a config
 * dump is never a credential leak.
 */
import type { Capability, ForgeKind, TrackerKind, WorkspaceName } from "../domain/task.ts";
import type { LogLevel } from "../obs/log.ts";

/**
 * Who the runner authors as (DESIGN.md §9.7).
 *
 * One identity for both writers: the supervisor committing the state repo and the agent
 * committing in a task worktree. They are the same actor, and two identities would make
 * the audit trail read as though the fleet had a second author nobody configured.
 *
 * Deployment-specific by nature — it names the App installed for THIS deployment — which
 * is why it is configuration and not a constant. See `identity` in `load.ts` for the one
 * address shape that is refused, and why.
 */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface ForgeConfig {
  readonly kind: ForgeKind;
  readonly host: string;
  /** Default owner/org for repos in this workspace. */
  readonly owner: string;
  /** API base, e.g. `https://codeberg.org/api/v1`. */
  readonly apiBase: string;
}

export interface TrackerConfig {
  readonly kind: TrackerKind;
  readonly apiBase: string;
  /** Label that marks an item as agent-eligible at intake. */
  readonly ingestLabel: string;
  /**
   * Labels the supervisor applies as a task moves (DESIGN.md §9.5). Optional because
   * the adapters default them (`agent-wip`, `needs-human`) — they exist here so a
   * tracker that already uses different vocabulary needs a config change, not a
   * code change. The label must already exist: no adapter creates one.
   */
  readonly wipLabel?: string;
  readonly needsHumanLabel?: string;
}

/**
 * One ecosystem: forge + tracker + credential bundle. A task in one workspace can
 * never obtain another workspace's credentials.
 */
export interface WorkspaceProfile {
  readonly name: WorkspaceName;
  readonly forge: ForgeConfig;
  readonly tracker?: TrackerConfig;
  /** Key into the mounted secret directory. */
  readonly secretRef: string;
}

export interface LeaseConfig {
  /** Heartbeat interval. Also the fencing granularity (DESIGN.md §5.1). */
  readonly heartbeatSeconds: number;
  /** A lease older than this is stealable. Must exceed plausible clock skew. */
  readonly staleAfterSeconds: number;
}

export interface HandoffConfig {
  /**
   * Fraction of the model's context window at which the session hands off.
   * Must leave pi's compaction trigger unreachable — enforced by
   * `assertHandoffBeforeCompaction` (DESIGN.md §6.1).
   */
  readonly thresholdFraction: number;
}

export interface LimitsConfig {
  readonly maxSessionsPerTask: number;
  /** Consecutive no-progress sessions before parking. */
  readonly noProgressLimit: number;
  /**
   * Times the review council may send one task back before it parks for a human
   * (DESIGN.md §12.1). The council and the implementation agent can otherwise trade a
   * task until the session limit, which looks from outside like a task that is running
   * and getting nowhere.
   */
  readonly maxReviewRounds: number;
  /**
   * Wall-clock ceiling on ONE session, in seconds.
   *
   * Not a budget — a hang detector. pi's bash tool documents `timeout` as optional with
   * no default, so the model decides whether a command can block forever. Housekeeping now
   * runs on its own timer (§6.4), so a `npm run dev` that never returns no longer takes
   * chat and intake down with it — but it still holds the work loop indefinitely, so the
   * runner claims nothing further while the heartbeat keeps renewing the lease and /healthz
   * keeps answering 200. Generous on purpose; a session that legitimately needs longer than
   * this is one nobody is watching.
   */
  readonly maxSessionSeconds: number;
  /**
   * Ceiling AND default for ONE command from the agent's shell (DESIGN.md §6.4).
   *
   * `maxSessionSeconds` above is the backstop; this is the actual fix. pi's bash tool
   * documents `timeout` as *"Defaults to no timeout"* and passes through whatever the
   * model asked for, so without this a single `npm test` whose subprocess never exits
   * holds the lease until the session ceiling fires hours later — which is exactly what
   * happened, for 2h42m, inside a review council reviewer.
   *
   * Defaults to 900 to match the per-command timeout the acceptance gate has always had
   * (`COMMAND_TIMEOUT_MS` in `supervisor/verifier.ts`). The gate and the agent trying to
   * satisfy it should tolerate the same command taking the same time; they disagreed, and
   * only the gate was protected.
   */
  readonly commandTimeoutSeconds: number;
}

export interface StateRepoConfig {
  /**
   * Clone URL of the state repo. Written by the supervisor only (DESIGN.md §9.3).
   * HTTPS, so the GitHub App token can authenticate it as a header.
   */
  readonly url: string;
  readonly branch: string;
  /** Checkout path on the PVC. */
  readonly path: string;
  /**
   * Secret holding the GitHub App credentials used for the state repo — same key
   * layout as a github workspace (`app-id`, `installation-id`, `private-key.pem`).
   * The App must be installed on the state repo, which is a different repo from the
   * ones tasks touch.
   *
   * Optional: without it the supervisor assumes the checkout is already authenticated,
   * which is only true for local development.
   */
  readonly secretRef?: string;
}

export interface WorkspacePathsConfig {
  /** Bare mirrors, one per repo. */
  readonly mirrors: string;
  /** Per-task worktrees. */
  readonly tasks: string;
  /**
   * The volume both of the above live on — what `df` would be run against.
   *
   * Only the usage measurement reads it (`workspace/usage.ts`): it is what `statfs` is
   * asked about, and what the `other` category is measured relative to. Defaulted to the
   * directory containing `mirrors` and `tasks` rather than required, because every
   * existing config predates it and a mandatory field would refuse to load them.
   */
  readonly root: string;
}

/**
 * Measuring the work volume (`workspace/usage.ts`).
 *
 * Its own section rather than a field under `paths`, because these are the two numbers an
 * operator tunes when the measurement itself becomes the problem — a volume big enough
 * that walking it costs real time — and `paths` is about WHERE things are.
 */
export interface UsageConfig {
  /**
   * Hours between measurements. Modelled on `toolchain.gcIntervalHours` and throttled for
   * the same reason it is: this walk is proportional to inode count over a tree that
   * includes one `node_modules` per task, and it runs on the work loop's idle branch, whose
   * next act would otherwise be claiming a task. Hourly is often enough to catch a volume
   * filling and rare enough that nobody notices the cost.
   *
   * 0 disables the measurement entirely — an interval of zero would otherwise mean
   * "every idle poll", which is the one setting that could actually hurt.
   */
  readonly intervalHours: number;
  /**
   * Ceiling on ONE measurement. Hitting it reports what was measured with `partial` set,
   * rather than blocking the loop until the walk finishes or throwing away the work.
   */
  readonly deadlineSeconds: number;
}

/**
 * When this runner throws a finished task's worktree away — DESIGN.md §3.1, and the
 * `Workspace` row of §2.
 *
 * The mirror of `ToolchainConfig.gcIntervalHours` / `gcKeepDays`, and it exists because
 * the store had a collector and the worktrees did not. A worktree is the thing that
 * actually grows per task — a checkout plus `node_modules` plus build output, per repo the
 * task declares — and every task ever run left one behind on a 20Gi ReadWriteOnce volume,
 * per replica, forever. The nix store was being collected daily next to a directory nobody
 * ever swept.
 *
 * Two knobs rather than one because there are two removals with different triggers. The
 * targeted one fires the moment a task reaches a state it will not resume from in place
 * and needs no configuration at all. `keepHours` governs only the SWEEP — the safety net
 * for the pod that was killed before the targeted removal could run — and it is an age
 * bound for the same reason `--delete-older-than` is: the thing worth keeping is whatever
 * a task touched recently, and that is what an age expresses.
 */
export interface WorktreeReapConfig {
  /** Hours between sweeps of `paths.tasks`. Only ever runs on an idle poll. */
  readonly intervalHours: number;
  /**
   * Hours a worktree directory survives after its last modification with no live task
   * claiming it.
   *
   * Generous by default, and deliberately not zero: a task that parked awaiting a human
   * keeps its worktree so the session that answers the question does not re-clone and
   * re-install, and a runner that crashed mid-session may re-claim the same task within
   * minutes. The sweep is a backstop against leaks, not a second scheduler.
   */
  readonly keepHours: number;
}

/** How this runner manages the per-task checkouts on its PVC. */
export interface WorkspaceConfig {
  readonly reap: WorktreeReapConfig;
}

/**
 * How the runner authenticates to the model provider (DESIGN.md §9.6).
 *
 * `proxy` — the in-cluster proxy holds the provider credential.
 * `subscription` — pi-ai's Anthropic OAuth mode against a Claude Pro/Max
 *   subscription, talking to api.anthropic.com directly. There is no proxy in this
 *   path: an OAuth bearer credential cannot be forwarded by a proxy that
 *   authenticates with `x-api-key`.
 */
export type LlmAuthMode = "proxy" | "subscription";

/**
 * How long the runner stops starting sessions after the provider refuses (§6.3).
 *
 * Not per task: the account is shared by every task on this runner, so the first
 * refusal is the answer for all of them.
 */
export interface CooldownConfig {
  /** Wait after the first refusal. Doubles per consecutive one. */
  readonly initialSeconds: number;
  /** Ceiling on one wait — also how often a long outage is re-checked. */
  readonly maxSeconds: number;
}

export interface LlmConfig {
  readonly auth: LlmAuthMode;
  readonly cooldown: CooldownConfig;
  /** Proxy base URL. Ignored for `subscription`, which uses pi's own provider. */
  readonly baseUrl: string;
  readonly modelId: string;
  /** Provider id registered with pi-ai for the proxy. Ignored for `subscription`. */
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /**
   * Where the rotating OAuth credential lives. Required for `subscription`.
   *
   * Must be on WRITABLE, durable storage — the PVC, never a mounted Secret.
   * Refreshing rotates the refresh token, so a read-only mount locks the
   * supervisor out as soon as the access token expires.
   *
   * In a FLEET this is the credential holder's field, not a runner's: the holder
   * owns the single durable copy and runners read it over `credentialsUrl`.
   * Both are present in a fleet's ConfigMap because one object configures both
   * workloads — see `credentialsUrl` for which one wins where.
   */
  readonly credentialsPath?: string;
  /**
   * Base URL of the credential holder (DESIGN.md §9.6). Set this to scale past ONE
   * replica.
   *
   * When present it WINS over `credentialsPath` in the supervisor: the runner reads
   * the credential over HTTP and never writes one. That is the whole mechanism —
   * a refresh rotates the refresh token, the cluster has no ReadWriteMany storage
   * class, so N replicas would hold N copies and N-1 of them would be invalid
   * within the hour.
   *
   * The holder itself ignores this field and uses `credentialsPath`.
   */
  readonly credentialsUrl?: string;
}

/** How this runner materialises a task's dev environment (DESIGN.md §8.1). */
export interface ToolchainConfig {
  /**
   * Flake reference supplying the packages an explicit `toolchain.packages` names.
   * PINNED to a revision, never `nixpkgs` unqualified: an unattended agent that picks up
   * a silent nixpkgs bump produces a red acceptance run with no diff to explain it.
   */
  readonly nixpkgs: string;
  /**
   * Ceiling on one environment resolve. Generous by default — a devShell that overrides
   * anything can miss the binary cache and build from source — but bounded, because a
   * nix evaluation that never returns would wedge the supervisor exactly like a hung
   * acceptance command would.
   */
  readonly timeoutSeconds: number;
  /**
   * Hours between `nix-collect-garbage` passes. The store shares a 20Gi PVC with the
   * mirrors and every task's worktree, so this is a requirement rather than hygiene.
   * Live environments are protected by the GC roots the resolver registers.
   */
  readonly gcIntervalHours: number;
  /** Days a store path survives with no GC root. */
  readonly gcKeepDays: number;
  /**
   * Binary caches to consult BEFORE the defaults (DESIGN.md §8.1). Empty by default.
   *
   * This is what makes a fleet affordable. Every replica has its own store — the cluster
   * has no ReadWriteMany storage class, so it cannot have anything else — and without a
   * shared cache each one substitutes the same dotnet closure over the public internet,
   * separately, every time the store is collected. One in-cluster pull-through cache
   * turns that into a LAN copy for everyone after the first.
   *
   * These are `extra-substituters`, never `substituters`: appending leaves
   * cache.nixos.org in place, so a cache that is down or empty costs a failed request and
   * not a from-source build of a toolchain.
   */
  readonly substituters: readonly string[];
  /**
   * Public keys that make `substituters` trustworthy. Empty by default.
   *
   * A pull-through cache in front of cache.nixos.org needs NONE: it serves the upstream's
   * own signatures, which nix already trusts. This is for a cache that signs its own
   * paths, which is what a store that also holds locally-BUILT derivations has to do.
   *
   * Configured separately from the URL rather than parsed out of it, because a key is a
   * trust decision and a URL is a location, and one operator changing the other's mind by
   * editing a string is exactly the accident worth preventing.
   */
  readonly trustedPublicKeys: readonly string[];
  /**
   * Free space on the store's filesystem, in GiB, below which nix collects MID-BUILD
   * until `maxFreeGb` is available again. 0 disables it. DESIGN.md §8.1.
   *
   * **This is the store's only real quota, and it has to be, because the manifests look
   * like they say otherwise.** A `volumeClaimTemplate` requesting 15Gi under `local-path`
   * is a scheduling request and not a limit: the provisioner hands out a directory on the
   * node's own filesystem and enforces nothing. A store that grows to 60Gi fills the node
   * and takes every other pod on it down with it. No storage class here would enforce it,
   * and `ephemeral-storage` limits do not cover a PersistentVolume.
   *
   * Measured against the NODE rather than the volume, deliberately: four replicas' volumes
   * share one disk with everything else scheduled there, so per-store ceilings that are
   * each individually fine still add up to a full node.
   */
  readonly minFreeGb: number;
  /**
   * How much free space an automatic collection aims to leave, in GiB. Must exceed
   * `minFreeGb` or nix collects on every build.
   *
   * The gap between the two is the hysteresis. Too narrow and a big substitution
   * re-triggers a collection it just paid for; this is why it is a separate number rather
   * than a multiple of `minFreeGb`.
   */
  readonly maxFreeGb: number;
}

/**
 * The daily digest (DESIGN.md §19).
 *
 * `enabled` defaults to FALSE, for the same reason the web view's does: a digest is
 * published to the shared Discord channel and committed to the shared state repo, and a
 * runner someone started on a workstation must not begin doing either because it was
 * upgraded. The claim protocol makes double-posting impossible, not unwanted.
 */
export interface DigestConfig {
  readonly enabled: boolean;
  /**
   * Local hour at which a day is considered over, 0–23. The digest covers the 24 hours
   * ending here — see `digest/day.ts` for why it is not midnight-to-now.
   */
  readonly hour: number;
  /**
   * IANA zone, e.g. `Europe/Berlin`. Named rather than an offset so DST is the zone
   * database's problem: a fixed `+02:00` publishes an hour late for five months a year.
   */
  readonly timeZone: string;
  /**
   * Whether a model writes the prose paragraph over the day's work.
   *
   * The facts are free and come from git; this is the only part of a digest that costs
   * tokens. Turning it off leaves a complete document with a section missing, which is
   * why it is a separate switch from `enabled` — a runner minding its spend should not
   * have to choose between prose and no digest at all.
   */
  readonly summarise: boolean;
}

/**
 * Supervisor-mediated cluster reads (DESIGN.md §20).
 *
 * Two switches, and they are not the same switch. `enabled` says this runner may perform
 * cluster reads at all; `namespaces` says which ones. An EMPTY list denies everything — see
 * `cluster/guard.ts` for why that reading is the only safe one — so `enabled: true` with the
 * list forgotten produces a runner that refuses every read and says so in its metrics,
 * rather than one that reads the whole cluster.
 *
 * This is the ONLY place the namespace bound is set. There is deliberately no per-task and
 * no per-alert list (§20): a bound an alert payload could widen for itself is not a bound.
 */
export interface ClusterConfig {
  readonly enabled: boolean;
  /** Namespaces a `remediation` session may read. Empty — the default — denies all. */
  readonly namespaces: readonly string[];
  /**
   * Loki's query API. Plain HTTP in-cluster: the deployment is `SingleBinary` with
   * `gateway.enabled: false`, so there is no nginx front door and no TLS to terminate.
   * Configurable so a Grafana datasource proxy can be substituted later.
   */
  readonly lokiUrl: string;
  /** The kube API. In-cluster this is the only value that works. */
  readonly kubeApiUrl: string;
  /** Ceiling on lines one `cluster_logs` call may return. Lowers the built-in cap, never raises it. */
  readonly maxLogLines: number;
}

export interface RunnerConfig {
  readonly runnerId: string;
  readonly capabilities: readonly Capability[];
  /** Author and committer of everything this runner writes. */
  readonly identity: CommitIdentity;
  readonly toolchain: ToolchainConfig;
  readonly stateRepo: StateRepoConfig;
  readonly paths: WorkspacePathsConfig;
  readonly workspace: WorkspaceConfig;
  readonly usage: UsageConfig;
  readonly lease: LeaseConfig;
  readonly handoff: HandoffConfig;
  readonly limits: LimitsConfig;
  readonly llm: LlmConfig;
  readonly workspaces: ReadonlyMap<WorkspaceName, WorkspaceProfile>;
  /** Seconds between claim attempts when no task is available. */
  readonly pollSeconds: number;
  /**
   * Seconds between housekeeping passes — pull, chat drain, intake, alerts, digest,
   * leadership (DESIGN.md §6.4).
   *
   * Its own interval because housekeeping runs on its own loop, independent of whether a
   * session is in flight. `pollSeconds` is a floor on how often an IDLE runner looks for
   * work, which is a throughput question; this is a ceiling on how long a human waits for
   * `/resume` to be noticed, which is a latency one, and the two have no reason to agree.
   *
   * Defaults at or below `pollSeconds` for that reason: making housekeeping slower than
   * claiming would reintroduce the very latency the split exists to remove.
   */
  readonly housekeepingSeconds: number;
  /** Directory of mounted secret files, keyed by `secretRef`. */
  readonly secretsDir: string;
  readonly log: LogConfig;
  readonly intake: IntakeConfig;
  readonly web: WebConfig;
  readonly digest: DigestConfig;
  readonly cluster: ClusterConfig;
  readonly remediation: RemediationConfig;
  /** The ephemeral cross-process plane (DESIGN.md §21). Off by default. */
  readonly redis: RedisConfig;
  /** Where the Discord bot runs: in this process, or its own (DESIGN.md §7, §10). */
  readonly bot: BotConfig;
}

/**
 * Which process owns the Discord connection (DESIGN.md §7).
 *
 * `mode: "in-process"` is the default and is exactly what every runner has always done:
 * the supervisor connects to the gateway itself. One replica, no Redis, a laptop — all of
 * it keeps working with no configuration at all, which is what keeps the existing test
 * suite meaningful rather than a description of a path nobody runs.
 *
 * `mode: "external"` says a SEPARATE process (`caterpillar-bot`) owns Discord, so this
 * supervisor must not connect. It becomes a pure worker: it drains the inbox, publishes
 * the snapshot and the thread bindings, and holds no gateway socket.
 *
 * The mode is only honoured when `redis.enabled` is also set, and that is a safety
 * interlock rather than a convenience. Redis is the ONLY way the two processes reach each
 * other; `external` without it would mean a supervisor that has stopped listening to
 * Discord and a bot that cannot reach the supervisor — a fleet that silently answers
 * nobody, produced by a single-line config mistake. So an `external` with no Redis logs
 * loudly and behaves as `in-process`.
 */
export interface BotConfig {
  readonly mode: "in-process" | "external";
  /**
   * Port the standalone bot serves `/healthz` and `/metrics` on.
   *
   * Its own field rather than reusing `METRICS_PORT`, because the two processes have
   * different ports in the same namespace and one number that meant both would be an
   * EADDRINUSE in whichever pod lost.
   */
  readonly port: number;
}

/**
 * The Alertmanager webhook receiver (DESIGN.md §20).
 *
 * `enabled` defaults to FALSE, and here that is more than the caution the web view and the
 * digest exercise: this listener is the only one in the process that can cause a task to
 * exist, and a task is a session with a shell and a forge credential. A runner someone
 * started on a workstation must not open that port because it was upgraded.
 *
 * There is no token field. The token is a credential and lives in the mounted secret
 * `caterpillar-remediation` under `webhook-token`, like every other credential (§9) — and
 * the receiver refuses to start without it, because an unauthenticated webhook that creates
 * tasks is a remote code execution path.
 */
export interface RemediationConfig {
  readonly enabled: boolean;
  /**
   * Its own port, separate from the metrics port and the web view's. All three are checked
   * against each other at startup: bind order would otherwise decide which one exists, and
   * the loser fails with an EADDRINUSE that names neither.
   */
  readonly port: number;
}

/**
 * The ephemeral cross-process plane (DESIGN.md §21).
 *
 * `enabled` defaults to FALSE, and the default here is load-bearing in a way the web
 * view's and the digest's are not. Redis carries the chat inbox, the task snapshot,
 * presence and cancel signals — four things a single-replica runner already does
 * perfectly well in its own heap. Turning it on is what lets a SEPARATE process (the
 * standalone Discord bot) see them; leaving it off is not a degraded mode, it is the
 * arrangement every runner has always run in.
 *
 * Which is also why nothing here may become required. A Redis outage has to degrade the
 * fleet to exactly this configuration, not take it down — so every consumer falls back
 * to its in-memory implementation and the supervisor keeps working its tasks. The
 * authoritative plane is git and stays git: leases, task state, the journal and the audit
 * trail are unaffected by anything in this block (§5, §21).
 *
 * There is no password field. It is a credential, so it lives in the mounted secret named
 * by `secretRef` under the key `password`, like every other credential (§9).
 */
export interface RedisConfig {
  readonly enabled: boolean;
  /**
   * `redis://host:port` or `rediss://` for TLS. One field rather than host+port because
   * the HA deployment is addressed by a Service name and the scheme is the only place
   * TLS can be asked for — two fields would need a third to say the same thing.
   */
  readonly url: string;
  /**
   * Mounted secret holding `password`. Optional: a Redis reachable only inside the
   * namespace's NetworkPolicy is a supported deployment, and requiring a credential for
   * it would mean inventing one.
   */
  readonly secretRef?: string;
  /**
   * Ceiling on ONE command, milliseconds.
   *
   * Short on purpose. Every read on this plane is in front of a human — Discord's
   * interaction budget is 3 seconds — and every write is in one of the supervisor's loops,
   * which must never block on a socket that is not going to answer. Exceeding it degrades; it does
   * not throw (`redis/guarded.ts`).
   */
  readonly commandTimeoutMs: number;
  /**
   * Prefix on every key this deployment writes.
   *
   * So two fleets can share one server without a staging supervisor draining production's
   * chat inbox. Defaulted rather than required, because the common case is one fleet.
   */
  readonly keyPrefix: string;
}

export interface IntakeConfig {
  /**
   * Seconds between tracker intake passes. Deliberately NOT the poll interval: a
   * GitHub pass costs one request per repo in the installation, so polling it would
   * exhaust the hourly rate limit within minutes (see `intakeDue`).
   */
  readonly intervalSeconds: number;
}

export interface LogConfig {
  /** Records below this severity are dropped. Defaults to `info`. */
  readonly level: LogLevel;
}

/**
 * The read-only web view (DESIGN.md §18).
 *
 * `enabled` defaults to FALSE. The view serves every session transcript the fleet has
 * produced, and a transcript quotes whatever the agent read; a runner on a workstation
 * must not begin answering for that because it was upgraded. In the cluster it is turned
 * on in the ConfigMap, where the Ingress that authenticates it is turned on too.
 */
export interface WebConfig {
  readonly enabled: boolean;
  /** Separate from the metrics port: the Ingress publishes this one and only this one. */
  readonly port: number;
  /** Log records held in memory for the view. Loki keeps the history. */
  readonly logCapacity: number;
  /** How often a live page re-fetches itself. */
  readonly refreshSeconds: number;
  /**
   * Refuse any request that did not arrive with an identity header from the
   * authenticating proxy.
   *
   * This is NOT authentication — anything already inside the cluster can set a header.
   * It is a fail-closed check on the one realistic failure: an Ingress whose forward-auth
   * annotations are dropped or misspelt, which otherwise publishes the whole state repo
   * to the internet and looks exactly like a working deployment.
   */
  readonly requireForwardedUser: boolean;
  /** Header carrying that identity. Lowercased — node lowercases what it receives. */
  readonly forwardedUserHeader: string;
}
