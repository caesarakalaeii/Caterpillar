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
import { InMemoryChatQueue } from "../redis/inbox.ts";
import { InMemorySnapshotStore } from "../redis/snapshot.ts";
import { type ChatOutcome } from "../supervisor/inbox.ts";
import { summarise } from "../supervisor/snapshot.ts";
import { DiscordBot } from "./bot.ts";
import { DiscordBridge } from "./bridge.ts";
import { encodeCustomId } from "./components.ts";
import { INTERACTION, RESPONSE, type Interaction } from "./interactions.ts";
import { MAX_REMEMBERED_MESSAGES, MessageIndex } from "./messages.ts";
import { ThreadIndex } from "./threads.ts";
import { ANSWER_FIELD, DONE_REASON_FIELD } from "./slash.ts";

const TASK = asTaskId("GH-acme-widget-42");
const CHANNEL = "1537550186388258866";
const THREAD = "1537785980415778816";
/**
 * A brainstorm thread whose task is PARKED, and whose id is derived from it.
 *
 * `BS-<threadId>` is a brainstorm's id by construction (§14.3), which is what lets the bridge
 * resolve a thread the index has no binding for — the case `/resume` is always in.
 */
const PARKED_THREAD = "1539374658363854934";
const PARKED_TASK = asTaskId(`BS-${PARKED_THREAD}`);
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

const harness = (
  over: {
    readonly threads?: ThreadIndex;
    readonly leadership?: { readonly held: () => boolean };
    readonly repos?: { reachable: () => Promise<readonly string[]> };
    /** False makes every reaction fail, as an installation without `ADD_REACTIONS` does. */
    readonly reactions?: boolean;
    readonly router?: { deliverable: (channelId: string) => Promise<boolean> };
    /**
     * What a GET of a single message says back, for the REST tier of reply targeting.
     *
     * Absent means Discord refuses the read — a message the bot cannot see, which is the
     * case that has to fall through to rank rather than throw.
     */
    readonly fetchedMessage?: { readonly content: string };
  } = {},
): {
  readonly bridge: DiscordBridge;
  readonly inbox: InMemoryChatQueue;
  readonly calls: Call[];
  readonly messages: MessageIndex;
} => {
  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    // Discord's own answer to a bot without `ADD_REACTIONS`, so the fallback is exercised
    // against the status the real API returns rather than a thrown stub.
    if (over.reactions === false && url.includes("/reactions/")) {
      return Promise.resolve(new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403 }));
    }
    // A GET of one message: `/channels/<id>/messages/<id>`, as against the POST to
    // `/channels/<id>/messages` that sends one.
    if ((init?.method ?? "GET") === "GET" && /\/messages\/[^/]+$/.test(url)) {
      return over.fetchedMessage === undefined
        ? Promise.resolve(new Response(JSON.stringify({ message: "Unknown Message" }), { status: 404 }))
        : Promise.resolve(new Response(JSON.stringify(over.fetchedMessage), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "999" }), { status: 200 }));
  };

  const snapshot = new InMemorySnapshotStore();
  void snapshot.replace([
    summarise(state()),
    summarise(state({ id: asTaskId("GH-acme-widget-7"), status: "ready" })),
    summarise(state({ id: PARKED_TASK, status: "parked", chat: { threadId: PARKED_THREAD } })),
  ]);

  const inbox = new InMemoryChatQueue();
  const messages = new MessageIndex();
  const bridge = new DiscordBridge({
    bot: new DiscordBot({ token: "bot-token", channelId: CHANNEL, fetch, apiBase: API, messages }),
    inbox,
    snapshot,
    logger: SILENT_LOGGER,
    ...(over.threads === undefined ? {} : { threads: over.threads }),
    // Absent means "act", so every test written before the fleet existed still applies.
    ...(over.leadership === undefined ? {} : { leadership: over.leadership }),
    ...(over.repos === undefined ? {} : { repos: over.repos }),
    ...(over.router === undefined ? {} : { router: over.router }),
    fetch,
  });

  return { bridge, inbox, calls, messages };
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
const settleQueued = async (inbox: InMemoryChatQueue, outcome: ChatOutcome): Promise<void> => {
  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  assert.notEqual(inbox.size, 0, "nothing was queued for the loop");
  for (const request of await inbox.drain()) request.settle(outcome);
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

test("the Mark done button asks for a reason before anything is written", async () => {
  const customId = encodeCustomId({ verb: "done", task: TASK });
  assert.ok(customId !== undefined);
  const { bridge, inbox, calls } = harness();

  await bridge.handleInteraction(
    interaction({ type: INTERACTION.component, data: { custom_id: customId } }),
  );

  assert.equal(inbox.size, 0, "the click itself must force nothing");
  assert.equal(callback(calls).body["type"], RESPONSE.modal);
});

test("the Mark done modal forces the task done, naming whoever submitted it", async () => {
  // The author is not on the intent the parser produces — the bridge is the only place that
  // knows who pressed the button, and the journal entry is unauditable without it.
  const customId = encodeCustomId({ verb: "done", task: TASK });
  assert.ok(customId !== undefined);
  const { bridge, inbox, calls } = harness();

  const handled = bridge.handleInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [{ components: [{ custom_id: DONE_REASON_FIELD, value: "obsolete" }] }],
      },
    }),
  );

  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  const queued = await inbox.drain();
  assert.deepEqual(queued.map((request) => ({ ...request, settle: undefined })), [
    {
      kind: "force-done",
      task: TASK,
      reason: "obsolete",
      author: "operator",
      settle: undefined,
    },
  ]);
  for (const request of queued) request.settle({ kind: "forced-done" });
  await handled;

  assert.equal(posted(calls).length, 1);
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
  const queued = await inbox.drain();
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

