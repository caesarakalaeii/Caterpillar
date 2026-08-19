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
import { SlotSteering } from "./steering.ts";

/** Verbatim from `tasks/BS-…-01/sessions/005.jsonl.gz` in the state repo. */
const SPEND_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request ' +
  'would exceed your account\'s monthly spend limit. Please try again later."},' +
  '"request_id":"req_011Ce4QadMncfV9FFP8Rt7Pf"}';

const run = async (
  responses: readonly ReturnType<typeof fauxAssistantMessage>[],
  signal?: AbortSignal,
  steering?: SlotSteering,
) => {
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
    // Generous: every test using this helper is about what a session MAKES of a
    // transcript, and a ceiling those hit would be a flake rather than a finding. The one
    // test that is about the ceiling builds its own session below.
    timeoutSeconds: 3600,
    ...(signal === undefined ? {} : { signal }),
    ...(steering === undefined ? {} : { steering }),
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

test("a signal aborted before the session starts spends no request", async () => {
  // `SessionOptions.signal` was declared and read nowhere, so nothing could stop a
  // session: not a pod shutdown, not a lost lease, not `/cancel`, not a wall clock.
  const result = await run([fauxAssistantMessage("hello")], AbortSignal.abort());

  assert.equal(result.outcome.reason, "interrupted");
  assert.equal(result.messages.length, 0, "the provider must not have been called");
});

test("an interruption is not recorded as a session failure", async () => {
  // The distinction that matters: `error` is terminal and `/resume` refuses it, so
  // classifying a pod restart as an error would demand a human for a deploy — and count
  // it against the no-progress streak on the way.
  const controller = new AbortController();
  controller.abort();

  const result = await run([fauxAssistantMessage("hello")], controller.signal);

  assert.equal(result.outcome.reason, "interrupted");
  assert.equal(result.outcome.error, undefined);
  assert.match(result.outcome.summary, /stopped from outside/);
});

test("a session whose provider never answers is stopped by its own wall clock", async () => {
  // The defect this pins, observed in the cluster: the supervisor armed a deadline around
  // the AGENT's session only. `ReviewCouncil`, `PlanMaintainer` and `LlmSummariser` all
  // run sessions too, and all three called `runSession` with no signal at all — so a
  // provider request that never returned wedged the whole single-threaded runner. One
  // did: 7h20m inside `council.start`, zero restarts, the poll loop and the chat drain
  // frozen behind it, /healthz answering 200 the entire time.
  //
  // The ceiling therefore belongs to `runSession` rather than to whoever calls it. A
  // caller may add a signal of its own; it cannot take this away, and — because the
  // field is required — the next call site cannot quietly omit it.
  const faux = fauxProvider({ models: [{ id: "faux-model", contextWindow: 200_000, maxTokens: 4096 }] });
  const models = createModels();
  models.setProvider(faux.provider);

  // A request that hangs until it is aborted, which is what a real one does. Resolving
  // it on abort rather than leaving it pending is the honest model: an HTTP request that
  // is cancelled unwinds, it does not vanish.
  faux.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        const keepalive = setInterval(() => {}, 1_000);
        const settle = (): void => {
          clearInterval(keepalive);
          resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
        };
        if (options?.signal?.aborted === true) settle();
        else options?.signal?.addEventListener("abort", settle, { once: true });
      }),
  ]);

  const started = Date.now();
  const result = await runSession({
    models,
    model: faux.getModel() as unknown as Model<Api>,
    systemPrompt: "system",
    initialPrompt: "review the change",
    tools: [],
    budget: new ContextBudget({ contextWindow: 200_000, thresholdFraction: 0.7 }),
    control: {},
    timeoutSeconds: 0.25,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome.reason, "interrupted", "the wall clock must stop it");
  assert.ok(elapsed >= 200, `it must not stop before its ceiling (${elapsed}ms)`);
  assert.ok(elapsed < 15_000, `nor run on past it (${elapsed}ms)`);
});

test("a steer typed before the session starts reaches the transcript", async () => {
  // The backlog path: a previous session was interrupted between the message arriving and
  // the turn boundary that would have read it. The session replacing it is the one that
  // should act on it, so `take()` is drained into pi's queue before the first request.
  const steering = new SlotSteering();
  steering.push("use the existing migration path");

  const result = await run(
    [fauxAssistantMessage("looking"), fauxAssistantMessage("adjusted")],
    undefined,
    steering,
  );

  const users = result.messages.filter((m) => m.role === "user");
  assert.equal(users.length, 2, "the steer should be a second user message, not a lost one");
  assert.match(
    JSON.stringify(users[1]),
    /use the existing migration path/,
    "the operator's own words have to survive the framing",
  );
});

test("a steer is attributed to the operator, never left to read as the agent's own note", async () => {
  const steering = new SlotSteering();
  steering.push("drop the third task");

  const result = await run(
    [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
    undefined,
    steering,
  );

  const steered = result.messages.filter((m) => m.role === "user").at(-1);
  assert.match(JSON.stringify(steered), /Message from the operator/);
});

test("the feed is unsubscribed when the session ends", async () => {
  // The feed belongs to the SLOT and outlives the session. A listener left behind delivers
  // the next human sentence into an `Agent` that has already finished, which loses it.
  const steering = new SlotSteering();
  await run([fauxAssistantMessage("done")], undefined, steering);

  steering.push("after the session");
  assert.deepEqual(
    steering.take(),
    ["after the session"],
    "a message arriving after the session must be buffered for the next one",
  );
});

test("a session with no feed runs exactly as it did", async () => {
  const result = await run([fauxAssistantMessage("done")]);
  assert.equal(result.messages.filter((m) => m.role === "user").length, 1);
});
