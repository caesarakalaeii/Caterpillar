/**
 * Bounding the journal on its way into a prompt. See DESIGN.md §4.1 and §15.
 *
 * `journal.md` appends forever and is read into EVERY session's opening prompt. That is
 * deliberate — it is the durable record a resumed session rebuilds from, and git keeps
 * it whole. What is NOT deliberate is paying for all of it, every session, first thing.
 *
 * SMOKE-1 ended with a 347KB journal: 620 byte-identical park entries from a retry
 * storm, around two entries that said anything. Any further session on that task would
 * have opened with ~90k tokens of the same sentence.
 *
 * So the FILE keeps everything and the PROMPT gets a bounded view. Nothing here writes;
 * truncation is a rendering decision, never a loss of history.
 */

/** ~8k tokens. Continuity lives in the last few entries; the rest is archaeology. */
const MAX_BUDGET_CHARS = 32_000;

/** Rough chars-per-token, only used to keep the cap proportionate on a small window. */
const CHARS_PER_TOKEN = 4;

/** At most this share of the context window may go to journal history. */
const WINDOW_SHARE = 0.05;

/**
 * How many characters of journal a model with this context window should be given.
 *
 * Fixed caps age badly in both directions: 32k characters is a rounding error in a 1M
 * window and a quarter of a 32k one, and the session still has to do its actual work in
 * whatever is left.
 */
export const journalBudgetChars = (contextWindow: number): number =>
  Math.max(1, Math.min(MAX_BUDGET_CHARS, Math.floor(contextWindow * WINDOW_SHARE * CHARS_PER_TOKEN)));

interface Entry {
  readonly heading: string;
  readonly body: string;
  readonly timestamp: string;
  /** Everything after the heading line, verbatim. Never rewritten. */
  readonly rest: string;
  /** How the entry renders, which is where a collapsed run states its count. */
  readonly text: string;
  readonly repeats?: number;
}

const HEADING = /^## Session (\d+) — (.*)$/gm;

/**
 * Split on entry boundaries by SLICING, so preamble + every entry re-joins into exactly
 * the input. Rebuilding from parsed lines quietly dropped the file's leading newline,
 * which meant a journal small enough to need no truncation still came back altered.
 */
const parse = (journal: string): { readonly preamble: string; readonly entries: Entry[] } => {
  const heads = [...journal.matchAll(HEADING)];
  const entries = heads.map((head, index) => {
    const from = head.index ?? 0;
    const to = heads[index + 1]?.index ?? journal.length;
    const text = journal.slice(from, to);
    return {
      heading: head[0],
      timestamp: head[2] ?? "",
      rest: text.slice(head[0].length),
      body: text.slice(head[0].length).trim(),
      text,
    };
  });

  return { preamble: journal.slice(0, heads[0]?.index ?? journal.length), entries };
};

/**
 * Fold a run of identical bodies into one entry that says how many there were.
 *
 * CONSECUTIVE only: parking, working, then parking again for the same reason is real
 * history, and the second park means something the first does not. A retry storm is a
 * run; a recurring problem is not.
 */
const collapse = (entries: readonly Entry[]): Entry[] => {
  const folded: Entry[] = [];

  for (const current of entries) {
    const previous = folded.at(-1);
    if (previous === undefined || previous.body !== current.body) {
      folded.push(current);
      continue;
    }

    const repeats = (previous.repeats ?? 1) + 1;
    folded[folded.length - 1] = {
      ...previous,
      repeats,
      // Rebuilt from the ORIGINAL heading and remainder every time. Deriving it from
      // the previous RENDER instead appended a second "(repeated ...)" on each fold, so
      // a run of 400 produced 399 suffixes on one heading.
      text:
        `${previous.heading} (repeated ${repeats} times, last at ${current.timestamp})` +
        previous.rest,
    };
  }

  return folded;
};

/** Rendered journal for a prompt: repeats folded, oldest entries dropped to fit. */
export const journalForPrompt = (journal: string, budget: number): string => {
  const { preamble, entries } = parse(journal);

  if (entries.length === 0) {
    // No headings to cut on — a hand-written or hand-edited journal. Keep the tail,
    // which is still the most recent thing that happened.
    if (journal.length <= budget) return journal;
    return `${elision(1)}\n${journal.slice(-budget)}`;
  }

  const folded = collapse(entries);
  const rendered = `${preamble}${folded.map((entry) => entry.text).join("")}`;
  if (rendered.length <= budget) return rendered;

  // Newest first until the budget runs out, then flip back to chronological order: a
  // journal read backwards is worse than a short one.
  const kept: Entry[] = [];
  let used = 0;
  for (const entry of [...folded].reverse()) {
    const cost = entry.text.length + 1;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(entry);
    used += cost;
  }

  return `${elision(folded.length - kept.length)}\n${kept.map((entry) => entry.text).join("")}`;
};

const elision = (count: number): string =>
  `\n_[${count} earlier entr${count === 1 ? "y" : "ies"} elided to fit the context ` +
  `budget. The full journal is in the state repo and nothing has been deleted.]_`;