test("an option button queues the answer itself, with no modal in between", async () => {
  // The whole point of the feature: one press, no typing. So it goes straight to the inbox,
  // where a modal submission ends up, rather than opening one.
  const customId = encodeCustomId({ verb: "opt", task: TASK, arg: "1" });
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
          { type: 1, components: [{ type: 2, style: 1, label: "Write a new one", custom_id: customId }] },
        ],
      },
    }),
  );

  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  const queued = await inbox.drain();
  assert.deepEqual(
    queued.map((request) => ({ ...request, settle: undefined })),
    [{ kind: "answer-option", task: TASK, option: 1, settle: undefined }],
  );
  for (const request of queued) request.settle({ kind: "applied", index: 3 });
  await handled;

  // And the buttons it was pressed on are disabled, so the same answer cannot be sent twice.
  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.updateMessage);
  const data = ack.body["data"] as {
    readonly components: readonly { readonly components: readonly { readonly disabled?: boolean }[] }[];
  };
  assert.equal(data.components[0]?.components[0]?.disabled, true);
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

test("a button in one of our threads works instead of being refused", () => {
  // It was not: the channel guard compared against the configured channel alone, so
  // every Answer button posted into a brainstorm thread answered "I only act in
  // #caterpillar" — dead on arrival, in the one place questions are asked.
  const customId = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(customId !== undefined);

  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, calls } = harness({ threads });

  return bridge
    .handleInteraction(
      interaction({ type: INTERACTION.component, channel_id: THREAD, data: { custom_id: customId } }),
    )
    .then(() => {
      assert.equal(callback(calls).body["type"], RESPONSE.modal, "it must open the modal");
    });
});

test("a button from a channel that is neither ours nor a thread is still refused", () => {
  const { bridge, calls } = harness({ threads: new ThreadIndex() });

  return bridge
    .handleInteraction(interaction({ channel_id: "8888", data: { name: "tasks" } }))
    .then(() => {
      const data = callback(calls).body["data"] as { readonly content: string };
      assert.match(data.content, /I only act in/);
    });
});

