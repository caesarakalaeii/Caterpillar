/**
 * Which process owns the Discord gateway. See DESIGN.md §7.
 *
 * Its own module, away from `index.ts`, for one reason: `index.ts` calls `main()` at the
 * bottom, so importing it from a test boots a supervisor. This decision is the hinge of
 * the whole split — get it wrong in either direction and either two processes act on one
 * channel or nobody does — and a hinge that cannot be tested without booting a runner does
 * not get tested, which is precisely how it shipped unwired the first time.
 */
import type { Logger } from "../obs/log.ts";
import type { RunnerConfig } from "./types.ts";

/**
 * Whether a SEPARATE process owns the Discord gateway, and the interlock that decides it.
 *
 * `bot.mode` alone is not enough to stand down, and the second condition is the whole
 * reason this is a function rather than a field read. Redis is the ONLY way the two
 * processes reach each other: a supervisor that has stopped listening to Discord while no
 * plane connects it to the bot is a fleet that silently answers nobody, produced by a
 * one-line config mistake. So `external` without `redis.enabled` is treated as the typo it
 * almost certainly is — logged at WARN, naming both halves, and behaving as `in-process`.
 *
 * Deliberately loud rather than fatal. Refusing to start would turn a Discord
 * misconfiguration into a runner that does no work at all, and the work is the part that
 * matters; a supervisor that keeps polling while shouting about its bot is strictly better
 * than one that does neither. The bot process makes the opposite call for the same reason
 * (`bot.ts` throws without Redis) — there, holding the connection IS the entire job, so a
 * bot that cannot reach the supervisor has nothing left to be right about.
 */
export const externalBot = (config: RunnerConfig, logger: Logger): boolean => {
  if (config.bot.mode !== "external") return false;
  if (config.redis.enabled) return true;

  logger.warn("bot.mode-ignored", {
    mode: config.bot.mode,
    reason:
      'bot.mode is "external" but redis.enabled is false — the two processes would have no ' +
      "way to reach each other, so this supervisor keeps the gateway itself",
  });
  return false;
};
