/**
 * Splitting a question that does not fit.
 *
 * Written against a real failure: a brainstorm asked a 3785-code-point question offering
 * four options, and the channel got it cut in the middle of option A — B, C and D never
 * arrived. Nothing about that message was answerable, and the answer button on it invited
 * a reply to the half that fitted.
 *
 * So the property under test is COMPLETENESS, not length: every code point of the original
 * has to survive somewhere, in order, across parts that each fit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { chunkProse, CONTENT_LIMIT, renderParts, type Notification } from "./discord.ts";

const TASK = asTaskId("BS-1537785980415778816");
const size = (text: string): number => [...text].length;

/**
 * A question shaped like the one that failed: long, markdown, multi-option, with the
 * decisive content at the END. Synthetic on purpose — the real one is another project's
 * prose and does not belong in this repo — but the same length and structure.
 */
const longQuestion = (): string =>
  [
    "I've read the repo and the picture is different from what the issue says.",
    "",
    "**Where it actually stands:**",
    "",
    ...Array.from(
      { length: 20 },
      (_, i) =>
        `- Mechanism ${i + 1} is dead: it resolves at load time, which the generated ` +
        `sublevels never reach, so no rewrite can touch them. It was tried twice, once ` +
        `against the data assets and once at runtime, and both are recorded with the ` +
        `evidence in ADR-00${20 + i}. Do not re-litigate it without new evidence.`,
    ),
    "",
    "**Which of these do you want the plan to be?**",
    "",
    "**A. Make the gate cheap and safe to run.** Agents build everything that does not " +
      "need the game, you run one launch, and the verdict gets filled in.",
    "**B. Same as A, plus close the seed-visibility gap** in the same pass.",
    "**C. Revive the runtime hook instead** and spend the effort on making it survive.",
    "**D. Something else** — you already know the answer, or you want the effort elsewhere.",
    "",
    "My read is A, extended toward B if the gate passes, and that C is a trap.",
  ].join("\n");

const question = (text: string): Notification => ({
  kind: "question",
  task: TASK,
  phase: "planning",
  question: text,
});

test("a question too long for one message is split, not truncated", () => {
  const text = longQuestion();
  assert.ok(size(text) > CONTENT_LIMIT, `fixture must exceed the limit, was ${size(text)}`);

  const parts = renderParts(question(text), { interactive: true });
  assert.ok(parts.length > 1, "it must take more than one message");

  for (const [i, part] of parts.entries()) {
    assert.ok(size(part.content) <= CONTENT_LIMIT, `part ${i} was ${size(part.content)}`);
  }
});

test("every line of the question survives, including the last option", () => {
  // The failure mode exactly: the decisive content is at the end, so a test that only
  // checks the beginning arrived would have passed against the bug.
  const text = longQuestion();
  const joined = renderParts(question(text), { interactive: true })
    .map((p) => p.content)
    .join("\n");

  for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
    assert.ok(joined.includes(line), `lost: ${line.slice(0, 60)}…`);
  }
  assert.match(joined, /\*\*D\. Something else\*\*/);
});

test("the answer button goes on the LAST part only", () => {
  // On the first part it would invite an answer to the half that had been read.
  const parts = renderParts(question(longQuestion()), { interactive: true });

  assert.equal(parts.at(-1)?.components !== undefined, true, "the last part must carry it");
  for (const part of parts.slice(0, -1)) {
    assert.equal(part.components, undefined, "an earlier part must not");
  }
});

test("the webhook form puts the typed hint on the last part only", () => {
  const parts = renderParts(question(longQuestion()), { interactive: false });

  assert.match(String(parts.at(-1)?.content), /!answer BS-1537785980415778816/);
  for (const part of parts.slice(0, -1)) {
    assert.doesNotMatch(part.content, /!answer/);
  }
});

