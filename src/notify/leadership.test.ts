/**
 * Which replica acts on Discord, and what happens when that changes.
 *
 * The properties that matter are all about the boundaries: nobody holds it before the
 * first refresh, a holder that cannot prove its claim steps down rather than assuming,
 * and a failure to reach the remote never propagates into the poll loop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunnerId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { FailingRedisClient, MemoryRedisClient } from "../redis/memory.ts";
import {
  ChatLeadership,
  CHAT_HOLDER_REF,
  RedisChatLock,
  type LockableRedis,
  type StealableClaims,
} from "./leadership.ts";

const RUNNER = asRunnerId("caterpillar-2");

/** Records what was asked of the claim, and answers with a script. */
const claims = (answers: readonly (string | undefined | Error)[]): StealableClaims & {
  readonly asked: { ref: string; held: string | undefined }[];
  readonly released: { ref: string; oid: string }[];
} => {
  const asked: { ref: string; held: string | undefined }[] = [];
  const released: { ref: string; oid: string }[] = [];
  let call = 0;
  return {
    asked,
    released,
    claimStealable: (ref, _message, held) => {
      asked.push({ ref, held });
      const answer = answers[Math.min(call++, answers.length - 1)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    releaseRef: (ref, oid) => {
      released.push({ ref, oid });
      return oid === "boom" ? Promise.reject(new Error("remote refused")) : Promise.resolve();
    },
  };
};

const leadership = (claimer: StealableClaims): ChatLeadership =>
  new ChatLeadership({ claims: claimer, runner: RUNNER, logger: SILENT_LOGGER });

/** One bot process, over whichever client the test wants. */
const lock = (redis: LockableRedis, runner: string): RedisChatLock =>
  new RedisChatLock({ redis, runner: asRunnerId(runner), logger: SILENT_LOGGER });

test("nothing is held until the first refresh", () => {
  // A replica that assumed leadership at construction would act on the events arriving in
  // the seconds before its first poll — which is exactly when every replica is starting.
  assert.equal(leadership(claims([])).held(), false);
});

test("winning the claim makes this replica the one that acts", async () => {
  const claimer = claims(["oid-1"]);
  const subject = leadership(claimer);

  await subject.refresh();

  assert.equal(subject.held(), true);
  assert.deepEqual(claimer.asked, [{ ref: CHAT_HOLDER_REF, held: undefined }]);
});

test("a holder renews from the oid it wrote, not from nothing", async () => {
  // Renewing with no expected oid would be a claim attempt, and `claimStealable` refuses
  // one against a live ref — so the holder would step down every poll and the fleet would
  // have no bridge until the claim went stale.
  const claimer = claims(["oid-1", "oid-2"]);
  const subject = leadership(claimer);

  await subject.refresh();
  await subject.refresh();

  assert.equal(subject.held(), true);
  assert.deepEqual(claimer.asked[1], { ref: CHAT_HOLDER_REF, held: "oid-1" });
});

test("a replica that does not win simply does not act", async () => {
  const subject = leadership(claims([undefined]));

  await subject.refresh();

  assert.equal(subject.held(), false, "three replicas out of four are here on every poll");
});

test("a holder whose claim was taken steps down", async () => {
  // The handover case. Continuing to act on a claim another replica now holds is the
  // double-acting this exists to prevent.
  const subject = leadership(claims(["oid-1", undefined]));

  await subject.refresh();
  assert.equal(subject.held(), true);

  await subject.refresh();
  assert.equal(subject.held(), false);
});

test("an unreachable remote steps down instead of throwing", async () => {
  // `refresh` is called from the poll loop. Throwing would make a network blip fail the
  // whole poll — no claiming, no chat drain, no intake — and stepping down is the honest
  // reading anyway: a claim that cannot be proved is not held.
  const subject = leadership(claims(["oid-1", new Error("ls-remote: could not resolve host")]));

  await subject.refresh();
  assert.equal(subject.held(), true);

  await subject.refresh();
  assert.equal(subject.held(), false);
});

test("a replica can win the claim back after losing it", async () => {
  // Whoever holds it next must be able to be this one again — otherwise a single blip
  // demotes a replica permanently, and with four of them the bridge walks away from the
  // fleet one pod at a time.
  const subject = leadership(claims(["oid-1", undefined, "oid-3"]));

  await subject.refresh();
  await subject.refresh();
  assert.equal(subject.held(), false);

  await subject.refresh();
  assert.equal(subject.held(), true);
});

/* ───────────────── the standalone bot's lock (option c, DESIGN.md §7) ───────────────── */

test("the first bot process to arrive takes the lock, the second does not act", async () => {
  // The rollout case, and the only reason this lock exists. Two bot pods overlap for a
  // few seconds; both are connected; exactly one may answer, or a `/brainstorm` mints two
  // threads and two tasks.
  const redis = new MemoryRedisClient();
  const incoming = lock(redis, "caterpillar-bot-1");
  const outgoing = lock(redis, "caterpillar-bot-2");

  await incoming.refresh();
  await outgoing.refresh();

  assert.equal(incoming.held(), true);
  assert.equal(outgoing.held(), false);
});

test("a holder renews against its own token rather than re-taking the key", async () => {
  // Attempting NX again would fail against our OWN key and read as a loss, so the bot
  // would step down on every tick and the fleet would have no bot at all.
  const redis = new MemoryRedisClient();
  const bot = lock(redis, "caterpillar-bot-1");

  await bot.refresh();
  await bot.refresh();
  await bot.refresh();

  assert.equal(bot.held(), true);
});

test("a lock released on shutdown is takeable immediately, not after the TTL", async () => {
  // Without the release an incoming pod waits out the TTL before it can speak, and for
  // those seconds the bot is online and answers nothing — the liveness failure the split
  // was meant to fix, reintroduced at every deploy.
  const redis = new MemoryRedisClient();
  const outgoing = lock(redis, "caterpillar-bot-1");
  const incoming = lock(redis, "caterpillar-bot-2");

  await outgoing.refresh();
  await incoming.refresh();
  assert.equal(incoming.held(), false);

  await outgoing.stop();
  await incoming.refresh();

  assert.equal(incoming.held(), true);
  assert.equal(outgoing.held(), false);
});

test("a process that already lost the lock cannot evict its successor on the way down", async () => {
  const redis = new MemoryRedisClient();
  const first = lock(redis, "caterpillar-bot-1");
  const second = lock(redis, "caterpillar-bot-2");

  await first.refresh();
  // The key expires under the first process — a paused pod, a slow network.
  await redis.del("chat:holder");
  await second.refresh();
  assert.equal(second.held(), true);

  // `releaseIfHeld` compares before deleting, so this is a no-op rather than a handover
  // to nobody.
  await first.stop();
  await second.refresh();
  assert.equal(second.held(), true);
});

test("an expired lock is taken over, so a killed bot does not silence the fleet", async () => {
  const redis = new MemoryRedisClient();
  const dead = lock(redis, "caterpillar-bot-1");
  const live = lock(redis, "caterpillar-bot-2");

  await dead.refresh();
  // No clean shutdown — SIGKILL, a node eviction. The TTL is the only thing that recovers.
  await redis.del("chat:holder");

  await live.refresh();
  assert.equal(live.held(), true);
});

test("an unreachable redis means this process does not act", async () => {
  // The same honest reading `ChatLeadership` takes for an unreachable remote: a claim that
  // cannot be proved is not held. Acting anyway is how two bots answer one message.
  const bot = lock(new FailingRedisClient(), "caterpillar-bot-1");

  await bot.refresh();
  assert.equal(bot.held(), false);
});

test("a holder that loses redis steps down rather than throwing out of its timer", async () => {
  const redis = new MemoryRedisClient();
  const bot = lock(redis, "caterpillar-bot-1");
  await bot.refresh();
  assert.equal(bot.held(), true);

  // `refresh` is called from a timer with no handler behind it, so a rejection here would
  // be an unhandled one — and the process dies on `unhandledRejection` by design.
  const broken = new RedisChatLock({
    redis: new FailingRedisClient(),
    runner: asRunnerId("caterpillar-bot-1"),
    logger: SILENT_LOGGER,
  });
  await broken.refresh();
  assert.equal(broken.held(), false);
});

test("nothing is held before the first refresh", () => {
  // A bot that assumed the lock at construction would act on whatever arrives in the
  // seconds before its first renewal — which is exactly when a rollout has two of them.
  assert.equal(lock(new MemoryRedisClient(), "caterpillar-bot-1").held(), false);
});

test("start() settles the first attempt before returning", async () => {
  // So the caller can connect the gateway knowing whether this process answers. Without
  // it the bot is online and declining to act for the length of one renewal interval.
  const bot = lock(new MemoryRedisClient(), "caterpillar-bot-1");

  await bot.start();
  assert.equal(bot.held(), true);

  await bot.stop();
});

test("a holder gives the ref back on the way out, so a rollout costs a poll not a stale window", async () => {
  // THE deploy defect. A holder that just dies leaves `refs/chat/holder` behind with the commit
  // time of its last renewal, and `claimStealable` refuses a ref that is not yet stale — so
  // every replica came up, connected its gateway, and acted on nothing for the remainder of
  // `lease.staleAfterSeconds`. Silently: a non-holder answers nothing and logs nothing, so a
  // slash command in the gap shows Discord's own "This interaction failed".
  //
  // Observed 2026-08-19: pods restarted 20:03–20:05, the ref went stale at 20:09:58 — exactly
  // 300s after the dead holder's last renewal — and the bot was deaf in between.
  const claimer = claims(["oid-1"]);
  const subject = leadership(claimer);
  await subject.refresh();
  assert.equal(subject.held(), true);

  await subject.standDown();

  assert.deepEqual(claimer.released, [{ ref: CHAT_HOLDER_REF, oid: "oid-1" }]);
  assert.equal(subject.held(), false, "it must stop acting the instant it gives the ref up");
});

test("a replica that holds nothing deletes nothing", async () => {
  // It would be deleting the ref its SUCCESSOR is holding — the one case where standing down
  // is worse than not bothering.
  const claimer = claims([undefined]);
  const subject = leadership(claimer);
  await subject.refresh();

  await subject.standDown();

  assert.deepEqual(claimer.released, []);
});

test("a stand-down that the remote refuses is not the thing that fails a shutdown", async () => {
  // The cost of a failed stand-down is exactly the behaviour that existed before it, and
  // shutdown must not be the path that hangs or throws.
  const claimer = claims(["boom"]);
  const subject = leadership(claimer);
  await subject.refresh();

  await subject.standDown();

  assert.equal(subject.held(), false);
});
