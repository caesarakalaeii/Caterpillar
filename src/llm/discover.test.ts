/**
 * The four contract rules, driven through `createLlmRuntime` with a stubbed list
 * endpoint (see local://llm-discovery-contract.md's resolution semantics): pin wins
 * while valid, a stale pin falls back with a warning, an ambiguous list settles
 * lexicographically with a warning, and a failed list fetch keeps a pin but errors
 * without one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmConfig } from "../config/types.ts";
import { SILENT_LOGGER, type LogFields, type Logger } from "../obs/log.ts";
import { createLlmRuntime } from "./models.ts";

const config = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  auth: "proxy",
  baseUrl: "https://gateway.invalid/v1",
  providerId: "p",
  contextWindow: 200_000,
  maxTokens: 32_000,
  cooldown: { initialSeconds: 60, maxSeconds: 1800 },
  ...over,
});

interface Warning {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

/** A logger that keeps only warnings — discovery's fallback paths are all warnings. */
const warningLogger = (): { logger: Logger; warnings: Warning[] } => {
  const warnings: Warning[] = [];
  return {
    logger: { ...SILENT_LOGGER, warn: (event, fields) => void warnings.push({ event, fields }) },
    warnings,
  };
};

const gateway = (ids: readonly string[]): typeof fetch => async () =>
  new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const unreachable: typeof fetch = async () => {
  throw new Error("ECONNREFUSED");
};

test("a pin the gateway still lists wins without a warning", async () => {
  const { logger, warnings } = warningLogger();
  const runtime = await createLlmRuntime({
    config: config({ modelId: "beta" }),
    logger,
    fetch: gateway(["alpha", "beta", "gamma"]),
  });

  assert.equal(runtime.model.id, "beta");
  assert.deepEqual(warnings, []);
});

test("a pin the gateway no longer lists falls back, naming the pin and the list", async () => {
  const { logger, warnings } = warningLogger();
  const runtime = await createLlmRuntime({
    config: config({ modelId: "retired" }),
    logger,
    fetch: gateway(["solo"]),
  });

  assert.equal(runtime.model.id, "solo");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.event, "llm.model-pin-stale");
  assert.equal(warnings[0]?.fields?.pinned, "retired");
  assert.equal(warnings[0]?.fields?.served, "solo");
});

test("an ambiguous list settles lexicographically, with a warning", async () => {
  const { logger, warnings } = warningLogger();
  const runtime = await createLlmRuntime({
    config: config(),
    logger,
    fetch: gateway(["zeta", "alpha", "mid"]),
  });

  assert.equal(runtime.model.id, "alpha");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.event, "llm.model-discovery-ambiguous");
  assert.equal(warnings[0]?.fields?.served, "zeta, alpha, mid");
  assert.equal(warnings[0]?.fields?.chosen, "alpha");
});

test("a failed list fetch keeps a set pin and warns", async () => {
  const { logger, warnings } = warningLogger();
  const runtime = await createLlmRuntime({
    config: config({ modelId: "pinned" }),
    logger,
    fetch: unreachable,
  });

  assert.equal(runtime.model.id, "pinned");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.event, "llm.model-discovery-failed");
  assert.equal(warnings[0]?.fields?.pinned, "pinned");
  assert.equal(warnings[0]?.fields?.url, "https://gateway.invalid/v1/models");
});

test("a failed list fetch with no pin refuses to boot, naming the URL tried", async () => {
  await assert.rejects(
    () => createLlmRuntime({ config: config(), fetch: unreachable }),
    (error: unknown) => error instanceof Error && /https:\/\/gateway\.invalid\/v1\/models/.test(error.message),
  );
});

test("an empty list is an error even though the endpoint answered", async () => {
  await assert.rejects(() => createLlmRuntime({ config: config(), fetch: gateway([]) }), /no models/);
});

test("the discovery request reaches the stripped /v1/models URL, with a bearer only when set", async () => {
  const urls: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const recording: typeof fetch = async (input, init) => {
    urls.push(String(input));
    const headers = new Headers(init?.headers);
    authorizations.push(headers.get("authorization") ?? undefined);
    return gateway(["m"])(input, init);
  };

  await createLlmRuntime({ config: config({ modelId: "m" }), fetch: recording });
  assert.deepEqual(urls, ["https://gateway.invalid/v1/models"]);
  assert.equal(authorizations[0], undefined, "no token env, no header");

  process.env["LLM_PROXY_TOKEN"] = "tok";
  try {
    await createLlmRuntime({ config: config({ modelId: "m" }), fetch: recording });
    assert.equal(authorizations[1], "Bearer tok");
  } finally {
    delete process.env["LLM_PROXY_TOKEN"];
  }
});
