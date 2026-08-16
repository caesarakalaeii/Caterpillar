/**
 * The webhook call, driven against a stub that answers the way Discord actually does:
 * 204 with no body on success, 429 with a `retry_after` on a burst, 404 for a webhook
 * that was deleted in the UI.
 *
 * Every assertion here is on what was POSTED, not on "it did not throw" — the whole
 * failure mode this guards against is a notifier that reports success while sending
 * something Discord rejects (a 2001-character question) or something it should never
 * have sent at all (an `@everyone` the agent wrote).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { CONTENT_LIMIT, DiscordNotifier, type Notification, render } from "./discord.ts";

const TASK = asTaskId("SMOKE-1");

/** A real-looking webhook URL: the last path segment IS the credential. */
const WEBHOOK = "https://discord.com/api/webhooks/12345/s3cret-token-value";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: { readonly content: string; readonly allowed_mentions?: unknown };
}

const stub = (
  responses: readonly Response[],
): {
  readonly calls: Call[];
  readonly slept: number[];
  readonly notifier: (max?: number) => DiscordNotifier;
} => {
  const calls: Call[] = [];
  const slept: number[] = [];
  const queue = [...responses];

  return {
    calls,
    slept,
    notifier: (max?: number) =>
      new DiscordNotifier({
        webhookUrl: WEBHOOK,
        sleep: async (ms) => {
          slept.push(ms);
        },
        ...(max === undefined ? {} : { maxRetries: max }),
        fetch: (url, init) => {
          calls.push({
            url,
            method: init?.method ?? "GET",
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(init?.body ?? "{}")) as Call["body"],
          });
          const next = queue.shift();
          assert.ok(next !== undefined, "the stub ran out of responses — too many calls");
          return Promise.resolve(next);
        },
      }),
  };
};

/** Discord counts code points; so does every length assertion here. */
const size = (text: string): number => [...text].length;

const ok = (): Response => new Response(null, { status: 204 });

test("a notification is POSTed to the webhook as JSON", async () => {
  const { calls, notifier } = stub([ok()]);
  await notifier().notify({ kind: "done", task: TASK, prUrl: "https://example.invalid/pr/1" });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, WEBHOOK);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.body.content, render({ kind: "done", task: TASK, prUrl: "https://example.invalid/pr/1" }));
  assert.match(call.body.content, /SMOKE-1/);
});

test("mentions the agent wrote are never allowed to fire", async () => {
  // The question text is agent-authored prose quoting whatever it read. Without this
  // field, a task whose repo contains the literal string `@everyone` pages the entire
  // server the first time the agent asks a question.
  const { calls, notifier } = stub([ok()]);
  await notifier().notify({
    kind: "question",
    task: TASK,
    phase: "implementing",
    question: "Should I delete @everyone from the ACL, or keep <@&12345>?",
  });

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.deepEqual(
    call.body.allowed_mentions,
    { parse: [] },
    "suppressing mentions must be explicit — Discord's default is to parse them all",
  );
  assert.match(call.body.content, /@everyone/, "the text itself is kept, only the ping is not");
});

test("long prose is truncated but the frame around it survives", async () => {
  // Discord answers a 2001-character content with a 400 and drops the message
  // entirely, so an untruncated question is not a long notification — it is no
  // notification, on exactly the path where silence is most expensive.
  const question = "why ".repeat(2000);
  const content = render({ kind: "question", task: TASK, phase: "implementing", question });

  assert.ok(size(content) <= CONTENT_LIMIT, `content was ${size(content)} code points`);
  assert.match(content, /SMOKE-1/, "the task id must survive truncation");
  assert.match(content, /!answer SMOKE-1/, "the reply instruction must survive truncation");
  assert.match(content, /truncated/, "a reader must be able to tell prose was cut");
});

test("content is clamped even when the frame alone is oversized", async () => {
  // A TaskId is an unbranded string derived from a tracker ref, so nothing upstream
  // bounds its length. Asserted on the POSTED body, because that is what Discord
  // validates.
  const { calls, notifier } = stub([ok()]);
  await notifier().notify({
    kind: "parked",
    task: asTaskId("T".repeat(CONTENT_LIMIT * 2)),
    reason: "no progress",
  });

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.ok(
    size(call.body.content) <= CONTENT_LIMIT,
    `posted ${size(call.body.content)} code points`,
  );
});

