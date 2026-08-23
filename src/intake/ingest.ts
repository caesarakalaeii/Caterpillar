/**
 * Tracker → state repo. See DESIGN.md §14.
 *
 * This is the only thing that creates work. Until it existed the supervisor polled an
 * empty `tasks/` directory forever and labelling an issue `agent` did nothing.
 *
 * Two properties matter more than anything else here, because intake runs on every poll:
 *
 *   IDEMPOTENCY — an item that is already a task must be skipped, or a fresh duplicate
 *   task appears every 30 seconds. This rests on `taskIdFor` being derived from the
 *   tracker ref alone (never the title, which humans edit) and on `hasTask`.
 *
 *   NO TRACKER SPAM — an item that cannot become a task is commented on ONCE, not once
 *   per poll. The suppressing record is durable and pushed rather than in-memory,
 *   because Keel rolls the pod on every push to main and an in-memory set would
 *   re-comment on every deploy.
 */
import { createHash } from "node:crypto";
import {
  EMPTY_USAGE,
  type RepoRef,
  type TaskState,
  type ToolchainSpec,
  type TrackerRef,
  type WorkspaceName,
} from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { StateStore } from "../state/store.ts";
import { unreachableSummary, type RepoReach } from "../forge/reach.ts";
import type { WorkspaceScope } from "../forge/types.ts";
import type { Tracker, TrackerItem } from "../tracker/types.ts";
import { renderSpec, taskIdFor, type IngestResult } from "./spec.ts";

/**
 * Whether an intake pass is due.
 *
 * Intake CANNOT run on the supervisor's poll interval. A GitHub pass costs one request
 * to enumerate the installation plus one per repo — the live installation is
 * account-wide at 65 repos, so ~66 requests a pass. At a 30s poll that is ~132 requests
 * a minute against an installation limit of 5000/hour (~83/min), which exhausts the
 * budget within minutes and takes the forge calls down with it. At the 300s default the
 * same pass costs ~13/min.
 *
 * Extracted as a pure function so the interval is testable without a clock. `lastAtMs`
 * of 0 means "never ran" and is checked EXPLICITLY rather than left to arithmetic: with a
 * real `Date.now()` the subtraction happens to exceed any interval, but relying on the
 * epoch being large makes the boot case true by accident instead of by intent.
 */
export const intakeDue = (
  lastAtMs: number,
  nowMs: number,
  intervalSeconds: number,
): boolean => lastAtMs === 0 || nowMs - lastAtMs >= intervalSeconds * 1000;

/**
 * The ref that makes exactly one runner in a fleet ingest per interval (DESIGN.md §14).
 *
 * `intakeDue` bounds how often ONE runner ingests. It says nothing about how often the
 * FLEET does, and the arithmetic above is why that is not a detail: a pass is ~66 requests
 * against an installation budget of ~83/minute, so four replicas at the 300s default sit
 * at ~52/min and ten replicas exhaust the hourly budget — taking every forge call down
 * with it, because the limit is per installation and not per endpoint.
 *
 * So the interval becomes a BUCKET and the bucket becomes a claim, won by the same
 * compare-and-swap that claims a task (§5). The winner ingests; the losers skip the pass
 * entirely and are not delayed by it. Nothing is released: the ref's existence IS the
 * record that the bucket has been served, which is what makes this idempotent across a
 * restart — a runner that dies mid-pass costs one skipped interval, and intake is
 * already best-effort by design.
 *
 * Bucketing on wall-clock rather than on each runner's own `lastIntakeAt` is what makes
 * the runners agree without talking: two pods that booted forty seconds apart compute the
 * same bucket, so they contend for one ref instead of alternating two.
 *
 * The agreement is approximate at a boundary and that is accepted rather than fixed.
 * Runners whose intervals fire either side of one land in ADJACENT buckets and both win,
 * so a fleet can ingest twice in an interval — but only twice, however many replicas
 * there are, because everyone before the boundary shares a ref and everyone after shares
 * the other. Two passes the hourly budget absorbs; N passes is the problem being solved.
 * A tighter scheme would need the runners to agree on a clock, which is a distributed
 * clock to be wrong about in exchange for one saved request per five minutes.
 */
