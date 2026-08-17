/**
 * Tests for the sections whose DEFAULTS are load-bearing — `web` (DESIGN.md §18) and
 * `digest` (§19).
 *
 * Both default to off, and both do something outward-facing when they are on: one opens a
 * port that answers with agent transcripts, the other posts to a shared channel and
 * commits to a shared repo. A runner someone started on a laptop must not begin doing
 * either because it was upgraded, and one that HAS been told to must not silently do it
 * wrongly — unauthenticated, or at an hour a misspelt zone quietly turned into UTC.
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
  // Required, and validated in identity.test.ts. Present here only so these tests are
  // about the `web` section rather than about a config that will not load.
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

test("a config that says nothing about the digest does not publish one", async () => {
  const config = await load({});

  assert.equal(config.digest.enabled, false);
  assert.equal(config.digest.hour, 18);
  assert.equal(config.digest.timeZone, "Europe/Berlin");
  assert.equal(config.digest.summarise, true, "the prose is the point of asking for one");
});

test("the digest hour is a wall-clock hour, not a number", async () => {
  await assert.rejects(() => load({ digest: { enabled: true, hour: 24 } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, hour: -1 } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, hour: 18.5 } }), ConfigError);
});

test("a timezone that is not a zone is refused, even with the digest off", async () => {
  // Checked while disabled on purpose. Otherwise the typo is found the day someone
  // enables it — in the cluster, at 18:00, inside the poll loop.
  await assert.rejects(() => load({ digest: { timezone: "Europe/Duesseldorf" } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, timezone: "+02:00" } }), ConfigError);

  const config = await load({ digest: { enabled: true, timezone: "UTC", hour: 0 } });
  assert.equal(config.digest.timeZone, "UTC");
  assert.equal(config.digest.hour, 0);
});

test("the prose can be turned off without losing the digest", async () => {
  const config = await load({ digest: { enabled: true, summarise: false } });

  assert.equal(config.digest.enabled, true);
  assert.equal(config.digest.summarise, false);
  await assert.rejects(() => load({ digest: { summarise: "no" } }), ConfigError);
});
