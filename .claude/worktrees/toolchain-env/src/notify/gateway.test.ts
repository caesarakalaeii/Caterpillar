/**
 * The gateway driven by a fake socket speaking the real protocol.
 *
 * Every failure this guards against is SILENT: a bridge that stays connected and never
 * delivers a command looks exactly like a channel nobody typed in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_LOGGER } from "../obs/log.ts";
import { DiscordGateway, type SocketLike } from "./gateway.ts";

const CHANNEL = "999";

interface Fake extends SocketLike {
  readonly sent: unknown[];
  emit(payload: unknown): void;
  fire(type: "open" | "error" | "close"): void;
  readonly closed: boolean;
}

const fakeSocket = (): Fake => {
  const messageHandlers: ((event: { data: unknown }) => void)[] = [];
  const others = new Map<string, (() => void)[]>();
  const sent: unknown[] = [];
  let closed = false;

  return {
    sent,
    get closed() {
      return closed;
    },
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      closed = true;
    },
    addEventListener: (type: string, handler: unknown): void => {
      if (type === "message") {
        messageHandlers.push(handler as (event: { data: unknown }) => void);
        return;
      }
      others.set(type, [...(others.get(type) ?? []), handler as () => void]);
    },
    emit: (payload: unknown) => {
      for (const handler of messageHandlers) handler({ data: JSON.stringify(payload) });
    },
    fire: (type) => {
      for (const handler of others.get(type) ?? []) handler();
    },
  } as Fake;
};

const build = (
  onMessage: (content: string, author: string) => Promise<void> = () => Promise.resolve(),
): { gateway: DiscordGateway; sockets: Fake[]; slept: number[] } => {
  const sockets: Fake[] = [];
  const slept: number[] = [];

  const gateway = new DiscordGateway({
    token: "bot-token",
    channelId: CHANNEL,
    onMessage,
    logger: SILENT_LOGGER,
    random: () => 0.5,
    sleep: async (ms) => {
      slept.push(ms);
    },
    socket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  return { gateway, sockets, slept };
};

const hello = (interval = 1_000): unknown => ({ op: 10, d: { heartbeat_interval: interval } });

const messageCreate = (over: Record<string, unknown> = {}): unknown => ({
  op: 0,
  s: 5,
  t: "MESSAGE_CREATE",
  d: { channel_id: CHANNEL, content: "!answer SMOKE-1 yes", author: { username: "caesar" }, ...over },
});

/** Runs the gateway until the first socket exists, then hands it back. */
const start = async (
  built: ReturnType<typeof build>,
): Promise<{ socket: Fake; stop: () => Promise<void> }> => {
  const controller = new AbortController();
  const running = built.gateway.run(controller.signal);
  while (built.sockets.length === 0) await new Promise((r) => setImmediate(r));
  const socket = built.sockets[0];
  assert.ok(socket !== undefined);

  return {
    socket,
    stop: async () => {
      controller.abort();
      await running;
    },
  };
};

test("HELLO is answered with IDENTIFY carrying the message-content intent", async () => {
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello());
  const identify = socket.sent.find((p) => (p as { op: number }).op === 2) as {
    d: { token: string; intents: number };
  };

  assert.ok(identify !== undefined, "a connection that never identifies stays silent forever");
  assert.equal(identify.d.token, "bot-token");
  // 1<<9 GUILD_MESSAGES | 1<<15 MESSAGE_CONTENT. Without the latter every message
  // arrives with empty content and no command ever matches.
  assert.equal(identify.d.intents & (1 << 15), 1 << 15, "MESSAGE_CONTENT intent is required");
  assert.equal(identify.d.intents & (1 << 9), 1 << 9, "GUILD_MESSAGES intent is required");

  await stop();
});

test("a command in the watched channel reaches the handler", async () => {
  const seen: string[] = [];
  const built = build(async (content) => {
    seen.push(content);
  });
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(messageCreate());
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seen, ["!answer SMOKE-1 yes"]);
  await stop();
});

test("bots, webhooks and other channels are ignored", async () => {
  // The supervisor POSTS into this channel via webhook, and its question notification
  // ends with a literal "!answer ..." hint. Without these guards the bridge answers its
  // own questions the moment a webhook is sealed.
  const seen: string[] = [];
  const built = build(async (content) => {
    seen.push(content);
  });
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(messageCreate({ author: { username: "caterpillar", bot: true } }));
  socket.emit(messageCreate({ webhook_id: "12345" }));
  socket.emit(messageCreate({ channel_id: "another-channel" }));
  socket.emit(messageCreate({ content: "" }));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seen, []);
  await stop();
});

test("the first heartbeat is jittered rather than immediate", async () => {
  // Every client reconnecting after an outage would otherwise beat in lockstep.
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello(1_000));
  assert.ok(built.slept.includes(500), `expected a jittered first beat, slept ${built.slept}`);

  await stop();
});

test("a heartbeat that is never ACKed tears the connection down", async () => {
  // A zombie socket stays open and delivers nothing. Waiting on it is indistinguishable
  // from an idle channel, forever.
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello(1_000));
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 2_100)); // two intervals, no ACK

  assert.equal(socket.closed, true, "an unACKed heartbeat must not be waited on forever");
  await stop();
});

test("the sequence number is tracked from every payload, for RESUME", async () => {
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit({ op: 0, s: 7, t: "READY", d: { session_id: "sess-1" } });
  socket.emit({ op: 0, s: 42, t: "TYPING_START", d: {} });
  socket.emit({ op: 1 }); // Discord asking for an immediate beat
  socket.emit({ op: 11 });

  // Reconnect: RESUME must replay from the LAST sequence seen, not the last dispatch
  // the handler cared about.
  socket.fire("close");
  while (built.sockets.length < 2) await new Promise((r) => setImmediate(r));
  const next = built.sockets[1];
  assert.ok(next !== undefined);
  next.emit(hello());

  const resume = next.sent.find((p) => (p as { op: number }).op === 6) as {
    d: { seq: number; session_id: string };
  };
  assert.ok(resume !== undefined, "a reconnect with a session must RESUME, not re-IDENTIFY");
  assert.equal(resume.d.seq, 42);
  assert.equal(resume.d.session_id, "sess-1");

  await stop();
});

test("an invalid session forces a fresh IDENTIFY instead of resuming forever", async () => {
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1" } });
  socket.emit({ op: 9, d: false });

  while (built.sockets.length < 2) await new Promise((r) => setImmediate(r));
  const next = built.sockets[1];
  assert.ok(next !== undefined);
  next.emit(hello());

  assert.equal(
    next.sent.some((p) => (p as { op: number }).op === 6),
    false,
    "resuming an invalidated session is refused identically, forever",
  );
  assert.ok(next.sent.some((p) => (p as { op: number }).op === 2), "must IDENTIFY afresh");

  await stop();
});
