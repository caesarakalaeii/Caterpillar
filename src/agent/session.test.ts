/**
 * What a session does with a failure pi refuses to throw.
 *
 * `Agent.prompt()` resolves normally when a provider request fails: the failure is
 * recorded as an assistant message with `stopReason: "error"` and an `errorMessage`,
 * and the loop simply stops. A `try/catch` around `prompt()` therefore sees nothing,
 * which is how a 429 came to be reported as "session ended without a control-plane
 * decision" — indistinguishable from a model that finished talking.
 *
 * These tests exist so that can never be true again. Real git and real tools are not
 * needed for it: the question is only what `runSession` makes of the transcript.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ContextBudget } from "./limits.ts";
import { runSession } from "./session.ts";

/** Verbatim from `tasks/BS-…-01/sessions/005.jsonl.gz` in the state repo. */
const SPEND_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request ' +
  'would exceed your account\'s monthly spend limit. Please try again later."},' +
  '"request_id":"req_011Ce4QadMncfV9FFP8Rt7Pf"}';

const run = async (responses: readonly ReturnType<typeof fauxAssistantMessage>[]) => {
  const faux = fauxProvider({ models: [{ id: "faux-model", contextWindow: 200_000, maxTokens: 4096 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  // The faux provider is typed over an open `string` api; the runtime shape is
  // identical to a real model, so this narrowing is safe and confined to the test.
  const model = faux.getModel() as unknown as Model<Api>;

  return runSession({
    models,
    model,
    systemPrompt: "system",
    initialPrompt: "do the thing",
    tools: [],
    budget: new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 }),
    control: {},
  });
};

test("a spend limit is a provider outage, not a handoff", async () => {
  const result = await run([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: SPEND_LIMIT }),
  ]);

  assert.equal(result.outcome.reason, "provider-unavailable");
  assert.equal(result.outcome.outage?.kind, "exhausted");
  assert.equal(result.outcome.outage?.status, 429);
  assert.match(result.outcome.summary, /monthly spend limit/);
});

test("a failure the provider did not cause stays an error the task owns", async () => {
  const result = await run([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt ' +
        'is too long: 250000 tokens > 200000 maximum"}}',
    }),
  ]);

  assert.equal(result.outcome.reason, "error");
  assert.equal(result.outcome.outage, undefined);
  assert.match(result.outcome.error ?? "", /prompt is too long/);
});

test("a session that simply stops talking is still a handoff", async () => {
  const result = await run([fauxAssistantMessage("I have nothing else to add.")]);

  assert.equal(result.outcome.reason, "handoff");
});