test("continuation parts say which they are", () => {
  // Otherwise a message lost to a rate limit is invisible: the reader sees prose that
  // stops mid-thought and no reason to suspect anything is missing.
  const parts = renderParts(question(longQuestion()), { interactive: true });

  assert.match(parts[0]?.content ?? "", /needs input/);
  assert.match(parts[1]?.content ?? "", /\(2\/\d\)/);
});

test("a question that fits is still exactly one message", () => {
  const parts = renderParts(question("Which migration path?"), { interactive: true });

  assert.equal(parts.length, 1);
  assert.match(parts[0]?.content ?? "", /needs input/);
  assert.ok(parts[0]?.components !== undefined);
});

test("everything that is not a question stays a single message", () => {
  // Informational by nature: a park reason cut short still says a task parked, and five
  // messages of stack trace is the noise Discord is meant not to be.
  const cases: readonly Notification[] = [
    { kind: "parked", task: TASK, reason: "no progress ".repeat(400) },
    { kind: "failed", task: TASK, error: "boom ".repeat(800) },
  ];

  for (const notification of cases) {
    const parts = renderParts(notification, { interactive: true });
    assert.equal(parts.length, 1, notification.kind);
    assert.ok(size(parts[0]?.content ?? "") <= CONTENT_LIMIT, notification.kind);
  }
});

test("an absurd question is capped and says where the rest is", () => {
  // A question this long is itself a bug. The cap stops one session posting fifty
  // messages, but dropping the remainder silently would repeat the original failure.
  const parts = renderParts(question("line of prose\n".repeat(4000)), { interactive: true });

  assert.ok(parts.length <= 6, `capped, got ${parts.length}`);
  assert.match(String(parts.at(-1)?.content), /more part\(s\) not shown/);
  assert.match(String(parts.at(-1)?.content), /questions\//);
});

test("a single over-long line is hard-split rather than dropped", () => {
  const wall = "x".repeat(5000);
  const chunks = chunkProse(wall, 100);

  assert.equal(chunks.join(""), wall, "no code point may be lost");
  for (const c of chunks) assert.ok(size(c) <= 100);
});

test("splitting never leaves a lone surrogate", () => {
  // Slicing UTF-16 units mid-pair yields a lone surrogate, which JSON.stringify encodes
  // happily and Discord rejects as invalid — a 400 that only appears for emoji. The
  // leading "x" shifts the cut to an ODD unit offset, where a naive slice breaks.
  const chunks = chunkProse(`x${"🙂".repeat(3000)}`, 100);

  for (const c of chunks) {
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c),
      false,
      "a lone surrogate survived the split",
    );
  }
});

test("chunking prefers line boundaries", () => {
  // Agent prose is markdown; a split mid-bullet reads as two broken bullets.
  const chunks = chunkProse(["- one", "- two", "- three"].join("\n"), 12);

  for (const c of chunks) assert.doesNotMatch(c, /^\s*$/);
  assert.deepEqual(chunks.join("\n").split("\n"), ["- one", "- two", "- three"]);
});

test("a question in its own thread carries no Answer button", () => {
  // The button exists to spare retyping a task id in a busy channel. In the task's own
  // thread there is no id to retype — the next message is the answer — so it is pure
  // friction: a modal to open for something a keystroke already does.
  const parts = renderParts(question("Which option?"), { interactive: true, inThread: true });

  assert.equal(parts[0]?.components, undefined);
  assert.match(parts[0]?.content ?? "", /Reply in this thread/);
  assert.doesNotMatch(parts[0]?.content ?? "", /!answer/);
});

test("the same question in the channel still gets the button", () => {
  const parts = renderParts(question("Which option?"), { interactive: true });

  assert.ok(parts[0]?.components !== undefined);
  assert.doesNotMatch(parts[0]?.content ?? "", /Reply in this thread/);
});

test("a long question in a thread still splits, and the last part says how to reply", () => {
  const parts = renderParts(question(longQuestion()), { interactive: true, inThread: true });

  assert.ok(parts.length > 1);
  for (const part of parts) assert.equal(part.components, undefined);
  assert.match(String(parts.at(-1)?.content), /Reply in this thread/);
});

