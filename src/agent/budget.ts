/**
 * The ceiling on how much a tool may RETURN. See DESIGN.md §6.4.
 *
 * `limits.commandTimeoutSeconds` bounds how long a command runs (invariant 12). Nothing
 * bounded how much it hands back, and the two failures are not the same shape: a hung
 * command holds a slot until something kills it, while a 40,000-line `grep` succeeds
 * instantly and quietly spends a large fraction of the context window that §6.1's handoff
 * threshold exists to protect. The session then hands off early, with a journal that can
 * only say it ran out of room.
 *
 * Three decisions are load-bearing, and all three came from a specific failure mode:
 *
 *   - **Head AND tail, never head alone.** A test runner prints the failure summary last
 *     and a compiler prints the first error first. Keeping only the head loses the verdict;
 *     keeping only the tail loses what started it. Both ends, and the output says which it
 *     kept — see `elision` below.
 *   - **Lines AND bytes.** A line ceiling alone lets one `cat` of a minified lockfile
 *     through whole, which is the single most expensive case. A byte ceiling alone lets
 *     40,000 one-word lines through, which is the most common one.
 *   - **The elision is stated.** Silent truncation makes a model believe a file ends where
 *     it does not, and it will act on that. `journal.ts` states its own elisions for the
 *     same reason.
 *
 * Pure: this module decides what to keep and what to say about the rest. Writing the
 * overflow to a file is `exec.ts`'s job, and the path it chose is passed back in here only
 * so the note can name it.
 */

/**
 * Built-in ceiling on lines from one tool call.
 *
 * 2,000 is pi's own `DEFAULT_MAX_LINES` for its bash tool and `cluster.maxLogLines`'s cap.
 * Matching it keeps one number in the system rather than three, and it is roughly 8k
 * tokens of typical output — a fifth of what `journal.ts` allows itself, for something a
 * session does many times rather than once.
 */
export const MAX_OUTPUT_LINES = 2_000;

/** Built-in ceiling on bytes from one tool call. 50KiB, again pi's own default. */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** What a config may ask for. Both halves optional; both default and clamp. */
export interface OutputCeilingRequest {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

export interface OutputCeiling {
  readonly maxLines: number;
  readonly maxBytes: number;
}

/**
 * A requested ceiling, defaulted and clamped.
 *
 * Same rule as `limits.commandTimeoutSeconds`: absent becomes the default, and anything
 * above the built-in cap is lowered to it. A bound that the thing being bounded can raise
 * is not a bound — and the agent can edit config files in its own worktree, so "the model
 * cannot raise it" has to be true of the code and not just of the prompt.
 *
 * Nonsense — zero, negative, fractional, NaN — becomes the DEFAULT rather than an error.
 * A `RangeError` here would be thrown per command, deep inside a tool call, on a config
 * the session may not have written; the default is the one answer that is never "no limit".
 */
export const outputCeiling = (request: OutputCeilingRequest): OutputCeiling => ({
  maxLines: clampPositiveInteger(request.maxLines, MAX_OUTPUT_LINES),
  maxBytes: clampPositiveInteger(request.maxBytes, MAX_OUTPUT_BYTES),
});

const clampPositiveInteger = (asked: number | undefined, ceiling: number): number =>
  asked === undefined || !Number.isInteger(asked) || asked < 1 ? ceiling : Math.min(asked, ceiling);

export interface BoundOutputOptions {
  /**
   * Where the whole output was written, if it was, relative to the agent's cwd.
   *
   * Named in the elision so a session that needs the middle can read it in slices. Absent
   * when nothing was spilled — in which case the note says only what is missing, which is
   * still better than saying nothing.
   */
  readonly overflowPath?: string;
}

export interface BoundedOutput {
  /** What the caller may put in front of the model, elision note included. */
  readonly text: string;
  readonly elided: boolean;
  /** Lines the model will not see. 0 when nothing was dropped. */
  readonly droppedLines: number;
  /** Lines the original had, for the log line and the metric. */
  readonly totalLines: number;
}

/**
 * Bound one tool's output, keeping both ends and declaring the gap.
 *
 * The line budget is split 1:3 head to tail. The tail is where a failing command puts its
 * verdict, so it gets the larger share; the head is kept at all because a run whose FIRST
 * error matters — a compiler, a linter — is otherwise unreadable.
 */
export const boundOutput = (
  text: string,
  ceiling: OutputCeiling,
  options: BoundOutputOptions = {},
): BoundedOutput => {
  const totalLines = countLines(text);

  if (text.length === 0) {
    return { text, elided: false, droppedLines: 0, totalLines: 0 };
  }
  if (totalLines <= ceiling.maxLines && Buffer.byteLength(text, "utf8") <= ceiling.maxBytes) {
    return { text, elided: false, droppedLines: 0, totalLines };
  }

  const lines = text.split("\n");
  const kept = keepBothEnds(lines, ceiling);

  // No whole line fits — one line is longer than the entire byte budget. The "never a
  // partial line" guarantee has to give way here, and it gives way loudly: a cut line that
  // looks complete is how a model comes to believe a file ends where it does not.
  if (kept.head.length === 0 && kept.tail.length === 0) {
    const shown = sliceBytes(text, ceiling.maxBytes);
    return {
      text: `${shown}\n${byteElision(shown, text, options.overflowPath)}`,
      elided: true,
      droppedLines: 0,
      totalLines,
    };
  }

  const shownLines = kept.head.length + kept.tail.length;
  const note = lineElision(shownLines, totalLines, kept.head.length > 0, options.overflowPath);
  const body = [...kept.head, note, ...kept.tail].join("\n");

  return { text: body, elided: true, droppedLines: totalLines - shownLines, totalLines };
};

/**
 * Lines counted the way a shell counts them: a trailing newline does not start a line.
 *
 * Without this, `printf 'a\n'` is two lines and every bounded count is off by one against
 * what `wc -l` told the operator.
 */
const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
};

