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
import { componentsFor, CONTENT_LIMIT, DiscordNotifier, type Notification, render } from "./discord.ts";

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
    { kind: "alert-task", task: TASK, alertname: "CaterpillarNoProgress", severity: "warning" },
  ];

  for (const notification of cases) {
    const content = render(notification);
    assert.match(content, /SMOKE-1/, notification.kind);
    assert.ok(size(content) > 0 && size(content) <= CONTENT_LIMIT, notification.kind);
  }
});

test("a refused alert names the alert rather than a task, and says it speaks once", () => {
  // The one notification besides the digest that has no task: the alert was declined, so
  // no task was created and there is nothing else to name (DESIGN.md §20). A reader also
  // has to be told the silence afterwards is deliberate, or the natural conclusion from one
  // message about an alert that keeps firing is that the receiver stopped working.
  const content = render({
    kind: "alert-refused",
    alertname: "CaterpillarNoProgress",
    fingerprint: "a1b2c3d4",
    detail: "`alerts/policy.yaml` has no entry for `CaterpillarNoProgress`.",
  });

  assert.match(content, /CaterpillarNoProgress/);
  assert.match(content, /a1b2c3d4/);
  assert.match(content, /alerts\/refusals\//);
  assert.ok(size(content) <= CONTENT_LIMIT);
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

test("a rejection says what was objected to, and what to do about it", () => {
  // The message this whole path exists for. `blocked by feasibility` was the entire body:
  // it named a lens, said nothing about the objection, and offered no next step — so a
  // brainstorm rejected three times running looked like a task that was simply stuck.
  const content = render({
    kind: "verdict",
    task: TASK,
    summary: "blocked by feasibility",
    detail: "**Feasibility** — task 2 declares no command that exercises the new endpoint.",
  });

  assert.match(content, /blocked by feasibility/, "the one-liner still names the lens");
  assert.match(content, /exercises the new endpoint/, "and the body says what it objected to");
  assert.match(content, /no action needed/, "an informational verdict must not read as a prompt");
  assert.match(content, /say what to change/, "…while still saying how to steer it");
});

test("the next step outlives a verdict too long to fit", () => {
  // `fit` truncates the prose it is GIVEN, so the objections are the prose and everything
  // that tells a reader what to do is the frame. Put the guidance inside the prose and the
  // longest, most contested verdicts are exactly the ones that arrive with no way forward.
  const content = render({
    kind: "verdict",
    task: TASK,
    summary: "blocked by design",
    detail: "the same objection restated ".repeat(200),
  });

  assert.ok(size(content) <= CONTENT_LIMIT, `content was ${size(content)} code points`);
  assert.match(content, /SMOKE-1/);
  assert.match(content, /blocked by design/);
  assert.match(content, /say what to change/, "the next step must survive truncation");
  assert.match(content, /truncated/, "and a reader must be able to tell prose was cut");
});

test("a stalled plan offers prose and a resume, never a merge", () => {
  // A brainstorm that stalls has produced no change and has no PR, so `review-stalled`'s
  // offer to "merge it as it stands" pointed at nothing. This is the park where a human
  // most reliably concluded there was nothing they could do.
  const content = render({
    kind: "plan-stalled",
    task: TASK,
    rounds: 3,
    summary: "blocked by decomposition",
    detail: "**Decomposition** — the five proposed tasks are one task.",
  });

  assert.match(content, /sent back 3 times/);
  assert.match(content, /five proposed tasks are one task/);
  assert.match(content, /\/resume SMOKE-1/);
  assert.doesNotMatch(content, /merge/i, "there is no pull request to merge");
});

test("a stalled review keeps the merge, and names the alternative to it", () => {
  const content = render({
    kind: "review-stalled",
    task: TASK,
    rounds: 3,
    summary: "blocked by correctness",
    detail: "**Correctness** — throws on an empty repo list.",
    prUrl: "https://example.invalid/pr/9",
    canMerge: true,
  });

  assert.match(content, /requested changes 3 times/);
  assert.match(content, /throws on an empty repo list/);
  assert.match(content, /Merge it as it stands/);
  assert.match(content, /\/resume SMOKE-1/);
});

test("a stalled plan says that resuming ALONE will not get past it", () => {
  // The failure mode the wording exists for: a human reads "parked", presses Resume, the
  // council refuses the same plan for the same reason, and it parks again. That happened ten
  // times to BS-1539374658363854934. The notification has to say that guidance is the part
  // that matters, not the restart.
  const content = render({
    kind: "plan-stalled",
    task: TASK,
    rounds: 13,
    summary: "blocked by feasibility, decomposition, criteria",
    detail: "**Criteria** — none of the five tasks declares a measurable command.",
  });

  assert.match(content, /sent back 13 times/);
  assert.match(content, /will not get past this/);
  assert.match(content, /round count/, "the reader has to know the budget is what resuming keeps");
});

test("every park a human is expected to act on carries the way back twice", () => {
  // Once as a button, because a park in a thread is read on a phone; once as prose, because
  // `resumeButton` returns undefined for an id too long to encode and a park with no stated
  // way forward is the failure this section is about.
  const parks: readonly Notification[] = [
    { kind: "parked", task: TASK, reason: "no progress for 3 sessions" },
    { kind: "failed", task: TASK, error: "the dev environment could not be prepared" },
    {
      kind: "plan-stalled",
      task: TASK,
      rounds: 3,
      summary: "blocked by criteria",
      detail: "**Criteria** — unmeasurable.",
    },
  ];

  for (const park of parks) {
    const attached = componentsFor(park);
    const labels = (attached ?? []).flatMap((r) => r.components.map((c) => ("label" in c ? c.label : "")));
    assert.ok(labels.includes("Resume"), `${park.kind} should offer a Resume button`);
  }
});

test("every park a human is expected to act on also offers to mark it done", () => {
  // The other half of the decision a park asks for: the task may be OBSOLETE rather than
  // stuck, and until now the only offered move was to resume it into work nobody wants.
  const parks: readonly Notification[] = [
    { kind: "parked", task: TASK, reason: "no progress for 3 sessions" },
    { kind: "failed", task: TASK, error: "the dev environment could not be prepared" },
    {
      kind: "plan-stalled",
      task: TASK,
      rounds: 3,
      summary: "blocked by criteria",
      detail: "**Criteria** — unmeasurable.",
    },
    {
      kind: "review-stalled",
      task: TASK,
      rounds: 3,
      reason: "the council keeps sending it back",
      canMerge: true,
      prUrl: "https://example.invalid/pr/1",
    },
  ];

  for (const park of parks) {
    const attached = componentsFor(park);
    const labels = (attached ?? []).flatMap((r) =>
      r.components.map((c) => ("label" in c ? c.label : "")),
    );
    assert.ok(labels.includes("Mark done"), `${park.kind} should offer a Mark done button`);
  }
});

test("a resume button refuses to encode rather than address the wrong task", () => {
  // `custom_id` is capped at 100 characters and a task id is tracker-derived. A clipped id is
  // still a valid-looking id, so the button is dropped instead — and the prose is what is
  // left, which is why it names the command.
  const long = asTaskId(`GH-acme-${"x".repeat(120)}`);
  const attached = componentsFor({ kind: "parked", task: long, reason: "no progress" });
  assert.equal(attached, undefined);
});
