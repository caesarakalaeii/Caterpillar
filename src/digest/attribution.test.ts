/**
 * Who wrote this repository — the fleet, or a person.
 *
 * Every case here is a way of getting that answer wrong. Matching on a name rather than an
 * address (two humans can be called the same thing, an address resolves to an account);
 * forgetting that a deployment's identity changes and reading half a window as human work;
 * printing a zero share for a repo this runner cannot see, which reads as "the fleet did
 * nothing here" rather than "nobody knows"; and quoting a share with no direction, which
 * is the number an owner cannot act on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, type AuthoredCommit, type FleetIdentity } from "./attribution.ts";

const FLEET: FleetIdentity = {
  emails: ["316492202+caterpillar-agent[bot]@users.noreply.github.com"],
};

const commit = (overrides: Partial<AuthoredCommit> = {}): AuthoredCommit => ({
  repo: "acme/widget",
  sha: "0000000",
  authorEmail: "human@example.invalid",
  insertions: 10,
  deletions: 0,
  ...overrides,
});

const fleetCommit = (overrides: Partial<AuthoredCommit> = {}): AuthoredCommit =>
  commit({ authorEmail: FLEET.emails[0] as string, ...overrides });

test("commits and lines are split by author into fleet and human", () => {
  const report = attribute({
    identity: FLEET,
    commits: [
      fleetCommit({ sha: "a", insertions: 90, deletions: 10 }),
      commit({ sha: "b", insertions: 30, deletions: 20 }),
    ],
  });

  const repo = report.repos[0];
  assert.equal(repo?.repo, "acme/widget");
  assert.equal(repo?.fleet.commits, 1);
  assert.equal(repo?.human.commits, 1);
  assert.equal(repo?.fleet.lines, 100);
  assert.equal(repo?.human.lines, 50);
  assert.equal(repo?.fleetLineShare, 100 / 150);
  assert.equal(repo?.fleetCommitShare, 0.5);
});

test("an address is matched case-insensitively and never by display name", () => {
  // Git lower-cases nothing, and a forge resolves the ADDRESS to an account. Two humans
  // can share a display name; a name match would hand one of them the fleet's work.
  const report = attribute({
    identity: FLEET,
    commits: [
      fleetCommit({ sha: "a", authorEmail: (FLEET.emails[0] as string).toUpperCase() }),
      commit({ sha: "b", authorName: "caterpillar-agent[bot]" }),
    ],
  });

  assert.equal(report.total.fleet.commits, 1);
  assert.equal(report.total.human.commits, 1);
});

test("an identity that changed partway through the window counts both addresses", () => {
  // §9.7: the identity is deployment configuration. A deployment that reinstalled its App
  // mid-window has two fleet addresses in one window, and reading the retired one as human
  // work would invent a person and halve the share on the day of the change.
  const report = attribute({
    identity: { emails: ["new@bot.invalid", "old@bot.invalid"] },
    commits: [
      commit({ sha: "a", authorEmail: "old@bot.invalid" }),
      commit({ sha: "b", authorEmail: "new@bot.invalid" }),
    ],
  });

  assert.equal(report.total.fleet.commits, 2);
  assert.equal(report.total.human.commits, 0);
});

test("the fleet share is reported against the previous window as a direction", () => {
  const report = attribute({
    identity: FLEET,
    commits: [fleetCommit({ insertions: 75, deletions: 0 }), commit({ insertions: 25 })],
    previous: [fleetCommit({ insertions: 25, deletions: 0 }), commit({ insertions: 75 })],
  });

  assert.equal(report.total.fleetLineShare, 0.75);
  assert.equal(report.previousFleetLineShare, 0.25);
  assert.equal(report.trend, "up");
});

test("a window with no earlier window to compare against has no trend", () => {
  const report = attribute({ identity: FLEET, commits: [fleetCommit()] });

  assert.equal(report.previousFleetLineShare, undefined);
  assert.equal(report.trend, undefined);
});

test("an identical share is flat rather than a direction nobody can see", () => {
  const report = attribute({
    identity: FLEET,
    commits: [fleetCommit({ insertions: 50, deletions: 0 }), commit({ insertions: 50 })],
    previous: [fleetCommit({ insertions: 10, deletions: 0 }), commit({ insertions: 10 })],
  });

  assert.equal(report.trend, "flat");
});

test("a repo this runner cannot read is named, not reported as zero fleet work", () => {
  // The §19 trap, inherited: a task branch lives in the mirror of the runner that worked
  // it, so another runner has no history for that repo at all. `0%` there is a false
  // statement about a repo the fleet may have written entirely.
  const report = attribute({
    identity: FLEET,
    commits: [fleetCommit({ repo: "acme/widget" })],
    unavailable: ["acme/gadget"],
  });

  assert.deepEqual(
    report.repos.map((entry) => entry.repo),
    ["acme/widget"],
    "an unreadable repo contributes no counted line",
  );
  assert.deepEqual(report.unavailable, ["acme/gadget"]);
});

test("a window in which nothing was committed at all is empty rather than a share of zero", () => {
  const report = attribute({ identity: FLEET, commits: [] });

  assert.equal(report.measured, false);
  assert.equal(report.total.fleetLineShare, undefined);
  assert.equal(report.total.fleetCommitShare, undefined);
});

test("a merge commit that touched no line still counts as a commit", () => {
  // Lines and commits are separate measures on purpose: a rebase-heavy fleet moves lines
  // without commits and a merge moves a commit without lines. Dropping the empty one would
  // make the two disagree about how much happened.
  const report = attribute({
    identity: FLEET,
    commits: [fleetCommit({ insertions: 0, deletions: 0 })],
  });

  assert.equal(report.total.fleet.commits, 1);
  assert.equal(report.total.fleet.lines, 0);
  assert.equal(report.total.fleetCommitShare, 1);
  assert.equal(report.total.fleetLineShare, undefined, "no line was written to have a share of");
});

test("repos are ordered by how much moved in them, so the busiest reads first", () => {
  const report = attribute({
    identity: FLEET,
    commits: [
      commit({ repo: "acme/quiet", insertions: 1, deletions: 0 }),
      fleetCommit({ repo: "acme/busy", insertions: 400, deletions: 100 }),
    ],
  });

  assert.deepEqual(
    report.repos.map((entry) => entry.repo),
    ["acme/busy", "acme/quiet"],
  );
});

test("an identity with no configured address attributes nothing to the fleet", () => {
  // A runner cannot start without an identity (§9.7), so this is the shape of a caller
  // that forgot to pass one. Attributing everything to the fleet by default would be a
  // number an owner would believe.
  const report = attribute({ identity: { emails: [] }, commits: [fleetCommit()] });

  assert.equal(report.total.fleet.commits, 0);
  assert.equal(report.total.human.commits, 1);
});
