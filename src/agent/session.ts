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
import type { SteeringFeed } from "./steering.ts";
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

/**
 * How a steer is framed for the model.
 *
 * Attributed, because an unattributed sentence dropped into a transcript mid-run reads like
 * something the agent said to itself, and an agent that mistakes its own note for an
 * instruction from a human has no way to weigh it. Marked as an interruption too: the model
 * is mid-task and the useful reading of "use the existing migration path" is "change course
 * now", not "here is some background".
 */
const steeringPrompt = (text: string): string =>
  `[Message from the operator, sent while you are working. Take it into account from here ` +
  `on — it may change what you should do next.]\n\n${text}`;

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
  /**
   * Called as each message settles, so something outside can watch a session that will
   * not write its transcript for another half hour (DESIGN.md §18).
   *
   * Observation only: it must not throw, and nothing here waits on it.
   */
  readonly onMessage?: (message: AgentMessage) => void;
  /**
   * Stops the session from outside: pod shutdown, a lost lease, a human `/cancel`, or
   * the wall clock. Declared here for a long time and read nowhere, which meant none of
   * those could actually stop anything — a hung `bash` call with no timeout wedged the
   * whole single-threaded runner while the heartbeat kept renewing the lease and
   * /healthz kept answering 200.
   */
  readonly signal?: AbortSignal;
  /**
   * Wall-clock ceiling on THIS session. A hang detector, not a budget.
   *
   * Required, and that is the point. It was the supervisor's job, applied around the
   * agent's session and nowhere else — but the council, the plan maintainer and the
   * digest summariser all run sessions too, and all three ran them with no signal
   * whatsoever. A provider request that never returns wedges the work loop: claiming sits
   * behind it, the heartbeat keeps renewing the lease, and /healthz keeps answering 200.
   * One did exactly that for 7h20m inside `council.start`, with zero restarts — back when
   * the chat drain and intake sat behind it as well (§6.4 has since split those out).
   *
   * Making it a required field rather than an optional one is the whole fix. A caller
   * may add a signal of its own — shutdown, a lost lease, a `/cancel` — but it cannot
   * take this away, and the next call site cannot quietly omit it.
   */
  readonly timeoutSeconds: number;
  /**
   * Where a human's mid-session guidance comes from (DESIGN.md §7.3).
   *
   * Optional, and absent is a session nobody can talk to — which is what every session was
   * until this existed. The council, the plan maintainer and the digest summariser all pass
   * nothing, deliberately: they are not the agent, they run for minutes rather than hours,
   * and a verdict a human leaned on is not a verdict.
   */
  readonly steering?: SteeringFeed;
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

  // `all`, not `one-at-a-time`. Refining an idea is many short replies (§14.3), so several
  // messages routinely arrive inside one turn; draining them one per turn would spend a
  // whole provider request on each and deliver the last one several turns after it was
  // typed — by which time it is advice about work already done.
  agent.steeringMode = "all";

  let sessionUsage: UsageTotals = EMPTY_USAGE;
  let handoffTriggered = false;

  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    if (event.message.role === "assistant") {
      sessionUsage = sumTotals(sessionUsage, toTotals(event.message.usage));
    }
    // An observer that throws would tear down pi's event dispatch mid-session, which is
    // a live view costing the task it was watching.
    try {
      options.onMessage?.(event.message);
    } catch {
      /* watching is never worth a session */
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

  // pi exposes `abort()` rather than taking a signal, so the bridge is explicit. The
  // listener is removed in the `finally` below: `options.signal` outlives this session —
  // it belongs to the task, which may run many — and an accumulating listener per session
  // is a leak that ends in a MaxListenersExceededWarning on a long-lived task.
  const abort = (): void => agent.abort();
  // The caller's reasons to stop and this session's own ceiling, as one signal. `any`
  // rather than a second listener so that everything downstream — the pre-flight check
  // below, `interrupted` in the outcome, the tools' own `signal` — sees both alike, and
  // a timeout is indistinguishable from a `/cancel` to code that has no business
  // telling them apart.
  const deadline = AbortSignal.timeout(options.timeoutSeconds * 1000);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  signal.addEventListener("abort", abort, { once: true });

  // Human input, queued rather than injected: pi drains the queue at a turn boundary, so
  // the agent always finishes the tool calls it started before it reads anything new. The
  // backlog goes in first and in order — it was typed before whatever arrives next.
  //
  // `steer` is not awaited and cannot be: it is called from a Redis subscription callback
  // (§21), and a queue push is synchronous anyway.
  const enqueue = (text: string): void => {
    agent.steer({ role: "user", content: steeringPrompt(text), timestamp: Date.now() });
  };
  for (const text of options.steering?.take() ?? []) enqueue(text);
  const unsubscribe = options.steering?.subscribe(enqueue);

  let error: string | undefined;
  try {
    // Already aborted before we started: do not spend a request to find out.
    if (!signal.aborted) await agent.prompt(options.initialPrompt);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    signal.removeEventListener("abort", abort);
    // Before anything else in the unwind. The feed outlives this session — it belongs to
    // the slot, which may run many — so a listener left behind would deliver the next
    // human's sentence into an `Agent` that has already finished.
    unsubscribe?.();
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
      interrupted: signal.aborted,
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
  readonly interrupted: boolean;
}

const buildOutcome = (input: OutcomeInput): SessionOutcome => {
  const base = { usage: input.sessionUsage, contextTokens: input.contextTokens };

  // FIRST, ahead of the error branch. Aborting the agent surfaces as a thrown
  // AbortError, and classifying that as a session failure would park a task for a pod
  // restart — and, worse, count it against the no-progress streak.
  if (input.interrupted) {
    return {
      ...base,
      reason: "interrupted",
      summary: "the session was stopped from outside — shutdown, lost lease, or cancel",
    };
  }

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
      ...(signal.questionOptions === undefined ? {} : { questionOptions: signal.questionOptions }),
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
