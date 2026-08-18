/**
 * Publishing the slash-command set. See DESIGN.md §7.1.
 *
 * Registration used to be a deploy-time step run by hand, for one good reason: a write per
 * pod per rollout, all of them identical. The supervisor restarts on every deploy and there
 * are four of it, so a naive `main()` call meant four identical PUTs per rollout — and the
 * step being manual meant `/brainstorm`'s `repo:` box could ship as code and still be a
 * plain text field in Discord, which is precisely what happened.
 *
 * The objection was about redundant writes, not about who does it. So this keeps the
 * property and drops the chore: the command set is registered **once per change, across the
 * whole fleet, ever**, claimed on a ref keyed by a DIGEST of the commands themselves.
 *
 *   - the ref's existence IS the record that this exact set has been published, so a
 *     restart re-registers nothing and there is no state to keep in memory
 *   - a changed command set is a changed digest, so the next boot after a deploy publishes
 *     it and the ones after that do not
 *   - a claim that ERRORS is not a claim someone else won — a rejected push is also what a
 *     dead network looks like, and reading it as a win would mark a set registered that
 *     nobody registered (the §19 lesson, in the §19 shape)
 *   - a failed WRITE hands the claim back, because a claimed-but-unregistered set is
 *     invisible and nothing would ever revisit it
 *
 * `npm run discord:register` stays, and stays unconditional. It is the escape hatch for the
 * case a digest cannot see: commands edited or deleted in Discord itself, where the ref says
 * "published" and the guild disagrees.
 */
import { createHash } from "node:crypto";
import type { Logger } from "../obs/log.ts";
import { errorFields } from "../obs/log.ts";
import { API_BASE } from "./bot.ts";
import { postJson, type FetchLike } from "./http.ts";
import { COMMANDS } from "./slash.ts";

/** The claim protocol, narrowed to what registering needs from `LeaseManager`. */
export interface CommandClaim {
  claimOnce(ref: string, message: string): Promise<string | undefined>;
  hasRef(ref: string): Promise<boolean>;
  releaseRef(ref: string, oid: string): Promise<void>;
}

export type RegistrationOutcome = "registered" | "already" | "skipped" | "failed";

export interface RegisterOptions {
  /** Both optional secrets: without them there is nothing to register, and that is fine. */
  readonly applicationId?: string;
  readonly guildId?: string;
  readonly token: string;
  readonly claims: CommandClaim;
  readonly runner: string;
  readonly logger: Logger;
  /** Defaults to the real `COMMANDS`. Overridden only by tests. */
  readonly commands?: readonly Record<string, unknown>[];
  readonly fetch?: FetchLike;
}

/**
 * The identity of a command set, as published to one guild.
 *
 * Over the commands AND the guild: the same array published to a test guild and to the real
 * one are two registrations, and a shared digest would let the first suppress the second.
 *
 * `JSON.stringify` of the literal is stable because the literal is — key order is source
 * order, and every value in it is a primitive or an array of them. A digest that reordered
 * itself would re-register on every boot, which is the failure this is guarding against.
 */
export const commandsDigest = (
  guildId: string,
  commands: readonly Record<string, unknown>[] = COMMANDS,
): string => createHash("sha256").update(`${guildId}\n${JSON.stringify(commands)}`).digest("hex");

/** Never deleted once the set it names has been published. */
export const commandsRef = (digest: string): string => `refs/commands/${digest.slice(0, 32)}`;

/**
 * PUT the command set. A full REPLACE: this array becomes the entire surface, so a command
 * removed from it disappears from the client.
 *
 * Shared by the CLI and the runner so there is exactly one thing that writes commands.
 */
export const putCommands = async (options: {
  readonly applicationId: string;
  readonly guildId: string;
  readonly token: string;
  readonly commands: readonly Record<string, unknown>[];
  readonly fetch?: FetchLike;
}): Promise<readonly string[]> => {
  const response = await postJson({
    url: `${API_BASE}/applications/${options.applicationId}/guilds/${options.guildId}/commands`,
    method: "PUT",
    body: JSON.stringify(options.commands),
    what: "command registration",
    headers: { authorization: `Bot ${options.token}` },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  // The names Discord echoed, for the CLI to print. Parsed defensively: the registration
  // succeeded either way, and a body we cannot read is not a failure to report as one.
  const body = (await response.json().catch(() => [])) as readonly { readonly name?: string }[];
  return Array.isArray(body) ? body.flatMap((command) => (command.name === undefined ? [] : [command.name])) : [];
};

/**
 * Register the command set if this exact set has never been registered for this guild.
 *
 * Never throws: a runner must boot with a bridge that works even when Discord refuses the
 * registration — `!answer` and the buttons do not depend on it, and a 403 here is an invite
 * missing the `applications.commands` scope, which no amount of retrying fixes.
 */
export const registerCommandsOnce = async (
  options: RegisterOptions,
): Promise<RegistrationOutcome> => {
  const { applicationId, guildId, claims, logger, runner } = options;
  const commands = options.commands ?? COMMANDS;

  if (applicationId === undefined || guildId === undefined) {
    logger.info("commands.not-registered", {
      reason: "no application-id and guild-id",
    });
    return "skipped";
  }

  const digest = commandsDigest(guildId, commands);
  const ref = commandsRef(digest);

  const oid = await claims
    .claimOnce(ref, `commands ${digest.slice(0, 12)} runner=${runner}`)
    .catch(() => undefined);

  if (oid === undefined) {
    // A failed CAS cannot tell a lost race from a dead network. Only the ref answers it,
    // and answering it wrong marks a command set published that nobody published.
    const taken = await claims.hasRef(ref).catch(() => false);
    if (taken) {
      logger.debug("commands.already-registered", { ref });
      return "already";
    }
    logger.warn("commands.claim-failed", { ref });
    return "failed";
  }

  try {
    await putCommands({ applicationId, guildId, token: options.token, commands, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    logger.info("commands.registered", { guild: guildId, commands: commands.length, ref });
    return "registered";
  } catch (error) {
    // Hand it back. The next boot — or another replica — has to be able to try again, and
    // a set that is claimed but not published would otherwise never be revisited.
    await claims.releaseRef(ref, oid).catch(() => undefined);
    logger.error("commands.failed", { guild: guildId, ...errorFields(error) });
    return "failed";
  }
};
