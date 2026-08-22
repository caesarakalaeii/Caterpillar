/**
 * Firing an occurrence once, fleet-wide, and never firing one silently.
 *
 * Every runner in a fleet reaches 09:00 at the same instant and every one of them can read
 * the whole state repo, so "fire this schedule" is a race by construction. It is settled
 * with the mechanism §19 already proved: a ref exactly one push can create.
 *
 * The asymmetry these tests exist for is the one §22 states. Firing twice is visible — two
 * tasks, two branches, a human who can see both. Firing never is silent: the ref says the
 * occurrence is settled, no task exists, and nobody finds out. So the claim is taken before
 * the task is created and released again whenever creating it failed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskSpec, type TaskState } from "../domain/task.ts";
import type { Notification } from "../notify/discord.ts";
import { JsonLogger } from "../obs/log.ts";
import type { ScheduleRecord } from "../state/store.ts";
import { parseSchedule } from "./definition.ts";
import { ScheduleRunner, scheduleRef } from "./run.ts";

/** Weekdays at 09:00 Berlin. 2026-08-17 is a Monday. */
const SCHEDULE = parseSchedule(
  "deps-audit",
  [
    "version: 1",
    "trigger:",
    '  cron: "0 9 * * 1-5"',
    "  timezone: Europe/Berlin",
    "workspace: primary",
    "repos:",
    "  - github.com/acme/widget",
    "prompt: Audit dependency updates and open a PR for the safe ones.",
    "acceptance:",
    "  - npm test",
    "",
  ].join("\n"),
);

/** The same schedule, gated on a precheck the runner has to consult first. */
const WITH_PRECHECK = parseSchedule(
  "deps-audit",
  [
    "version: 1",
    "trigger:",
    '  cron: "0 9 * * 1-5"',
    "  timezone: Europe/Berlin",
    "workspace: primary",
    "repos:",
    "  - github.com/acme/widget",
    "prompt: Audit dependency updates.",
    "acceptance:",
    "  - npm test",
    "precheck:",
    '  command: "npm outdated --json | grep -q ."',
    "",
  ].join("\n"),
);

/** 09:05 Berlin on Monday the 17th: the 09:00 occurrence is due and five minutes late. */
const MONDAY_MORNING = new Date("2026-08-17T07:05:00Z");
/** 08:00 Berlin on the same Monday. Nothing has come due yet. */
const MONDAY_EARLY = new Date("2026-08-17T06:00:00Z");

const OCCURRENCE = "2026-08-17T0700Z";
const TASK = asTaskId(`SCHED-deps-audit-${OCCURRENCE}`);

interface HarnessOptions {
  readonly schedules?: readonly ReturnType<typeof parseSchedule>[];
  readonly errors?: readonly { readonly schedule: string; readonly message: string }[];
  readonly claimed?: boolean;
  readonly refExists?: boolean;
  readonly existingTask?: boolean;
  readonly openTasks?: number;
  readonly precheck?: { readonly ok: boolean; readonly detail: string };
  readonly precheckThrows?: boolean;
  readonly writeFails?: boolean;
  /** An occurrence this runner has already settled, as the ledger would report it. */
  readonly settled?: ScheduleRecord;
}

interface Harness {
  readonly runner: ScheduleRunner;
  readonly specs: TaskSpec[];
  readonly states: TaskState[];
  readonly records: ScheduleRecord[];
  readonly claims: string[];
  readonly released: string[];
  readonly pushes: string[];
  readonly notifications: Notification[];
  readonly prechecked: string[];
}

