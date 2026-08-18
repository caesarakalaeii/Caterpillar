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
 *   "proxy" — the in-cluster proxy from §9.6, authenticated with a token that is
 *     not a provider credential. Keeps the spend cap and lets an off-cluster runner
 *     hold nothing.
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
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config/types.ts";

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
const proxiedModel = (config: LlmConfig): Model<"anthropic-messages"> => ({
  id: config.modelId,
  name: config.modelId,
  api: "anthropic-messages",
  provider: config.providerId,
  baseUrl: config.baseUrl,
  reasoning: true,
  input: ["text", "image"],
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
}

/** Register the configured provider and resolve the model. */
export const createLlmRuntime = (options: LlmRuntimeOptions): LlmRuntime => {
  const { config } = options;

  const models =
    options.credentials === undefined
      ? createModels()
      : createModels({ credentials: options.credentials });

  if (config.auth === "subscription") {
    // pi's own provider, which carries both the OAuth ("Claude Pro/Max") and
    // api-key modes. We do not rebuild it: the OAuth flow, the token refresh, and
    // the model table all live there and are the whole reason this works.
    models.setProvider(anthropicProvider());

    const model = models.getModel(ANTHROPIC_PROVIDER_ID, config.modelId);
    if (model === undefined) {
      throw new ModelNotFoundError(ANTHROPIC_PROVIDER_ID, config.modelId);
    }
    return { models, model };
  }

  models.setProvider(
    createProvider<"anthropic-messages">({
      id: config.providerId,
      name: "caterpillar llm proxy",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("LLM proxy token", [PROXY_TOKEN_ENV]) },
      models: [proxiedModel(config)],
      api: anthropicMessagesApi(),
    }),
  );

  const model = models.getModel(config.providerId, config.modelId);
  if (model === undefined) throw new ModelNotFoundError(config.providerId, config.modelId);

  return { models, model };
};
