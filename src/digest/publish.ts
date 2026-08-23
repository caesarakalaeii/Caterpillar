/**
 * Deciding that a day is over, and saying so exactly once. See DESIGN.md §19.
 *
 * Every runner in a fleet reaches 18:00 at the same instant and every one of them can read
 * the whole state repo, so "publish the digest" is a race by construction. It is settled
 * the way task claiming is (§5): `refs/digests/<date>` is created by a compare-and-swap
 * against an empty expected value, which exactly one push in the fleet can win. Nothing
 * renews it and nothing steals it — a published day does not become unpublished.
 *
 * The failure this is shaped around is the asymmetric one. Publishing twice is
 * embarrassing and visible. A day that is MARKED published and never was is silent: the
 * ref says done, no message arrives, and nobody finds out until they go looking for a
 * digest that never existed. So the claim is taken first and released again whenever
 * publishing failed, and the ordering inside is git before Discord — the durable copy is
 * written before anything announces it, and a Discord outage never rewrites the record.
 *
 * It runs on the housekeeping loop, so it is deliberately cheap and deliberately bounded:
 * one digest per pass, and nothing at all before the hour. Being on housekeeping rather
 * than the work loop is what stops a long session from swallowing the day's digest
 * entirely (§6.4).
 */
import type { Notification, Notifier } from "../notify/discord.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import type { Git } from "../state/git.ts";
import type { AttributionReport, FleetIdentity } from "./attribution.ts";
import {
  collectDay,
  type AuthorshipReader,
  type ChangeReader,
  type DayDigest,
} from "./collect.ts";
import { dueWindows, type DayBoundary, type DigestWindow } from "./day.ts";
import { renderDigest, summaryLine } from "./render.ts";
import type { Summariser } from "./summarise.ts";

/** The marker ref for one day. Never deleted once its digest is published. */
export const digestRef = (date: string): string => `refs/digests/${date}`;

/** The two writes a digest makes to the state repo. */
export interface DigestStore {
  writeDigest(date: string, body: string): Promise<void>;
  commitAndPush(message: string, remote: string, branch: string): Promise<void>;
}

/** The claim protocol, narrowed to what publishing needs from `LeaseManager`. */
export interface DigestClaim {
  claimOnce(ref: string, message: string): Promise<string | undefined>;
  hasRef(ref: string): Promise<boolean>;
  releaseRef(ref: string, oid: string): Promise<void>;
}

export interface DailyDigestOptions {
  /** Bound to the state repo checkout. Read for history, written through `store`. */
  readonly git: Git;
  readonly store: DigestStore;
  readonly leases: DigestClaim;
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly boundary: DayBoundary;
  readonly runner: string;
  readonly branch: string;
  /** Reads the code a task produced, when this runner holds the mirror. */
  readonly changes?: ChangeReader;
  /** Reads who authored the window's commits. Absent means no authorship section. */
  readonly authorship?: AuthorshipReader;
  /** The fleet's commit identity (§9.7), so authorship can tell it from a person's. */
  readonly identity?: FleetIdentity;
  /** Counts the window's authorship. Called only for a day that was actually published. */
  readonly onAttributed?: (report: AttributionReport) => void;
  /** Writes the prose. Absent means a facts-only digest, which is a complete one. */
  readonly summariser?: Summariser;
  /** Counts published digests, by outcome. */
  readonly onPublished?: (date: string, quiet: boolean) => void;
}

/**
 * Days this process has already settled, so a published evening does not cost an
 * `ls-remote` every thirty seconds until midnight.
 *
 * In memory, and that is the correct scope: it is an optimisation over a check that is
 * already authoritative on the remote. A restarted pod re-checks and finds the ref.
 */
const REMEMBERED_DAYS = 8;

export class DailyDigest {
  private readonly options: DailyDigestOptions;

  private readonly settled = new Set<string>();

  constructor(options: DailyDigestOptions) {
    this.options = options;
  }

  /**
   * Publish at most one due digest. Never throws.
   *
   * At most one: publishing two back to back costs two model calls and two pushes on a
   * poll that should be claiming a task, and the second is still due thirty seconds later.
   * Oldest first, so a runner that missed yesterday's cutoff does not leave the channel
   * reading backwards.
   */
  async maybePublish(now: Date, signal?: AbortSignal): Promise<void> {
    for (const window of dueWindows(now, this.options.boundary)) {
      if (signal?.aborted === true) return;
      if (this.settled.has(window.date)) continue;

      // Only a day that turned out to belong to another runner lets this poll move on to
      // the next one. Publishing stops here by design, and so does failing: whatever
      // broke — the push, the collector — will break identically on the following day,
      // and trying it costs a second failure and a second released claim to learn nothing.
      if ((await this.attempt(window, signal)) !== "elsewhere") return;
    }
  }

