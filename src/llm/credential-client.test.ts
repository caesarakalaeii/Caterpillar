import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import {
  CredentialHolderError,
  CredentialReadOnlyError,
  HttpCredentialStore,
} from "./credential-client.ts";

const oauth = (access: string, minutesLeft: number): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-for-${access}`,
  expires: Date.now() + minutesLeft * 60_000,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
}

/** A holder that answers with `replies` in order, recording what it was asked. */
const holder = (
  replies: readonly (Credential | undefined)[],
): { store: HttpCredentialStore; calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;

  const store = new HttpCredentialStore({
    baseUrl: "http://holder.invalid",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      const credential = replies[Math.min(index++, replies.length - 1)];
      if (credential === undefined) {
        return new Response(JSON.stringify({ error: "none" }), { status: 404 });
      }
      return new Response(JSON.stringify({ credential }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return { store, calls };
};

test("a credential is read from the holder", async () => {
  const { store, calls } = holder([oauth("a1", 60)]);

  const read = await store.read("anthropic");
  assert.equal(read?.type, "oauth");
  assert.equal((read as { access: string }).access, "a1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET");
  assert.match(calls[0]?.url ?? "", /\/v1\/credentials\/anthropic$/);
});

test("a healthy credential is cached, so a session does not call the holder per request", async () => {
  const { store, calls } = holder([oauth("a1", 60)]);

  await store.read("anthropic");
  await store.read("anthropic");
  await store.read("anthropic");

  assert.equal(calls.length, 1);
});

test("a credential close to expiry is NOT served from cache", async () => {
  // Inside the margin, so the holder is asked again — otherwise this class would keep
  // handing pi a token pi immediately judges stale, and every request would refresh.
  const { store, calls } = holder([oauth("a1", 2), oauth("a2", 60)]);

  const first = await store.read("anthropic");
  assert.equal((first as { access: string }).access, "a1");

  const second = await store.read("anthropic");
  assert.equal((second as { access: string }).access, "a2");
  assert.equal(calls.length, 2);
});

test("modify asks the HOLDER to refresh and never runs the callback", async () => {
  // The whole point of the class. Running pi's callback here would call
  // anthropicOAuth.refresh from a runner, rotating a token it cannot persist and
  // invalidating the copy every other replica is using.
  const { store, calls } = holder([oauth("rotated", 60)]);
  let ranLocally = false;

  const result = await store.modify("anthropic", async () => {
    ranLocally = true;
    return oauth("locally-refreshed", 60);
  });

  assert.equal(ranLocally, false, "the runner must not refresh the fleet's credential");
  assert.equal((result as { access: string }).access, "rotated");
  assert.equal(calls[0]?.method, "POST");
  assert.match(calls[0]?.url ?? "", /\/v1\/credentials\/anthropic\/refresh$/);
});

test("a 404 from the holder reads as 'not seeded yet', not as an error", async () => {
  // A fleet brought up before `npm run llm:login` must idle, exactly as a single runner
  // with an empty PVC does today — not crash-loop.
  const { store } = holder([undefined]);
  assert.equal(await store.read("anthropic"), undefined);
});

test("a credential that vanishes from the holder is dropped from the cache", async () => {
  const { store, calls } = holder([oauth("a1", 2), undefined]);

  await store.read("anthropic");
  assert.equal(await store.read("anthropic"), undefined);

  // A third read must go back to the holder rather than serve the stale one.
  assert.equal(await store.read("anthropic"), undefined);
  assert.equal(calls.length, 3);
});

test("delete is refused — a runner cannot log the fleet out", async () => {
  const { store } = holder([oauth("a1", 60)]);
  await assert.rejects(() => store.delete("anthropic"), CredentialReadOnlyError);
});

test("an unreachable holder fails with a message naming it and no token material", async () => {
  const store = new HttpCredentialStore({
    baseUrl: "http://holder.invalid",
    token: "super-secret-token",
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.rejects(
    () => store.read("anthropic"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialHolderError);
      assert.match(error.message, /holder\.invalid/);
      assert.ok(!error.message.includes("super-secret-token"));
      return true;
    },
  );
});

test("a non-404 error status is surfaced rather than read as 'no credential'", async () => {
  // A 500 that resolved undefined would look identical to an un-seeded holder, and the
  // runner would idle forever on what is actually a broken dependency.
  const store = new HttpCredentialStore({
    baseUrl: "http://holder.invalid",
    fetch: async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
  });

  await assert.rejects(() => store.read("anthropic"), CredentialHolderError);
});

test("the bearer token is presented when one is configured", async () => {
  const calls: Call[] = [];
  const store = new HttpCredentialStore({
    baseUrl: "http://holder.invalid/",
    token: "t0ken",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify({ credential: oauth("a1", 60) }), { status: 200 });
    },
  });

  await store.read("anthropic");
  assert.equal(calls[0]?.authorization, "Bearer t0ken");
  // The trailing slash on baseUrl must not produce a doubled one in the path.
  assert.equal(calls[0]?.url, "http://holder.invalid/v1/credentials/anthropic");
});
