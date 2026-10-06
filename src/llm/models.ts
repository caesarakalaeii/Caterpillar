/**
 * LLM provider wiring. See DESIGN.md §9.6.
 *
 * Two auth modes, chosen per runner:
 *
 *   "subscription" — pi-ai's own Anthropic provider using its OAuth mode
 *     ("Anthropic (Claude Pro/Max)", `isSubscription: true`). The credential is a
 *     rotating refresh token held in a FileCredentialStore on durable storage; pi
 *     refreshes it inside `CredentialStore.modify`. This talks to api.anthropic.com
 *     DIRECTLY — an OAuth bearer credential cannot be routed through a proxy that
 *     authenticates with `x-api-key`, so there is no proxy in this path.
 *
 *   "proxy" — the endpoint named by `llm.baseUrl` holds the provider credential,
 *     authenticated with a token that is not a provider credential. `llm.scheme`
 *     selects its wire API: `anthropic-messages` (the original, `x-api-key`) or
 *     `openai-completions`, which is what vLLM serves — an OpenAI-compatible
 *     `/v1/chat/completions` that authenticates with `Authorization: Bearer`.
 *     Keeps the spend cap and lets an off-cluster runner hold nothing.
 *
 * The modes are not exclusive at runtime. pi resolves "a stored credential owns the
 * provider; ambient env is consulted only when nothing is stored", so a subscription
 * runner can keep ANTHROPIC_API_KEY in its environment as a fallback and it is used
 * only if the stored credential is gone.
 *
 * Swapping providers stays a config change, which is why this is built on pi-ai's
 * provider abstraction rather than a vendor SDK (DESIGN.md §2.1).
 */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { LlmConfig } from "../config/types.ts";
import { SILENT_LOGGER, type Logger } from "../obs/log.ts";
import { listGatewayModels, modelsUrl } from "./discover.ts";

/** Env var carrying the proxy's own token — not a provider credential. */
export const PROXY_TOKEN_ENV = "LLM_PROXY_TOKEN";

/** pi-ai's own provider id. The stored credential is keyed by it. */
export const ANTHROPIC_PROVIDER_ID = "anthropic";

export class ModelNotFoundError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`model '${modelId}' is not registered for provider '${providerId}'`);
    this.name = "ModelNotFoundError";
  }
}

export class SubscriptionNotLoggedInError extends Error {
  constructor(path: string) {
    super(
      `no Anthropic subscription credential in ${path} — run 'npm run llm:login' on a ` +
        `machine with a browser and copy the file onto the runner's storage. It must ` +
        `stay WRITABLE: refreshing rotates the token, so a read-only mount locks the ` +
        `supervisor out once the access token expires`,
    );
    this.name = "SubscriptionNotLoggedInError";
  }
}

/**
 * Model descriptor for the proxied model.
 *
 * Costs are zeroed deliberately: the proxy is the authority on spend, and carrying
 * a stale local price table would make `usage.cost` quietly wrong. Token counts
 * remain exact, so the handoff trigger is unaffected.
 */
const proxiedModel = (config: LlmConfig, modelId: string): Model<"anthropic-messages" | "openai-completions"> => ({
  id: modelId,
  name: modelId,
  api: config.scheme ?? "anthropic-messages",
  provider: config.providerId,
  baseUrl: config.baseUrl,
  // Thinking survives either scheme: pi maps `reasoning: true` to the provider's own
  // convention, and the openai-completions API reads vLLM's `reasoning_content`.
  reasoning: true,
  // Text by default, not the old hardcoded ["text", "image"]: whether a proxied
  // endpoint takes images is a property of the MODEL behind it, and the coding
  // gateway reports supports_vision: false for the alias. Advertising image input
  // the endpoint refuses turns a task's screenshot into an unactionable provider
  // error; a config that knows its endpoint takes images can say so.
  input: config.imageInput ? ["text", "image"] : ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: config.contextWindow,
  maxTokens: config.maxTokens,
});

export interface LlmRuntime {
  readonly models: MutableModels;
  readonly model: Model<Api>;
}

