/**
 * Entrypoint for the credential holder pod. See DESIGN.md §9.6.
 *
 *   npm run llm:holder
 *
 * Same image as the supervisor, different command — so the nix that seeds a store, the pi
 * that refreshes a token and the code that serves it are all built and rolled together. A
 * second image would let the holder's pi drift from the runners' pi, and the thing that
 * would break is a token format nobody is watching.
 *
 * It reads the SAME config file the supervisor reads, and takes only `llm` from it. That
 * is not tidiness: `llm.credentialsPath`, `llm.modelId` and `llm.providerId` have to agree
 * between the two or the holder refreshes a credential nobody asked for, and one ConfigMap
 * is how they are made to agree.
 *
 * Environment:
 *   CONFIG_PATH             — as the supervisor (default /etc/caterpillar/config/config.json)
 *   LLM_CREDENTIAL_TOKEN    — shared bearer token. Absent = unauthenticated, and warned about.
 *   CREDENTIAL_HOLDER_PORT  — listen port, default 8081.
 */
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { loadConfig } from "../config/load.ts";
import { JsonLogger } from "../obs/log.ts";
import { FileCredentialStore } from "../llm/credentials.ts";
import { createCredentialHolder, HOLDER_TOKEN_ENV } from "../llm/credential-holder.ts";

const DEFAULT_PORT = 8081;

const main = async (): Promise<void> => {
  const config = await loadConfig(
    process.env["CONFIG_PATH"] ?? "/etc/caterpillar/config/config.json",
  );
  const logger = new JsonLogger({ level: config.log.level });

  const path = config.llm.credentialsPath;
  if (path === undefined) {
    // Refused rather than defaulted. A holder with nowhere durable to write is a holder
    // that loses the fleet's credential on its first restart, and it would look healthy.
    throw new Error(
      "llm.credentialsPath is required to run the credential holder — it is the single " +
        "durable copy of the fleet's credential and must be on this pod's own writable volume",
    );
  }

  const store = new FileCredentialStore(path);

  // `getAuth` on this runtime is the entire refresh mechanism (see credential-holder.ts).
  // The provider is pi's own, so the OAuth flow, the rotation and the token format are
  // the ones the supervisor already depends on.
  const models = createModels({ credentials: store });
  models.setProvider(anthropicProvider());

  const token = process.env[HOLDER_TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    logger.warn("credential.no-token", {
      detail:
        `${HOLDER_TOKEN_ENV} is not set — any pod that can reach this Service can read ` +
        `the fleet's Anthropic credential`,
    });
  }

  const port = Number(process.env["CREDENTIAL_HOLDER_PORT"] ?? DEFAULT_PORT);
  const server = createCredentialHolder({
    models,
    store,
    ...(token === undefined || token.length === 0 ? {} : { token }),
    logger,
  });

  // Bind on all interfaces: a ClusterIP Service reaches the pod on its pod IP, and
  // binding loopback would answer the probe and refuse every runner.
  server.listen(port, () => {
    logger.info("credential.listening", { port, credentialsPath: path });
  });

  // SIGTERM is how Kubernetes asks; without this the pod waits out its grace period on
  // every roll, which turns a 2-second restart into 30.
  const stop = (): void => {
    logger.info("credential.stopping");
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
