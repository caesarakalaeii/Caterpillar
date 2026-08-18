/**
 * Which threads are still worth listening to.
 *
 * This decides whether a message typed into a thread is routed as an answer or dropped,
 * and both mistakes are silent: bind a dead thread and it swallows everything typed into
 * it, unbind a live one and a human's answer never arrives.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskStatus } from "../domain/task.ts";
import { threadBindings, ThreadIndex, ThreadRouter, type ThreadOwner } from "./threads.ts";

const THREAD = "1537785980415778816";

const owner = (id: string, status: TaskStatus, threadId?: string): ThreadOwner => ({
  id: asTaskId(id),
  status,
  ...(threadId === undefined ? {} : { threadId }),
});

test("a live task's thread is bound", () => {
  assert.deepEqual(threadBindings([owner("BS-1", "awaiting-human", THREAD)]), [
    [THREAD, asTaskId("BS-1")],
  ]);
});

test("a cancelled task's thread is NOT bound", () => {
  // Otherwise the abandoned thread keeps accepting messages as answers, the loop replies
  // `not-waiting`, and the bridge — correctly — says nothing. Everything typed into it
  // disappears with no feedback at all.
  for (const status of ["parked", "done", "failed"] as const) {
    assert.deepEqual(threadBindings([owner("BS-1", status, THREAD)]), [], status);
  }
});

test("a plan's children keep their brainstorm's thread alive after it finishes", () => {
  // Children inherit `chat` from the brainstorm, so the parent going `done` must not
  // close the thread the work is still being discussed in.
  const bindings = threadBindings([
    owner("BS-1", "done", THREAD),
    owner("BS-1-01", "ready", THREAD),
  ]);

  assert.deepEqual(bindings, [[THREAD, asTaskId("BS-1-01")]]);
});

test("when several live tasks share a thread, the one WAITING owns it", () => {
  // That is the task a human replying is replying to.
  const bindings = threadBindings([
    owner("BS-1-01", "ready", THREAD),
    owner("BS-1-02", "awaiting-human", THREAD),
    owner("BS-1-03", "running", THREAD),
  ]);

  assert.deepEqual(bindings, [[THREAD, asTaskId("BS-1-02")]]);
});

test("ties break on id, so every runner agrees", () => {
  const forward = threadBindings([owner("BS-1-02", "ready", THREAD), owner("BS-1-01", "ready", THREAD)]);
  const reverse = threadBindings([owner("BS-1-01", "ready", THREAD), owner("BS-1-02", "ready", THREAD)]);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, [[THREAD, asTaskId("BS-1-01")]]);
});

test("a task with no thread contributes nothing", () => {
  assert.deepEqual(threadBindings([owner("GH-acme-widget-42", "ready")]), []);
});

test("a locally bound thread survives a rebuild that has not heard of it yet", () => {
  // The standalone bot creates a brainstorm's thread and binds it HERE, seconds before any
  // task exists for the supervisor to publish. A `replace` that dropped it would unbind the
  // thread a human was just invited to type in — and an unbound thread is filtered out by
  // the gateway before the bridge can even answer honestly, so the failure is pure silence.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));

  index.replace([["other-thread", asTaskId("BS-2")]]);

  assert.equal(index.taskFor(THREAD), asTaskId("BS-1"), "the local binding must survive");
  assert.equal(index.taskFor("other-thread"), asTaskId("BS-2"));
});

test("once the publisher speaks about a thread, the publisher wins", () => {
  // The pin is only a stand-in for a mapping that has not arrived. The moment the
  // authoritative mapping mentions the thread it takes over, value and all — otherwise a
  // stale local guess would outlive the truth.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));

  index.replace([[THREAD, asTaskId("BS-1-01")]]);
  assert.equal(index.taskFor(THREAD), asTaskId("BS-1-01"));

  // ...and having been spoken for, it is no longer pinned: the task going terminal drops
  // it from the mapping, and the thread must then unbind. A pin that outlived this would
  // leave a finished conversation swallowing every message typed into it.
  index.replace([]);
  assert.equal(index.taskFor(THREAD), undefined, "a terminal task's thread must unbind");
});

test("unbinding beats the pin, so a failed brainstorm stops routing at once", () => {
  // `startBrainstorm` unbinds when the intent did not start a task. That has to win over
  // the pin it set moments earlier, or a thread with no task behind it keeps reading
  // everything typed into it as an answer to nothing.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));
  index.unbind(THREAD);

  index.replace([]);
  assert.equal(index.knows(THREAD), false);
});

test("unbinding takes effect before the next rebuild", () => {
  // The rebuild runs once per poll; a cancel has to stop routing immediately, or a
  // message racing it is queued as an answer to a task that was just parked.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));
  assert.equal(index.knows(THREAD), true);

  index.unbind(THREAD);
  assert.equal(index.knows(THREAD), false);
  assert.equal(index.taskFor(THREAD), undefined);
});

/* ────────────────────── delivery, as distinct from routing (§7) ────────────────────── */