const harness = (options: HarnessOptions = {}): Harness => {
  const specs: TaskSpec[] = [];
  const states: TaskState[] = [];
  const records: ScheduleRecord[] = [];
  const claims: string[] = [];
  const released: string[] = [];
  const pushes: string[] = [];
  const notifications: Notification[] = [];
  const prechecked: string[] = [];

  const runner = new ScheduleRunner({
    runner: "pod-7f3a",
    branch: "main",
    maxSessionsPerTask: 20,
    logger: new JsonLogger({ level: "error", write: () => undefined }),
    store: {
      listSchedules: async () => ({
        schedules: options.schedules ?? [SCHEDULE],
        errors: options.errors ?? [],
      }),
      hasTask: async () => options.existingTask === true,
      countOpenScheduleTasks: async () => options.openTasks ?? 0,
      readScheduleRecord: async () => options.settled,
      writeScheduleRecord: async (_schedule, _occurrence, record) => {
        records.push(record);
      },
      writeState: async (state) => {
        states.push(state);
      },
      writeSpec: async (spec) => {
        if (options.writeFails === true) throw new Error("the disk is full");
        specs.push(spec);
      },
      commitAndPush: async (message) => {
        pushes.push(message);
      },
    },
    leases: {
      claimOnce: async (ref) => {
        claims.push(ref);
        return options.claimed === false ? undefined : `oid-for-${ref}`;
      },
      hasRef: async () => options.refExists === true,
      releaseRef: async (ref) => {
        released.push(ref);
      },
    },
    notifier: {
      notify: async (notification) => {
        notifications.push(notification);
      },
    },
    ...(options.precheck === undefined && options.precheckThrows !== true
      ? {}
      : {
          precheck: async (schedule) => {
            prechecked.push(schedule.id);
            if (options.precheckThrows === true) throw new Error("nix could not be built");
            return options.precheck ?? { ok: true, detail: "exit 0" };
          },
        }),
  });

  return {
    runner,
    specs,
    states,
    records,
    claims,
    released,
    pushes,
    notifications,
    prechecked,
  };
};

test("a due occurrence is claimed, then becomes a task", async () => {
  const subject = harness();

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.claims, [scheduleRef("deps-audit", OCCURRENCE)]);
  assert.deepEqual(subject.released, [], "a successful firing keeps its claim forever");

  // ORDER IS LOAD-BEARING, as at intake (§14.2): `state.json` first, `spec.md` last,
  // because the spec is the existence marker `hasTask` keys on.
  assert.equal(subject.states.length, 1);
  assert.equal(subject.specs.length, 1);
  assert.equal(subject.specs[0]?.id, TASK);

  // Verbatim from the schedule, all of it. A runner that appended to the acceptance list
  // would be writing the completion gate of a task it also created.
  assert.deepEqual(subject.specs[0]?.acceptance, ["npm test"]);
  assert.deepEqual(subject.specs[0]?.repos, [
    { host: "github.com", owner: "acme", name: "widget" },
  ]);
  assert.equal(subject.specs[0]?.workspace, "primary");
  assert.match(subject.specs[0]?.goal ?? "", /Audit dependency updates/);
  assert.match(subject.specs[0]?.goal ?? "", /deps-audit/, "the goal names its schedule");

  assert.equal(subject.records[0]?.outcome, "fired");
  assert.equal(subject.records[0]?.task, TASK);
  assert.equal(subject.pushes.length, 1);
  assert.deepEqual(
    subject.notifications.map((n) => n.kind),
    ["schedule-task"],
  );
});

test("nothing happens before the first occurrence is due", async () => {
  const subject = harness();

  await subject.runner.maybeFire(MONDAY_EARLY);

  assert.deepEqual(subject.claims, []);
  assert.deepEqual(subject.specs, []);
  assert.deepEqual(subject.pushes, []);
});

test("a disabled schedule is read and not fired", async () => {
  // Off is a state a schedule is allowed to be in, not an absence: the prompt and the
  // acceptance commands stay in the repo so turning it back on is an edit.
  const off = parseSchedule(
    "deps-audit",
    [
      "version: 1",
      "trigger:",
      '  cron: "0 9 * * 1-5"',
      "  timezone: Europe/Berlin",
      "workspace: primary",
      "repos:",
      "  - github.com/acme/widget",
      "prompt: Audit dependency updates.",
      "acceptance:",
      "  - npm test",
      "enabled: false",
      "",
    ].join("\n"),
  );
  const subject = harness({ schedules: [off] });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.claims, []);
  assert.deepEqual(subject.specs, []);
});

test("a lost claim whose ref exists is another runner's occurrence, not a failure", async () => {
  const subject = harness({ claimed: false, refExists: true });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.claims, [scheduleRef("deps-audit", OCCURRENCE)]);
  assert.deepEqual(subject.specs, [], "the winner creates the task, and only the winner");
  assert.deepEqual(subject.records, [], "and only the winner writes the ledger entry");
});

