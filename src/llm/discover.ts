/**
 * Boot-time model discovery against an OpenAI-compatible gateway.
 *
 * `GET <root>/v1/models` is the one endpoint every OpenAI-compatible server answers,
 * with a bearer token or without one. Reading the model id from it means an upstream
 * model swap is a gateway change, not a config edit and rollout on every runner. This
 * module only speaks HTTP and parses; the pin/fallback rules live in models.ts, which
 * owns the config and the logging.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** `GET <root>/v1/models`, where `<root>` is the base URL without its wire-path `/v1`. */
export const modelsUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/v1\/?$/, "")}/v1/models`;

export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

export interface GatewayModelsOptions {
  /** The proxied endpoint's base URL. Any trailing `/v1` is stripped. */
  readonly baseUrl: string;
  /** Bearer token, when the deployment has one. Absent means the endpoint is open. */
  readonly token?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. Defaults to `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Attempts after the first, for 5xx and network errors. Same discipline as session.ts. */
const MAX_DISCOVERY_RETRIES = 2;

/** Base delay between retries, doubled per attempt. */
const RETRY_BASE_MS = 1_000;

const isModelEntry = (entry: unknown): entry is { readonly id: string } =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  typeof entry.id === "string";

/**
 * Whether a failure is worth retrying. A 5xx is the gateway being temporarily down
 * or overloaded; a network error is a transient DNS or connection fault. A 4xx is a
 * request problem that retrying will reproduce identically.
 */
const retryable = (status: number | undefined): boolean =>
  status === undefined || status >= 500;

/** Ask the gateway which model ids it currently serves. */
export const listGatewayModels = async (
  options: GatewayModelsOptions,
): Promise<readonly string[]> => {
  const url = modelsUrl(options.baseUrl);
  const http = options.fetch ?? fetch;
  const wait = options.sleep ?? ((ms: number) => sleep(ms));
  let lastError: ModelDiscoveryError | undefined;
  for (let attempt = 0; attempt <= MAX_DISCOVERY_RETRIES; attempt++) {
    if (attempt > 0) await wait(RETRY_BASE_MS * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await http(url, {
        headers: {
          accept: "application/json",
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
      });
    } catch (cause) {
      lastError = new ModelDiscoveryError(
        `model discovery failed: GET ${url} could not be reached ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
      // A network fault may clear; retry if attempts remain.
      continue;
    }

    if (!response.ok) {
      lastError = new ModelDiscoveryError(
        `model discovery failed: GET ${url} answered ${response.status} ${response.statusText}`,
      );
      // A 5xx may clear; a 4xx will not. Retry only the transient kind.
      if (retryable(response.status)) continue;
      throw lastError;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ModelDiscoveryError(
        `model discovery failed: GET ${url} did not answer with JSON ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }

    const data: unknown =
      typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
    if (!Array.isArray(data)) {
      throw new ModelDiscoveryError(
        `model discovery failed: GET ${url} answered something that is not a model list`,
      );
    }

    const entries: readonly unknown[] = data;
    const ids: string[] = [];
    for (const entry of entries) {
      if (isModelEntry(entry)) ids.push(entry.id);
    }
    return ids;
  }

  // All retries exhausted. The last error is the most informative; if none was set
  // (the loop fell through without a catch), something is deeply wrong.
  throw lastError ?? new ModelDiscoveryError(`model discovery failed: GET ${url}`);
};
