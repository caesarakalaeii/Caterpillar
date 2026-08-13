import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "./credentials.ts";

const oauth = (access: string, refresh: string): Credential => ({
  type: "oauth",
  access,
  refresh,
  expires: Date.now() + 3_600_000,
});

const storePath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "caterpillar-cred-")), "auth.json");

test("a missing file reads as no credential, not an error", async () => {
  // First boot on an empty PVC. Throwing here would make a fresh runner look broken.
  const store = new FileCredentialStore(await storePath());
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("a stored credential round-trips", async () => {
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("a1", "r1"));

  const read = await store.read("anthropic");
  assert.equal(read?.type, "oauth");
  assert.equal((read as { access: string }).access, "a1");
  assert.deepEqual(await store.list(), [{ providerId: "anthropic", type: "oauth" }]);
});

test("list exposes metadata only, never token material", async () => {
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("secret-access", "secret-refresh"));

  const listed = JSON.stringify(await store.list());
  assert.ok(!listed.includes("secret-access"));
  assert.ok(!listed.includes("secret-refresh"));
});

test("the credential file is not world-readable", async () => {
  // It holds a live refresh token, and the agent shares this container.
  const path = await storePath();
  await new FileCredentialStore(path).modify("anthropic", async () => oauth("a", "r"));

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("modify sees the current credential, so a refresh can rotate it", async () => {
  // pi refreshes inside modify and returns the rotated token — the callback must be
  // handed what is actually stored, not a stale copy.
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("a1", "r1"));

  const seen: string[] = [];
  await store.modify("anthropic", async (current) => {
    seen.push((current as { refresh: string } | undefined)?.refresh ?? "none");
    return oauth("a2", "r2");
  });

  assert.deepEqual(seen, ["r1"]);
  assert.equal((await store.read("anthropic") as { refresh: string }).refresh, "r2");
});

test("returning undefined leaves the stored credential untouched", async () => {
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("a1", "r1"));

  const result = await store.modify("anthropic", async () => undefined);
  assert.equal((result as { access: string }).access, "a1");
  assert.equal((await store.read("anthropic") as { access: string }).access, "a1");
});

test("concurrent modifies serialize rather than interleaving", async () => {
  // The whole point of the lock: two sessions refreshing at once must not both
  // read r1 and both write, because the loser persists a token the provider has
  // already invalidated.
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("a0", "r0"));

  const observed: string[] = [];
  const rotate = (next: string) =>
    store.modify("anthropic", async (current) => {
      observed.push((current as { refresh: string }).refresh);
      // Yield, so an unserialized implementation would definitely interleave here.
      await new Promise((resolve) => setImmediate(resolve));
      return oauth(next, next);
    });

  await Promise.all([rotate("r1"), rotate("r2")]);

  // Whichever ran second must have seen the first one's write, not the seed.
  assert.equal(observed.length, 2);
  assert.equal(observed[0], "r0");
  assert.ok(observed[1] === "r1" || observed[1] === "r2", `saw ${observed[1]}`);
});

test("delete removes one provider and leaves the others", async () => {
  const store = new FileCredentialStore(await storePath());
  await store.modify("anthropic", async () => oauth("a", "r"));
  await store.modify("openai", async () => ({ type: "api_key", key: "k" }));

  await store.delete("anthropic");
  assert.equal(await store.read("anthropic"), undefined);
  assert.equal((await store.read("openai"))?.type, "api_key");
});

test("a corrupt credential file fails without echoing its contents", async () => {
  // The body is a live refresh token; a parse error must not put it in the logs.
  const path = await storePath();
  await writeFile(path, "{not json — ghs_ExampleSecretValue", "utf8");

  await assert.rejects(
    () => new FileCredentialStore(path).read("anthropic"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not valid JSON/);
      assert.ok(!error.message.includes("ghs_ExampleSecretValue"));
      return true;
    },
  );
});

test("writes are atomic — a reader never sees a half-written file", async () => {
  const path = await storePath();
  const store = new FileCredentialStore(path);
  await store.modify("anthropic", async () => oauth("a1", "r1"));
  await store.modify("anthropic", async () => oauth("a2", "r2"));

  // Written via temp-and-rename, so the file always parses.
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["anthropic"]);
});
