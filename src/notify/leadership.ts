/**
 * Which replica of the fleet acts on Discord. See DESIGN.md §7.
 *
 * Every replica connects to the gateway — that is what keeps the bot online across a
 * rollout, and a connection costs nothing — but exactly one may act on what arrives over
 * it. Four that all acted opened four threads for one `/brainstorm`, because a
 * brainstorm's id is derived from the thread Discord has just created for it, and turned
 * one `!answer` into four runners writing the same state repo.
 *
 * The claim is a git ref won by the same compare-and-swap that claims a task (§5), for
 * the same reason the daily digest's is (§19): the state repo is the only thing the fleet
 * shares, so it is the only place a fleet-wide decision can be made. No new coordination
 * mechanism, and nothing to run when there is one replica.
 *
 * Refreshed from the poll loop rather than on a timer of its own. The loop already runs
 * on the interval this wants, and a timer would keep renewing the claim while a session
 * blocked the loop — advertising a holder that cannot currently answer anything.
 */
import type { RunnerId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";

/** `refs/chat/holder` — one per fleet, not per task or per day. */
export const CHAT_HOLDER_REF = "refs/chat/holder";

/** What leadership needs from `LeaseManager`, narrowed to one method. */
export interface StealableClaims {
  claimStealable(ref: string, message: string, held?: string): Promise<string | undefined>;
}

export interface ChatLeadershipOptions {
  readonly claims: StealableClaims;
  readonly runner: RunnerId;
  readonly logger: Logger;
}

export class ChatLeadership {
  private readonly options: ChatLeadershipOptions;
  /** The oid this replica believes it wrote, or undefined when it holds nothing. */
  private oid: string | undefined;

  constructor(options: ChatLeadershipOptions) {
    this.options = options;
  }

  /** Read synchronously, on every inbound Discord event. Never does IO. */
  held(): boolean {
    return this.oid !== undefined;
  }

  /**
   * Take the claim, or renew it, or discover it has been taken away.
   *
   * Failure is never fatal and never throws: a runner that cannot reach the remote must
   * keep working its task, and the honest reading of "I could not renew" is "I am not the
   * holder" — so it steps down rather than acting on a claim it cannot prove.
   */
  async refresh(): Promise<void> {
    const { claims, runner, logger } = this.options;
    const message = `chat holder: ${runner}`;

    try {
      const next =
        this.oid === undefined
          ? await claims.claimStealable(CHAT_HOLDER_REF, message)
          : await claims.claimStealable(CHAT_HOLDER_REF, message, this.oid);

      if (next === undefined) {
        // Losing it is worth a line; not having it is not. Three replicas out of four are
        // in the second case on every poll, forever.
        if (this.oid !== undefined) logger.warn("chat.stepped-down", { runner });
        this.oid = undefined;
        return;
      }

      if (this.oid === undefined) logger.info("chat.holder", { runner });
      this.oid = next;
    } catch (error) {
      if (this.oid !== undefined) {
        logger.warn("chat.stepped-down", {
          runner,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.oid = undefined;
    }
  }
}
