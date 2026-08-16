import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { asTaskId } from "../domain/task.ts";
import { LiveSession } from "./live.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

const start = {
  task: asTaskId("TASK-1"),
  session: 3,
  model: "claude-opus-5",
  startedAt: "2026-08-16T10:00:00.000Z",
};

test("nothing is in flight before a session begins", async () => {
  assert.equal(new LiveSession().current(), undefined);
});

test("messages accumulate under the session that is running", async () => {
  const live = new LiveSession();
  live.begin(start);
  live.record(user("go"));
  live.record(user("still going"));

  const view = live.current();
  assert.equal(view?.task, "TASK-1");
  assert.equal(view?.session, 3);
  assert.equal(view?.model, "claude-opus-5");
  assert.equal(view?.startedAt, "2026-08-16T10:00:00.000Z");
  assert.equal(view?.messages.length, 2);
});

test("ending a session clears it, so a finished transcript is read from git and not from here", async () => {
  // The transcript is on disk the moment the session ends. Keeping a second copy alive
  // in the process would pin every message of every task the runner ever ran.
  const live = new LiveSession();
  live.begin(start);
  live.record(user("go"));
  live.end();

  assert.equal(live.current(), undefined);
});

test("a new session does not inherit the previous one's messages", async () => {
  const live = new LiveSession();
  live.begin(start);
  live.record(user("first session"));
  live.end();

  live.begin({ ...start, session: 4 });
  assert.deepEqual(live.current()?.messages, []);
});

test("a message arriving with no session in flight is dropped, not remembered", async () => {
  // pi settles its listeners after the run returns, so a `message_end` can land just
  // after `end()`. Attributing it to whatever session starts next would be a lie.
  const live = new LiveSession();
  live.record(user("late"));
  assert.equal(live.current(), undefined);

  live.begin(start);
  assert.deepEqual(live.current()?.messages, []);
});

test("the view is a snapshot: taking it and then recording does not mutate what was read", async () => {
  const live = new LiveSession();
  live.begin(start);
  live.record(user("one"));

  const view = live.current();
  live.record(user("two"));

  assert.equal(view?.messages.length, 1, "a rendered page must not change under the renderer");
  assert.equal(live.current()?.messages.length, 2);
});
