/**
 * The whole schedule path against real git: a real remote, two real state-repo clones, and
 * two runners racing for the same 09:00.
 *
 * Everything else about this subsystem is testable with fakes. The claim is not. It rests on
 * `--force-with-lease=<ref>:` with an EMPTY expected value meaning "must not already exist"
 * — a GIT behaviour, not a behaviour of this code — and a fake that answers "already
 * claimed" proves only that the fake was written to. The same goes for the writes: a task
 * written to disk and never staged survives until the next `reset --hard` and then does not
 * exist.
 *
 * So this asserts on the ORIGIN, never on a checkout: what a second runner would find.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asRunnerId } from "../domain/task.ts";
import type { Notification } from "../notify/discord.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { Git } from "../state/git.ts";
import { LeaseManager } from "../state/lease.ts";
import { StateStore } from "../state/store.ts";
import { ScheduleRunner, scheduleRef, type PrecheckResult } from "./run.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Weekdays at 09:00 Berlin. 2026-08-17 is a Monday, so 07:00Z is its occurrence. */
const SCHEDULE = [
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
  "",
].join("\n");

/** The same schedule, gated on a precheck. */
const GATED = SCHEDULE + ['precheck:', '  command: "npm outdated --json | grep -q ."', ''].join("\n");

/** 09:05 Berlin on the Monday. The 09:00 occurrence is due and five minutes late. */
const MONDAY = new Date("2026-08-17T07:05:00Z");
const OCCURRENCE = "2026-08-17T0700Z";
const TASK = `SCHED-deps-audit-${OCCURRENCE}`;

const identify = async (git: Git): Promise<void> => {
  await git.run("config", "user.email", "test@example.invalid");
  await git.run("config", "user.name", "test");
};

interface World {
  readonly origin: string;
  readonly runner: (id: string, precheck?: PrecheckResult) => Promise<Runner>;
}

interface Runner {
  readonly schedule: ScheduleRunner;
  readonly notifications: Notification[];
  /** How many times this runner's precheck was consulted. */
  readonly prechecks: () => number;
}

/** A bare origin whose state repo carries one schedule, plus clones per runner. */
const world = async (declaration = SCHEDULE): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-schedule-e2e-"));
  roots.push(root);

  const origin = join(root, "origin.git");
  const setup = new Git(root);
  await setup.run("init", "--bare", "--quiet", "--initial-branch=main", origin);

  const seedPath = join(root, "seed");
  await setup.run("clone", "--quiet", origin, seedPath);
  const seed = new Git(seedPath);
  await identify(seed);
  await mkdir(join(seedPath, "schedules"), { recursive: true });
  await writeFile(join(seedPath, "schedules", "deps-audit.yaml"), declaration, "utf8");
  await seed.run("add", "-A");
  await seed.run("commit", "-m", "chore(schedules): audit the dependencies each weekday");
  await seed.run("push", "origin", "HEAD:main");

  return {
    origin,
    runner: async (id: string, precheck?: PrecheckResult): Promise<Runner> => {
      const statePath = join(root, id);
      await setup.run("clone", "--quiet", origin, statePath);
      const git = new Git(statePath);
      await identify(git);

      const notifications: Notification[] = [];
      let prechecks = 0;

      return {
        notifications,
        prechecks: () => prechecks,
        schedule: new ScheduleRunner({
          store: new StateStore(statePath, git),
          leases: new LeaseManager({
            git,
            remote: "origin",
            runner: asRunnerId(id),
            staleAfterSeconds: 300,
          }),
          notifier: {
            notify: async (notification) => {
              notifications.push(notification);
            },
          },
          logger: SILENT_LOGGER,
          runner: id,
          branch: "main",
          maxSessionsPerTask: 20,
          precheck: async () => {
            prechecks += 1;
            return precheck ?? { ok: true, detail: "exit 0" };
          },
        }),
      };
    },
  };
};

/** A file's contents on the origin's `main`, or undefined when it is not there. */
const onOrigin = async (origin: string, path: string): Promise<string | undefined> => {
  const git = new Git(origin);
  const result = await git.tryRun("show", `main:${path}`);
  return result.code === 0 ? result.stdout : undefined;
};

const refsUnder = async (origin: string, prefix: string): Promise<readonly string[]> => {
  const listed = await new Git(origin).run("for-each-ref", "--format=%(refname)", prefix);
  return listed.split("\n").filter((line) => line.length > 0);
};

