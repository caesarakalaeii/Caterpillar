/**
 * Runs exactly one agent session. See DESIGN.md §6.
 *
 * A session ends in one of three ways:
 *   1. a control-plane tool fired (ask_human / handoff / done / blocked)
 *   2. the context budget hit the handoff threshold — `shouldStopAfterTurn`
 *   3. it errored
 *
 * In every case the caller gets a SessionOutcome and the state repo is updated
 * before the process is allowed to exit. Sessions never mutate task state directly;
 * that is the supervisor's job, so a crashed session cannot leave half-written state.
 *
 * (3) is subtler than it looks and is the reason this file was amended. pi does NOT
 * throw when a provider request fails: `Agent` catches it, appends an assistant message
 * carrying `stopReason: "error"` and an `errorMessage`, and returns. A `try/catch`
 * around `prompt()` sees a perfectly ordinary return, so an errored session used to be
 * reported as "ended without a control-plane decision" — a handoff. Both halves of the
 * failure are read here now.
 */
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, MutableModels, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { EMPTY_USAGE, type SessionOutcome, type UsageTotals } from "../domain/task.ts";
import { classifyProviderFailure } from "../llm/outage.ts";
import { ContextBudget } from "./limits.ts";
import type { ControlSink } from "./tools.ts";

/**
 * Attempts after the first, for the errors an immediate retry can actually fix.
 *
 * pi's default is zero, so a single 500 or a one-second burst limit ended a whole
 * session and cost a fresh context to resume from. The policy underneath is pi's
 * (`retryProviderRequest`): 408/409/429/5xx only, exponential backoff, and — the part
 * that matters here — a refusal to sit out a wait longer than `maxRetryDelayMs`. A
 * spend limit therefore still fails fast rather than parking the runner on a socket
 * for an hour, and `classifyProviderFailure` reads the delay the server asked for out
 * of the resulting message.
 */
const MAX_PROVIDER_RETRIES = 2;

export interface SessionOptions {
  readonly models: MutableModels;
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  /** Prompt assembled from spec.md + journal.md + handoff.md. */
  readonly initialPrompt: string;
  readonly tools: readonly AgentTool[];
  readonly budget: ContextBudget;
  readonly control: ControlSink;
  /** Prior transcript when resuming rather than starting fresh. */
  readonly messages?: readonly AgentMessage[];
  readonly signal?: AbortSignal;
}

export interface SessionResult {
  readonly outcome: SessionOutcome;
  readonly messages: readonly AgentMessage[];
  /**
   * True when the session ended past the point where context is no longer safely
   * within the window. Must always be false: it means the handoff trigger fired too
   * late and the next provider request risks a context-length error (DESIGN.md §6.1).
   */
  readonly contextOverrun: boolean;
}

const toTotals = (usage: Usage): UsageTotals => ({
  inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
  outputTokens: usage.output,
  costUsd: usage.cost.total,
});

const sumTotals = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

export const runSession = async (options: SessionOptions): Promise<SessionResult> => {
  const { budget, control } = options;

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...options.tools],
      ...(options.messages !== undefined ? { messages: [...options.messages] } : {}),
    },
    // Wrapped rather than bound, only to add the retry budget. The caller's options win
    // if they ever carry one, so this is a default and not an override.
    streamFn: (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) =>
      options.models.streamSimple(model, context, {
        ...streamOptions,
        maxRetries: streamOptions?.maxRetries ?? MAX_PROVIDER_RETRIES,
      }),
  });

  let sessionUsage: UsageTotals = EMPTY_USAGE;
  let handoffTriggered = false;

  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      sessionUsage = sumTotals(sessionUsage, toTotals(event.message.usage));
    }
  });

  /**
   * The handoff trigger. Evaluated at a turn boundary, so the agent always finishes
   * the tool calls it started — "finish the current atomic step, then stop".
   *
   * A control-plane tool takes precedence: if the agent already decided to park or
   * claim done, that reason is more informative than a token threshold.
   */
  agent.shouldStopAfterTurn = ({ context }) => {
    if (control.signal !== undefined) return true;
    if (budget.shouldHandoff(context.messages)) {
      handoffTriggered = true;
      return true;
    }
    return false;
  };

  let error: string | undefined;
  try {
    await agent.prompt(options.initialPrompt);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  // The failure pi swallowed, if the throw did not happen. `errorMessage` is cleared at
  // the start of every run and set from the last turn, so it describes THIS session.
  error ??= agent.state.errorMessage;

  const messages = agent.state.messages;
  const contextTokens = budget.tokensUsed(messages);

  return {
    outcome: buildOutcome({
      control,
      error,
      handoffTriggered,
      sessionUsage,
      contextTokens,
    }),
    messages,
    contextOverrun: budget.wouldCompact(messages),
  };
};

interface OutcomeInput {
  readonly control: ControlSink;
  readonly error: string | undefined;
  readonly handoffTriggered: boolean;
  readonly sessionUsage: UsageTotals;
  readonly contextTokens: number;
}

const buildOutcome = (input: OutcomeInput): SessionOutcome => {
  const base = { usage: input.sessionUsage, contextTokens: input.contextTokens };

  if (input.error !== undefined) {
    // An outage is reported ahead of any control signal for the same reason an error
    // is: whatever the agent had decided, this session did not finish deciding it.
    const outage = classifyProviderFailure(input.error);
    if (outage !== undefined) {
      return {
        ...base,
        reason: "provider-unavailable",
        error: input.error,
        outage,
        summary: `the model provider stopped answering: ${outage.detail}`,
      };
    }

    return {
      ...base,
      reason: "error",
      error: input.error,
      summary: `session failed: ${input.error}`,
    };
  }

  const signal = input.control.signal;
  if (signal !== undefined) {
    return {
      ...base,
      reason: signal.reason,
      summary: signal.summary,
      ...(signal.question !== undefined ? { question: signal.question } : {}),
      ...(signal.requires !== undefined ? { requires: signal.requires } : {}),
      ...(input.control.plan !== undefined ? { plan: input.control.plan } : {}),
    };
  }

  if (input.handoffTriggered) {
    return {
      ...base,
      reason: "handoff",
      summary: `context budget reached at ${input.contextTokens} tokens`,
    };
  }

  // The model stopped on its own without calling a control tool. Treat as a handoff
  // rather than completion — silence is not a completion claim.
  return {
    ...base,
    reason: "handoff",
    summary: "session ended without a control-plane decision",
  };
};

/** Re-exported so the supervisor can account usage from stored transcripts. */
export { calculateContextTokens };
