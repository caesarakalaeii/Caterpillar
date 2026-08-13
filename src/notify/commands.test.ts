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
