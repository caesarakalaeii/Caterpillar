/**
 * The gateway driven by a fake socket speaking the real protocol.
 *
 * Every failure this guards against is SILENT: a bridge that stays connected and never
 * delivers a command looks exactly like a channel nobody typed in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { FleetActivity } from "./activity.ts";
import { DiscordGateway, type GatewayOptions, type SocketLike } from "./gateway.ts";

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
  onMessage: (content: string, author: string, channelId: string) => Promise<void> = () =>
    Promise.resolve(),
  presence?: GatewayOptions["presence"],
  threads?: GatewayOptions["threads"],
): { gateway: DiscordGateway; sockets: Fake[]; slept: number[] } => {
  const sockets: Fake[] = [];
  const slept: number[] = [];

  const gateway = new DiscordGateway({
    token: "bot-token",
    channelId: CHANNEL,
    onMessage,
    ...(presence === undefined ? {} : { presence }),
    ...(threads === undefined ? {} : { threads }),
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
  d: { channel_id: CHANNEL, content: "!answer SMOKE-1 yes", author: { username: "operator" }, ...over },
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

/* ----------------------------------------------------------------- presence (§7.2) */

const ready = (over: Record<string, unknown> = {}): unknown => ({
  op: 0,
  s: 1,
  t: "READY",
  d: { session_id: "sess-1", resume_gateway_url: "wss://resume.example", ...over },
});

/** A fleet with one running task, already surveyed once. */
const surveyed = (): FleetActivity => {
  const activity = new FleetActivity({ now: () => 1_000 });
  activity.publish([
    { id: asTaskId("ALERT-6155db"), status: "running", phase: "implementing" },
  ]);
  return activity;
};

test("IDENTIFY carries the presence, rather than sending it as a second frame", async () => {
  // A separate opcode 3 after IDENTIFY would leave the bot briefly online with no activity.
  // On a fleet that reconnects during every rollout that is a visible flicker to no purpose.
  const built = build(undefined, surveyed());
  const { socket, stop } = await start(built);

  socket.emit(hello());
  const identify = socket.sent.find((p) => (p as { op: number }).op === 2) as {
    d: { presence?: { activities: { name: string; type: number }[]; status: string } };
  };

  assert.ok(identify.d.presence !== undefined, "a fresh connection must not be briefly blank");
  assert.equal(identify.d.presence.activities[0]?.name, "ALERT-6155db · implementing");
  assert.equal(identify.d.presence.activities[0]?.type, 3, "Watching");
  assert.equal(identify.d.presence.status, "online");

  await stop();
});

test("a gateway with no presence source identifies exactly as it did before", async () => {
  // The field must be ABSENT and not empty: Discord reads a `presence` carrying no
  // activities as an instruction to clear one.
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello());
  const identify = socket.sent.find((p) => (p as { op: number }).op === 2) as {
    d: Record<string, unknown>;
  };

  assert.equal("presence" in identify.d, false);
  await stop();
});

test("a change after READY is sent as an opcode 3 on that connection", async () => {
  const activity = surveyed();
  const built = build(undefined, activity);
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(ready());

  activity.publish([{ id: asTaskId("TASK-9"), status: "awaiting-human", phase: "review" }]);

  const updates = socket.sent.filter((p) => (p as { op: number }).op === 3) as {
    d: { activities: { name: string }[] };
  }[];

  assert.equal(updates.length, 1, "the change must reach the live socket");
  assert.equal(updates[0]?.d.activities[0]?.name, "1 waiting for you");

  await stop();
});

test("RESUMED re-sends the presence, because a resume carries no IDENTIFY", async () => {
  // The failure this pins: a runner comes back from a blip and keeps advertising whatever it
  // was doing before it, indefinitely — worst for the runners that were out longest.
  const activity = surveyed();
  const built = build(undefined, activity);
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit({ op: 0, s: 2, t: "RESUMED", d: {} });

  const resumed = socket.sent.filter((p) => (p as { op: number }).op === 3) as {
    d: { activities: { name: string }[] };
  }[];
  assert.equal(resumed.length, 1, "a resumed session must be told the presence again");
  assert.equal(resumed[0]?.d.activities[0]?.name, "ALERT-6155db · implementing");

  await stop();
});

test("READY does NOT re-send, because the IDENTIFY beside it already carried the presence", async () => {
  // A per-connection allowance spent repeating what Discord was just told is the one that is
  // not available when the state actually changes.
  const built = build(undefined, surveyed());
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(ready());

  assert.equal(socket.sent.filter((p) => (p as { op: number }).op === 3).length, 0);
  await stop();
});

