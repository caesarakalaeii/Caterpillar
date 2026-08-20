import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_LOGGER } from "../obs/log.ts";
import { mergedCatalog } from "./catalog.ts";

test("every workspace's repos are offered, once each, in order", async () => {
  const catalog = mergedCatalog({
    logger: SILENT_LOGGER,
    catalogs: [
      { reachable: () => Promise.resolve(["acme/widget", "acme/api"]) },
      { reachable: () => Promise.resolve(["contoso/acme-api", "acme/widget"]) },
    ],
  });

  assert.deepEqual(await catalog.reachable(), ["acme/widget", "acme/api", "contoso/acme-api"]);
});

test("one forge failing does not empty the box for the others", async () => {
  // An autocomplete accepts exactly one response. A throw here would be an interaction
  // nobody answers, which the client shows as a spinner that never resolves.
  const catalog = mergedCatalog({
    logger: SILENT_LOGGER,
    catalogs: [
      { reachable: () => Promise.reject(new Error("GitHub 500")) },
      { reachable: () => Promise.resolve(["contoso/acme-api"]) },
    ],
  });

  assert.deepEqual(await catalog.reachable(), ["contoso/acme-api"]);
});

test("a forge that never answers loses its place, not the whole suggestion", async () => {
  const catalog = mergedCatalog({
    logger: SILENT_LOGGER,
    budgetMs: 20,
    catalogs: [
      { reachable: () => new Promise<readonly string[]>(() => undefined) },
      { reachable: () => Promise.resolve(["acme/widget"]) },
    ],
  });

  assert.deepEqual(await catalog.reachable(), ["acme/widget"]);
});
