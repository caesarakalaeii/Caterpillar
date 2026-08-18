/**
 * What the bot says it is doing, and when it says it again.
 *
 * Two properties carry this feature and both fail SILENTLY if broken: a presence that is
 * never re-sent looks identical to a fleet that never changed state, and one that is sent
 * on every survey exhausts Discord's per-connection allowance so the update that matters is
 * the one that gets dropped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId, type TaskPhase, type TaskStatus } from "../domain/task.ts";
import { FleetActivity, renderActivity, WATCHING, type ActivityTask, type PresencePayload } from "./activity.ts";

const task = (id: string, status: TaskStatus, phase: TaskPhase = "planning"): ActivityTask => ({
  id: asTaskId(id),
  status,
  phase,
});

test("one running task is named, with the phase it is in", () => {
  const activity = renderActivity([
    task("ALERT-6155db", "running", "implementing"),
    task("BS-1-01", "done"),
  ]);

  // Reads as "Watching ALERT-6155db · implementing" in the member list, which is the whole
  // deliverable: what it is working on, without opening the web view.
  assert.equal(activity.name, "ALERT-6155db · implementing");
  assert.equal(activity.type, WATCHING);
});

test("several running tasks collapse to a count rather than a list of ids", () => {
  // Two ids already overflow the column this is read in. The count is the honest summary;
  // the web view is where you go to find out which.
  const activity = renderActivity([
    task("TASK-1", "running"),
    task("TASK-2", "running", "verifying"),
    task("TASK-3", "running"),
  ]);

  assert.equal(activity.name, "3 tasks running");
});

test("a task waiting on a human is appended to a running one, never allowed to hide it", () => {
  // Both matter and they answer different questions — "is it working" and "is it stuck on
  // me". Displacing the running task would lose the first; dropping the count loses the
  // second, which is the only state where reading this changes what someone does next.
  const activity = renderActivity([
    task("TASK-1", "running", "review"),
    task("TASK-2", "awaiting-human"),
  ]);

  assert.equal(activity.name, "TASK-1 · review · 1 needs you");
});

test("nothing running and something waiting promotes the wait to the whole line", () => {
  // Now it is the whole story: the fleet is stopped until somebody answers, so this must
  // not read as the idle line.
  const one = renderActivity([task("TASK-2", "awaiting-human"), task("TASK-9", "done")]);
  assert.equal(one.name, "1 waiting for you");

  const several = renderActivity([task("A", "awaiting-human"), task("B", "awaiting-human")]);
  assert.equal(several.name, "2 waiting for you");
});

test("an idle fleet says whether there is a backlog, because only one of the two is a bug", () => {
  // "idle with 4 ready" and "idle with nothing queued" look the same from outside and are
  // different problems: the first means the fleet is not taking work it has been given.
  assert.equal(renderActivity([]).name, "for work · nothing queued");
  assert.equal(
    renderActivity([task("A", "ready"), task("B", "ready"), task("C", "done")]).name,
    "for work · 2 ready",
  );
});

test("a task id long enough to be truncated is truncated deliberately", () => {
  // Discord truncates a long name without saying so. Doing it here is what makes the
  // ellipsis visible rather than the text simply stopping.
  const long = `TASK-${"x".repeat(200)}`;
  const activity = renderActivity([task(long, "running")]);

  assert.ok(activity.name.length <= 96, `got ${activity.name.length}`);
  assert.ok(activity.name.endsWith("…"), activity.name);
});

test("nothing is published before the first survey, so a fresh IDENTIFY carries no presence", () => {
  // An IDENTIFY carrying `presence` with no activities tells Discord to CLEAR one. Before
  // the first survey there is nothing true to say, so the field must be absent entirely.
  const fleet = new FleetActivity();
  assert.equal(fleet.payload(), undefined);
});

test("an unchanged fleet is not re-sent, because the allowance is per connection", () => {
  // The survey runs every housekeeping tick and an idle fleet renders the identical string
  // every time. Sending unconditionally would spend the whole rate-limit allowance on
  // "nothing happened" and drop the update that matters.
  const sent: PresencePayload[] = [];
  const fleet = new FleetActivity({ now: () => 1_000 });
  fleet.attach((payload) => sent.push(payload));

  fleet.publish([task("TASK-1", "running")]);
  fleet.publish([task("TASK-1", "running")]);
  fleet.publish([task("TASK-1", "running")]);

  assert.equal(sent.length, 1, "only the change is sent");
  assert.equal(sent[0]?.activities[0]?.name, "TASK-1 · planning");
  assert.equal(sent[0]?.status, "online");
});

test("a real change is sent, and restamps how long the fleet has been in that state", () => {
  const sent: PresencePayload[] = [];
  let clock = 1_000;
  const fleet = new FleetActivity({ now: () => clock });
  fleet.attach((payload) => sent.push(payload));

  fleet.publish([task("TASK-1", "running")]);
  clock = 5_000;
  fleet.publish([task("TASK-1", "running", "verifying")]);

  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.since, 1_000);
  // Restamped on the change rather than on every publish, so Discord's elapsed timer
  // measures the STATE and not the uptime of the process.
  assert.equal(sent[1]?.since, 5_000);
  assert.equal(sent[1]?.activities[0]?.name, "TASK-1 · verifying");
});

test("attaching alone sends nothing — a fresh IDENTIFY already carried the presence", () => {
  // Replaying here would spend a second presence update, out of a per-connection allowance,
  // to tell Discord what the IDENTIFY just told it.
  const fleet = new FleetActivity({ now: () => 1_000 });
  fleet.publish([task("TASK-7", "running")]);

  const sent: PresencePayload[] = [];
  fleet.attach((payload) => sent.push(payload));

  assert.equal(sent.length, 0);
  assert.equal(fleet.payload()?.activities[0]?.name, "TASK-7 · planning");
});

test("resending is what survives a RESUME, which carries no IDENTIFY", () => {
  // A resume replays missed events but does not re-identify, so Discord still holds the
  // presence from before the disconnect. Without this the runner keeps advertising it.
  const fleet = new FleetActivity({ now: () => 1_000 });
  fleet.publish([task("TASK-7", "running")]);

  const sent: PresencePayload[] = [];
  fleet.attach((payload) => sent.push(payload));
  fleet.resend();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.activities[0]?.name, "TASK-7 · planning");
});

test("resending before any survey sends nothing rather than clearing the presence", () => {
  // A payload with no activities is how Discord is told to CLEAR one, so an empty resend
  // would actively erase a status rather than leave it alone.
  const sent: PresencePayload[] = [];
  const fleet = new FleetActivity();
  fleet.attach((payload) => sent.push(payload));
  fleet.resend();

  assert.equal(sent.length, 0);
});

test("a detached mailbox keeps its state and sends nothing", () => {
  // The window between a socket closing and the next one opening. Surveys keep running, and
  // writing into a disposed socket is the failure this guards.
  const sent: PresencePayload[] = [];
  const fleet = new FleetActivity({ now: () => 1_000 });
  fleet.attach((payload) => sent.push(payload));
  fleet.publish([task("TASK-1", "running")]);
  fleet.detach();

  fleet.publish([task("TASK-2", "running")]);

  assert.equal(sent.length, 1, "nothing is sent while no socket is attached");
  // The state still moved, so the next IDENTIFY is correct rather than a replay of the
  // presence from before the disconnect.
  assert.equal(fleet.payload()?.activities[0]?.name, "TASK-2 · planning");
});

test("publishing without any connection never throws", () => {
  // A presence is a comfort signal. It must never be the reason a survey fails.
  const fleet = new FleetActivity();
  assert.doesNotThrow(() => fleet.publish([task("TASK-1", "running")]));
});