const MAIN = "main-channel";

const buildRouter = (
  options: {
    readonly knows?: (channelId: string) => boolean;
    readonly parentOf?: (channelId: string) => Promise<string | undefined>;
  } = {},
): { route: ThreadRouter; lookups: string[] } => {
  const lookups: string[] = [];
  const parentOf = options.parentOf ?? ((): Promise<string | undefined> => Promise.resolve(MAIN));
  return {
    lookups,
    route: new ThreadRouter({
      channelId: MAIN,
      index: { knows: options.knows ?? ((): boolean => false) },
      parentOf: (channelId) => {
        lookups.push(channelId);
        return parentOf(channelId);
      },
    }),
  };
};

test("an unbound thread of our channel is deliverable, so it can be answered honestly", async () => {
  // The case the class exists for: the bot's index arrives over Redis and is legitimately
  // behind, and a message dropped here is silence where the bridge had an honest answer.
  const { route } = buildRouter();
  assert.equal(await route.deliverable(THREAD), true);
});

test("a thread of some other channel is not deliverable", async () => {
  const { route } = buildRouter({ parentOf: () => Promise.resolve("someone-elses-channel") });
  assert.equal(await route.deliverable(THREAD), false);
});

test("a channel with no parent at all is not deliverable", async () => {
  const { route } = buildRouter({ parentOf: () => Promise.resolve(undefined) });
  assert.equal(await route.deliverable(THREAD), false);
});

test("a failed lookup is read as not ours, never as an exception", async () => {
  // The gateway calls this for every unknown message; a rejection escaping here would be
  // one unhandled rejection per message during a Discord outage.
  const { route } = buildRouter({ parentOf: () => Promise.reject(new Error("429")) });
  assert.equal(await route.deliverable(THREAD), false);
});

test("both answers are cached, so an unrelated busy channel costs one lookup", async () => {
  const yes = buildRouter();
  await yes.route.deliverable(THREAD);
  await yes.route.deliverable(THREAD);
  assert.deepEqual(yes.lookups, [THREAD], "a positive answer is cached");

  const no = buildRouter({ parentOf: () => Promise.resolve("elsewhere") });
  await no.route.deliverable("noisy");
  await no.route.deliverable("noisy");
  assert.deepEqual(no.lookups, ["noisy"], "a negative answer is cached too, or a busy channel floods the API");
});

test("a burst in one thread is a single lookup, not one per message", async () => {
  let release: (value: string) => void = () => {};
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const { route, lookups } = buildRouter({ parentOf: () => pending });

  const all = Promise.all([
    route.deliverable(THREAD),
    route.deliverable(THREAD),
    route.deliverable(THREAD),
  ]);
  release(MAIN);

  assert.deepEqual(await all, [true, true, true]);
  assert.deepEqual(lookups, [THREAD], "concurrent messages share the in-flight lookup");
});

test("the main channel and a bound thread need no lookup at all", async () => {
  const { route, lookups } = buildRouter({ knows: (id) => id === THREAD });

  assert.equal(await route.deliverable(MAIN), true);
  assert.equal(await route.deliverable(THREAD), true);
  assert.deepEqual(lookups, [], "the hot path must not touch the REST API");
});

test("a thread that becomes bound is known synchronously by the router", () => {
  const index = new ThreadIndex();
  const route = new ThreadRouter({ channelId: MAIN, index, parentOf: () => Promise.resolve(MAIN) });

  assert.equal(route.knows(THREAD), false);
  index.bind(THREAD, asTaskId("BS-1"));
  assert.equal(route.knows(THREAD), true);
});

test("a pin expires, so a thread no mapping will ever name does not stay bound forever", () => {
  // The leak the generation counter closes. A brainstorm whose task goes terminal before
  // the first survey that would have published it is never named by any mapping, and a
  // permanent pin would leave the dead thread bound for the life of the process — where
  // every message typed there is read as an answer to a finished task and gets silence.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));

  // Several passes that never mention it, as a cancelled brainstorm's never would.
  for (let pass = 0; pass < 10; pass++) index.replace([]);

  assert.equal(index.knows(THREAD), false, "an unnameable pinned thread must eventually unbind");
});

test("a pin still covers the window it exists for", () => {
  // The property the expiry must not cost: the supervisor has not published yet, and the
  // human was just invited to type in this thread.
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));

  index.replace([]);
  assert.equal(index.taskFor(THREAD), asTaskId("BS-1"), "the next refresh must not unbind it");
});

test("a mapping that names the thread refreshes nothing about the pin — it ends it", () => {
  const index = new ThreadIndex();
  index.bind(THREAD, asTaskId("BS-1"));
  index.replace([[THREAD, asTaskId("BS-1")]]);

  // From here the publisher is the authority, so the very next mapping without it unbinds.
  index.replace([]);
  assert.equal(index.knows(THREAD), false, "a published thread unbinds on the pass that drops it");
});
