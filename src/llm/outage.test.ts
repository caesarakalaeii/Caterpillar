/**
 * The classifier, pinned against the exact strings pi hands us.
 *
 * Every message here is either one this supervisor actually received or one copied
 * from the provider's documented error shapes. That is the point: the classifier reads
 * prose, so a test written from memory would pin the wrong prose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProviderFailure } from "./outage.ts";

/** The message that ended five sessions in nine seconds on 2026-08-15. */
const SPEND_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request ' +
  'would exceed your account\'s monthly spend limit. Please try again later."},' +
  '"request_id":"req_011Ce4QadMncfV9FFP8Rt7Pf"}';

test("the monthly spend limit is exhaustion, not a burst rate limit", () => {
  const outage = classifyProviderFailure(SPEND_LIMIT);

  assert.equal(outage?.kind, "exhausted");
  assert.equal(outage?.status, 429);
  assert.match(outage?.detail ?? "", /monthly spend limit/);
});

test("a subscription usage limit is exhaustion too", () => {
  const outage = classifyProviderFailure(
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have ' +
      'reached your usage limit for this 5 hour window."}}',
  );

  assert.equal(outage?.kind, "exhausted");
});

test("a low credit balance is exhaustion even though it arrives as a 400", () => {
  const outage = classifyProviderFailure(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your ' +
      'credit balance is too low to access the Anthropic API."}}',
  );

  assert.equal(outage?.kind, "exhausted");
});

test("a per-minute burst limit is a rate limit, which clears on its own", () => {
  const outage = classifyProviderFailure(
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of ' +
      'request tokens has exceeded your per-minute rate limit."}}',
  );

  assert.equal(outage?.kind, "rate-limited");
});

test("a retry delay the client refused to wait out carries the delay it was asked for", () => {
  const outage = classifyProviderFailure(
    `Server requested 3600s retry delay (max: 60s). ${SPEND_LIMIT}`,
  );

  // The provider named a wait, so the runner has no reason to guess one.
  assert.equal(outage?.retryAfterMs, 3_600_000);
  // ...and the reason underneath still decides what kind of outage it is.
  assert.equal(outage?.kind, "exhausted");
});

test("5xx and overloaded are the provider, not the account", () => {
  assert.equal(
    classifyProviderFailure(
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    )?.kind,
    "unavailable",
  );
  assert.equal(
    classifyProviderFailure('500 {"type":"error","error":{"type":"api_error"}}')?.kind,
    "unavailable",
  );
});

test("an expired or rejected credential is its own kind — waiting will not fix it", () => {
  const outage = classifyProviderFailure(
    '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth ' +
      'token has expired."}}',
  );

  assert.equal(outage?.kind, "unauthorised");
});

test("a dropped connection is an outage, with no status to read", () => {
  for (const message of ["fetch failed", "Connection error.", "Request timed out."]) {
    assert.equal(classifyProviderFailure(message)?.kind, "network", message);
  }
});

test("a context-length refusal is the TASK's problem and must not read as an outage", () => {
  // Backing the runner off for this would hide a real bug behind a cooldown, and the
  // task would fail again identically an hour later.
  assert.equal(
    classifyProviderFailure(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt ' +
        'is too long: 250000 tokens > 200000 maximum"}}',
    ),
    undefined,
  );
});

test("an unknown model id is a misconfiguration, not an outage", () => {
  // Anthropic's shape: a 404 with "model: <id>" in a not_found_error. The id is
  // wrong in config, and a cooldown would hide the bug and reproduce it on retry.
  assert.equal(
    classifyProviderFailure(
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: ' +
        'claude-nope"}}',
    ),
    undefined,
  );
});

test("the coding gateway retiring an alias mid-run is an outage, not a misconfiguration", () => {
  // The runner resolved the model id at boot; a later swap means every running
  // task hits 404 "unknown alias". Backing off stops the stampede and a pod
  // restart re-runs discovery. Distinguished from the Anthropic shape above by
  // the gateway's own wording, which is all the classifier has to go on.
  const outage = classifyProviderFailure(
    '404: {"message":"unknown alias","type":"invalid_request_error"}',
  );

  assert.equal(outage?.kind, "model-retired");
  assert.equal(outage?.status, 404);
  assert.equal(outage?.detail, "unknown alias");
});

/** pi's openai-completions path composes `"<status>: <body>"` — captured against a stub
 * server driven through createLlmRuntime with scheme "openai-completions", not written
 * from memory. */
const GATEWAY_BUSY =
  '429: {"message":"Model is at capacity, reserved for production load",' +
  '"type":"rate_limit_error","code":429}';

test("the coding gateway's capacity 429 is a rate limit, in the colon shape", () => {
  // The gateway serves hobby traffic only when production load allows, so this is the
  // intended steady state, not an incident: cooldown and retry, task untouched.
  const outage = classifyProviderFailure(GATEWAY_BUSY);

  assert.equal(outage?.kind, "rate-limited");
  assert.equal(outage?.status, 429);
  assert.match(outage?.detail ?? "", /reserved for production load/);
});

test("a rejected key from the gateway is unauthorised, in the colon shape too", () => {
  const outage = classifyProviderFailure(
    '401: {"message":"Invalid API key","type":"invalid_request_error"}',
  );

  assert.equal(outage?.kind, "unauthorised");
  assert.equal(outage?.status, 401);
  assert.equal(outage?.detail, "Invalid API key");
});

test("the flat openai body is read for detail without the nested error wrapper", () => {
  const outage = classifyProviderFailure(GATEWAY_BUSY);

  assert.equal(
    outage?.detail,
    "Model is at capacity, reserved for production load",
    "flat message wins over the raw body",
  );
});

test("anything that is not a provider error at all classifies as nothing", () => {
  assert.equal(classifyProviderFailure("Agent is already processing."), undefined);
  assert.equal(classifyProviderFailure(""), undefined);
});
