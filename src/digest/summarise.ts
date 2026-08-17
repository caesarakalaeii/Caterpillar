/**
 * The prose paragraph of a digest. See DESIGN.md §19.
 *
 * Everything else in a digest is measured; this part is written, and that difference
 * drives every decision here.
 *
 * **No tools.** The summariser cannot read a file, run a command or reach a repo. It is
 * given evidence and asked to describe it, so the worst it can do is describe the evidence
 * badly — it cannot go looking for a story. That is deliberate: this runs unattended once
 * a day and its output is posted to a channel where nobody will diff it against the repo.
 *
 * **The evidence is facts.** The rendered digest (measured from git), the agent's own
 * journal entries for the window (the audit trail, §4.1), and the commit subjects and
 * diffstat that actually landed. Prose about a day is only worth reading if the day is
 * real.
 *
 * **It never fails a digest.** A provider outage, a refusal, a model that says nothing —
 * all of them return an error string that the document prints in place of the prose. The
 * facts were never at risk, and a digest that failed to publish because a paragraph could
 * not be written would be the tail wagging the dog.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { ContextBudget } from "../agent/limits.ts";
import { runSession } from "../agent/session.ts";
import type { ControlSink } from "../agent/tools.ts";
import { EMPTY_USAGE, type UsageTotals } from "../domain/task.ts";
import type { LlmRuntime } from "../llm/models.ts";
import type { DayDigest } from "./collect.ts";
import { renderDigest } from "./render.ts";

export interface Summary {
  /** The paragraph, when one was written. */
  readonly narrative?: string;
  /** Why there is none, when there is none. Printed in the digest. */
  readonly error?: string;
  readonly usage: UsageTotals;
}

export interface Summariser {
  /** Never throws. A digest without prose is still a digest. */
  summarise(digest: DayDigest, signal?: AbortSignal): Promise<Summary>;
}

/**
 * Ceiling on the journal evidence, in code points.
 *
 * The journal is unbounded on disk by design (§4.1) and a retry storm can append hundreds
 * of near-identical blocks — SMOKE-1 finished with 347KB of it. Cut silently, the model
 * would summarise a third of a day with no way to know that is what it was shown, so the
 * cut is stated in the prompt.
 */
export const EVIDENCE_LIMIT = 24_000;

const SummariseParams = Type.Object({
  narrative: Type.String({
    description:
      "Three to six sentences on what the fleet actually changed. Plain prose, no " +
      "bullet list, no headings. Name tasks by id.",
  }),
});

const SYSTEM_PROMPT = `You write the opening paragraph of an autonomous coding fleet's daily digest.

Your reader runs the fleet. They already have the counts, the costs and the task list —
those are printed directly beneath your paragraph — so repeating them wastes the only part
of the document written in sentences.

Say what CHANGED: what the work did to the code, what it was for, what it ran into, and
what is now waiting on the reader. Group work that belongs together; a day spent twice on
the same subsystem is worth saying once.

Rules:
- Only state what the evidence supports. You cannot see the repositories — you have the
  commit subjects, the diffstat and the agent's own journal, and nothing else. If the
  evidence does not say why something was done, do not supply a reason.
- Never restate the numbers. "Three tasks finished" is already on the page.
- Prefer the concrete. "The mirror refresh stopped refusing renamed branches" beats
  "improvements were made to the workspace layer".
- If a task is stuck, parked, or waiting on a human, say so plainly and say what it needs.
- Three to six sentences. It is a paragraph, not a report.
- The fleet is called Caterpillar and its runners are runners. Do not name the model
  behind them, the vendor that trained it, or any tool it resembles — the reader is
  paying for the work, not for an advertisement, and next month it may be a different
  model doing the same job.

Call \`summarise_day\` exactly once. That ends your turn.`;

export interface LlmSummariserOptions {
  readonly llm: LlmRuntime;
  readonly timeZone: string;
  readonly thresholdFraction: number;
}

