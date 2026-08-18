/**
 * Registering the command set exactly once per change, across a whole fleet.
 *
 * The property under test is the one that kept this a manual step: a supervisor restarts
 * on every rollout and there are four of them, so registering at boot must not mean four
 * identical writes per deploy. It is the same claim-then-do shape as the daily digest
 * (§19) — claimed on a ref keyed by a digest of the commands, and the claim is HANDED BACK
 * if the write fails, because a claimed-but-unregistered command set is invisible.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_LOGGER } from "../obs/log.ts";
import {
  commandsDigest,
  commandsRef,
  registerCommandsOnce,
  type CommandClaim,
  type RegisterOptions,
} from "./register.ts";
import { COMMANDS } from "./slash.ts";

const COMMAND_SET: readonly Record<string, unknown>[] = [
  { name: "answer", description: "Answer the question a task is waiting on" },
];

/** A claim that nobody has taken, remembering what was claimed and released. */
const claims = (
  over: Partial<CommandClaim> = {},
): CommandClaim & { readonly claimed: string[]; readonly released: string[] } => {
  const claimed: string[] = [];
  const released: string[] = [];
  return {
    claimed,
    released,
    claimOnce: (ref) => {
      claimed.push(ref);
      return Promise.resolve("oid1");
    },
    hasRef: () => Promise.resolve(false),
    releaseRef: (ref) => {
      released.push(ref);
      return Promise.resolve();
    },
    ...over,
  };
};

const put = (): { readonly calls: { url: string; body: string }[]; readonly fetch: (url: string, init?: RequestInit) => Promise<Response> } => {
  const calls: { url: string; body: string }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return Promise.resolve(new Response("[]", { status: 200 }));
    },
  };
};

const options = (over: Partial<RegisterOptions> = {}): RegisterOptions => ({
  applicationId: "app1",
  guildId: "guild1",
  token: "bot-token",
  runner: "runner-0",
  logger: SILENT_LOGGER,
  commands: COMMAND_SET,
  claims: claims(),
  ...over,
});

test("the digest changes with the commands and with the guild, and not otherwise", () => {
  const first = commandsDigest("guild1", COMMAND_SET);
  assert.equal(first, commandsDigest("guild1", COMMAND_SET), "the same set must not re-register");
  assert.notEqual(first, commandsDigest("guild2", COMMAND_SET), "another guild is another target");
  assert.notEqual(
    first,
    commandsDigest("guild1", [{ ...COMMAND_SET[0], autocomplete: true }]),
    "a changed option is a changed set — this is exactly the `repo:` box appearing",
  );
});

test("the first runner registers, and says which guild it wrote to", async () => {
  const claim = claims();
  const http = put();

  const outcome = await registerCommandsOnce(options({ claims: claim, fetch: http.fetch }));

  assert.equal(outcome, "registered");
  assert.deepEqual(claim.claimed, [commandsRef(commandsDigest("guild1", COMMAND_SET))]);
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0]?.url ?? "", /applications\/app1\/guilds\/guild1\/commands/);
  assert.deepEqual(JSON.parse(http.calls[0]?.body ?? "null"), COMMAND_SET);
});

test("every other replica of the fleet writes nothing at all", async () => {
  // Four replicas boot within seconds of each other on every rollout. Three of them
  // losing the claim IS the ordinary path, and it must cost no Discord write.
  const claim = claims({ claimOnce: () => Promise.resolve(undefined), hasRef: () => Promise.resolve(true) });
  const http = put();

  const outcome = await registerCommandsOnce(options({ claims: claim, fetch: http.fetch }));

  assert.equal(outcome, "already");
  assert.deepEqual(http.calls, [], "a lost claim must not still register");
});

test("a restart on an unchanged command set registers nothing", async () => {
  // The ref's existence IS the record, so this survives a pod restart — which is the
  // whole reason it is a ref and not a flag in memory.
  const claim = claims({ claimOnce: () => Promise.resolve(undefined), hasRef: () => Promise.resolve(true) });
  const http = put();

  assert.equal(await registerCommandsOnce(options({ claims: claim, fetch: http.fetch })), "already");
  assert.deepEqual(http.calls, []);
});

test("a claim that ERRORS is not read as someone else's win", async () => {
  // A rejected push is also what a dead network looks like. Getting this backwards would
  // mark a command set registered that nobody has registered — the digest's §19 lesson.
  const claim = claims({
    claimOnce: () => Promise.reject(new Error("state repo unreachable")),
    hasRef: () => Promise.resolve(false),
  });
  const http = put();

  assert.equal(await registerCommandsOnce(options({ claims: claim, fetch: http.fetch })), "failed");
  assert.deepEqual(http.calls, [], "nothing was claimed, so nothing may be written");
});

test("a failed write hands the claim back, so the next boot retries", async () => {
  const claim = claims();
  const outcome = await registerCommandsOnce(
    options({
      claims: claim,
      fetch: () => Promise.resolve(new Response("Missing Access", { status: 403 })),
    }),
  );

  assert.equal(outcome, "failed");
  assert.deepEqual(
    claim.released,
    [commandsRef(commandsDigest("guild1", COMMAND_SET))],
    "a claimed-but-unregistered set is invisible; it has to be released",
  );
});

test("without an application id or a guild id there is nothing to register", async () => {
  // Both are optional secrets: a runner with a bot token but no application id still runs
  // the bridge and still answers `!answer` (§7). It must not fail to boot over it.
  const claim = claims();
  const http = put();

  const { applicationId: _a, ...noApplication } = options({ claims: claim, fetch: http.fetch });
  const { guildId: _g, ...noGuild } = options({ claims: claim, fetch: http.fetch });
  for (const missing of [noApplication, noGuild]) {
    assert.equal(await registerCommandsOnce(missing), "skipped");
  }
  assert.deepEqual(claim.claimed, [], "nothing to write means nothing to claim either");
  assert.deepEqual(http.calls, []);
});

test("the real command set is what a runner registers by default", async () => {
  const claim = claims();
  const http = put();

  const { commands: _c, ...withRealCommands } = options({ claims: claim, fetch: http.fetch });
  await registerCommandsOnce(withRealCommands);

  assert.deepEqual(JSON.parse(http.calls[0]?.body ?? "null"), COMMANDS);
});
