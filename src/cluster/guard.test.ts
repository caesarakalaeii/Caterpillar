/**
 * Tests for the namespace guard (DESIGN.md §20).
 *
 * Small module, load-bearing tests. The failure this file exists to prevent is not a
 * clever bypass; it is the ordinary misconfiguration — `cluster.enabled: true` with the
 * namespace list forgotten — silently meaning "read anything", which is the default half
 * the idioms in JavaScript give you for an empty array.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NamespaceNotAllowedError, assertNamespaceAllowed } from "./guard.ts";

test("an allowlisted namespace passes", () => {
  assertNamespaceAllowed("monitoring", ["caterpillar", "monitoring"]);
});

test("an empty allowlist denies everything, and says the list is empty", () => {
  let caught: unknown;
  try {
    assertNamespaceAllowed("monitoring", []);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof NamespaceNotAllowedError);
  assert.match((caught as Error).message, /no cluster namespace allowlist/);
  // Where to fix it, named, because a denial with no address sends an operator guessing.
  assert.match((caught as Error).message, /cluster\.namespaces/);
});

test("a denial names the namespaces that would have worked", () => {
  let caught: unknown;
  try {
    assertNamespaceAllowed("kube-system", ["caterpillar", "monitoring"]);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof NamespaceNotAllowedError);
  assert.match((caught as Error).message, /caterpillar, monitoring/);
});

test("matching is exact — no prefixes, no case folding, no trailing whitespace", () => {
  const allowed = ["monitoring"];
  for (const attempt of [
    // A prefix match would turn an allowlist entry into a grant over every namespace
    // named after it, which is how a staging namespace becomes readable by accident.
    "monitoring-staging",
    "monitoring2",
    // Kubernetes names are lowercase by grammar, so an uppercase spelling is not another
    // way of saying the same namespace — it is a name that cannot exist.
    "Monitoring",
    "MONITORING",
    " monitoring",
    "monitoring ",
    "",
  ]) {
    assert.throws(
      () => assertNamespaceAllowed(attempt, allowed),
      NamespaceNotAllowedError,
      `'${attempt}' was allowed`,
    );
  }
});

test("a substring of an allowed name is not allowed", () => {
  assert.throws(
    () => assertNamespaceAllowed("monitor", ["monitoring"]),
    NamespaceNotAllowedError,
  );
});
