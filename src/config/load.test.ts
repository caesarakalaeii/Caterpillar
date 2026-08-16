/**
 * Tests for the `web` section (DESIGN.md §18).
 *
 * The defaults are the security boundary: a runner that has not been told to serve a web
 * view must not open a port that answers with agent transcripts, and one that HAS been
 * told must not silently accept unauthenticated requests because a field was misspelt.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError, loadConfig } from "./load.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const BASE = {
  capabilities: ["linux"],
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
      forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
      secretRef: "caterpillar-github-app",
    },
  },
};

const load = async (over: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadConfig>>> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ ...BASE, ...over }), "utf8");
  process.env["RUNNER_ID"] = "test-runner";
  return loadConfig(path);
};

test("a config that says nothing about the web view does not serve one", async () => {
  // The view exposes every transcript the fleet has produced. A runner on a laptop must
  // not start answering for them because it was upgraded.
  const config = await load({});
  assert.equal(config.web.enabled, false);
});

test("enabling it takes the documented defaults", async () => {
  const config = await load({ web: { enabled: true } });

  assert.equal(config.web.enabled, true);
  assert.equal(config.web.port, 8080);
  assert.equal(config.web.logCapacity, 500);
  assert.equal(config.web.refreshSeconds, 10);
  assert.equal(config.web.requireForwardedUser, false);
  assert.equal(config.web.forwardedUserHeader, "remote-user");
});

test("every field can be set", async () => {
  const config = await load({
    web: {
      enabled: true,
      port: 9999,
      logCapacity: 50,
      refreshSeconds: 3,
      requireForwardedUser: true,
      forwardedUserHeader: "X-Auth-User",
    },
  });

  assert.equal(config.web.port, 9999);
  assert.equal(config.web.logCapacity, 50);
  assert.equal(config.web.refreshSeconds, 3);
  assert.equal(config.web.requireForwardedUser, true);
  assert.equal(config.web.forwardedUserHeader, "x-auth-user", "matched against a lowercased header");
});

test("a non-boolean where a boolean belongs is refused rather than coerced", async () => {
  // `requireForwardedUser: "false"` is truthy in JavaScript and false in intent. Coercing
  // it either way silently produces the opposite of what the operator wrote.
  await assert.rejects(() => load({ web: { enabled: "yes" } }), ConfigError);
  await assert.rejects(
    () => load({ web: { enabled: true, requireForwardedUser: "true" } }),
    ConfigError,
  );
});

test("a port that is not a port is refused", async () => {
  await assert.rejects(() => load({ web: { enabled: true, port: 0 } }), ConfigError);
  await assert.rejects(() => load({ web: { enabled: true, port: 70000 } }), ConfigError);
  await assert.rejects(() => load({ web: { enabled: true, port: 8080.5 } }), ConfigError);
});