test("plain chat in a thread is submitted as that task's answer", async () => {
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleMessage("we want B", "operator", THREAD);
  await settleQueued(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.match(String((posted(calls)[0]?.body ?? {})["content"]), /Answered/);
});

test("chatting while the agent is busy is acknowledged on the message, not in the thread", async () => {
  // §7.1 chose SILENCE here, to stop a conversation of many short replies becoming a wall of
  // receipts. It was right about the noise and wrong about the silence: "the session has it"
  // and "it was discarded" looked identical, and until §7.3 the second was what happened.
  //
  // So the acknowledgement moves onto the human's OWN message. No new line in the thread, and
  // no ambiguity about whether anything received it.
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleMessage("actually, hold on", "operator", THREAD, "5551212");
  await settleQueued(inbox, { kind: "steered" });
  await handled;

  assert.equal(posted(calls).length, 0, "a steer must not add a line to the conversation");
  const reaction = calls.find((call) => call.url.includes("/reactions/"));
  assert.ok(reaction !== undefined, "the human's own message should carry the acknowledgement");
  assert.equal(reaction?.method, "PUT");
  assert.match(reaction?.url ?? "", /messages\/5551212\/reactions/);
});

test("a steer the bot cannot react to is acknowledged in words instead", async () => {
  // Reactions need `ADD_REACTIONS`, which an existing installation may never have granted. An
  // ack that silently does not happen is the exact failure this replaced, so the fallback is
  // not optional.
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, inbox, calls } = harness({ threads, reactions: false });

  const handled = bridge.handleMessage("actually, hold on", "operator", THREAD, "5551212");
  await settleQueued(inbox, { kind: "steered" });
  await handled;

  const body = posted(calls)[0]?.body["content"];
  assert.match(String(body), /current step/);
});

test("guidance for a parked task comes back with the way out attached", async () => {
  // The thread of a parked task used to be unbound, so this whole path answered nothing at
  // all — while the park notification that sent the human here asked them to type in it.
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleMessage("the criteria are unmeasurable", "operator", THREAD, "1");
  await settleQueued(inbox, { kind: "guided", notes: 1, resumable: true, roundsCleared: true });
  await handled;

  const message = posted(calls)[0];
  assert.match(String(message?.body["content"]), /round count/);
  const attached = message?.body["components"] as readonly { components: { label?: string }[] }[];
  assert.deepEqual(
    attached?.flatMap((r) => r.components.map((c) => c.label)),
    ["Resume"],
    "a parked task's guidance should not require the human to go and find the command",
  );
});

test("guidance for a task that is already claimable offers no button to press", () => {
  // It is going to run by itself. A Resume button here is an act with no effect, offered to
  // somebody who was told to press it.
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleMessage("one more thing", "operator", THREAD, "1");
  return settleQueued(inbox, { kind: "guided", notes: 2, resumable: false, roundsCleared: false })
    .then(() => handled)
    .then(() => {
      assert.equal(posted(calls)[0]?.body["components"], undefined);
    });
});

test("a brainstorm thread starts talking before the loop has settled anything", async () => {
  // The defect: `startBrainstorm` opened the thread, then AWAITED the loop before saying
  // anything in it or binding it. The loop is blocked for the whole of a session, so the
  // human watched an empty thread with their idea at the top of it and no sign that
  // anything had received it — twenty minutes, in the run this was written from.
  //
  // Nothing here needs the state repo. The task's id is its thread id by construction
  // (§14.3), so both the acknowledgement and the binding are knowable the moment Discord
  // hands back the thread, and neither has to wait for a write.
  const threads = new ThreadIndex();
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleInteraction(
    interaction({
      data: {
        name: "brainstorm",
        options: [
          { name: "topic", value: "make the overlay themeable" },
          { name: "repo", value: "acme/widget" },
        ],
      },
    }),
  );

  // Deliberately BEFORE settling: this is the whole point.
  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();

  const inThread = posted(calls).filter((call) => call.url.includes("/channels/999/"));
  assert.equal(inThread.length, 1, "the thread must say something while the loop is busy");
  assert.match(String(inThread[0]?.body["content"]), /BS-999/);

  assert.equal(
    threads.taskFor("999"),
    asTaskId("BS-999"),
    "an idea typed into the thread before the loop catches up must not be dropped",
  );

  for (const request of await inbox.drain()) request.settle({ kind: "started", task: asTaskId("BS-999") });
  await handled;
});

