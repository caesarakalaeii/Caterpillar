import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BLOCK_CHARS, parseTranscript } from "./transcript.ts";

const jsonl = (...messages: readonly unknown[]): string =>
  messages.map((message) => JSON.stringify(message)).join("\n");

const assistant = (content: unknown, extra: Record<string, unknown> = {}): unknown => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-opus-5",
  usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.5 } },
  stopReason: "toolUse",
  timestamp: 1_760_000_000_000,
  ...extra,
});

test("a user message carries its text however pi shaped the content", async () => {
  const entries = parseTranscript(
    jsonl(
      { role: "user", content: "plain string", timestamp: 1_760_000_000_000 },
      { role: "user", content: [{ type: "text", text: "block form" }], timestamp: 0 },
    ),
  );

  assert.equal(entries[0]?.role, "user");
  assert.equal(entries[0]?.text, "plain string");
  assert.equal(entries[1]?.text, "block form");
});

test("an epoch timestamp becomes something a human can read, and a missing one is absent", async () => {
  const entries = parseTranscript(
    jsonl({ role: "user", content: "hi", timestamp: 1_760_000_000_000 }, { role: "user", content: "hi" }),
  );

  assert.equal(entries[0]?.at, new Date(1_760_000_000_000).toISOString());
  assert.equal(entries[1]?.at, undefined);
});

test("assistant text, thinking and tool calls are separated rather than concatenated", async () => {
  const entries = parseTranscript(
    jsonl(
      assistant([
        { type: "thinking", thinking: "the tests live in src" },
        { type: "text", text: "Running the suite." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
      ]),
    ),
  );

  const entry = entries[0];
  assert.equal(entry?.role, "assistant");
  assert.equal(entry?.text, "Running the suite.");
  assert.equal(entry?.thinking, "the tests live in src");
  assert.equal(entry?.calls.length, 1);
  assert.equal(entry?.calls[0]?.name, "bash");
  assert.equal(entry?.calls[0]?.id, "call-1");
  assert.match(entry?.calls[0]?.arguments ?? "", /npm test/);
});

test("usage and stop reason ride along, because cost per turn is why a task got expensive", async () => {
  const entries = parseTranscript(jsonl(assistant([{ type: "text", text: "done" }])));

  assert.deepEqual(entries[0]?.usage, { inputTokens: 13, outputTokens: 4, costUsd: 0.5 });
  assert.equal(entries[0]?.stopReason, "toolUse");
});

test("a provider failure pi swallowed is shown as the error it was", async () => {
  // pi does not throw on a failed request: it appends an assistant message carrying
  // `stopReason: "error"`. A transcript view that ignored `errorMessage` would render
  // the moment a session died as an empty assistant turn.
  const entries = parseTranscript(
    jsonl(assistant([], { stopReason: "error", errorMessage: "429 rate limit" })),
  );

  assert.equal(entries[0]?.error, "429 rate limit");
});

test("a tool result names its tool and says whether it failed", async () => {
  const entries = parseTranscript(
    jsonl({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "2 tests failed" }],
      isError: true,
      timestamp: 1_760_000_000_000,
    }),
  );

  const entry = entries[0];
  assert.equal(entry?.role, "toolResult");
  assert.equal(entry?.tool, "bash");
  assert.equal(entry?.callId, "call-1");
  assert.equal(entry?.text, "2 tests failed");
  assert.equal(entry?.isError, true);
});

test("an image block is named, not inlined", async () => {
  const entries = parseTranscript(
    jsonl({
      role: "toolResult",
      toolCallId: "c",
      toolName: "read",
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      isError: false,
      timestamp: 0,
    }),
  );

  assert.equal(entries[0]?.text, "[image/png image]");
});

test("a huge block is clipped and says how much it dropped", async () => {
  // A bash tool result can be megabytes. Rendering it whole makes the page the problem;
  // dropping it silently makes the view lie. The raw transcript endpoint has all of it.
  const entries = parseTranscript(
    jsonl({
      role: "toolResult",
      toolCallId: "c",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(BLOCK_CHARS + 500) }],
      isError: false,
      timestamp: 0,
    }),
  );

  const text = entries[0]?.text ?? "";
  assert.ok(text.length < BLOCK_CHARS + 200, "the block must be clipped");
  assert.match(text, /500 characters omitted/);
  assert.equal(entries[0]?.truncated, true);
});

test("one unreadable line does not cost the rest of the transcript", async () => {
  const entries = parseTranscript(
    ["{not json", JSON.stringify({ role: "user", content: "after", timestamp: 0 })].join("\n"),
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.role, "unknown");
  assert.match(entries[0]?.text ?? "", /could not be read/);
  assert.equal(entries[1]?.text, "after");
});

test("blank lines are skipped, so a trailing newline is not a message", async () => {
  const entries = parseTranscript(`${JSON.stringify({ role: "user", content: "hi", timestamp: 0 })}\n\n`);
  assert.equal(entries.length, 1);
});

test("entries are indexed in the order they were written", async () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "a", timestamp: 0 },
    { role: "user", content: "b", timestamp: 0 },
  ];
  const entries = parseTranscript(jsonl(...messages));
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [0, 1],
  );
});
