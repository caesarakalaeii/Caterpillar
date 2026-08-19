/**
 * The shared Discord HTTP client, driven where it is easy to get wrong: the request it
 * BUILDS, not merely the response it returns.
 *
 * The bug that motivates this file is worth stating, because a normal test would not have
 * caught it and did not. `parentChannel` called `postJson` with `method: "GET"` and
 * `body: ""`. Node's `fetch` rejects a GET carrying a body with a synchronous `TypeError`
 * thrown while CONSTRUCTING the request — before any network I/O, so no stub server ever
 * sees it and no status code ever comes back. The caller wrapped the call in
 * `.catch(() => undefined)` for good reasons, so the throw was silently converted into
 * "this channel has no parent" for every channel in existence, and the bot resumed
 * dropping messages in threads whose binding had not arrived yet.
 *
 * Every fetch stub in this repo takes `init` and reads what it wants from it. Such a stub
 * ignores a body the real `fetch` refuses, which is exactly how the defect passed review
 * and CI. So the assertions below do two things a stub alone cannot:
 *   - assert the body is ABSENT rather than empty, since "" is what was actually sent; and
 *   - hand the recorded init to a real `Request`, making the platform's own rule the
 *     oracle, so this keeps biting even if Node's message or timing changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { postJson } from "./http.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const recorder = (
  responses: readonly Response[] = [new Response("{}", { status: 200 })],
): {
  readonly calls: Call[];
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
} => {
  const calls: Call[] = [];
  const queue = [...responses];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      assert.ok(next !== undefined, "the recorder ran out of responses — too many calls");
      return Promise.resolve(next);
    },
  };
};

/**
 * The real platform check, applied to what the client actually passed.
 *
 * `new Request(...)` runs the same validation `fetch` does, so this fails for the same
 * reason production failed rather than for a reason a test author imagined.
 */
const assertRequestIsConstructible = (call: Call): void => {
  assert.doesNotThrow(() => {
    new Request("https://example.invalid/", call.init);
  }, "fetch must accept the init the client built — a GET carrying a body throws before any I/O");
};

test("a GET is sent with no body at all, so fetch can construct it", async () => {
  const { calls, fetch } = recorder();

  await postJson({
    url: "https://example.invalid/channels/123",
    body: "",
    what: "channel lookup",
    method: "GET",
    fetch,
  });

  const call = calls[0];
  assert.ok(call !== undefined, "the request must be attempted");
  assert.equal(call.init?.method, "GET");

  // ABSENT, not "". An empty string is falsy, so a laxer assertion like `!init.body`
  // would have passed against the exact bug this guards.
  assert.ok(
    !("body" in (call.init ?? {})) || call.init?.body === undefined,
    "a GET must carry no body key — Node's fetch rejects even an empty one",
  );
  assertRequestIsConstructible(call);
});

test("a HEAD is treated the same way as a GET", async () => {
  const { calls, fetch } = recorder();

  await postJson({ url: "https://example.invalid/x", body: "", what: "probe", method: "HEAD", fetch });

  const call = calls[0];
  assert.ok(call !== undefined);
  assertRequestIsConstructible(call);
});

test("a lowercase get is still bodiless — the method is not case sensitive", async () => {
  const { calls, fetch } = recorder();

  // Discord's API is addressed with uppercase verbs throughout this codebase, but the
  // guard keys off a string a caller supplies. Matching case-sensitively would let a
  // plausible spelling through to the same synchronous throw.
  await postJson({ url: "https://example.invalid/x", body: "", what: "probe", method: "get", fetch });

  const call = calls[0];
  assert.ok(call !== undefined);
  assertRequestIsConstructible(call);
});

test("a POST still carries its body — the fix must not starve the hot path", async () => {
  const { calls, fetch } = recorder();
  const payload = JSON.stringify({ content: "hello" });

  await postJson({ url: "https://example.invalid/webhooks/1/t", body: payload, what: "webhook message", fetch });

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.init?.method, "POST", "POST is the default method");
  assert.equal(call.init?.body, payload, "the body must survive — every write depends on it");
  assertRequestIsConstructible(call);
});

test("an explicit PATCH keeps its body too", async () => {
  const { calls, fetch } = recorder();
  const payload = JSON.stringify({ content: "edited" });

  await postJson({
    url: "https://example.invalid/messages/1",
    body: payload,
    what: "message edit",
    method: "PATCH",
    fetch,
  });

  assert.equal(calls[0]?.init?.body, payload);
});
