/**
 * The queue between an inbound chat message and the poll loop.
 *
 * Everything here is about WHEN a request is visible to the loop, which is the whole
 * reason the class exists: the loop is blocked for the entire duration of a session, so
 * what it can see without draining decides what a human waiting in Discord experiences.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { ChatInbox, type ChatOutcome } from "./inbox.ts";

const TASK = asTaskId("T-1");

test("a submission is not settled until the loop deals with it", async () => {
  const inbox = new ChatInbox();

  let settled = false;
  const pending = inbox.submit({ kind: "park", task: TASK }).then((outcome) => {
    settled = true;
    return outcome;
  });

  await Promise.resolve();
  assert.equal(settled, false, "submitting is not the same as being acted on");

  for (const request of inbox.drain()) request.settle({ kind: "parked" });
  assert.deepEqual(await pending, { kind: "parked" } satisfies ChatOutcome);
});

test("draining swaps the queue, so a submission mid-drain waits for the next pass", () => {
  const inbox = new ChatInbox();
  void inbox.submit({ kind: "park", task: TASK });

  const taken = inbox.drain();
  void inbox.submit({ kind: "park", task: asTaskId("T-2") });

  assert.equal(taken.length, 1);
  assert.equal(inbox.size, 1, "the second submission belongs to the next drain");
});

test("takeWhere leaves everything it did not match queued", () => {
  const inbox = new ChatInbox();
  void inbox.submit({ kind: "park", task: TASK });
  void inbox.submit({ kind: "answer", task: TASK, text: "yes" });

  const taken = inbox.takeWhere((request) => request.kind === "park");

  assert.equal(taken.length, 1);
  assert.equal(inbox.size, 1, "the answer writes the state repo and must wait for the loop");
});

test("the queue can be asked what it holds without consuming it", () => {
  // For the one caller that must not consume: a session in flight checks whether anyone
  // is waiting on a brainstorm so it can stop after the current session and let the loop
  // drain properly. Taking the request here would strand it — this code cannot write the
  // state repo, which is exactly why it is handing back to the loop.
  const inbox = new ChatInbox();
  assert.equal(inbox.some((request) => request.kind === "brainstorm"), false);

  void inbox.submit({
    kind: "brainstorm",
    topic: "make the thing faster",
    repos: ["acme/widget"],
    threadId: "1538626232302960801",
    author: "operator",
  });

  assert.equal(inbox.some((request) => request.kind === "brainstorm"), true);
  assert.equal(inbox.some((request) => request.kind === "merge"), false);
  assert.equal(inbox.size, 1, "asking must not consume");
});
