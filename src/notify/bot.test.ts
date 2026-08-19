/**
 * `DiscordBot.parentChannel`, driven against a REAL HTTP server over the REAL global
 * `fetch`.
 *
 * That combination is the point of this file rather than an accident of style. This
 * method shipped broken — it sent a GET carrying `body: ""`, which Node's `fetch` refuses
 * with a synchronous `TypeError` while building the request — and it shipped broken
 * precisely because it had no test, while the code that consumes it was covered only
 * through an injected `parentOf` stub. A stub takes `init` and reads what it likes from
 * it; it never applies the platform's rules, so it cannot reproduce a failure that
 * happens inside `fetch` itself before a single byte moves.
 *
 * So: a loopback server, no injected fetch, and assertions on what arrived on the wire.
 * `parentChannel` swallows every failure into `undefined` by design (its caller's fallback
 * is the same either way), which is what made the defect invisible in production — so a
 * test that only checked "it did not throw" would be worthless here. Each case below
 * pins the resolved VALUE, and the happy path additionally pins the method and headers
 * the server actually received.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { DiscordBot } from "./bot.ts";

interface Received {
  method?: string | undefined;
  url?: string | undefined;
  authorization?: string | undefined;
  body?: string | undefined;
}

interface Harness {
  readonly bot: DiscordBot;
  readonly received: Received;
  readonly close: () => Promise<void>;
}

/** A loopback Discord stand-in. `respond` decides what the API says back. */
const harness = async (
  respond: (send: (status: number, body: string) => void) => void,
): Promise<Harness> => {
  const received: Received = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.method = req.method;
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = Buffer.concat(chunks).toString();
      respond((status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  return {
    // No `fetch` and no `sleep` injected: this is how `src/bot.ts` constructs it.
    bot: new DiscordBot({ token: "tok", channelId: "main", apiBase: `http://127.0.0.1:${port}` }),
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test("a thread's parent channel is read from the API over a real GET", async () => {
  const { bot, received, close } = await harness((send) => {
    send(200, JSON.stringify({ id: "thread-1", parent_id: "main" }));
  });

  try {
    const parent = await bot.parentChannel("thread-1");

    // The value, not just the absence of a throw. Before the fix this was `undefined`
    // for every input, because the request died in `fetch` before reaching any server.
    assert.equal(parent, "main", "the parent channel must come back from the API");

    assert.equal(received.method, "GET");
    assert.equal(received.url, "/channels/thread-1");
    assert.equal(received.authorization, "Bot tok", "the bot token authorises the lookup");
    assert.equal(received.body, "", "a GET carries no body — the server must receive none");
  } finally {
    await close();
  }
});

test("a top-level channel reports no parent", async () => {
  // Discord answers `parent_id: null` for a channel that is not a thread. That must read
  // as "no parent", not as a failure, and not as the string "null".
  const { bot, close } = await harness((send) => {
    send(200, JSON.stringify({ id: "main", parent_id: null }));
  });

  try {
    assert.equal(await bot.parentChannel("main"), undefined);
  } finally {
    await close();
  }
});

test("a channel the bot cannot see resolves to undefined rather than throwing", async () => {
  // A 404 is permanent — `postJson` does not retry it — and the caller treats an unknown
  // parent as "not our thread". Throwing here would take down the gateway's filter.
  const { bot, close } = await harness((send) => {
    send(404, JSON.stringify({ message: "Unknown Channel" }));
  });

  try {
    assert.equal(await bot.parentChannel("nope"), undefined);
  } finally {
    await close();
  }
});

test("a malformed body resolves to undefined rather than throwing", async () => {
  const { bot, close } = await harness((send) => {
    send(200, "not json at all");
  });

  try {
    assert.equal(await bot.parentChannel("thread-1"), undefined);
  } finally {
    await close();
  }
});
