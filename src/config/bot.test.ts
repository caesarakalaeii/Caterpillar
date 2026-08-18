/**
 * The gate that decides whether the supervisor connects to Discord (DESIGN.md §7).
 *
 * Worth its own suite for a reason the review found the hard way: `bot.mode` parsed
 * correctly and `loadDiscord` honoured an `external` flag correctly, and the two were
 * never joined — so a fleet configured for the split still ran two acting bots, and every
 * test passed. Both failure directions are silent in production and loud only here:
 * standing down when nothing else is listening means a fleet that answers nobody, and
 * failing to stand down means two processes acting on one channel.
 *
 * Configs go through the real `loadConfig` rather than a hand-built object, so a default
 * that changes shape cannot leave this passing against a config nobody could write.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogFields, Logger } from "../obs/log.ts";
import { externalBot } from "./bot.ts";
import { loadConfig } from "./load.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const BASE = {
  capabilities: ["linux"],
  identity: {
    name: "caterpillar-agent[bot]",
    email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
  },
  stateRepo: { url: "https://example.invalid/state.git", branch: "main", path: "/work/state" },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks" },
  secretsDir: "/etc/caterpillar/secrets",
  llm: {
    auth: "proxy",
    baseUrl: "http://llm-proxy",
    modelId: "m",
    providerId: "p",
    contextWindow: 200000,
    maxTokens: 32000,
  },
  workspaces: {
    caesar: {
      forge: {
        kind: "github",
        host: "github.com",
        owner: "acme",
        apiBase: "https://api.github.com",
      },
      secretRef: "caterpillar-github-app",
    },
  },
};

const load = async (over: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadConfig>>> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-botcfg-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ ...BASE, ...over }), "utf8");
  process.env["RUNNER_ID"] = "test-runner";
  return loadConfig(path);
};

/** Collects warnings, so "logs loudly" is asserted rather than asserted about. */
const recording = (): { logger: Logger; warnings: string[] } => {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string, _fields?: LogFields) => warnings.push(event),
    error: () => undefined,
  };
  return { logger, warnings };
};

test("a config that says nothing keeps the gateway, exactly as every runner always has", async () => {
  // The unsplit path, and the one the whole existing suite is written against. Silence in
  // the config must never be the thing that stops a runner answering Discord.
  const config = await load({});
  const { logger, warnings } = recording();

  assert.equal(externalBot(config, logger), false);
  assert.deepEqual(warnings, [], "the default is not a misconfiguration and must not warn");
});

test("external with Redis stands the supervisor down from the gateway", async () => {
  // The split proper: a separate process owns the connection, so this one must not
  // connect. Two processes reading one channel is the duplicate-acting failure §7 exists
  // to prevent, and they arbitrate by different mechanisms so neither would stop the other.
  const config = await load({
    bot: { mode: "external" },
    redis: { enabled: true, url: "redis://localhost:6379" },
  });
  const { logger, warnings } = recording();

  assert.equal(externalBot(config, logger), true);
  assert.deepEqual(warnings, []);
});

test("external WITHOUT Redis is treated as the typo it is, loudly", async () => {
  // The interlock. Redis is the only path between the two processes, so standing down
  // without it would produce a supervisor that has stopped listening and a bot that cannot
  // reach it — a fleet that silently answers nobody, from a one-line mistake. Keeping the
  // gateway is the recoverable direction; saying so is what makes it diagnosable.
  const config = await load({ bot: { mode: "external" } });
  const { logger, warnings } = recording();

  assert.equal(config.bot.mode, "external", "the mode still parses; it is only not obeyed");
  assert.equal(externalBot(config, logger), false);
  assert.deepEqual(warnings, ["bot.mode-ignored"]);
});

test("in-process with Redis still keeps the gateway", async () => {
  // Redis on is not itself a decision about Discord. A fleet may run the plane for the
  // snapshot and cancels and still want the bot in the supervisor — that is the
  // single-replica path, and it must not be opted out of by enabling something else.
  const config = await load({ redis: { enabled: true, url: "redis://localhost:6379" } });
  const { logger, warnings } = recording();

  assert.equal(externalBot(config, logger), false);
  assert.deepEqual(warnings, []);
});