test("two runners racing fire the occurrence exactly once between them", async () => {
  const scene = await world();
  const first = await scene.runner("pod-a");
  const second = await scene.runner("pod-b");

  for (let pass = 0; pass < 3; pass += 1) {
    await first.schedule.maybeFire(MONDAY);
    await second.schedule.maybeFire(MONDAY);
  }

  const created = [...first.notifications, ...second.notifications];
  assert.equal(created.length, 1, "one task, however many passes either runner made");
  assert.deepEqual(
    created.map((notification) =>
      notification.kind === "schedule-task" ? notification.occurrence : "not a schedule",
    ),
    [OCCURRENCE],
  );

  assert.deepEqual(await refsUnder(scene.origin, "refs/schedules"), [
    scheduleRef("deps-audit", OCCURRENCE),
  ]);

  // On the ORIGIN, which is what makes this a test of the push rather than of a checkout.
  const spec = await onOrigin(scene.origin, `tasks/${TASK}/spec.md`);
  assert.match(spec ?? "", /Audit dependency updates\./);
  assert.match(spec ?? "", /acceptance:\n\s+- npm test/);
  assert.match(
    (await onOrigin(scene.origin, `tasks/${TASK}/state.json`)) ?? "",
    /"status": "ready"/,
  );
  assert.match(
    (await onOrigin(scene.origin, `schedules/occurrences/deps-audit-${OCCURRENCE}.json`)) ?? "",
    /"outcome": "fired"/,
  );
});

test("a runner that never saw the occurrence fire does not fire it again", async () => {
  // Nothing is remembered in memory here, deliberately: the ledger and the claim ref are
  // both on the remote, so a fresh pod reaches the same conclusion a running one does.
  const scene = await world(GATED);
  const first = await scene.runner("pod-a");
  await first.schedule.maybeFire(MONDAY);
  assert.equal(first.notifications.length, 1);

  const late = await scene.runner("pod-late");
  await late.schedule.maybeFire(MONDAY);
  await late.schedule.maybeFire(MONDAY);

  assert.equal(late.notifications.length, 0, "the claim is on the remote, and it is taken");
  assert.equal(late.prechecks(), 0, "and it costs no precheck to find that out");
});

test("a precheck that says no settles the occurrence without creating a task", async () => {
  const scene = await world(GATED);
  const runner = await scene.runner("pod-a", { ok: false, detail: "exit 1: nothing outdated" });

  await runner.schedule.maybeFire(MONDAY);

  assert.equal(await onOrigin(scene.origin, `tasks/${TASK}/spec.md`), undefined);
  assert.match(
    (await onOrigin(scene.origin, `schedules/occurrences/deps-audit-${OCCURRENCE}.json`)) ?? "",
    /"outcome": "skipped"/,
  );
  // The claim is kept, so the next pass does not re-run the command.
  assert.deepEqual(await refsUnder(scene.origin, "refs/schedules"), [
    scheduleRef("deps-audit", OCCURRENCE),
  ]);
  await runner.schedule.maybeFire(MONDAY);
  assert.equal(runner.prechecks(), 1, "settled means settled");
});

test("a push the remote refuses leaves the occurrence claimable rather than lost", async () => {
  // The asymmetric failure with a real refusal: the claim lands, the state push does not.
  // A hook declining `main` is what a protected branch or a full disk looks like from here.
  const scene = await world();
  const hook = join(scene.origin, "hooks", "update");
  await writeFile(
    hook,
    '#!/bin/sh\ncase "$1" in refs/heads/main) echo "declined" >&2; exit 1;; esac\nexit 0\n',
    { encoding: "utf8", mode: 0o755 },
  );

  const runner = await scene.runner("pod-a");
  await runner.schedule.maybeFire(MONDAY);

  assert.equal(await onOrigin(scene.origin, `tasks/${TASK}/spec.md`), undefined);

  // The claim is HELD, not handed back: the task and its ledger entry are written in this
  // checkout, so a second runner creating the same task would be the duplicate. What was
  // lost is the push, and `commitAndPush` on the next pass carries the same files.
  assert.deepEqual(await refsUnder(scene.origin, "refs/schedules"), [
    scheduleRef("deps-audit", OCCURRENCE),
  ]);

  await rm(hook);
  await runner.schedule.maybeFire(MONDAY);
  assert.match(
    (await onOrigin(scene.origin, `tasks/${TASK}/spec.md`)) ?? "",
    /Audit dependency updates\./,
    "the next pass pushes what the refused one wrote",
  );
});

test("a schedule that will not parse fires nothing and claims nothing", async () => {
  // Refused where a human is looking (the intake pass, §22) — and here, at firing time, it
  // simply is not one of the schedules that exist.
  const scene = await world(SCHEDULE.replace("acceptance:", "acceptence:"));
  const runner = await scene.runner("pod-a");

  await runner.schedule.maybeFire(MONDAY);

  assert.deepEqual(await refsUnder(scene.origin, "refs/schedules"), []);
  assert.equal(runner.notifications.length, 0);
});
