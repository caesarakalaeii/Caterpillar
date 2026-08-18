/**
 * What the viewer does with four runners, one of which is not answering.
 *
 * The two facts under test are the two that make this process worth existing: a replica
 * that fails is RENDERED rather than dropped (a silently missing runner reads as an idle
 * one), and per-process data is unioned rather than sampled (the live panel used to show
 * whichever pod the Service picked, and a refresh showed a different one).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunnerId, asTaskId } from "../domain/task.ts";
import type { FleetView, TaskRow } from "../web/view.ts";
import { Aggregator } from "./aggregate.ts";
import { StaticDiscovery, type RunnerEndpoint } from "./discovery.ts";
import { Fanout } from "./fanout.ts";

const RUNNERS: readonly RunnerEndpoint[] = [
  { name: "caterpillar-0", base: "http://caterpillar-0:8080" },
  { name: "caterpillar-1", base: "http://caterpillar-1:8080" },
  { name: "caterpillar-2", base: "http://caterpillar-2:8080" },
  { name: "caterpillar-3", base: "http://caterpillar-3:8080" },
];

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id: asTaskId(id),
  title: id,
  kind: "implement",
  status: "ready",
  phase: "implementing",
  sessions: 1,
  maxSessions: 20,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
  requires: [],
  noProgressStreak: 0,
  blockedBy: [],
  held: false,
  updatedAt: "2026-08-18T09:00:00.000Z",
  ...over,
});

const fleetOf = (live: FleetView["live"], tasks: readonly TaskRow[] = []): FleetView => ({
  tasks,
  counts: { ready: tasks.length },
  runners: [],
  live,
});

/**
 * A fetch that answers from a table, and hangs for anyone not in it.
 *
 * The hang is the point of the timeout test: a runner that REFUSES a connection fails in
 * milliseconds and is the easy case. The one that costs a dashboard its page is the pod
 * that accepted the socket and then stopped answering, which is exactly what a
 * single-threaded supervisor wedged in a tool call looks like from outside.
 */
const fetcherFor = (
  answers: ReadonlyMap<string, unknown>,
  options: { readonly hang?: readonly string[]; readonly seen?: Headers[] } = {},
): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.headers !== undefined) options.seen?.push(new Headers(init.headers as Record<string, string>));

    if ((options.hang ?? []).some((prefix) => url.startsWith(prefix))) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }

    const body = answers.get(url);
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;

const aggregatorWith = (
  fetcher: typeof fetch,
  runners: readonly RunnerEndpoint[] = RUNNERS,
  timeoutMs = 25,
): Aggregator =>
  new Aggregator({
    discovery: new StaticDiscovery(runners),
    fanout: new Fanout({ timeoutMs, fetch: fetcher, forwardedUserHeader: "remote-user" }),
  });

test("four runners merge into one page, and the one that hangs is named", async () => {
  const answers = new Map<string, unknown>([
    [
      "http://caterpillar-0:8080/api/fleet",
      fleetOf(
        [
          {
            runner: "ignored-self-report",
            task: asTaskId("TASK-1"),
            session: 3,
            model: "claude-opus-5",
            startedAt: "2026-08-18T08:00:00.000Z",
            messages: 12,
          },
        ],
        [
          task("TASK-1", {
            status: "running",
            held: true,
            owner: {
              runner: asRunnerId("caterpillar-0"),
              leaseOid: "abc",
              since: "2026-08-18T08:00:00.000Z",
            },
          }),
          task("TASK-2"),
        ],
      ),
    ],
    ["http://caterpillar-1:8080/api/fleet", fleetOf([])],
    [
      "http://caterpillar-3:8080/api/fleet",
      fleetOf([
        {
          runner: "whatever-it-calls-itself",
          task: asTaskId("TASK-9"),
          session: 1,
          model: "claude-opus-5",
          startedAt: "2026-08-18T08:30:00.000Z",
          messages: 4,
        },
      ]),
    ],
  ]);

  const merged = await aggregatorWith(
    fetcherFor(answers, { hang: ["http://caterpillar-2:8080"] }),
  ).fleet({ path: "/api/fleet" });

  // The live panel is a UNION. Before this it was whichever pod the Service picked, and a
  // refresh showed a different one.
  assert.deepEqual(
    merged.view.live.map((entry) => `${entry.runner}:${entry.task}`),
    ["caterpillar-0:TASK-1", "caterpillar-3:TASK-9"],
    "the runner name is the DISCOVERED one, not whatever a pod calls itself",
  );

  // The task list is ONE runner's, because the state repo is identical everywhere.
  assert.deepEqual(merged.view.tasks.map((row) => row.id), ["TASK-1", "TASK-2"]);
  assert.equal(merged.source, "caterpillar-0");

  // Every discovered runner has a row, including the two holding nothing: an idle runner
  // stops being invisible without the registry in git §18 rejected twice.
  assert.deepEqual(
    merged.view.runners.map((row) => `${row.id}:${row.tasks.length}`),
    ["caterpillar-0:1", "caterpillar-1:0", "caterpillar-2:0", "caterpillar-3:0"],
  );
  assert.equal(merged.view.runners.every((row) => !row.self), true, "the viewer is not a runner");

  // And the one that did not answer is a fact on the page, not a gap in it.
  assert.deepEqual(
    merged.unreachable.map((entry) => `${entry.runner}:${entry.error}`),
    ["caterpillar-2:timed out"],
  );
});

