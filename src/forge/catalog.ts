/**
 * One repo catalogue over every workspace. See DESIGN.md §9.1.1.
 *
 * `/brainstorm` does not name a workspace — the loop derives it from the repo (§14.3) — so
 * the box that completes `repo:` has to offer every repo the runner can reach, whichever
 * forge that is. This merges the per-workspace catalogues into the one list the suggestion
 * ranking works over.
 *
 * Two properties matter, and both exist because this feeds a Discord autocomplete:
 *
 *   BOUNDED. An interaction must be acknowledged within 3 seconds and an autocomplete
 *   accepts exactly one response, so a forge that is slow does not delay a suggestion — it
 *   loses its place in one. The budget is per catalogue and generous relative to a cached
 *   read, because the listing behind each is cached for five minutes (§9.1.1) and only a
 *   cold one costs a request at all.
 *
 *   ISOLATED. One workspace's forge failing must not empty the box for the others. A
 *   failure is a warn line and an empty contribution, never a throw: the alternative is an
 *   interaction nobody answers, which the client shows as a spinner that never resolves.
 */
import type { Logger } from "../obs/log.ts";
import type { RepoCatalog } from "./reach.ts";

/**
 * How long one workspace's catalogue may take before it is left out of this round.
 *
 * A cached read is microseconds; a cold one is a token mint plus a listing. 1500ms leaves
 * room for the cold case inside Discord's 3 seconds while still being a bound.
 */
const CATALOG_BUDGET_MS = 1500;

const bounded = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        // NOT unref'd, for the reason `redis/client.ts`'s `withTimeout` gives: this timer is
        // the only thing that will settle a race against a forge that never answers, and an
        // unref'd one lets the loop go idle with the caller's promise still pending. Node 22
        // fails that outright ("Promise resolution is still pending but the event loop has
        // already resolved") where 26 happens to tolerate it, and in the runner it would be
        // an autocomplete that is never answered — exactly what the budget exists to stop.
        // The `finally` clears it, so it can never hold a finished process open.
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Every repo any of these catalogues can reach, in order, de-duplicated.
 *
 * Order is preserved rather than sorted: each forge lists its repos in an order it chose,
 * and re-sorting between keystrokes would reshuffle a list somebody is reading.
 */
export const mergedCatalog = (deps: {
  readonly catalogs: readonly RepoCatalog[];
  readonly logger: Logger;
  readonly budgetMs?: number;
}): RepoCatalog => ({
  reachable: async () => {
    const lists = await Promise.all(
      deps.catalogs.map((catalog) =>
        bounded(
          catalog.reachable().catch((error: unknown) => {
            // Not an error the human typing needs to see. The door checks still refuse an
            // unreachable repo (§9.1.1); this only means they were not offered a list.
            deps.logger.warn("repo.catalog-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return [] as readonly string[];
          }),
          deps.budgetMs ?? CATALOG_BUDGET_MS,
          [] as readonly string[],
        ),
      ),
    );

    return [...new Set(lists.flat())];
  },
});