test("truncation does not split a surrogate pair", async () => {
  // Slicing UTF-16 units mid-pair yields a lone surrogate, which JSON.stringify happily
  // encodes and Discord rejects as invalid — a 400 that only appears for emoji.
  //
  // The leading "x" is load-bearing: it shifts the cut to an ODD unit offset. Pure emoji
  // prose puts the boundary between two pairs, where a UTF-16 slice is accidentally
  // correct and this test passes over the bug it exists to catch.
  const { calls, notifier } = stub([ok()]);
  await notifier().notify({ kind: "failed", task: TASK, error: `x${"🙂".repeat(CONTENT_LIMIT)}` });

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      call.body.content,
    ),
    false,
    "a lone surrogate survived truncation",
  );
});

test("a 429 is retried after the delay Discord asked for", async () => {
  const limited = new Response(JSON.stringify({ retry_after: 1.5 }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
  const { calls, slept, notifier } = stub([limited, ok()]);

  await notifier().notify({ kind: "parked", task: TASK, reason: "context limit" });

  assert.equal(calls.length, 2, "a rate-limited notification must be sent, not dropped");
  assert.deepEqual(slept, [1500], "Discord's advertised delay is in SECONDS, not ms");
});

test("the retry delay is capped so a notification cannot stall the supervisor", async () => {
  // notify() is awaited inside the task loop: an honoured `retry_after: 3600` would
  // block the runner for an hour over a signal message.
  const limited = new Response(JSON.stringify({ retry_after: 3600 }), { status: 429 });
  const { slept, notifier } = stub([limited, ok()]);

  await notifier().notify({ kind: "parked", task: TASK, reason: "context limit" });

  const delay = slept[0] ?? 0;
  assert.ok(delay > 0 && delay <= 10_000, `delay was ${delay}ms`);
});

test("a 5xx is retried, then gives up rather than looping forever", async () => {
  const down = (): Response => new Response("upstream boom", { status: 503 });
  const { calls, notifier } = stub([down(), down(), down()]);

  await assert.rejects(
    () => notifier(2).notify({ kind: "done", task: TASK, prUrl: "https://example.invalid/pr/1" }),
    (error: Error) => {
      assert.match(error.message, /503/);
      return true;
    },
  );
  assert.equal(calls.length, 3, "one attempt plus maxRetries, and no more");
});

test("a 4xx that retrying cannot fix fails on the first attempt", async () => {
  // A deleted webhook answers 404 forever. Retrying it burns the loop's time and
  // hides the one thing the operator needs to see.
  const { calls, notifier } = stub([
    new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }),
  ]);

  await assert.rejects(
    () => notifier().notify({ kind: "parked", task: TASK, reason: "context limit" }),
    /404/,
  );
  assert.equal(calls.length, 1, "a 404 must not be retried");
});

test("the webhook token never reaches the error message", async () => {
  // The URL is the credential: anyone holding it can post as the bot. It must not be
  // reachable from a thrown error, which the supervisor logs verbatim.
  const { notifier } = stub([new Response("bad request", { status: 400 })]);

  await assert.rejects(
    () => notifier().notify({ kind: "parked", task: TASK, reason: "context limit" }),
    (error: Error) => {
      assert.equal(error.message.includes("s3cret-token-value"), false, error.message);
      assert.equal(error.message.includes(WEBHOOK), false, error.message);
      return true;
    },
  );
});

test("every notification kind renders with the task id and its payload", async () => {
  const cases: readonly Notification[] = [
    { kind: "question", task: TASK, phase: "implementing", question: "which migration?" },
    { kind: "parked", task: TASK, reason: "no progress for 3 sessions" },
    { kind: "done", task: TASK, prUrl: "https://example.invalid/pr/1" },
    { kind: "failed", task: TASK, error: "mirror clone failed" },
    {
      kind: "provider-unavailable",
      task: TASK,
      detail: "This request would exceed your account's monthly spend limit.",
      retryInSeconds: 1800,
    },
    { kind: "provider-recovered", task: TASK },
  ];

  for (const notification of cases) {
    const content = render(notification);
    assert.match(content, /SMOKE-1/, notification.kind);
    assert.ok(size(content) > 0 && size(content) <= CONTENT_LIMIT, notification.kind);
  }
});

test("a pause says what broke, that no task is at fault, and when it retries", () => {
  // The message a human wakes up to. It has to answer all three questions at once, or
  // the obvious reading of "paused" is "a task did something wrong".
  const content = render({
    kind: "provider-unavailable",
    task: TASK,
    detail: "This request would exceed your account's monthly spend limit.",
    retryInSeconds: 1800,
  });

  assert.match(content, /monthly spend limit/);
  assert.match(content, /nothing is at fault/);
  assert.match(content, /30 minutes/);
});
