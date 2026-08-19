/**
 * Registers the slash commands with Discord.
 *
 *   npm run discord:register                       # reads the mounted secret
 *   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... \
 *     npm run discord:register
 *
 * A runner NOW registers the set itself at boot, once per change across the whole fleet
 * (`notify/register.ts`) — the objection this file used to record was about redundant
 * writes, and a digest-keyed claim answers it without making a human remember the step.
 *
 * This remains, and remains UNCONDITIONAL: it is the escape hatch for what a digest cannot
 * see. Commands edited or deleted in Discord itself leave the ref saying "published" and the
 * guild disagreeing, and this is what fixes that. It is also how a command set is iterated
 * on against a test guild from a workstation, without a pod or a state repo.
 *
 * Registration is a full REPLACE: the array in `slash.ts` becomes the entire command set,
 * so a command deleted from it disappears from the client. That is what makes this
 * idempotent — running it twice is a no-op rather than a duplicate.
 *
 * GUILD-scoped, not global. Guild commands appear instantly; global ones propagate
 * eventually and cannot be iterated on. There is one guild.
 *
 * Two things this cannot fix if they are wrong:
 *   - the bot must have been invited with the `applications.commands` scope. An invite
 *     built with `scope=bot` alone joins the guild and registers nothing, and the failure
 *     is a 403 that reads like a bad token.
 *   - the application id is the BOT USER's id, which is not the same as anything printed
 *     by the gateway.
 */
import { SecretBundle } from "../secrets/load.ts";
import { DiscordHttpError } from "../notify/http.ts";
import { putCommands } from "../notify/register.ts";
import { COMMANDS } from "../notify/slash.ts";

const SECRETS_DIR = process.env["SECRETS_DIR"] ?? "/etc/caterpillar/secrets";

/**
 * Read a value from the environment, falling back to the mounted secret.
 *
 * The environment comes first so this is runnable from a workstation against a test
 * guild without a secret mount, which is where a command set is actually iterated on.
 */
const resolve = async (env: string, key: string): Promise<string> => {
  const fromEnv = process.env[env];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const value = await new SecretBundle(SECRETS_DIR, "caterpillar-discord")
    .readOptional(key)
    .catch(() => undefined);
  if (value === undefined || value.length === 0) {
    throw new Error(`set ${env} in the environment, or seal \`${key}\` into caterpillar-discord`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const token = await resolve("DISCORD_BOT_TOKEN", "bot-token");
  const applicationId = await resolve("DISCORD_APPLICATION_ID", "application-id");
  const guildId = await resolve("DISCORD_GUILD_ID", "guild-id");

  console.log(`✓ registering ${COMMANDS.length} command(s) in guild ${guildId}`);
  for (const command of COMMANDS) {
    console.log(`  /${String(command["name"])} — ${String(command["description"])}`);
  }

  const registered = await putCommands({ applicationId, guildId, token, commands: COMMANDS });
  console.log(
    `✓ Discord accepted ${registered.length} command(s): ${registered
      .map((name) => `/${name}`)
      .join(" ")}`,
  );
  console.log("\nGuild commands take effect immediately — try one in the channel now.");
};

main().catch((error: unknown) => {
  if (error instanceof DiscordHttpError) {
    console.error(`✗ ${error.message}`);
    if (error.status === 403) {
      console.error(
        "  A 403 here is almost always the missing `applications.commands` scope: the " +
          "bot was invited with `scope=bot` alone. Re-invite with " +
          "`scope=bot+applications.commands` — the guild membership it already has is " +
          "kept, and no restart is needed.",
      );
    }
    if (error.status === 401) {
      console.error("  A 401 is the bot token. A 404 would be the application id.");
    }
    process.exitCode = 1;
    return;
  }
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
