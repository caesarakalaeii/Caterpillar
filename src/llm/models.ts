/**
 * LLM provider wiring. See DESIGN.md §9.6.
 *
 * The supervisor never holds a provider credential. It points pi-ai at the
 * in-cluster proxy, which owns the real credential and enforces the global spend
 * cap. Off-cluster runners therefore store nothing.
 *
 * Swapping to a private provider later is a change to `LlmConfig` plus the proxy's
 * own configuration — no code here changes, which is the whole point of routing
 * through pi-ai's provider abstraction rather than an SDK.
 */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config/types.ts";

/** Env var carrying the proxy's own token — not a provider credential. */
export const PROXY_TOKEN_ENV = "LLM_PROXY_TOKEN";

export class ModelNotFoundError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`model '${modelId}' is not registered for provider '${providerId}'`);
    this.name = "ModelNotFoundError";
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

/** Register the proxy as a pi-ai provider and resolve the configured model. */
export const createLlmRuntime = (config: LlmConfig): LlmRuntime => {
  const models = createModels();

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