test("a failed claim with no ref behind it is a dead network, and is retried", async () => {
  // The asymmetry §22 turns on. A rejected push is what a lost race and an unreachable
  // remote look like alike, so the ref is CHECKED — and when it is absent, nothing may
  // conclude the occurrence has been served. Getting this backwards writes off an
  // occurrence nobody fired.
  const subject = harness({ claimed: false, refExists: false });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.specs, []);
  assert.deepEqual(subject.records, [], "an unfired occurrence must not be recorded as one");
});

test("a precheck that exits non-zero skips the occurrence and spends no session", async () => {
  // The whole point of the gate (§22, §11.1): work whose only blocker is external state
  // must not cost a session to discover there was nothing to do.
  const subject = harness({
    schedules: [WITH_PRECHECK],
    precheck: { ok: false, detail: "exit 1: no updates" },
  });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.prechecked, ["deps-audit"]);
  assert.deepEqual(subject.specs, [], "no task, so no session");
  assert.equal(subject.records[0]?.outcome, "skipped");
  assert.match(subject.records[0]?.detail ?? "", /no updates/);
  // The claim is KEPT. A skipped occurrence is a decision, not a failure — releasing it
  // would have the next poll run the precheck again, every poll, until the hour passed.
  assert.deepEqual(subject.released, []);
  assert.equal(subject.pushes.length, 1, "the skip is durable, not a log line");
});

test("a precheck that cannot be run is a failure, so the claim goes back", async () => {
  // Distinct from a precheck that says no. "The environment could not be built" is not
  // evidence about the work, so the occurrence must stay available to a runner that can
  // build it — the machine that owns `requires` may not be this one.
  const subject = harness({ schedules: [WITH_PRECHECK], precheckThrows: true });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.specs, []);
  assert.deepEqual(subject.records, [], "nothing is written off");
  assert.deepEqual(subject.released, [scheduleRef("deps-audit", OCCURRENCE)]);
});

test("a task that already exists is left alone", async () => {
  // The id is derived from the schedule and the occurrence, so two runners compute the
  // same one. Checked before the claim, because an existing task answers every other
  // question this pass could ask.
  const subject = harness({ existingTask: true });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.claims, []);
  assert.deepEqual(subject.specs, []);
});

test("a schedule at its open-task limit refuses the occurrence rather than piling on", async () => {
  // A weekly audit whose last task is still in review must not open a second one saying
  // the same thing (§20's `maxOpenTasks`, applied to a schedule).
  const subject = harness({ openTasks: 1 });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.specs, []);
  assert.equal(subject.records[0]?.outcome, "refused");
  assert.match(subject.records[0]?.detail ?? "", /already has 1 open task/);
  assert.deepEqual(subject.released, [], "the occurrence is settled, not retried");
});

test("a write that fails hands the claim back, so the occurrence is not lost", async () => {
  const subject = harness({ writeFails: true });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.released, [scheduleRef("deps-audit", OCCURRENCE)]);
  assert.deepEqual(subject.records, [], "a claim handed back records nothing");
});

test("a malformed schedule costs itself and nothing else", async () => {
  // The reason §22 puts one schedule per file. The error is already reported by the
  // intake pass; here it must simply not stop the schedules that parsed.
  const subject = harness({
    errors: [{ schedule: "broken", message: "schedules/broken.yaml is invalid: unknown key" }],
  });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.equal(subject.specs.length, 1, "the good schedule still fires");
});

test("an occurrence already settled in the ledger is not fired again", async () => {
  // The ledger is the cheap local answer and it is checked before the ref: an occurrence
  // this runner skipped is settled, and re-running its precheck every poll until the hour
  // passed would spend the housekeeping loop on a question already answered.
  const subject = harness({
    settled: { schedule: "deps-audit", occurrence: OCCURRENCE, outcome: "skipped" },
  });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.claims, []);
  assert.deepEqual(subject.specs, []);
});

test("a schedule that declares a precheck is not fired by a runner that cannot run one", async () => {
  // Firing anyway would ignore the condition the operator wrote; recording a skip would
  // write off an occurrence over a fact about this process. So the claim goes back and the
  // occurrence stays available to a runner that can answer.
  const subject = harness({ schedules: [WITH_PRECHECK] });

  await subject.runner.maybeFire(MONDAY_MORNING);

  assert.deepEqual(subject.specs, []);
  assert.deepEqual(subject.records, []);
  assert.deepEqual(subject.released, [scheduleRef("deps-audit", OCCURRENCE)]);
});