test("a brainstorm the loop refuses says so in its thread, and stops listening to it", async () => {
  // The other half. Binding early is only safe if a refusal takes the binding back —
  // otherwise a thread nothing owns keeps swallowing everything typed into it, which is
  // exactly what `threadBindings` refuses to do for terminal tasks.
  const threads = new ThreadIndex();
  const { bridge, inbox, calls } = harness({ threads });

  const handled = bridge.handleInteraction(
    interaction({
      data: {
        name: "brainstorm",
        options: [
          { name: "topic", value: "make the overlay themeable" },
          { name: "repo", value: "nobody/widget" },
        ],
      },
    }),
  );

  await settleQueued(inbox, { kind: "refused", reason: "No workspace owns `nobody`." });
  await handled;

  const inThread = posted(calls).filter((call) => call.url.includes("/channels/999/"));
  assert.equal(inThread.length, 2, "the refusal belongs in the thread, under the idea");
  assert.match(String(inThread[1]?.body["content"]), /No workspace owns/);
  assert.equal(threads.taskFor("999"), undefined, "a thread with no task must not be bound");
});

test("a replica that does not hold the chat claim acts on nothing", async () => {
  // Four replicas each ran the gateway and each handled every event, because nothing said
  // one of them should. Reads mostly hid it — Discord accepts one response per interaction
  // token, so three replicas just logged a failure — but `/brainstorm` does not: its id is
  // derived from the thread Discord has just created for it, so four replicas would open
  // four threads and mint four unrelated tasks from one command. `!answer` is worse
  // still: four runners writing the same state repo, which is how a runner ends up with a
  // commit that can never rebase.
  const { bridge, inbox, calls } = harness({ leadership: { held: () => false } });

  await bridge.handleInteraction(
    interaction({
      data: {
        name: "brainstorm",
        options: [
          { name: "topic", value: "make the overlay themeable" },
          { name: "repo", value: "acme/widget" },
        ],
      },
    }),
  );
  await bridge.handleMessage("!answer yes", "operator", THREAD);

  assert.equal(inbox.size, 0, "it must queue nothing for the loop");
  assert.equal(calls.length, 0, "and say nothing to Discord — not even a refusal");
});

test("the replica that holds the claim behaves exactly as before", async () => {
  // The gate must be the only difference. A leadership check that also changed what the
  // holder does would be a second behaviour nobody asked for.
  const { bridge, inbox, calls } = harness({ leadership: { held: () => true } });

  await bridge.handleInteraction(interaction({ data: { name: "tasks" } }));

  assert.equal(inbox.size, 0, "a listing still never queues work");
  assert.match(String((callback(calls).body["data"] as { content: string }).content), /GH-acme-widget-42/);
});

test("a message in a thread with no known binding gets an honest answer, not silence", async () => {
  // Routine for the STANDALONE bot (§7): its index arrives over Redis from the supervisor,
  // so a thread bound seconds ago, or a bot that started before any supervisor, is a
  // thread it does not know yet.
  //
  // Silence is the one unacceptable reply. In a bound thread everything typed IS the
  // answer, so a human typing into one that looks unbound would get nothing back and
  // could not tell that from the agent being busy.
  const { bridge, inbox, calls } = harness({ threads: new ThreadIndex() });

  await bridge.handleMessage("we want B", "operator", THREAD);

  assert.equal(inbox.size, 0, "an unroutable message must not be queued as somebody's answer");
  const said = posted(calls);
  assert.equal(said.length, 1, "the human was told nothing");
  assert.match(String(said[0]?.body["content"]), /do not know which task this thread/i);
  // Answered IN the thread, where the person is looking.
  assert.match(String(said[0]?.url), new RegExp(`/channels/${THREAD}/messages$`));
});

test("a binding that arrives later makes the same thread answerable", async () => {
  // The staleness window closing. Once the supervisor's binding reaches the bot, the
  // thread behaves exactly as it does in the unsplit process.
  const threads = new ThreadIndex();
  const { bridge, inbox, calls } = harness({ threads });

  await bridge.handleMessage("we want B", "operator", THREAD);
  assert.equal(inbox.size, 0);

  threads.replace([[THREAD, TASK]]);
  const handled = bridge.handleMessage("we want B", "operator", THREAD);
  await settleQueued(inbox, { kind: "applied", index: 1 });
  await handled;

  const said = posted(calls);
  assert.match(String(said[said.length - 1]?.body["content"]), /Answered/);
});

test("an ordinary message in the main channel is still ignored", async () => {
  // The unbound-thread reply must not become a reply to everything. The channel carries
  // ordinary conversation, and answering all of it would make the bot unusable.
  const { bridge, inbox, calls } = harness({ threads: new ThreadIndex() });

  await bridge.handleMessage("morning all", "operator", CHANNEL);

  assert.equal(inbox.size, 0);
  assert.deepEqual(calls, [], "the channel is not a thread and silence is correct there");
});