export interface LlmRuntimeOptions {
  readonly config: LlmConfig;
  /**
   * Required for `auth: "subscription"` — where the rotating OAuth credential is
   * read and written. Omit for proxy mode, which holds no rotating credential.
   */
  readonly credentials?: CredentialStore;
  /** Injectable for tests, and for the boot warnings discovery writes. */
  readonly logger?: Logger;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. Defaults to `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Register the configured provider and resolve the model. */
export const createLlmRuntime = async (options: LlmRuntimeOptions): Promise<LlmRuntime> => {
  const { config, logger = SILENT_LOGGER } = options;

  const models =
    options.credentials === undefined
      ? createModels()
      : createModels({ credentials: options.credentials });

  if (config.auth === "subscription") {
    // pi's own provider, which carries both the OAuth ("Claude Pro/Max") and
    // api-key modes. We do not rebuild it: the OAuth flow, the token refresh, and
    // the model table all live there and are the whole reason this works.
    models.setProvider(anthropicProvider());

    // The loader refuses a subscription config without a model id, so this only
    // fires for a runtime built in code, never for a loaded config.
    const pinnedId = config.modelId;
    if (pinnedId === undefined) {
      throw new ModelNotFoundError(ANTHROPIC_PROVIDER_ID, "(no llm.modelId)");
    }
    const model = models.getModel(ANTHROPIC_PROVIDER_ID, pinnedId);
    if (model === undefined) {
      throw new ModelNotFoundError(ANTHROPIC_PROVIDER_ID, pinnedId);
    }
    return { models, model };
  }

  const modelId = await resolveProxiedModelId(config, logger, options.fetch, options.sleep);

  models.setProvider(
    createProvider({
      id: config.providerId,
      name: "caterpillar llm proxy",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("LLM proxy token", [PROXY_TOKEN_ENV]) },
      models: [proxiedModel(config, modelId)],
      // Bearer vs. x-api-key is the API's business, not the auth helper's: the
      // anthropic-messages API stamps the key as `x-api-key`, the openai-completions
      // API hands it to the OpenAI client, which sends `Authorization: Bearer`.
      api: {
        "anthropic-messages": anthropicMessagesApi(),
        "openai-completions": openAICompletionsApi(),
      },
    }),
  );

  const model = models.getModel(config.providerId, modelId);
  if (model === undefined) throw new ModelNotFoundError(config.providerId, modelId);

  return { models, model };
};

/**
 * Which model id the proxied endpoint serves.
 *
 * The config's `modelId` is a pin, not a requirement. While the gateway still lists
 * it, the pin wins — an operator who named a model meant that model, and discovery
 * must not silently upgrade them. Once the pin no longer matches, or was never set,
 * the gateway's own answer decides, deterministically: one id is used as found,
 * several are settled by lexicographic order with a warning, none is a hard error.
 */
const resolveProxiedModelId = async (
  config: LlmConfig,
  logger: Logger,
  http?: typeof fetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<string> => {
  const pin = config.modelId;
  const token = process.env[PROXY_TOKEN_ENV];

  let ids: readonly string[];
  try {
    ids = await listGatewayModels({
      baseUrl: config.baseUrl,
      ...(token === undefined ? {} : { token }),
      ...(http === undefined ? {} : { fetch: http }),
      ...(sleep === undefined ? {} : { sleep }),
    });
  } catch (error) {
    if (pin === undefined) throw error;
    // The gateway may still serve the pinned model even when its list endpoint does
    // not answer: discovery is a boot-time convenience, and refusing to boot over it
    // would trade a working endpoint for a tidy startup log.
    logger.warn("llm.model-discovery-failed", {
      url: modelsUrl(config.baseUrl),
      pinned: pin,
    });
    return pin;
  }

  if (pin !== undefined && ids.includes(pin)) return pin;

  if (pin !== undefined) {
    logger.warn("llm.model-pin-stale", {
      pinned: pin,
      served: ids.join(", "),
    });
  }

  if (ids.length === 0) {
    throw new Error(
      `model discovery found no models at ${modelsUrl(config.baseUrl)}` +
        (pin === undefined ? "" : ` — the pinned '${pin}' is not among them`) +
        "; set llm.modelId to a model the endpoint actually serves",
    );
  }

  // Lexicographic order makes an ambiguous list deterministic rather than a
  // coin flip of gateway response order. The warning names the whole list so
  // the operator can pin one id and silence it.
  const [smallest] = [...ids].sort();
  const modelId = smallest ?? "";
  if (ids.length > 1) {
    logger.warn("llm.model-discovery-ambiguous", {
      url: modelsUrl(config.baseUrl),
      served: ids.join(", "),
      chosen: modelId,
    });
  }
  return modelId;
};
