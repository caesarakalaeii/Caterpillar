/**
 * Tests for the commit identity the runner authors with (DESIGN.md §9.7).
 *
 * This is not a cosmetic field. Every commit the supervisor makes to the state repo and
 * every commit the agent makes in a task worktree carries it, and a forge resolves an
 * address to an ACCOUNT — so the wrong string here does not produce an anonymous commit,
 * it produces a commit signed by whoever happens to own that address.
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
    primary: {
      forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
      secretRef: "caterpillar-github-app",
    },
  },
};

const load = async (over: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadConfig>>> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-identity-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ ...BASE, ...over }), "utf8");
  process.env["RUNNER_ID"] = "test-runner";
  return loadConfig(path);
};

test("the identity is loaded as written", async () => {
  const config = await load({});

  assert.equal(config.identity.name, "caterpillar-agent[bot]");
  assert.equal(config.identity.email, "316492202+caterpillar-agent[bot]@users.noreply.github.com");
});

test("a config that names no identity is refused rather than defaulted", async () => {
  // There is no safe guess. Every default is a claim about who authored an audit trail,
  // and a wrong one is indistinguishable from a right one after the fact — so the runner
  // refuses to start instead of picking a name on the operator's behalf.
  const config = { ...BASE } as Record<string, unknown>;
  delete config["identity"];

  const root = await mkdtemp(join(tmpdir(), "caterpillar-identity-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  process.env["RUNNER_ID"] = "test-runner";

  await assert.rejects(loadConfig(path), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /identity\.name/);
    return true;
  });
});

test("a bare github noreply address is refused — it belongs to a real account", async () => {
  // The defect this rule exists for. `caterpillar@users.noreply.github.com` reads like a
  // reserved, inert address for a project called caterpillar. It is not: it is the
  // pre-2017 noreply form, and GitHub resolves it to the account with that login — an
  // unrelated person, who then appears as the author of everything the fleet pushed.
  await assert.rejects(
    load({ identity: { name: "caterpillar", email: "caterpillar@users.noreply.github.com" } }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /users\.noreply\.github\.com/);
      assert.match(error.message, /<id>\+<login>/);
      return true;
    },
  );
});

test("the id-prefixed noreply form is accepted for a bot and for a person", async () => {
  // Both are unambiguous: the numeric id names exactly one account, so nothing is
  // claimed by accident.
  const bot = await load({
    identity: {
      name: "caterpillar-agent[bot]",
      email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
    },
  });
  assert.equal(bot.identity.email, "316492202+caterpillar-agent[bot]@users.noreply.github.com");

  const person = await load({
    identity: { name: "Acme Bot", email: "82340152+acme@users.noreply.github.com" },
  });
  assert.equal(person.identity.email, "82340152+acme@users.noreply.github.com");
});

test("the rule is about github's noreply domain, not about plus addressing", async () => {
  // A runner pushing to Codeberg has no github noreply address to get wrong, and must
  // not be forced to invent an id prefix that means nothing there.
  const config = await load({
    identity: { name: "Caterpillar", email: "caterpillar@bots.example.invalid" },
  });

  assert.equal(config.identity.email, "caterpillar@bots.example.invalid");
});

test("an address that is not an address is refused", async () => {
  await assert.rejects(
    load({ identity: { name: "Caterpillar", email: "caterpillar" } }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /identity\.email/);
      return true;
    },
  );
});

test("a name that is not a string is refused", async () => {
  await assert.rejects(
    load({ identity: { name: 42, email: "bot@example.invalid" } }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /identity\.name/);
      return true;
    },
  );
});

test("addresses the fleet used to commit as are loaded, so a window can straddle a change", async () => {
  // The digest's authorship split (§19) matches on the address. A deployment that
  // reinstalled its App has commits under the retired address in the same window as the
  // current one, and reading those as a person's work invents a contributor and halves the
  // fleet's reported share on exactly the day the operator is most likely to look.
  //
  // Retired addresses only ever READ. Nothing commits as one, so `identityFault` is not
  // asked of them: refusing a bare noreply address here would make a deployment that
  // already made that mistake unable to describe its own history.
  const config = await load({
    identity: {
      name: "caterpillar-agent[bot]",
      email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
      pastEmails: ["11111111+old-agent[bot]@users.noreply.github.com"],
    },
  });

  assert.deepEqual(config.identity.pastEmails, [
    "11111111+old-agent[bot]@users.noreply.github.com",
  ]);
});

test("a config with no past addresses has none, rather than an implied one", async () => {
  const config = await load({});

  assert.deepEqual(config.identity.pastEmails, []);
});

test("a past address that is not a string is refused rather than silently dropped", async () => {
  // Dropped, it would read as "the fleet never used that address" and the window in
  // question would be mis-attributed with nothing anywhere saying why.
  await assert.rejects(
    load({
      identity: { name: "bot", email: "bot@example.invalid", pastEmails: ["ok@x.invalid", 42] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /identity\.pastEmails/);
      return true;
    },
  );
});