test("the repo box is completed from the workspaces' repos, not from task ids", async () => {
  // The whole point of §9.1.1's second half: `allchat` must find `all-chat` while it is
  // still being typed, so the name that parked a task cannot be committed to at all.
  const { bridge, calls } = harness({
    repos: {
      reachable: () => Promise.resolve(["acme/Caterpillar", "acme/all-chat"]),
    },
  });

  await bridge.handleInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "brainstorm", options: [{ name: "repo", value: "allchat", focused: true }] },
    }),
  );

  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.autocomplete);
  const data = ack.body["data"] as { readonly choices: readonly { readonly value: string }[] };
  assert.deepEqual(
    data.choices.map((choice) => choice.value),
    ["acme/all-chat"],
  );
});

test("a forge that cannot be asked answers with an empty box, not a dead interaction", async () => {
  // An autocomplete accepts one response and no other kind. A throw out of here is a
  // spinner that never resolves, which is worse than no suggestions.
  const { bridge, calls } = harness({
    repos: { reachable: () => Promise.reject(new Error("GitHub 500")) },
  });

  await bridge.handleInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "brainstorm", options: [{ name: "repo", value: "all", focused: true }] },
    }),
  );

  const ack = callback(calls);
  assert.equal(ack.body["type"], RESPONSE.autocomplete);
  const data = ack.body["data"] as { readonly choices: readonly unknown[] };
  assert.deepEqual(data.choices, []);
});

test("a runner with no catalogue still answers the box", async () => {
  // No forge configured for the bridge is a supported shape (a standalone bot process has
  // no credentials at all), and it must behave as it did before the box was completed.
  const { bridge, calls } = harness();

  await bridge.handleInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "brainstorm", options: [{ name: "repo", value: "all", focused: true }] },
    }),
  );

  assert.equal(callback(calls).body["type"], RESPONSE.autocomplete);
});

test("/resume works in a thread NO binding names, and needs no task id", async () => {
  // THE `/resume` bug, and both halves of it at once. `/resume` addresses nothing but parked
  // and failed tasks; bindings used to drop a task the moment it went terminal; and the gate
  // consulted the bindings. So the command was refused with "I only act in #caterpillar and
  // its threads" inside a thread of #caterpillar — the thread of the very task it names.
  //
  // The gate now reads `channel.parent_id`, which Discord sends on every interaction, so this
  // works with an EMPTY index: no binding, no REST call, and nothing that can be stale.
  const { bridge, inbox, calls } = harness({ threads: new ThreadIndex() });

  const handled = bridge.handleInteraction(
    interaction({
      channel_id: PARKED_THREAD,
      channel: { id: PARKED_THREAD, parent_id: CHANNEL },
      data: { name: "resume" },
    }),
  );
  await settleQueued(inbox, { kind: "resumed", from: "parked" });
  await handled;

  // Acknowledged first, as every write is.
  assert.equal(callback(calls).body["type"], RESPONSE.message);
  // And the id came from the thread. `BS-<threadId>` is a brainstorm's id by construction
  // (§14.3), so the thread resolves to a task with no lookup table at all.
  assert.match(String((posted(calls)[0]?.body ?? {})["content"]), /Resumed/);
});

test("a thread of our channel is ours even with no binding and no parent_id", async () => {
  // The fallback for a payload with no `channel` object. Without it the gate would be back to
  // asking the index, which is the question that was wrong.
  const looked: string[] = [];
  const { bridge, inbox, calls } = harness({
    threads: new ThreadIndex(),
    router: {
      deliverable: (channelId) => {
        looked.push(channelId);
        return Promise.resolve(true);
      },
    },
  });

  const handled = bridge.handleInteraction(
    interaction({ channel_id: PARKED_THREAD, data: { name: "resume" } }),
  );
  await settleQueued(inbox, { kind: "resumed", from: "parked" });
  await handled;

  assert.deepEqual(looked, [PARKED_THREAD]);
  assert.notEqual(inbox.size + posted(calls).length, 0);
});

