import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { parseCommand } from "./commands.ts";
import { render } from "./discord.ts";

test("an answer command carries the task id and everything after it", () => {
  assert.deepEqual(parseCommand("!answer SMOKE-1 yes, use the fork point"), {
    kind: "answer",
    task: asTaskId("SMOKE-1"),
    text: "yes, use the fork point",
  });
});

test("the answer keeps its original formatting", () => {
  // An answer is prose a human wrote for an agent: code blocks, lists, and blank lines
  // all mean something. Re-joining the words on single spaces would flatten all of it.
  const answer = "do this:\n\n```sh\nnpm test\n```\n\n- then that";
  const parsed = parseCommand(`!answer SMOKE-1 ${answer}`);

  assert.equal(parsed?.kind, "answer");
  assert.equal(parsed.kind === "answer" ? parsed.text : "", answer);
});

test("the supervisor's OWN question notification is not a command", () => {
  // It ends with "Reply: `!answer <task> <your answer>`". The bridge reads the channel
  // it posts into, so a parser keying on "contains !answer" would answer its own
  // question with its own instructions the moment a webhook is sealed.
  const notification = render({
    kind: "question",
    task: asTaskId("SMOKE-1"),
    phase: "implementing",
    question: "Which migration path?",
  });

  assert.equal(parseCommand(notification), undefined);
});

test("ordinary chat is ignored", () => {
  for (const message of ["hello", "", "  ", "answer SMOKE-1 yes", "!deploy now", "!!"]) {
    assert.equal(parseCommand(message), undefined, message);
  }
});

test("a task id that would escape the tasks directory is refused", () => {
  // The id becomes a directory name under `tasks/`. Refusing beats a traversal that
  // half-works, and beats a confusing "unknown task" for something that IS a task id.
  const parsed = parseCommand("!answer ../../etc/passwd yes");

  assert.equal(parsed?.kind, "malformed");
});

test("a command missing its id or its answer says so rather than doing nothing", () => {
  // Silence is the worst reply here: the human has no way to tell a typo from an
  // offline bridge, and will sit waiting on a task that is still parked.
  for (const message of ["!answer", "!answer   ", "!answer SMOKE-1", "!answer SMOKE-1   "]) {
    const parsed = parseCommand(message);
    assert.equal(parsed?.kind, "malformed", message);
    assert.match(parsed?.kind === "malformed" ? parsed.reason : "", /!answer/);
  }
});

test("inside a task's thread the id is implied", () => {
  // The point of a brainstorm thread: refining an idea is many short answers, and
  // retyping `BS-1537550186388258866` before each one is exactly the friction the whole
  // chat surface exists to remove.
  const thread = asTaskId("BS-1537550186388258866");

  assert.deepEqual(parseCommand("!answer yes, use the existing path", thread), {
    kind: "answer",
    task: thread,
    text: "yes, use the existing path",
  });
});

test("a thread answers ITS task, even when another id is typed", () => {
  // Reversed deliberately. A thread is a conversation with exactly one task, and the
  // ambiguity cost more than the capability: `!answer we want B` was read as an answer
  // to a task called `we`, because `we` matches the task-id charset.
  //
  // Answering a DIFFERENT task from inside a thread is not lost — `/answer` takes an
  // explicit id and works from anywhere, with autocomplete to get it right.
  const thread = asTaskId("BS-1537550186388258866");
  const other = asTaskId("GH-acme-widget-42");

  assert.deepEqual(parseCommand(`!answer ${other} proceed`, thread), {
    kind: "answer",
    task: thread,
    text: `${other} proceed`,
  });
});

test("an implied answer keeps its original formatting", () => {
  // An answer can be a code block or a list. Re-joining on single spaces would flatten
  // all of it, which matters more here than in the channel — a thread is where the long
  // answers get typed.
  const thread = asTaskId("BS-42");
  const parsed = parseCommand("!answer use:\n\n```ts\nconst x = 1;\n```", thread);

  assert.equal(parsed?.kind, "answer");
  assert.match(parsed?.kind === "answer" ? parsed.text : "", /```ts\nconst x = 1;\n```/);
});

test("an empty thread message is ignored, not refused", () => {
  // Changed with the grammar: every message in a thread is now an answer, so an empty
  // one is nothing said rather than a malformed command. Replying "cannot be empty" to
  // it would be the bot talking to itself in a conversation it is only half part of.
  assert.equal(parseCommand("!answer   ", asTaskId("BS-42")), undefined);
});

test("in a thread, a plain message IS the answer", () => {
  // Requiring `!answer` in a task's own thread was friction in the one place the chat
  // surface exists to remove it: refining an idea is many short replies.
  const thread = asTaskId("BS-1537785980415778816");

  assert.deepEqual(parseCommand("we want B", thread), {
    kind: "answer",
    task: thread,
    text: "we want B",
  });
});

test("`!answer we want B` in a thread answers the THREAD, not a task called `we`", () => {
  // The exact message that failed in production. `we` matches the task-id charset, so
  // the channel parser took it as an id and replied "No task we in the state repo."
  const thread = asTaskId("BS-1537785980415778816");

  assert.deepEqual(parseCommand("!answer we want B", thread), {
    kind: "answer",
    task: thread,
    text: "we want B",
  });
});

test("a thread reply keeps its formatting and its own id is not swallowed twice", () => {
  const thread = asTaskId("BS-42");

  assert.equal(
    parseCommand(`!answer ${thread} use:\n\n\`\`\`ts\nconst x = 1;\n\`\`\``, thread)?.kind,
    "answer",
  );
  const parsed = parseCommand(`!answer ${thread} use:\n\n\`\`\`ts\nconst x = 1;\n\`\`\``, thread);
  assert.match(parsed?.kind === "answer" ? parsed.text : "", /^use:\n\n```ts/);
});

test("an empty thread message is ignored rather than refused", () => {
  // Nothing was said, so there is nothing to reply to. A "cannot be empty" here would
  // be the bot talking to itself.
  assert.equal(parseCommand("   ", asTaskId("BS-42")), undefined);
  assert.equal(parseCommand("!answer", asTaskId("BS-42")), undefined);
});

test("outside a thread the channel grammar is unchanged", () => {
  assert.equal(parseCommand("we want B"), undefined, "plain chat in the channel is not a command");
  assert.deepEqual(parseCommand("!answer GH-acme-widget-42 yes"), {
    kind: "answer",
    task: asTaskId("GH-acme-widget-42"),
    text: "yes",
  });
});