test("logs from every ring are merged newest-first and tagged with their process", async () => {
  // `/logs` used to be one pod's thousand lines out of four thousand, and nothing on the
  // page said so.
  const answers = new Map<string, unknown>([
    [
      "http://caterpillar-0:8080/api/logs",
      {
        records: [
          { ts: "2026-08-18T09:00:02.000Z", level: "info", event: "poll.tick", fields: {} },
          { ts: "2026-08-18T09:00:00.000Z", level: "info", event: "boot", fields: {} },
        ],
      },
    ],
    [
      "http://caterpillar-1:8080/api/logs",
      {
        records: [
          { ts: "2026-08-18T09:00:01.000Z", level: "warn", event: "intake.rejected", fields: {} },
          // Something writing past the logger: no timestamp, and the one line worth seeing.
          { ts: "", level: "info", event: "log.unparsed", fields: { line: "boom" } },
        ],
      },
    ],
    ["http://caterpillar-2:8080/api/logs", { records: [] }],
    ["http://caterpillar-3:8080/api/logs", { records: [] }],
  ]);

  const merged = await aggregatorWith(fetcherFor(answers)).logs({ path: "/api/logs" });

  assert.deepEqual(
    merged.records.map((record) => `${record.runner}:${record.event}`),
    [
      "caterpillar-0:poll.tick",
      "caterpillar-1:intake.rejected",
      "caterpillar-0:boot",
      "caterpillar-1:log.unparsed",
    ],
  );
  assert.deepEqual(merged.unreachable, []);
  assert.equal(merged.answered.length, 4, "so `0 lines` differs from `nobody answered`");
});

test("the identity the proxy vouched for is forwarded on every fan-out request", async () => {
  // The runners' `requireForwardedUser` is a fail-closed check on the Ingress losing its
  // forward-auth annotations. The viewer must forward the header it RECEIVED rather than
  // the runners relaxing that check, or the seatbelt is cut to let this process through.
  const seen: Headers[] = [];
  const answers = new Map<string, unknown>(
    RUNNERS.map((runner) => [`${runner.base}/api/fleet`, fleetOf([])]),
  );

  await aggregatorWith(fetcherFor(answers, { seen })).fleet({
    path: "/api/fleet",
    user: "caesar",
  });

  assert.equal(seen.length, 4);
  for (const headers of seen) {
    assert.equal(headers.get("remote-user"), "caesar", "every replica, not just the first");
  }

  // And an anonymous request forwards nothing at all: inventing an identity would be this
  // process authenticating, which it must never do.
  seen.length = 0;
  await aggregatorWith(fetcherFor(answers, { seen })).fleet({ path: "/api/fleet" });
  for (const headers of seen) assert.equal(headers.get("remote-user"), null);
});

test("data that is identical everywhere comes from the first runner that answers", async () => {
  // The state repo is the fleet's shared surface, so asking four runners for one task's
  // documents is four times the work for one answer. The runners that failed on the way
  // there are still reported, because "you are reading this from the one runner that is
  // up" is worth saying.
  const answers = new Map<string, unknown>([
    ["http://caterpillar-2:8080/api/tasks/TASK-1", { id: "TASK-1" }],
  ]);

  const result = await aggregatorWith(
    fetcherFor(answers, { hang: ["http://caterpillar-0:8080"] }),
  ).fromAny<{ id: string }>({ path: "/api/tasks/TASK-1" });

  assert.equal(result.value?.id, "TASK-1");
  assert.equal(result.source, "caterpillar-2");
  assert.deepEqual(
    result.unreachable.map((entry) => `${entry.runner}:${entry.error}`),
    ["caterpillar-0:timed out", "caterpillar-1:404 Not Found"],
  );
});

test("a fleet where nobody answers is empty and says which runners were tried", async () => {
  const merged = await aggregatorWith(
    fetcherFor(new Map(), { hang: RUNNERS.map((runner) => runner.base) }),
  ).fleet({ path: "/api/fleet" });

  assert.deepEqual(merged.view.tasks, []);
  assert.equal(merged.source, undefined);
  assert.equal(merged.unreachable.length, 4);
  // Still one row per discovered runner: DNS said they are ready, and a page with no rows
  // at all would read as a fleet that has been scaled to zero.
  assert.equal(merged.view.runners.length, 4);
});
