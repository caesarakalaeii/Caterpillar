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
 * teardown cannot know what every test left running and because a leaked git child is
 * reaped in milliseconds — it exits on its own, and the next attempt finds a quiet tree.
 * A test that genuinely leaks a handle is still caught, by --test-timeout, which is what
 * that flag is for.
 */
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Attempts before giving up. Six attempts spans ~150ms of backoff, which is far longer
 * than a git child needs to exit once it has been signalled or has finished its write.
 */
const ATTEMPTS = 6;

/**
 * Remove a directory tree, retrying while a concurrent writer keeps refilling it.
 *
 * Resolves when the tree is gone, including when it never existed. Rethrows the last
 * error if the tree is still there after every attempt: a tree that cannot be removed at
 * all is a real failure and hiding it would leave the next run to trip over the leftovers.
 */
export const removeTempTree = async (path: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      // Linear backoff. The writer is expected to be finishing, not backing off itself,
      // so spacing attempts a few milliseconds apart is enough and keeps teardown quick.
      await sleep(attempt * 10);
    }
  }
};