  private async attempt(
    window: DigestWindow,
    signal?: AbortSignal,
  ): Promise<"published" | "elsewhere" | "failed"> {
    const { leases, logger, runner } = this.options;
    const ref = digestRef(window.date);

    const oid = await leases
      .claimOnce(ref, `digest ${window.date} runner=${runner}`)
      .catch(() => undefined);

    if (oid === undefined) {
      // A failed CAS cannot distinguish a lost race from a dead network — both are a
      // rejected push. Only the ref's existence answers it, and getting this backwards
      // would mark a day published that nobody has published.
      const taken = await leases.hasRef(ref).catch(() => false);
      if (taken) {
        this.remember(window.date);
        logger.debug("digest.claimed-elsewhere", { date: window.date });
        return "elsewhere";
      }
      logger.warn("digest.claim-failed", { date: window.date });
      return "failed";
    }

    try {
      await this.publish(window, signal);
      this.remember(window.date);
      return "published";
    } catch (error) {
      // Hand the day back. A claimed-but-unpublished day is invisible, and the next poll —
      // or another runner — must be able to try again.
      await leases.releaseRef(ref, oid).catch(() => undefined);
      logger.error("digest.failed", { date: window.date, ...errorFields(error) });
      return "failed";
    }
  }

  private async publish(window: DigestWindow, signal?: AbortSignal): Promise<void> {
    const { git, store, logger, boundary, runner, branch, changes, authorship, identity } =
      this.options;

    const digest = await collectDay({
      git,
      window,
      ...(changes === undefined ? {} : { changes }),
      ...(authorship === undefined ? {} : { authorship }),
      ...(identity === undefined ? {} : { identity }),
    });

    const summary = await this.narrate(digest, signal);

    // Aborted while the paragraph was being written: hand the day back rather than push
    // half of it as the process is being torn down. The claim is released by the caller's
    // catch and the next boot publishes the day whole — including the prose this call was
    // interrupted in the middle of.
    if (signal?.aborted === true) {
      throw new Error("the runner is shutting down; this day is left for the next poll");
    }

    const body = renderDigest({
      digest,
      timeZone: boundary.timeZone,
      runner,
      ...summary,
    });

    // Git first, Discord second, and never the other way round: the state repo is the
    // record and the channel is a view of it (§11.2). Announcing something that then
    // failed to commit would leave a message pointing at a file that does not exist.
    await store.writeDigest(window.date, body);
    await store.commitAndPush(`chore(digest): ${window.date}`, "origin", branch);

    logger.info("digest.published", {
      date: window.date,
      tasks: digest.totals.tasksTouched,
      sessions: digest.totals.sessions,
      costUsd: digest.totals.costUsd,
      quiet: digest.quiet,
    });
    this.options.onPublished?.(window.date, digest.quiet);
    // After the push, like `onPublished` and for its reason: these are counters of what was
    // published, and a day whose commit failed was not.
    if (digest.attribution !== undefined) this.options.onAttributed?.(digest.attribution);

    await this.announce(digest, body);
  }

  /**
   * The prose, when there is a summariser and there is something to describe.
   *
   * A quiet day is not worth a model call: the document already says nothing moved, and
   * spending tokens to have that said again in a sentence is the kind of cost that is
   * invisible per day and obvious per month.
   */
  private async narrate(
    digest: DayDigest,
    signal?: AbortSignal,
  ): Promise<{ narrative?: string; narrativeError?: string }> {
    const { summariser } = this.options;
    if (summariser === undefined || digest.quiet) return {};

    const summary = await summariser.summarise(digest, signal);
    return {
      ...(summary.narrative === undefined ? {} : { narrative: summary.narrative }),
      ...(summary.error === undefined ? {} : { narrativeError: summary.error }),
    };
  }

  /**
   * Announce it, and never let that failure reach the caller.
   *
   * Same rule as every other notification (§11.2): delivery must not undo the work it
   * describes. Here it is stronger than usual — a throw would release a claim whose digest
   * is already committed and pushed, and the retry would publish the same day twice.
   */
  private async announce(digest: DayDigest, body: string): Promise<void> {
    const notification: Notification = {
      kind: "digest",
      date: digest.date,
      summary: summaryLine(digest),
      body,
    };

    await this.options.notifier.notify(notification).catch((error: unknown) => {
      this.options.logger.warn("digest.notify-failed", {
        date: digest.date,
        ...errorFields(error),
      });
    });
  }

  private remember(date: string): void {
    this.settled.add(date);
    // Insertion-ordered, so the oldest goes first. Nothing here needs history — the ref on
    // the remote is the authority, and this only exists to avoid asking it every poll.
    for (const stale of [...this.settled].slice(0, -REMEMBERED_DAYS)) this.settled.delete(stale);
  }
}
