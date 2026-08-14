/**
 * The bridge, driven against a stubbed Discord.
 *
 * The contract under test is the timing one, because it is the only part of this that
 * cannot be recovered by reading the code later: Discord gives an interaction 3 seconds
 * to be acknowledged and 15 minutes of token life, while the supervisor settles a
 * request whenever its poll loop next comes round — which may be hours. So every
 * assertion here is a variation on ACKNOWLEDGE FIRST, DELIVER SEPARATELY.
 *
 * Nothing here talks to a socket. The gateway hands the bridge a payload; this hands it
 * the same payload directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskState } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { ChatInbox, type ChatOutcome } from "../supervisor/inbox.ts";
import { summarise, TaskSnapshot } from "../supervisor/snapshot.ts";
import { DiscordBot } from "./bot.ts";
import { DiscordBridge } from "./bridge.ts";
import { encodeCustomId } from "./components.ts";
import { INTERACTION, RESPONSE, type Interaction } from "./interactions.ts";
import { ANSWER_FIELD } from "./slash.ts";

const TASK = asTaskId("GH-acme-widget-42");
const CHANNEL = "1537550186388258866";
const API = "https://discord.test/api/v10";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const state = (over: Partial<TaskState> = {}): TaskState => ({
  id: TASK,
  status: "awaiting-human",
  phase: "implementing",
  requires: [],
  sessions: 3,
  limits: { maxSessions: 20 },
  usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
  progress: { lastProgressSession: 2, noProgressStreak: 1 },
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T01:00:00.000Z",
  ...over,
});

const harness = (): {
  readonly bridge: DiscordBridge;
  readonly inbox: ChatInbox;
  readonly calls: Call[];
} => {
  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "999" }), { status: 200 }));
  };

  const snapshot = new TaskSnapshot();
  snapshot.replace([summarise(state()), summarise(state({ id: asTaskId("GH-acme-widget-7"), status: "ready" }))]);

  const inbox = new ChatInbox();
  const bridge = new DiscordBridge({
    bot: new DiscordBot({ token: "bot-token", channelId: CHANNEL, fetch, apiBase: API }),
    inbox,
    snapshot,
    logger: SILENT_LOGGER,
    fetch,
  });

  return { bridge, inbox, calls };
};

const interaction = (over: Partial<Interaction>): Interaction => ({
  id: "i1",
  token: "interaction-token",
  type: INTERACTION.command,
  channel_id: CHANNEL,
  member: { user: { id: "u1", username: "operator" } },
  ...over,
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Stand in for the poll loop: wait for the request to be queued, then settle it. */
const settleQueued = async (inbox: ChatInbox, outcome: ChatOutcome): Promise<void> => {
  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  assert.notEqual(inbox.size, 0, "nothing was queued for the loop");
  for (const request of inbox.drain()) request.settle(outcome);
};

const callback = (calls: readonly Call[]): Call => {
  const found = calls.find((call) => call.url.includes("/callback"));
  assert.ok(found !== undefined, "the interaction was never acknowledged");
  return found;
};

const posted = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.url.endsWith("/messages"));

test("a listing is answered outright, without going near the loop", async () => {
  // `/tasks` through the inbox would mean waiting for the poll loop, which can be
  // mid-session for hours — the answer would arrive after Discord had already declared
  // the interaction failed.
  const { bridge, inbox, calls } = harness();

  await bridge.handleInteraction(interaction({ data: { name: "tasks" } }));

  assert.equal(inbox.size, 0, "a read must never queue work for the loop");
  assert.equal(callback(calls).body["type"], RESPONSE.message);
  const data = callback(calls).body["data"] as { readonly content: string };
  assert.match(data.content, /GH-acme-widget-42/);
});

test("an answer is acknowledged first and its outcome posted afterwards", async () => {
  const { bridge, inbox, calls } = harness();

  const handled = bridge.handleInteraction(
    interaction({
      data: {
        name: "answer",
        options: [
          { name: "task", value: TASK },
          { name: "text", value: "use the existing migration path" },
        ],
      },
    }),
  );

  // The acknowledgement must already be out before the loop has done anything at all.
  await settleQueued(inbox, { kind: "applied", index: 3 });
  await handled;

  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.message);

  const messages = posted(calls);
  assert.equal(messages.length, 1, "the outcome must arrive as its own channel message");
  assert.match(String((messages[0]?.body ?? {})["content"]), /Answered \*\*GH-acme-widget-42\*\*/);
});