/** Fraction of the line budget spent on the head. The rest goes to the tail. */
const HEAD_SHARE = 0.25;

/**
 * Take lines from both ends until either budget runs out.
 *
 * Tail first, and the tail gets what the head does not use: on a failing command the last
 * line is the one the session most needs, so if only one line fits it must be that one.
 */
const keepBothEnds = (
  lines: readonly string[],
  ceiling: OutputCeiling,
): { readonly head: string[]; readonly tail: string[] } => {
  const headLimit = Math.max(1, Math.floor(ceiling.maxLines * HEAD_SHARE));
  const tailLimit = ceiling.maxLines - headLimit;

  const tail: string[] = [];
  const head: string[] = [];
  // Charged against the byte budget even though it is not part of the output, because the
  // note is what the model reads and paying for it is the honest accounting.
  let bytes = 0;

  const fits = (line: string): boolean => {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + cost > ceiling.maxBytes) return false;
    bytes += cost;
    return true;
  };

  for (let index = lines.length - 1; index >= 0 && tail.length < tailLimit; index -= 1) {
    const line = lines[index] ?? "";
    if (!fits(line)) break;
    tail.unshift(line);
  }
  for (let index = 0; index < lines.length - tail.length && head.length < headLimit; index += 1) {
    const line = lines[index] ?? "";
    if (!fits(line)) break;
    head.push(line);
  }

  return { head, tail };
};

/** Cut a string to a byte budget without splitting a UTF-8 sequence. */
const sliceBytes = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Back off any continuation byte, so the cut never lands inside a code point and the
  // model is not handed a replacement character it will read as content.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

const where = (overflowPath: string | undefined): string =>
  overflowPath === undefined
    ? "The rest was not written anywhere and is gone."
    : `The whole output is in ${overflowPath} — read it in slices (sed -n, tail, grep) ` +
      `rather than whole, or you will spend the context this saved.`;

const lineElision = (
  shown: number,
  total: number,
  keptHead: boolean,
  overflowPath: string | undefined,
): string =>
  `[caterpillar: output bounded — ${shown.toLocaleString("en-US")} of ` +
  `${total.toLocaleString("en-US")} lines shown, ` +
  `${keptHead ? "head and tail kept, the middle elided" : "tail kept, the start elided"}. ` +
  `${where(overflowPath)}]`;

const byteElision = (shown: string, whole: string, overflowPath: string | undefined): string =>
  `[caterpillar: output bounded — ` +
  `${Buffer.byteLength(shown, "utf8").toLocaleString("en-US")} of ` +
  `${Buffer.byteLength(whole, "utf8").toLocaleString("en-US")} bytes shown, head kept: no ` +
  `whole line fits the byte ceiling, so this line is CUT and does not end where it appears ` +
  `to. ${where(overflowPath)}]`;
