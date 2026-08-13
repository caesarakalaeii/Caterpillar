/**
 * Verifies a Discord webhook end to end, by posting a real message to the real channel.
 *
 *   DISCORD_WEBHOOK_URL=... npm run verify:discord
 *   DISCORD_WEBHOOK_URL=... npm run verify:discord -- --kind question
 *
 * This is the only way to prove the outbound half works before a task depends on it:
 * everything short of a live POST is a stub agreeing with itself. It leaves one message
 * in the channel — that message IS the result.
 *
 * The webhook URL comes from the environment, never argv: its last path segment is the
 * credential, and argv is visible to every process on the box. Nothing here prints it,
 * including on failure — the id is echoed, the token never is.
 *
 * In-cluster, where the secret is already mounted:
 *
 *   DISCORD_WEBHOOK_URL=$(cat /etc/caterpillar/secrets/caterpillar-discord/webhook-url) \
 *     node dist/cli/verify-discord.js
 */
import { asTaskId } from "../domain/task.ts";
import {
  CONTENT_LIMIT,
  DiscordNotifier,
  DiscordWebhookError,
  type Notification,
  render,
} from "../notify/discord.ts";

const ENV = "DISCORD_WEBHOOK_URL";

const TASK = asTaskId("VERIFY");

const SAMPLES: Readonly<Record<string, Notification>> = {
  parked: { kind: "parked", task: TASK, reason: "webhook verification, not a real park" },
  question: {
    kind: "question",
    task: TASK,
    phase: "implementing",
    question: "This is a webhook verification. No answer is expected.",
  },
  done: { kind: "done", task: TASK, prUrl: "https://example.invalid/pr/0" },
  failed: { kind: "failed", task: TASK, error: "webhook verification, not a real failure" },
};

/** `https://discord.com/api/webhooks/<id>/<token>` — the id is safe to print, the token is not. */
const webhookId = (url: string): string => {
  const segments = new URL(url).pathname.split("/").filter((part) => part.length > 0);
  return segments.at(-2) ?? "unknown";
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--kind");
  const kind = (index < 0 ? undefined : argv[index + 1]) ?? "parked";

  const notification = SAMPLES[kind];
  if (notification === undefined) {
    throw new Error(`unknown --kind '${kind}' — one of ${Object.keys(SAMPLES).join(", ")}`);
  }

  const webhookUrl = process.env[ENV] ?? "";
  if (webhookUrl.length === 0) throw new Error(`set ${ENV} in the environment`);
  console.log(`✓ webhook found in ${ENV} — id ${webhookId(webhookUrl)}`);

  // Printed before sending, so a message that renders wrong is caught here rather than
  // by reading the channel afterwards.
  const content = render(notification);
  console.log(`\n--- ${[...content].length} of ${CONTENT_LIMIT} code points ---\n${content}\n---\n`);

  await new DiscordNotifier({ webhookUrl }).notify(notification);
  console.log(`✓ posted — check the channel; the message above should be in it verbatim`);
  console.log(
    "\nNot verified here: mention suppression and truncation, which are unit-tested " +
      "because provoking them live means pinging a real server and posting 2000 characters.",
  );
};

main().catch((error: unknown) => {
  if (error instanceof DiscordWebhookError) {
    console.error(`✗ ${error.message}`);
    if (error.status === 401 || error.status === 404) {
      console.error(
        "  A 404 is a webhook that no longer exists — deleted in the channel's " +
          "Integrations settings, or a URL that was never right. Re-create it and " +
          "re-seal the secret; retrying will not help.",
      );
    }
    process.exitCode = 1;
    return;
  }
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