test("a click disables the buttons it was made with", async () => {
  // Two clicks on the same button would queue the same write twice. Disabling them in
  // the acknowledgement is what makes the second one impossible.
  const customId = encodeCustomId({ verb: "park", task: TASK });
  assert.ok(customId !== undefined);
  const { bridge, inbox, calls } = harness();

  const handled = bridge.handleInteraction(
    interaction({
      type: INTERACTION.component,
      data: { custom_id: customId },
      message: {
        id: "m1",
        content: "**GH-acme-widget-42** needs input",
        components: [
          { type: 1, components: [{ type: 2, style: 2, label: "Cancel", custom_id: customId }] },
        ],
      },
    }),
  );

  await settleQueued(inbox, { kind: "parked" });
  await handled;

  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.updateMessage, "a click must rewrite its own message");

  const data = ack.body["data"] as {
    readonly content: string;
    readonly components: readonly { readonly components: readonly { readonly disabled?: boolean }[] }[];
  };
  assert.match(data.content, /needs input/, "the original message must survive the rewrite");
  assert.match(data.content, /queued by operator/);
  assert.equal(data.components[0]?.components[0]?.disabled, true);
});

test("the Answer button opens a modal and writes nothing yet", async () => {
  const customId = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(customId !== undefined);
  const { bridge, inbox, calls } = harness();

  await bridge.handleInteraction(
    interaction({ type: INTERACTION.component, data: { custom_id: customId } }),
  );

  assert.equal(inbox.size, 0);
  assert.equal(callback(calls).body["type"], RESPONSE.modal);
});

test("a submitted modal answers the task the button came from", async () => {
  const customId = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(customId !== undefined);
  const { bridge, inbox, calls } = harness();

  const handled = bridge.handleInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [{ components: [{ custom_id: ANSWER_FIELD, value: "yes, proceed" }] }],
      },
    }),
  );

  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  const queued = inbox.drain();
  assert.deepEqual(
    queued.map((request) => ({
      kind: request.kind,
      task: request.kind === "brainstorm" ? undefined : request.task,
    })),
    [{ kind: "answer", task: TASK }],
  );
  for (const request of queued) request.settle({ kind: "applied", index: 3 });
  await handled;

  assert.equal(posted(calls).length, 1);
});

test("autocomplete answers from the snapshot, ranked so a waiting task comes first", async () => {
  const { bridge, calls } = harness();

  await bridge.handleInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "answer", options: [{ name: "task", value: "widget", focused: true }] },
    }),
  );

  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.autocomplete);
  const data = ack.body["data"] as { readonly choices: readonly { readonly value: string }[] };
  assert.equal(data.choices[0]?.value, TASK, "the task awaiting a human must be suggested first");
});

test("a command from another channel is refused, not served", async () => {
  // §7 restricts the bot to one channel deliberately: a bot that acts anywhere it is
  // visible is a bot anyone in the guild can drive. A guild-registered command can be
  // invoked from any of them.
  const { bridge, inbox, calls } = harness();

  await bridge.handleInteraction(
    interaction({ channel_id: "8888", data: { name: "cancel", options: [{ name: "task", value: TASK }] } }),
  );

  assert.equal(inbox.size, 0);
  const data = callback(calls).body["data"] as { readonly content: string };
  assert.match(data.content, /I only act in/);
});

test("a stale button is answered rather than left showing a failure", async () => {
  // Silently dropping an interaction shows the person who clicked a permanent "This
  // interaction failed" with no explanation.
  const { bridge, inbox, calls } = harness();

  await bridge.handleInteraction(
    interaction({ type: INTERACTION.component, data: { custom_id: "c0:ans:OLD-TASK" } }),
  );

  assert.equal(inbox.size, 0);
  assert.equal(callback(calls).body["type"], RESPONSE.message);
});

test("a typed !answer takes the same path as the slash command", async () => {
  const { bridge, inbox, calls } = harness();

  const handled = bridge.handleMessage(`!answer ${TASK} use the existing path`, "operator", CHANNEL);
  await settleQueued(inbox, { kind: "applied", index: 3 });
  await handled;

  assert.equal(calls.length, 1, "a typed command has no interaction to acknowledge");
  assert.match(String((posted(calls)[0]?.body ?? {})["content"]), /Answered/);
});