export class LlmSummariser implements Summariser {
  private readonly options: LlmSummariserOptions;

  constructor(options: LlmSummariserOptions) {
    this.options = options;
  }

  async summarise(digest: DayDigest, signal?: AbortSignal): Promise<Summary> {
    const { llm } = this.options;

    let narrative: string | undefined;
    const control: ControlSink = {};

    try {
      const result = await runSession({
        // So a pod shutting down is not held open by a paragraph. Everything that matters
        // about the day is already measured; this is the one call that waits on a network.
        ...(signal === undefined ? {} : { signal }),
        models: llm.models,
        model: llm.model,
        systemPrompt: SYSTEM_PROMPT,
        initialPrompt: summaryPrompt(digest, this.options.timeZone),
        tools: [
          {
            name: "summarise_day",
            label: "Summarise the day",
            description: "Record the paragraph and end this pass. Call it exactly once.",
            parameters: SummariseParams,
            execute: async (_id: string, params: Static<typeof SummariseParams>) => {
              narrative = params.narrative;
              control.signal = { reason: "done-claimed", summary: "digest summarised" };
              return { content: [{ type: "text" as const, text: "Recorded." }], details: null };
            },
          } as AgentTool,
        ],
        budget: new ContextBudget({
          contextWindow: llm.model.contextWindow,
          thresholdFraction: this.options.thresholdFraction,
        }),
        control,
      });

      if (narrative === undefined || narrative.trim() === "") {
        return {
          error: result.outcome.error ?? "the model ended without writing one",
          usage: result.outcome.usage,
        };
      }

      return { narrative: narrative.trim(), usage: result.outcome.usage };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error.message : String(error),
        usage: EMPTY_USAGE,
      };
    }
  }
}

/**
 * The evidence, as the model is shown it.
 *
 * Pure, and exported, because the prompt IS the guarantee: what this function does not put
 * in is what the summariser cannot know, and that is worth being able to assert on.
 */
export const summaryPrompt = (digest: DayDigest, timeZone: string): string => {
  const facts = renderDigest({ digest, timeZone, runner: "the fleet" });

  const evidence: string[] = [];
  let spent = 0;
  let omitted = 0;

  for (const change of digest.changed) {
    // The paths are already bounded by the change reader and are the cheapest evidence
    // there is — they say which part of the system a day was spent on when the commit
    // subjects do not.
    const touched = change.changes.flatMap((repo) =>
      repo.files.length === 0 ? [] : [`Files touched in \`${repo.repo}\`: ${repo.files.join(", ")}`],
    );

    const journal = change.journal;
    const size = journal === undefined ? 0 : [...journal].length;
    // Whole entries only. Half a journal entry is evidence of nothing, and a model given
    // one will happily finish the sentence itself.
    const fits = journal !== undefined && spent + size <= EVIDENCE_LIMIT;
    if (journal !== undefined && !fits) omitted += 1;
    if (fits) spent += size;

    if (touched.length === 0 && !fits) continue;
    evidence.push(
      `### \`${change.id}\` — ${change.title}`,
      "",
      ...(touched.length === 0 ? [] : [...touched, ""]),
      ...(fits ? [(journal as string).trim(), ""] : []),
    );
  }

  return [
    "Here is everything measured about the window, followed by what the agents wrote",
    "about it themselves.",
    "",
    "## The measured digest",
    "",
    facts,
    "",
    ...(evidence.length === 0
      ? []
      : ["## What the agents recorded in this window", "", ...evidence]),
    ...(omitted === 0
      ? []
      : [
          `_${omitted} task journal(s) omitted here to stay inside the evidence budget. Do`,
          "not assume the omitted tasks did nothing — say only what the measured digest",
          "above shows about them._",
          "",
        ]),
    digest.quiet
      ? "Nothing moved in this window. Say so in one sentence; do not pad it."
      : "Write the paragraph, then call `summarise_day`.",
  ].join("\n");
};
