/**
 * A stored pi transcript, turned into something a page can render. See DESIGN.md §18.
 *
 * Pure: it takes the decompressed JSONL and returns entries. The store owns the file
 * layout and the gzip, the renderer owns the HTML, and this owns the one thing that is
 * neither — knowing what pi's message shapes mean.
 *
 * Two rules the view depends on:
 *   - a line that cannot be read costs that line and nothing else. A transcript is
 *     appended by a process that can be killed mid-write, and one truncated tail must
 *     not blank the forty messages before it.
 *   - blocks are clipped, with the loss declared. A bash result can be megabytes; the
 *     raw endpoint serves the whole thing for anyone who needs it.
 */
import type { UsageTotals } from "../domain/task.ts";

/** Ceiling on one rendered block. Generous — the point is to bound a page, not to summarise. */
export const BLOCK_CHARS = 20_000;

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  /** Pretty-printed JSON, already clipped. */
  readonly arguments: string;
}

export interface TranscriptEntry {
  /** Position in the file, so a page can link to one message. */
  readonly index: number;
  readonly role: "user" | "assistant" | "toolResult" | "unknown";
  /** ISO timestamp, when pi recorded a usable one. */
  readonly at?: string;
  readonly text: string;
  readonly thinking?: string;
  readonly calls: readonly ToolCallView[];
  /** `toolResult` only. */
  readonly tool?: string;
  readonly callId?: string;
  readonly isError?: boolean;
  /** `assistant` only — cost per turn is how a task got expensive. */
  readonly usage?: UsageTotals;
  readonly stopReason?: string;
  /** The failure pi swallowed rather than threw (see agent/session.ts). */
  readonly error?: string;
  /** True when any block of this entry was clipped. */
  readonly truncated?: boolean;
}

export const parseTranscript = (jsonl: string): readonly TranscriptEntry[] => {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    entries.push(toEntry(line, entries.length));
  }
  return entries;
};

/**
 * Messages held in memory rather than read off disk — the session running right now
 * (`obs/live.ts`).
 *
 * Deliberately the SAME entry builder as the stored path. A live session and a finished
 * one differ only in where the bytes came from, and two renderers would eventually
 * disagree about what a tool call looks like.
 */
export const entriesOf = (messages: readonly unknown[]): readonly TranscriptEntry[] =>
  messages.map((message, index) => fromMessage(message, index));

const toEntry = (line: string, index: number): TranscriptEntry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return unreadable(index, "this line could not be read as JSON");
  }
  return fromMessage(parsed, index);
};

const fromMessage = (parsed: unknown, index: number): TranscriptEntry => {
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable(index, "this line could not be read as a message");
  }

  const message = parsed as Record<string, unknown>;
  switch (message["role"]) {
    case "user":
      return userEntry(index, message);
    case "assistant":
      return assistantEntry(index, message);
    case "toolResult":
      return toolResultEntry(index, message);
    default:
      return unreadable(index, `this line could not be read as a message`);
  }
};

const unreadable = (index: number, detail: string): TranscriptEntry => ({
  index,
  role: "unknown",
  text: detail,
  calls: [],
});

const userEntry = (index: number, message: Record<string, unknown>): TranscriptEntry => {
  const { text, truncated } = clip(contentText(message["content"]));
  return {
    index,
    role: "user",
    text,
    calls: [],
    ...at(message["timestamp"]),
    ...(truncated ? { truncated } : {}),
  };
};

const assistantEntry = (index: number, message: Record<string, unknown>): TranscriptEntry => {
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const texts: string[] = [];
  const thinking: string[] = [];
  const calls: ToolCallView[] = [];

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as Record<string, unknown>;
    switch (typed["type"]) {
      case "text":
        if (typeof typed["text"] === "string") texts.push(typed["text"]);
        break;
      case "thinking":
        if (typeof typed["thinking"] === "string") thinking.push(typed["thinking"]);
        break;
      case "toolCall":
        calls.push({
          id: String(typed["id"] ?? ""),
          name: String(typed["name"] ?? "?"),
          arguments: clip(stringifyArguments(typed["arguments"])).text,
        });
        break;
      default:
        break;
    }
  }

  const body = clip(texts.join("\n\n"));
  const reasoning = clip(thinking.join("\n\n"));
  const error = message["errorMessage"];
  const usage = usageOf(message["usage"]);

  return {
    index,
    role: "assistant",
    text: body.text,
    calls,
    ...at(message["timestamp"]),
    ...(reasoning.text === "" ? {} : { thinking: reasoning.text }),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof message["stopReason"] === "string" ? { stopReason: message["stopReason"] } : {}),
    ...(typeof error === "string" && error !== "" ? { error } : {}),
    ...(body.truncated || reasoning.truncated ? { truncated: true } : {}),
  };
};

const toolResultEntry = (index: number, message: Record<string, unknown>): TranscriptEntry => {
  const { text, truncated } = clip(contentText(message["content"]));
  return {
    index,
    role: "toolResult",
    text,
    calls: [],
    tool: String(message["toolName"] ?? "?"),
    callId: String(message["toolCallId"] ?? ""),
    isError: message["isError"] === true,
    ...at(message["timestamp"]),
    ...(truncated ? { truncated } : {}),
  };
};

/**
 * pi's content is either a bare string or a block array. An image is NAMED rather than
 * inlined: the data is a base64 payload that would be megabytes of page for a picture
 * nobody asked to see, and the raw endpoint still has it.
 */
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as Record<string, unknown>;
    if (typed["type"] === "text" && typeof typed["text"] === "string") parts.push(typed["text"]);
    else if (typed["type"] === "image") parts.push(`[${String(typed["mimeType"] ?? "image")} image]`);
  }
  return parts.join("\n\n");
};

/** Tool arguments as the agent sent them, readable. Falls back to a string on a cycle. */
const stringifyArguments = (value: unknown): string => {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const clip = (text: string): { readonly text: string; readonly truncated: boolean } => {
  if (text.length <= BLOCK_CHARS) return { text, truncated: false };
  const dropped = text.length - BLOCK_CHARS;
  return {
    text: `${text.slice(0, BLOCK_CHARS)}\n\n… ${dropped} characters omitted — the raw transcript has all of it.`,
    truncated: true,
  };
};

/** pi stamps epoch milliseconds. A zero or a missing value is no timestamp at all. */
const at = (timestamp: unknown): { readonly at?: string } => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return {};
  return { at: new Date(timestamp).toISOString() };
};

/**
 * The same accounting `agent/session.ts` does: cache reads and writes are input tokens
 * that were paid for, so a view that counted only `input` would understate every turn
 * after the first.
 */
const usageOf = (value: unknown): UsageTotals | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const number = (key: string): number => (typeof usage[key] === "number" ? usage[key] : 0);
  const cost = usage["cost"];
  const total =
    typeof cost === "object" && cost !== null && typeof (cost as Record<string, unknown>)["total"] === "number"
      ? ((cost as Record<string, unknown>)["total"] as number)
      : 0;

  return {
    inputTokens: number("input") + number("cacheRead") + number("cacheWrite"),
    outputTokens: number("output"),
    costUsd: total,
  };
};