export const intakeRef = (nowMs: number, intervalSeconds: number): string =>
  `refs/intake/${Math.floor(nowMs / (intervalSeconds * 1000))}`;

/** What one pass did. Reported so an idle intake is distinguishable from a broken one. */
export interface IntakePass {
  /** Items the trackers returned, before any were skipped or refused. */
  readonly seen: number;
  readonly created: number;
  readonly rejected: number;
  /** Trackers that could not be listed at all. */
  readonly failed: number;
  /** Schedules in the state repo that parsed (DESIGN.md §22). */
  readonly schedules: number;
  /** Files under `schedules/` that are not schedules. Warned about once per pass. */
  readonly schedulesInvalid: number;
}

/** What intake decided about one item. Mirrored into the metric's `outcome` label. */
export type IntakeOutcome = "created" | "rejected" | "skipped";

/**
 * Told about every decision intake makes, so an operator can count refusals in Grafana
 * without reading a pod's stdout.
 *
 * The same shape as `AlertObserver` in `remediation/receiver.ts`, and here for the same
 * reason: `Ingester` should not learn how a counter is incremented, and the adapter in
 * `index.ts` is the one place that decides what the labels are called.
 */
export interface IntakeObserver {
  observe(workspace: WorkspaceName, outcome: IntakeOutcome): void;
  /** How many items the tracker returned for this workspace in this pass. */
  items(workspace: WorkspaceName, seen: number): void;
}

export interface IngesterDeps {
  readonly store: StateStore;
  /** Trackers to ingest from, by workspace. A workspace without one is supported. */
  readonly trackers: ReadonlyMap<WorkspaceName, Tracker>;
  /**
   * The configured repo bound per workspace (§9.1). An item naming a repo outside it is
   * refused at intake, where the refusal reaches the human who wrote it.
   */
  readonly scopes: ReadonlyMap<WorkspaceName, WorkspaceScope>;
  readonly logger: Logger;
  /** Session cap stamped into each new task's `state.json`. */
  readonly maxSessionsPerTask: number;
  /** Optional: without one intake behaves exactly as it did before it had a metric. */
  readonly metrics?: IntakeObserver;
  /**
   * Whether the repos an item names are ones the workspace's credential can reach
   * (DESIGN.md §9.1.1), narrowed to that one question.
   *
   * An `agent` block's `repos` list is free text, and `scopes` only bounds where a repo may
   * be — not whether it is there. A task built from a repo nothing can clone dies in its
   * first session on a git exit code, and on this path nobody is watching for it: the human
   * labelled an issue and walked away. Refusing at intake puts the answer in a comment on
   * the item instead.
   *
   * Optional, and it fails open on a throw — see the refusal site for why.
   */
  readonly forges?: ReadonlyMap<WorkspaceName, RepoReach>;
  /**
   * Whether the packages a `toolchain` block declares resolve against the configured
   * nixpkgs pin (DESIGN.md §8.1), narrowed to that one question.
   *
   * The same argument as `forges` one field up, with a different exit code. `spec.ts`
   * checks that the block is SHAPED right; nothing checked that `lua51` is spelt
   * `lua5_1`, so the answer arrived inside a session, from `nix print-dev-env`, after a
   * runner had claimed the task.
   *
   * Optional, and it fails open on a throw and on "could not evaluate" alike — see the
   * refusal site.
   */
  readonly toolchainDoctor?: ToolchainCheck;
}

/**
 * The one question intake asks about a declared toolchain.
 *
 * An interface here rather than an import of `ToolchainDoctor`, for the reason
 * `RepoInspector` exists in `workspace/toolchain.ts`: intake has no business knowing how
 * nix is invoked, and a test needs to answer this without a nix store. `ToolchainDoctor`
 * satisfies it structurally.
 */
export interface ToolchainCheck {
  /** A refusal to put on the item, or undefined for "no objection" and "cannot tell". */
  fault(declared: ToolchainSpec | undefined): Promise<string | undefined>;
}

