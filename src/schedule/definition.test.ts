/**
 * The state-repo format for a schedule, and what it refuses.
 *
 * Every refusal here has to happen when the file is COMMITTED, not at 09:00 by a runner
 * that then has nothing useful to do (§22). So the parser is strict in the way
 * `remediation/policy.ts` is strict, and for the same reason: the mistake that matters is
 * `acceptence:`, which ignored produces a schedule whose tasks nothing can ever mark done.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSchedule,
  scheduleOf,
  scheduleTaskId,
  ScheduleParseError,
  SCHEDULE_VERSION,
} from "./definition.ts";

const GOOD = `
version: 1
trigger:
  cron: "0 9 * * 1-5"
  timezone: Europe/Berlin
workspace: primary
repos:
  - github.com/acme/widget
prompt: |
  Audit dependency updates.
acceptance:
  - npm test
`;

test("a schedule carries its trigger, its scope and its acceptance commands", () => {
  const schedule = parseSchedule("deps-audit", GOOD);

  assert.equal(schedule.id, "deps-audit");
  assert.equal(schedule.version, SCHEDULE_VERSION);
  assert.equal(schedule.trigger.cron, "0 9 * * 1-5");
  assert.equal(schedule.trigger.timeZone, "Europe/Berlin");
  assert.equal(schedule.workspace, "primary");
  assert.deepEqual(schedule.repos, [{ host: "github.com", owner: "acme", name: "widget" }]);
  assert.equal(schedule.prompt, "Audit dependency updates.");
  assert.deepEqual(schedule.acceptance, ["npm test"]);
  assert.deepEqual(schedule.requires, []);
  assert.equal(schedule.enabled, true, "a committed schedule is on unless it says otherwise");
  assert.equal(schedule.precheck, undefined);
  assert.equal(schedule.maxOpenTasks, 1);
});

test("a schedule with no acceptance commands is refused", () => {
  // §12: a task with no machine-checkable completion gate can never be marked done, so a
  // schedule that would create one may not exist.
  const text = GOOD.replace("acceptance:\n  - npm test\n", "");

  assert.throws(() => parseSchedule("deps-audit", text), ScheduleParseError);
  assert.throws(() => parseSchedule("deps-audit", `${text}acceptance: []\n`), /at least one/);
});

test("a misspelled key is refused rather than ignored", () => {
  // `acceptence:` ignored is a schedule with no completion gate — indistinguishable from
  // omitting it, and the symptom is a queue of tasks nothing can close.
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("acceptance:", "acceptence:")),
    /unknown key/,
  );
});

test("a cron expression that cannot fire is refused when it is committed", () => {
  // Not at 09:00, by a runner that has nothing useful to do about it.
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("0 9 * * 1-5", "0 9 31 2 *")),
    /cron/,
  );
  assert.throws(() => parseSchedule("deps-audit", GOOD.replace("0 9 * * 1-5", "every day")), /cron/);
});

test("a fixed offset is refused, because it is an hour wrong for seven months", () => {
  // The zone is what makes DST the zone database's problem (§19). `+02:00` is accepted by
  // `Intl` and is silently wrong for most of the year.
  assert.throws(() => parseSchedule("deps-audit", GOOD.replace("Europe/Berlin", "+02:00")), /zone/);
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("Europe/Berlin", "Mars/Olympus")),
    /zone/,
  );
});

test("a timezone is required, because a schedule with no zone has no hour", () => {
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("  timezone: Europe/Berlin\n", "")),
    /timezone/,
  );
});

test("a schedule must name at least one repo, and they must be repo references", () => {
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("  - github.com/acme/widget\n", "")),
    /at least one repository/,
  );
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace("github.com/acme/widget", "../../etc")),
    /repository reference/,
  );
});

test("a schedule must say what the session is for", () => {
  assert.throws(
    () => parseSchedule("deps-audit", GOOD.replace(/prompt: \|\n  Audit.*\n/, "")),
    /prompt/,
  );
});

test("an unknown capability is refused: no runner would ever claim the task", () => {
  assert.throws(
    () => parseSchedule("deps-audit", `${GOOD}requires:\n  - kubernetes\n`),
    /not a known capability/,
  );
});

test("a precheck is a command and a timeout, and the timeout has a default", () => {
  const schedule = parseSchedule(
    "deps-audit",
    `${GOOD}precheck:\n  command: "test -n \\"$(npm outdated)\\""\n`,
  );

  assert.equal(schedule.precheck?.command, 'test -n "$(npm outdated)"');
  assert.equal(schedule.precheck?.timeoutSeconds, 120);
});

test("a precheck with no command is refused, so an empty gate cannot pass silently", () => {
  assert.throws(() => parseSchedule("deps-audit", `${GOOD}precheck:\n  timeoutSeconds: 30\n`), /command/);
});

test("a disabled schedule parses, so turning one off is a one-line edit", () => {
  // The alternative is deleting the file, which loses the prompt and the acceptance
  // commands someone wrote — and makes turning it back on a rewrite rather than an edit.
  assert.equal(parseSchedule("deps-audit", `${GOOD}enabled: false\n`).enabled, false);
});

test("a version this parser does not understand is refused", () => {
  assert.throws(() => parseSchedule("deps-audit", GOOD.replace("version: 1", "version: 2")), /version/);
});

test("a schedule id that is not a path segment is refused", () => {
  // The id becomes a task id and a git ref component. `..` is a legal directory name and
  // resolves out of the tree it is meant to name.
  assert.throws(() => parseSchedule("../escape", GOOD), /identifier/);
  assert.throws(() => parseSchedule("deps audit", GOOD), /identifier/);
  assert.throws(() => parseSchedule("", GOOD), /identifier/);
});

test("the task id names the schedule and the occurrence it came from", () => {
  // Deterministic and derived from both, which is what makes the path idempotent: two
  // runners that both decide 09:00 is due compute the same directory under `tasks/`.
  assert.equal(
    scheduleTaskId("deps-audit", "2026-08-17T0700Z"),
    "SCHED-deps-audit-2026-08-17T0700Z",
  );
  assert.equal(scheduleTaskId("deps-audit", "not-an-occurrence"), undefined);
  assert.equal(scheduleTaskId("../escape", "2026-08-17T0700Z"), undefined);
});

test("the schedule a task came from is read back out of its id", async () => {
  // The page needs it and nothing else carries it: a scheduled spec has no `kind` and no
  // `tracker` (§22), so the id is the whole record of where the task came from.
  assert.equal(scheduleOf("SCHED-deps-audit-2026-08-17T0700Z"), "deps-audit");
  assert.equal(scheduleOf("SCHED-a-2026-08-17T0700Z"), "a");
  // Not a schedule task, or one whose id has been tampered with by hand.
  assert.equal(scheduleOf("GH-acme-widget-12"), undefined);
  assert.equal(scheduleOf("SCHED-deps-audit"), undefined);
  assert.equal(scheduleOf("SCHED--2026-08-17T0700Z"), undefined);
});
