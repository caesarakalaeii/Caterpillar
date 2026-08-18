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
import { threadBindings, ThreadIndex, type ThreadOwner } from "./threads.ts";

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