test("a presence change after the socket is gone is not written to it", async () => {
  // Surveys keep running across a disconnect. Writing into a disposed socket is the bug.
  const activity = surveyed();
  const built = build(undefined, activity);
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(ready());
  const before = socket.sent.length;

  socket.fire("close");
  await new Promise((r) => setImmediate(r));
  activity.publish([{ id: asTaskId("TASK-4"), status: "running", phase: "planning" }]);

  assert.equal(socket.sent.length, before, "nothing may be sent on a closed connection");
  await stop();
});

test("connected() is false until IDENTIFY has been answered, and false again after close", async () => {
  // The standalone bot's readiness probe reads this. An open socket that has not
  // identified delivers nothing, so reporting it ready would keep a pod in the Service
  // that answers no human — `supervisor/loop.ts:~287`'s lesson, one process along.
  const built = build();
  const { socket, stop } = await start(built);

  assert.equal(built.gateway.connected(), false, "a dialled socket is not yet a working bot");

  socket.emit(hello());
  assert.equal(built.gateway.connected(), false, "IDENTIFY sent is still not IDENTIFY answered");

  socket.emit({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1" } });
  assert.equal(built.gateway.connected(), true);

  socket.fire("close");
  assert.equal(built.gateway.connected(), false, "a closed socket must not report ready");

  await stop();
});

test("a zombie socket reports disconnected, not merely logs", async () => {
  // Open, and delivering nothing. This is the failure that looks identical to an idle
  // channel, and the whole reason the probe cannot just be "the HTTP server is up".
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello(1_000));
  socket.emit({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1" } });
  assert.equal(built.gateway.connected(), true);

  // Two beats with no ACK between them is the zombie test the gateway already makes.
  await new Promise((r) => setTimeout(r, 5));
  socket.fire("close");

  assert.equal(built.gateway.connected(), false);
  await stop();
});

test("a RESUMED connection is connected again", async () => {
  // A reconnect is the ordinary case during a rollout, and a bot that never reported
  // ready again after resuming would be restarted forever by its own probe.
  const built = build();
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit({ op: 0, s: 1, t: "RESUMED", d: {} });

  assert.equal(built.gateway.connected(), true);
  await stop();
});

/* ─────────────────── which channels reach the bridge (§7, §14.3) ─────────────────── */

const THREAD = "thread-77";

/**
 * Drive a message from `THREAD` through the real socket path and report whether it landed.
 *
 * Deliberately NOT a direct `bridge.handleMessage` call. Every existing test of the
 * unbound-thread reply called the bridge directly, which is exactly why the gap this
 * covers survived: the branch was reachable in a test and unreachable in production,
 * because the gateway dropped the message before the bridge could answer.
 */
const deliverFromThread = async (
  threads: GatewayOptions["threads"],
): Promise<{ delivered: string[] }> => {
  const delivered: string[] = [];
  const built = build(
    (_content, _author, channelId) => {
      delivered.push(channelId);
      return Promise.resolve();
    },
    undefined,
    threads,
  );
  const { socket, stop } = await start(built);

  socket.emit(hello());
  socket.emit(messageCreate({ channel_id: THREAD }));
  // The routing decision may be asynchronous (a parent lookup), so let it settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await stop();

  return { delivered };
};

test("a message in a bound thread reaches the bridge without any lookup", async () => {
  let lookups = 0;
  const { delivered } = await deliverFromThread({
    knows: (channelId) => channelId === THREAD,
    deliverable: () => {
      lookups += 1;
      return Promise.resolve(true);
    },
  });

  assert.deepEqual(delivered, [THREAD]);
  assert.equal(lookups, 0, "a known thread must stay on the synchronous path");
});

test("a message in an UNBOUND thread of our channel still reaches the bridge", async () => {
  // The whole point. The standalone bot's index arrives over Redis and is legitimately
  // behind, so a thread bound seconds ago — or one no supervisor has published yet — must
  // still be delivered, or the bridge's honest "I do not know which task this thread
  // belongs to yet" is dead code and the human gets silence.
  const { delivered } = await deliverFromThread({
    knows: () => false,
    deliverable: () => Promise.resolve(true),
  });

  assert.deepEqual(delivered, [THREAD], "an unbound thread of ours must be answerable");
});

test("a message in an unrelated channel is still dropped", async () => {
  // The filter still has to filter: this bot shares a guild with channels that are none
  // of its business, and answering in one would be worse than missing a reply.
  const { delivered } = await deliverFromThread({
    knows: () => false,
    deliverable: () => Promise.resolve(false),
  });

  assert.deepEqual(delivered, [], "a channel that is not ours must never reach the bridge");
});

test("without a router the filter behaves exactly as it did in-process", async () => {
  // The supervisor's in-process path supplies a bare `ThreadIndex` with no `deliverable`,
  // and must keep dropping unknown channels rather than gaining a REST call per message.
  const { delivered } = await deliverFromThread({ knows: () => false });

  assert.deepEqual(delivered, []);
});
