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
  type TrackerRef,
  type WorkspaceName,
} from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { StateStore } from "../state/store.ts";
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

/** What one pass did. Reported so an idle intake is distinguishable from a broken one. */
export interface IntakePass {
  /** Items the trackers returned, before any were skipped or refused. */
  readonly seen: number;
  readonly created: number;
  readonly rejected: number;
  /** Trackers that could not be listed at all. */
  readonly failed: number;
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
      for (const item of items) {
        const outcome = await this.ingestItem(workspace, tracker, item);
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
    return { seen, created, rejected, failed };
  }

  private async ingestItem(
    workspace: WorkspaceName,
    tracker: Tracker,
    item: TrackerItem,
  ): Promise<"created" | "rejected" | "skipped"> {
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
      const digest = digestOf(item);
      const previous = await store.readIntakeRejection(id);
      if (previous?.digest === digest) {
        // Already refused, and the human has not touched it since. Say nothing.
        logger.debug("intake.still-rejected", { task: id, url: item.url });
        return "skipped";
      }

      logger.warn("intake.rejected", {
        task: id,
        tracker: tracker.kind,
        url: item.url,
        reason: rendered.reason,
      });
      await store.writeIntakeRejection(id, { digest, reason: rendered.reason });

      // The record is written BEFORE the comment. If commenting fails, the refusal is
      // still suppressed next pass — a human who has to be told twice is a smaller
      // problem than a tracker item accumulating one comment per poll forever.
      try {
        await tracker.comment(
          item.ref,
          `This item is labelled for the agent but cannot be turned into a task yet.\n\n${rendered.reason}`,
        );
      } catch (error) {
        logger.warn("intake.comment-failed", {
          task: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return "rejected";
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
