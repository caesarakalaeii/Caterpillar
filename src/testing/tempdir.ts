/**
 * Removing a temp tree that another process may still be writing into.
 *
 * For test teardown only. Production code removes trees it owns exclusively and should
 * keep using `rm` directly — a retry there would paper over a real concurrent writer.
 *
 * `rm(path, {recursive: true, force: true})` is not enough on a tree a subprocess is
 * still touching. The removal walks the tree, then rmdir's each directory it believes it
 * has emptied; anything created in between makes that rmdir fail with ENOTEMPTY, and
 * `force` does not help because it suppresses ENOENT — the opposite race.
 *
 * This cost three consecutive rejected completion claims on one branch. The supervisor
 * tests in supervisor/loop.test.ts drive a real supervisor over a real git remote, and
 * `Supervisor.run` resolves without draining a housekeeping pass that is mid-flight:
 * `workLoop` awaits its sessions, but `housekeepingLoop` only checks the abort signal
 * BETWEEN passes, so an abort landing inside `housekeepOnce` leaves that pass's
 * `store.pull` git child writing into `state/.git/objects` after `await running` has
 * returned. The file-level teardown then deleted the tree under it and failed the whole
 * file in a hook, intermittently, on whichever matrix leg lost the race.
 *
 * Retrying is the right fix rather than draining the supervisor harder, because the
 * teardown cannot know what every test left running and because a leaked git child exits
 * on its own — the next attempt then finds a quiet tree. A test that genuinely leaks a
 * handle is still caught, by --test-timeout, which is what that flag is for.
 *
 * How LONG to retry for is the part that was wrong. The first version spent six attempts
 * over ~150ms of backoff, on the reasoning that a git child is reaped in milliseconds.
 * That holds on an idle machine and not on a loaded CI runner, where the same fetch can
 * hold `.git/objects` open for far longer, and the delete then failed with ENOTEMPTY and
 * took the whole file down in a hook — on whichever matrix leg lost the race, which is
 * why it never reproduced locally. The budget is a deadline now, so it says what it is
 * waiting for instead of encoding it in an attempt count.
 */
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * How long to keep trying before giving up.
 *
 * Sized for the slowest writer this has to outlast — a `git fetch` into a fixture repo on
 * a contended CI runner — with room to spare, because the cost of waiting too long is a
 * few seconds of teardown on a run that was going to fail anyway, while the cost of not
 * waiting long enough is a red matrix leg nobody can reproduce.
 */
const DEADLINE_MS = 10_000;

/** Between attempts, and also the cap on the linear backoff below. */
const MAX_DELAY_MS = 250;

/**
 * Remove a directory tree, retrying while a concurrent writer keeps refilling it.
 *
 * Resolves when the tree is gone, including when it never existed. Rethrows the last
 * error if the tree is still there after every attempt: a tree that cannot be removed at
 * all is a real failure and hiding it would leave the next run to trip over the leftovers.
 */
export const removeTempTree = async (path: string): Promise<void> => {
  const giveUpAt = Date.now() + DEADLINE_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      // Checked AFTER an attempt, so the deadline can never skip the retry entirely: even
      // a deadline of zero gets one more go at the tree than a plain `rm` would.
      if (Date.now() >= giveUpAt) throw error;
      // Linear backoff, capped. The writer is finishing rather than backing off itself, so
      // attempts stay closely spaced and teardown of a quiet tree is still immediate.
      await sleep(Math.min(attempt * 10, MAX_DELAY_MS));
    }
  }
};