test("a command in an unrelated channel is still refused when it has a parent", async () => {
  // The gate got wider, not absent. A thread of somebody ELSE's channel is not ours, and the
  // parent is exactly what proves it.
  const { bridge, inbox, calls } = harness({ threads: new ThreadIndex() });

  await bridge.handleInteraction(
    interaction({
      channel_id: "8888",
      channel: { id: "8888", parent_id: "7777" },
      data: { name: "resume", options: [{ name: "task", value: TASK }] },
    }),
  );

  assert.equal(inbox.size, 0);
  const data = callback(calls).body["data"] as { readonly content: string };
  assert.match(data.content, /I only act in/);
});

test("a message in the thread of a task that is DONE says so instead of stalling", async () => {
  // `threadBindings` keeps `done` out deliberately — there is nothing to ask a task that
  // passed every gate and merged. Without resolving it anyway, the reply was "I do not know
  // which task this thread belongs to yet — I am still catching up with the supervisor",
  // which is a promise that will never be kept.
  const { bridge, inbox, calls } = harness({ threads: new ThreadIndex() });

  const handled = bridge.handleMessage("what happened to the third task?", "operator", PARKED_THREAD, "1");
  await settleQueued(inbox, { kind: "finished" });
  await handled;

  const content = String((posted(calls)[0]?.body ?? {})["content"]);
  assert.doesNotMatch(content, /catching up/);
  assert.match(content, /brainstorm/);
});

/* ───────────── which task a REPLY is for, in a thread several tasks share (§7.3) ───────────── */

/**
 * The sibling that does NOT own the thread under the rank rule.
 *
 * `threadBindings` ranks `awaiting-human` above `ready`, so with both bound to one thread
 * the binding names `TASK` and a reply meant for this one was filed against `TASK` —
 * silently. Every test below is a variation on catching that.
 */
const SIBLING = asTaskId("GH-acme-widget-7");

/** A thread whose binding names `TASK`, with `SIBLING` sharing it as a plan child does. */
const sharedThread = (): ThreadIndex => {
  const threads = new ThreadIndex();
  threads.bind(THREAD, TASK);
  return threads;
};

const queuedTask = async (inbox: InMemoryChatQueue, outcome: ChatOutcome): Promise<string> => {
  for (let attempt = 0; attempt < 50 && inbox.size === 0; attempt++) await flush();
  const requests = await inbox.drain();
  const first = requests[0];
  assert.ok(first !== undefined, "nothing was queued for the loop");
  for (const request of requests) request.settle(outcome);
  return first.kind === "brainstorm" ? "" : first.task;
};

test("a reply to an indexed message goes to that message's task, not the thread's owner", async () => {
  // THE BUG. Both tasks share one thread, `TASK` outranks `SIBLING`, and the human replied
  // to `SIBLING`'s question. Answering the higher-ranked sibling instead is the silent
  // misfiling this removes.
  const { bridge, inbox, messages } = harness({ threads: sharedThread() });
  messages.record("question-msg", SIBLING);

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg", "question-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, SIBLING, "the reply must land on the task whose message was replied to");
});

test("a reply to a message the index has lost is targeted by fetching it", async () => {
  // The index is in memory, so a restart empties it while the thread it served is still
  // live. Without this tier every reply after a rollout would be misfiled again.
  const { bridge, inbox, calls } = harness({
    threads: sharedThread(),
    fetchedMessage: { content: `**${SIBLING}** needs input\nPhase: implementing\n\nWhich path?` },
  });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg", "question-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, SIBLING, "the id must be read out of the fetched message's own text");
  const fetched = calls.find((call) => call.url.endsWith("/messages/question-msg"));
  assert.ok(fetched !== undefined, "the referenced message was never read back");
  assert.equal(fetched.method, "GET");
  assert.equal(fetched.url, `${API}/channels/${THREAD}/messages/question-msg`);
});

test("a reply the bot cannot place falls back to rank and says which task it used", async () => {
  // Both tiers failed: nothing indexed, and Discord will not show the message. Rank is all
  // that is left — but answering the wrong sibling in silence is the exact failure being
  // removed, so the reply names what it was filed against and a human can see the mistake.
  const { bridge, inbox, calls } = harness({ threads: sharedThread() });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg", "question-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, TASK, "with nothing to go on, today's rank rule still applies");
  const said = String(posted(calls)[0]?.body["content"]);
  assert.match(said, /I filed this against/, "an unavoidable guess must be a visible one");
  assert.match(said, new RegExp(TASK), "the note is worthless without naming the task");
});

