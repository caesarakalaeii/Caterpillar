/**
 * Tests for the two-and-a-half strings a session is allowed to name (DESIGN.md §20).
 *
 * `client.test.ts` already proves that a hostile pod name never reaches Loki. This file
 * tests the grammar directly, because the grammar is the thing being relied on: the client
 * is safe *because* these functions are, and a change here that quietly widened the pattern
 * would show up there only if someone had happened to write the matching case.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidNameError, isPodPattern, validateKind, validateName, validatePodPattern } from "./names.ts";

test("the accepted names are the ones Kubernetes accepts", () => {
  for (const name of ["a", "a1", "caterpillar", "caterpillar-0", "loki-1-2-3", "a".repeat(253)]) {
    assert.equal(validateName("name", name), name);
  }
});

test("everything outside the grammar is refused", () => {
  for (const name of [
    "",
    "-leading",
    "trailing-",
    "Upper",
    "under_score",
    "dot.separated",
    "a b",
    "a/b",
    "a:b",
    "a".repeat(254),
    "café",
  ]) {
    assert.throws(() => validateName("name", name), InvalidNameError, `'${name}' was accepted`);
  }
});

test("a pod pattern accepts one trailing wildcard and no other regex", () => {
  for (const pod of ["caterpillar", "caterpillar-0", "caterpillar.*", "caterpillar-.*", "caterpillar-7d9f-.*"]) {
    assert.equal(validatePodPattern("pod", pod), pod);
  }

  for (const pod of [
    // A bare wildcard is the namespace-wide query, which has its own honest spelling:
    // omitting `pod` entirely.
    ".*",
    "-.*",
    // Anything that would match outside the prefix it appears to be about.
    "caterpillar.*-0",
    "caterpillar-.*.*",
    "caterpillar|loki",
    "caterpillar[0-9]",
    "^caterpillar$",
    "caterpillar.+",
    'x"} | {namespace="kube-system',
  ]) {
    assert.throws(() => validatePodPattern("pod", pod), InvalidNameError, `'${pod}' was accepted`);
  }
});

test("isPodPattern is what decides `=` from `=~`", () => {
  assert.equal(isPodPattern("caterpillar-.*"), true);
  assert.equal(isPodPattern("caterpillar-0"), false);
});

test("a kind is CamelCase, and is not the describe allowlist", () => {
  // Deliberately wider than `DESCRIBABLE_KINDS`: an event's involved object is routinely a
  // ReplicaSet or a HorizontalPodAutoscaler, and a filter narrower than the events that
  // exist would hide the evidence the tool is for. Filtering is not access.
  for (const kind of ["Pod", "ReplicaSet", "HorizontalPodAutoscaler", "Endpoints", "Node"]) {
    assert.equal(validateKind("kind", kind), kind);
  }

  for (const kind of ["", "pod", "Pod/x", "Pod ", "Pod,involvedObject.namespace=x", "P".repeat(64)]) {
    assert.throws(() => validateKind("kind", kind), InvalidNameError, `'${kind}' was accepted`);
  }
});

test("a refusal names the field and the value, because the agent has to fix it", () => {
  const error = (() => {
    try {
      validateName("namespace", "Kube-System");
      return undefined;
    } catch (caught) {
      return caught as Error;
    }
  })();

  assert.ok(error instanceof InvalidNameError);
  assert.match(error.message, /namespace 'Kube-System'/);
  assert.match(error.message, /lowercase letters/);
});