/**
 * The repo an item lives in, when the tracker has one.
 *
 * Only a fallback for an undeclared `repos`: a GitHub issue about a repo almost always
 * means that repo. Vikunja has no such notion, so a Vikunja item must declare it.
 */
const selfRepo = (ref: TrackerRef): RepoRef | undefined => {
  if (ref.kind !== "github-issues" || ref.container === undefined) return undefined;
  const [owner, name] = ref.container.split("/");
  if (owner === undefined || name === undefined) return undefined;
  return { host: "github.com", owner, name };
};

/**
 * Identity of the item's human-authored content.
 *
 * Covers the title as well as the body, because both feed the goal. Compared with strict
 * equality on the full hex digest — a prefix or substring comparison here would treat a
 * changed item as unchanged.
 */
const digestOf = (item: TrackerItem): string =>
  createHash("sha256").update(`${item.title}\n\n${item.body}`).digest("hex");

export class Ingester {
  private readonly deps: IngesterDeps;

  constructor(deps: IngesterDeps) {
    this.deps = deps;
  }

  /**
   * One intake pass over every configured tracker. Returns tasks created.
   *
   * Commits once at the end rather than per item: a pass that ingests five issues should
   * be one push, and the state repo's history should read as intake events rather than
   * as individual file writes.
   */
  async ingest(remote: string, branch: string): Promise<IntakePass> {
    const { store, trackers, logger } = this.deps;
    const schedules = await this.validateSchedules();
    let created = 0;
    let seen = 0;
    let rejected = 0;
    let failed = 0;
    let changed = false;

    for (const [workspace, tracker] of trackers) {
      let items: readonly TrackerItem[];
      try {
        items = await tracker.listAgentItems();
      } catch (error) {
        // One unreachable tracker must not stop the others, and must not stop the
        // supervisor: intake is best-effort, the state repo is authoritative, and a task
        // already in `tasks/` is unaffected by a tracker being down.
        logger.warn("intake.tracker-failed", {
          workspace,
          tracker: tracker.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
        continue;
      }

      seen += items.length;
      // Published even when it is zero, and that is the point of the gauge: a workspace
      // whose backlog has just been drained must report 0 rather than keep the number it
      // had when it last had work.
      this.deps.metrics?.items(workspace, items.length);

      for (const item of items) {
        const outcome = await this.ingestItem(workspace, tracker, item);
        this.deps.metrics?.observe(workspace, outcome);
        if (outcome === "created") created += 1;
        if (outcome === "rejected") rejected += 1;
        if (outcome !== "skipped") changed = true;
      }
    }

    if (changed) {
      await store.commitAndPush(
        created > 0 ? `chore(intake): ingest ${created} task(s)` : "chore(intake): record refusals",
        remote,
        branch,
      );
    }
    return { seen, created, rejected, failed, ...schedules };
  }

  /**
   * Read every schedule and report the ones that are not (DESIGN.md §22).
   *
   * HERE rather than in the firing pass, because the two answer to different audiences. The
   * firing pass runs at 09:00 with nobody watching and can only skip what it cannot parse;
   * intake runs on a timer whose whole output is a report, and the moment a schedule becomes
   * malformed is the commit that made it so — which is when somebody is looking.
   *
   * It creates nothing and refuses nothing durably. There is no tracker item to comment on
   * and no author to tell: a schedule is committed by an operator, so the report goes where
   * an operator looks, which is this runner's log and the `/intake` page.
   *
   * Never throws. A state repo whose `schedules/` cannot be read must not stop the tracker
   * pass that is the rest of this method.
   */
  private async validateSchedules(): Promise<{
    readonly schedules: number;
    readonly schedulesInvalid: number;
  }> {
    try {
      const listing = await this.deps.store.listSchedules();
      for (const error of listing.errors) {
        // At WARN and once per pass. An operator who has just committed a broken schedule
        // gets a line naming the file and the field; a fleet that has been carrying one for
        // a week gets one line per interval per runner, which is the same rate intake
        // already logs its own pass at.
        this.deps.logger.warn("intake.schedule-invalid", {
          schedule: error.schedule,
          reason: error.message,
        });
      }
      return {
        schedules: listing.schedules.length,
        schedulesInvalid: listing.errors.length,
      };
    } catch (error) {
      this.deps.logger.warn("intake.schedules-unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { schedules: 0, schedulesInvalid: 0 };
    }
  }

  /**
   * A refusal for an item whose repos the workspace's credential cannot reach, or
   * undefined — which also covers "the forge could not be asked".
   *
   * Those two are the same answer on purpose. Intake is best-effort and runs unattended
   * every five minutes; a `/installation/repositories` behind a 500 is not evidence that an
   * App was uninstalled, and turning it into one would comment a refusal onto every open
   * item in the backlog and suppress it durably (§14.2). A repo that is genuinely
   * unreachable is refused on the next pass instead.
   */
  private async unreachableReason(
    workspace: WorkspaceName,
    repos: readonly RepoRef[],
  ): Promise<string | undefined> {
    const reach = this.deps.forges?.get(workspace);
    if (reach === undefined) return undefined;

    try {
      const unreachable = await reach.unreachable(repos);
      if (unreachable.length === 0) return undefined;
      return (
        `${unreachableSummary(unreachable)}\n\nFix the \`repos\` list, or install the ` +
        `App on the repository, and the next intake pass will pick this up.`
      );
    } catch (error) {
      this.deps.logger.warn("intake.reach-unknown", {
        workspace,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * A refusal for an item whose declared toolchain cannot be produced, or undefined —
   * which also covers "the check could not run".
   *
   * Those two are one answer for the same reason they are in `unreachableReason`: a nix
   * that is absent, timed out, or could not fetch the pin has learnt nothing about the
   * package name. Turning that into a refusal on a runner without nix would comment on
   * every item in the backlog that declares a toolchain, and suppress each one durably
   * (§14.2) — so the fleet's most careful items would be the ones it rejected.
   */
  private async toolchainReason(
    declared: ToolchainSpec | undefined,
  ): Promise<string | undefined> {
    const doctor = this.deps.toolchainDoctor;
    if (doctor === undefined || declared === undefined) return undefined;

    try {
      return await doctor.fault(declared);
    } catch (error) {
      this.deps.logger.warn("intake.toolchain-unknown", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Record a refusal, and comment on the item ONCE.
   *
   * Extracted because there are now two reasons an item cannot become a task — its body
   * (`renderSpec`) and its repos (`unreachableReason`) — and both must be suppressed the
   * same way. `listAgentItems` filters on the label alone, so an un-suppressed refusal
   * comments on every pass forever (§14.2).
   */
  private async refuse(
    workspace: WorkspaceName,
    tracker: Tracker,
    item: TrackerItem,
    reason: string,
  ): Promise<IntakeOutcome> {
    const { store, logger } = this.deps;
    const id = taskIdFor(item.ref);
    const digest = digestOf(item);

    const previous = await store.readIntakeRejection(id);
    if (previous?.digest === digest) {
      // Already refused, and the human has not touched it since. Say nothing.
      logger.debug("intake.still-rejected", { task: id, url: item.url });
      return "skipped";
    }

    logger.warn("intake.rejected", { task: id, tracker: tracker.kind, url: item.url, reason });
    // `url`, `title` and `workspace` are written alongside the suppression key so the
    // `/intake` page can link to the item being refused. The DIGEST is unchanged by
    // their presence — it covers the item's title and body, not the record — so a
    // record written before these fields existed still suppresses, and the first poll
    // after this build ships does not re-comment on every open refusal.
    await store.writeIntakeRejection(id, {
      digest,
      reason,
      url: item.url,
      title: item.title,
      workspace,
    });

    // The record is written BEFORE the comment. If commenting fails, the refusal is
    // still suppressed next pass — a human who has to be told twice is a smaller
    // problem than a tracker item accumulating one comment per poll forever.
    try {
      await tracker.comment(
        item.ref,
        `This item is labelled for the agent but cannot be turned into a task yet.\n\n${reason}`,
      );
    } catch (error) {
      logger.warn("intake.comment-failed", {
        task: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return "rejected";
  }

  private async ingestItem(
    workspace: WorkspaceName,
    tracker: Tracker,
    item: TrackerItem,
  ): Promise<IntakeOutcome> {
    const { store, logger } = this.deps;
    const id = taskIdFor(item.ref);

    if (await store.hasTask(id)) {
      logger.debug("intake.exists", { task: id, tracker: tracker.kind });
      return "skipped";
    }

    const self = selfRepo(item.ref);
    const scope = this.deps.scopes.get(workspace);
    if (scope === undefined) {
      // Refusing beats guessing. A workspace with a tracker but no forge profile is a
      // misconfiguration, and inventing a permissive scope would turn it into a leak.
      logger.warn("intake.no-scope", { task: id, workspace, tracker: tracker.kind });
      return "skipped";
    }

    const rendered: IngestResult = item.authorTrusted
      ? renderSpec(item, {
          workspace,
          scope,
          ...(self !== undefined ? { defaultRepo: self } : {}),
        })
      : {
          kind: "rejected",
          // Deliberately NOT the `agent` block template. The template is instructions for
          // making this body executable, and handing them to an author we have just
          // declined to trust is the one comment that turns a refusal into a tutorial.
          // The person who needs to act is the maintainer who applied the label.
          reason:
            "The author of this item does not have write access to this repository, so " +
            "its body is not run as a task. An `agent` block's `acceptance` list is " +
            "executed as shell on the runner, and the body can be edited by its author " +
            "after the label is applied — so the label alone cannot authorise it.\n\n" +
            "If this work should go to the agent, a maintainer should open it as their " +
            "own item, referencing this one.",
        };

    if (rendered.kind === "rejected") {
      return this.refuse(workspace, tracker, item, rendered.reason);
    }

    // The item is executable; the question left is whether the repos it names are ones this
    // workspace's credential can reach at all (§9.1.1). Refused through the SAME path as any
    // other intake refusal — recorded, suppressed, commented once — because "this repo does
    // not exist" is exactly as much a thing the author has to fix as a missing `acceptance`.
    const unreachable = await this.unreachableReason(workspace, rendered.spec.repos);
    if (unreachable !== undefined) {
      return this.refuse(workspace, tracker, item, unreachable);
    }

    // And whether the environment it asks for can be produced at all (§8.1). Same door,
    // same refusal path: a typo'd nixpkgs attribute is as much the author's to fix as a
    // repo that does not exist, and discovering it here costs a comment instead of the
    // session it used to cost.
    const badToolchain = await this.toolchainReason(rendered.spec.toolchain);
    if (badToolchain !== undefined) {
      return this.refuse(workspace, tracker, item, badToolchain);
    }

    const now = new Date().toISOString();
    const state: TaskState = {
      id,
      status: "ready",
      phase: "planning",
      requires: rendered.spec.requires,
      sessions: 0,
      limits: { maxSessions: this.deps.maxSessionsPerTask },
      usage: EMPTY_USAGE,
      progress: { lastProgressSession: 0, noProgressStreak: 0 },
      createdAt: now,
      updatedAt: now,
    };

    // ORDER IS LOAD-BEARING: state first, spec last. `hasTask` keys on `spec.md`, so the
    // spec is the completion marker — a crash between the two writes leaves a task the
    // claim loop skips (it reads the spec and gives up) and that the NEXT intake pass
    // recreates cleanly, because `hasTask` is still false and `writeSpec` has nothing to
    // refuse. Writing the spec first would wedge the item: permanently "existing", never
    // claimable.
    await store.writeState(state);
    await store.writeSpec(rendered.spec);
    await store.clearIntakeRejection(id);

    logger.info("intake.created", {
      task: id,
      workspace,
      tracker: tracker.kind,
      url: item.url,
      repos: rendered.spec.repos.map((r) => `${r.host}/${r.owner}/${r.name}`).join(","),
      acceptance: rendered.spec.acceptance.length,
    });
    return "created";
  }
}