test("a reply whose fetched message names no task falls back the same way", async () => {
  // A reply to a human's message, or to bot prose with no id in it. It must fall through
  // cleanly rather than error, and still carry the note.
  const { bridge, inbox, calls } = harness({
    threads: sharedThread(),
    fetchedMessage: { content: "morning all" },
  });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg", "question-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, TASK);
  assert.match(String(posted(calls)[0]?.body["content"]), /I filed this against/);
});

test("a steer that had to be guessed is said in words, not only reacted to", async () => {
  // A steer is normally acknowledged with a reaction alone (§7.3), to keep a conversation
  // of many short replies from becoming a wall of receipts. A reaction cannot say WHICH
  // task it was filed against, so the one case that had to guess gets a line as well.
  const { bridge, inbox, calls } = harness({ threads: sharedThread() });

  const handled = bridge.handleMessage("hold on", "operator", THREAD, "human-msg", "question-msg");
  await settleQueued(inbox, { kind: "steered" });
  await handled;

  assert.match(String(posted(calls)[0]?.body["content"]), /I filed this against/);
});

test("a message that is not a reply routes by rank with nothing said about it", async () => {
  // The unchanged path, and the reason the note is attached to guessing rather than to
  // rank: in a thread nobody replied in, rank is the answer rather than a fallback, and a
  // note under every line would be the receipts wall §7.3 avoided.
  const { bridge, inbox, calls } = harness({ threads: sharedThread() });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, TASK);
  assert.equal(
    calls.some((call) => call.method === "GET"),
    false,
    "an ordinary message must not cost a REST call",
  );
  assert.doesNotMatch(String(posted(calls)[0]?.body["content"]), /I filed this against/);
});

test("the message index evicts its oldest entry rather than growing without limit", async () => {
  // It grows by one per task-scoped message the bot posts, in a process meant to run for
  // weeks. Unbounded, that is a leak with no ceiling.
  const { messages } = harness();

  for (let n = 0; n <= MAX_REMEMBERED_MESSAGES; n++) messages.record(`m${n}`, TASK);

  assert.equal(messages.size, MAX_REMEMBERED_MESSAGES);
  assert.equal(messages.taskFor("m0"), undefined, "the oldest entry must be the one dropped");
  assert.equal(
    messages.taskFor(`m${MAX_REMEMBERED_MESSAGES}`),
    TASK,
    "and the newest must be the one kept — a reply targets a recent message",
  );
});

test("a task-scoped message the bot posts is remembered, so a reply to it is placeable", async () => {
  // The index is only worth having if it is populated by the ordinary posting path. Every
  // notification and every outcome names its task; nothing else has to be threaded through.
  const { bridge, inbox, calls, messages } = harness({ threads: sharedThread() });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg");
  await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(posted(calls).length, 1, "the outcome should have been posted");
  // The stubbed API hands back id `999` for every message it accepts.
  assert.equal(messages.taskFor("999"), TASK, "the outcome the bot just posted must be placeable");
});

test("a fetched message whose bold prefix is not a task falls back rather than misrouting", async () => {
  // Not every bold opener is a task id. The brainstorm opening message starts `**Brainstorm**`
  // and `Brainstorm` passes `isTaskId` — it is a legal directory name — so parsing alone
  // would file the answer against a task that does not exist, and the human would be told
  // "No task **Brainstorm** in the state repo" instead of being answered.
  const { bridge, inbox, calls } = harness({
    threads: sharedThread(),
    fetchedMessage: { content: "**Brainstorm** — acme/widget\n\nmake the overlay themeable" },
  });

  const handled = bridge.handleMessage("use option B", "operator", THREAD, "human-msg", "question-msg");
  const task = await queuedTask(inbox, { kind: "applied", index: 1 });
  await handled;

  assert.equal(task, TASK, "an id no task answers to must not win over the rank rule");
  assert.match(String(posted(calls)[0]?.body["content"]), /I filed this against/);
});
