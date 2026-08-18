/**
 * Log in to Anthropic with a Claude Pro/Max subscription and persist the credential.
 *
 *   npm run llm:login -- --out ./auth.json
 *
 * Run this on a machine with a browser, then copy the file onto the runner's PVC at
 * `llm.credentialsPath`. The pod cannot do it: pi's OAuth flow opens a browser or
 * prints a device code, and neither has anywhere to go inside a Deployment.
 *
 * The file it writes contains a live refresh token. It must land on WRITABLE storage —
 * pi rotates the refresh token on every refresh, so a read-only mount (a Kubernetes
 * Secret, most obviously) locks the supervisor out as soon as the access token
 * expires, about an hour in.
 *
 *   npm run llm:login -- --out ./auth.json --status   # inspect, print no secrets
 */
import { createInterface } from "node:readline/promises";
import { createModels, type AuthEvent, type AuthPrompt } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { FileCredentialStore } from "../llm/credentials.ts";
import { ANTHROPIC_PROVIDER_ID } from "../llm/models.ts";

const arg = (flag: string): string | undefined => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};

const has = (flag: string): boolean => process.argv.slice(2).includes(flag);

/** Renders pi's login events. Deliberately prints no token material. */
const notify = (event: AuthEvent): void => {
  switch (event.type) {
    case "info":
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`  ${link.label ?? "link"}: ${link.url}`);
      return;
    case "auth_url":
      console.log(`\nOpen this URL to authorise:\n\n  ${event.url}\n`);
      if (event.instructions !== undefined) console.log(event.instructions);
      return;
    case "device_code":
      console.log(`\nGo to ${event.verificationUri} and enter code: ${event.userCode}\n`);
      return;
    case "progress":
      console.log(`… ${event.message}`);
      return;
  }
};

const main = async (): Promise<void> => {
  const out = arg("--out");
  if (out === undefined) {
    throw new Error("usage: --out <path/to/auth.json> [--status]");
  }

  const store = new FileCredentialStore(out);

  if (has("--status")) {
    const stored = await store.list();
    if (stored.length === 0) {
      console.log(`no credential stored in ${out}`);
      return;
    }
    for (const info of stored) console.log(`${info.providerId}: ${info.type}`);
    return;
  }

  const models = createModels({ credentials: store });
  models.setProvider(anthropicProvider());

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const credential = await models.login(ANTHROPIC_PROVIDER_ID, "oauth", {
      notify,
      prompt: async (prompt: AuthPrompt) => {
        // Everything pi asks for here is a code to paste back, not a secret to
        // protect — but it is still never echoed anywhere beyond this terminal.
        const answer = await rl.question(`${prompt.message}: `);
        return answer.trim();
      },
    });

    console.log(`\n✓ logged in — stored a '${credential.type}' credential in ${out}`);
    console.log(
      `\nCopy it to the runner's llm.credentialsPath on WRITABLE storage (the PVC):\n` +
        `  kubectl -n caterpillar cp ${out} <pod>:/work/credentials/anthropic.json\n\n` +
        `Do NOT put it in a Secret. Refreshing rotates the token, and a read-only\n` +
        `mount locks the supervisor out about an hour later.`,
    );
  } finally {
    rl.close();
  }
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
