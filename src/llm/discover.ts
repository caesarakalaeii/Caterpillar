/**
 * Boot-time model discovery against an OpenAI-compatible gateway.
 *
 * `GET <root>/v1/models` is the one endpoint every OpenAI-compatible server answers,
 * with a bearer token or without one. Reading the model id from it means an upstream
 * model swap is a gateway change, not a config edit and rollout on every runner. This
 * module only speaks HTTP and parses; the pin/fallback rules live in models.ts, which
 * owns the config and the logging.
 */

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
}

const isModelEntry = (entry: unknown): entry is { readonly id: string } =>
  typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string";

/** Ask the gateway which model ids it currently serves. */
export const listGatewayModels = async (
  options: GatewayModelsOptions,
): Promise<readonly string[]> => {
  const url = modelsUrl(options.baseUrl);
  const http = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await http(url, {
      headers: {
        accept: "application/json",
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
    });
  } catch (cause) {
    throw new ModelDiscoveryError(
      `model discovery failed: GET ${url} could not be reached ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (!response.ok) {
    throw new ModelDiscoveryError(
      `model discovery failed: GET ${url} answered ${response.status} ${response.statusText}`,
    );
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
};