/** Every part must be independently well-formed: fences balanced, nothing left open. */
const fenceLines = (text: string): number => text.split("\n").filter((l) => /^[ \t]*```/.test(l)).length;

test("a code block is never split when it could stay whole", () => {
  // Split across two messages it leaves the first with an unterminated fence — Discord
  // renders the whole tail as code — and the second opening a block nothing meant to
  // start. Every message after it in the conversation is then formatted wrong.
  const block = ["```ts", ...Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`), "```"];
  const text = [..."a".repeat(0), "Some prose before.", "", ...block, "", "Some prose after."].join("\n");

  // A budget that forces a split SOMEWHERE, but leaves the block able to fit alone.
  const chunks = chunkProse(text, 200);

  assert.ok(chunks.length > 1, "the fixture must actually split");
  for (const [i, c] of chunks.entries()) {
    assert.equal(fenceLines(c) % 2, 0, `part ${i} has an unbalanced fence:\n${c}`);
  }
  assert.equal(
    chunks.filter((c) => c.includes("const x0 = 0;")).length,
    1,
    "the block must live in exactly one part",
  );
});

test("a block that would straddle a boundary moves whole to the next part", () => {
  const text = [
    "Filler that nearly fills the first message on its own, line by line.",
    "Another line of filler to push the boundary right up to the block.",
    "```ts",
    "const kept = 'together';",
    "```",
  ].join("\n");

  const chunks = chunkProse(text, 140);
  const withBlock = chunks.filter((c) => c.includes("const kept"));

  assert.equal(withBlock.length, 1);
  assert.match(String(withBlock[0]), /```ts\nconst kept = 'together';\n```/);
});

test("a block too big for any message is split into well-formed blocks", () => {
  // The one case where splitting is unavoidable. Each piece closes its own fence and the
  // next reopens it, carrying the language so highlighting survives the break.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long dump`);
  const chunks = chunkProse(["```log", ...lines, "```"].join("\n"), 300);

  assert.ok(chunks.length > 2, `expected several pieces, got ${chunks.length}`);
  for (const [i, c] of chunks.entries()) {
    assert.equal(fenceLines(c) % 2, 0, `piece ${i} unbalanced`);
    assert.ok(c.startsWith("```log"), `piece ${i} must reopen with the language`);
    assert.ok(c.endsWith("```"), `piece ${i} must close`);
    assert.ok([...c].length <= 300, `piece ${i} was ${[...c].length}`);
  }

  const recovered = chunks.flatMap((c) => c.split("\n").slice(1, -1));
  assert.deepEqual(recovered, lines, "no line may be lost or duplicated across the split");
});

test("a fence the agent forgot to close is closed for it", () => {
  // Agent prose is generated; a dropped closing fence is a realistic thing for a model
  // to do, and one missing line would otherwise format the rest of the message as code.
  const chunks = chunkProse(["Here is the config:", "```json", '{ "a": 1 }'].join("\n"), 2000);

  assert.equal(chunks.length, 1);
  assert.equal(fenceLines(String(chunks[0])) % 2, 0);
  assert.ok(String(chunks[0]).endsWith("```"));
});

test("a question containing a code block renders parts that are each well-formed", () => {
  // The end-to-end shape: this is what actually reaches Discord.
  const text = [
    longQuestion(),
    "",
    "```bash",
    ...Array.from({ length: 20 }, (_, i) => `./gen-pak.sh --stage ${i}`),
    "```",
  ].join("\n");

  const parts = renderParts(question(text), { interactive: true });

  for (const [i, part] of parts.entries()) {
    assert.equal(fenceLines(part.content) % 2, 0, `part ${i} unbalanced:\n${part.content}`);
    assert.ok([...part.content].length <= CONTENT_LIMIT);
  }
});
