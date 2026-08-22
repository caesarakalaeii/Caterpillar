/**
 * A human reviewing the pull request in the forge is guidance, and until this existed it
 * reached the agent nowhere: the review council could block a change with a verdict, and a
 * human could only do it by switching surfaces and typing in Discord (DESIGN.md §7.3).
 *
 * These pin the two halves of the answer: what the agent is SHOWN, and which comment is new
 * enough to be worth forgiving a review round for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoRef } from "../domain/task.ts";
import type { ReviewComment } from "../forge/types.ts";
import { newestHumanComment, renderReviewGuidance } from "./review-guidance.ts";

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "widget" };

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "1",
  repo: REPO,
  pr: 7,
  author: "a-human",
  fromFleet: false,
  body: "this swallows the error",
  createdAt: "2026-08-13T10:00:00.000Z",
  resolved: false,
  outdated: false,
  ...over,
});

test("an unresolved comment is quoted with its file and line", () => {
  const section = renderReviewGuidance([
    comment({ path: "src/agent/runner.ts", line: 42, body: "this swallows the error" }),
  ]);

  assert.match(section ?? "", /src\/agent\/runner\.ts:42/);
  assert.match(section ?? "", /this swallows the error/);
  assert.match(section ?? "", /a-human/);
});

test("no comments at all renders nothing, not an empty heading", () => {
  // The section is spliced into every session's prompt. A heading with nothing under it
  // reads as "a human reviewed this and said nothing", which is the opposite of the truth.
  assert.equal(renderReviewGuidance([]), undefined);
});

test("a resolved comment is collapsed to a count, not quoted", () => {
  // Resolved means the conversation is over. Quoting it in full sends the agent to
  // re-do work that was already accepted, and it is the bulk of an old pull request.
  const section = renderReviewGuidance([
    comment({ id: "1", resolved: true, body: "rename this variable" }),
    comment({ id: "2", body: "still wrong here" }),
  ]);

  assert.equal((section ?? "").includes("rename this variable"), false);
  assert.match(section ?? "", /still wrong here/);
  assert.match(section ?? "", /1 resolved/);
});

test("an outdated comment is collapsed too, and says which it was", () => {
  // Outdated means the line it was written against no longer exists. It may still be
  // worth reading, so the count is stated — but it is not an instruction any more.
  const section = renderReviewGuidance([
    comment({ id: "1", outdated: true, body: "off by one" }),
    comment({ id: "2", body: "still wrong here" }),
  ]);

  assert.equal((section ?? "").includes("off by one"), false);
  assert.match(section ?? "", /1 outdated/);
});

test("comments the fleet wrote itself are not fed back to it as guidance", () => {
  // The reviewer identity approves and the agent replies; both land on the same pull
  // request. Reading our own words back as a human's instruction is a loop with no
  // human in it, and it is exactly what would reset the round count forever.
  const section = renderReviewGuidance([
    comment({ id: "1", author: "caterpillar[bot]", fromFleet: true, body: "opened by the agent" }),
  ]);

  assert.equal(section, undefined);
});

test("comments are grouped by pull request when the task spans several repos", () => {
  // A multi-repo task opens one PR per repo (§9.4.1). Two files called `index.ts` in two
  // repos are indistinguishable without the slug, and the agent has to know which
  // checkout to go and edit.
  const sibling: RepoRef = { host: "github.com", owner: "acme", name: "gadget" };
  const section =
    renderReviewGuidance([
      comment({ id: "1", path: "index.ts", line: 1, body: "widget is wrong" }),
      comment({ id: "2", repo: sibling, pr: 3, path: "index.ts", line: 1, body: "gadget is wrong" }),
    ]) ?? "";

  assert.match(section, /acme\/widget#7/);
  assert.match(section, /acme\/gadget#3/);
  assert.ok(
    section.indexOf("widget is wrong") < section.indexOf("gadget is wrong"),
    "the order the repos were given in is the order they are shown in",
  );
});

test("a comment with no file is still shown, as a comment on the pull request", () => {
  // A review body or a conversation comment has no path. Dropping it would lose the one
  // kind of comment a human writes when the objection is about the change as a whole.
  const section = renderReviewGuidance([comment({ body: "this is the wrong approach" })]) ?? "";

  assert.match(section, /this is the wrong approach/);
});

test("the newest human comment is what a round is forgiven for", () => {
  // The round cap detects a loop with nothing new entering it (§12.1). A human objection is
  // new information; the fleet's own comment is not, and neither is a resolved thread.
  const newest = newestHumanComment([
    comment({ id: "1", createdAt: "2026-08-13T10:00:00.000Z" }),
    comment({ id: "2", createdAt: "2026-08-14T10:00:00.000Z" }),
    comment({ id: "3", createdAt: "2026-08-15T10:00:00.000Z", fromFleet: true }),
  ]);

  assert.equal(newest, "2026-08-14T10:00:00.000Z");
});

test("a resolved comment does not forgive a round", () => {
  // It was said, it was dealt with, and the thread was closed. Counting it would forgive a
  // round on every session for the rest of the task's life.
  assert.equal(newestHumanComment([comment({ resolved: true })]), undefined);
});

test("an outdated comment does not forgive a round either", () => {
  assert.equal(newestHumanComment([comment({ outdated: true })]), undefined);
});

test("no human comments means no watermark, so nothing is forgiven", () => {
  assert.equal(newestHumanComment([]), undefined);
});

test("an unparseable timestamp is ignored rather than becoming a permanent watermark", () => {
  // The timestamps are forge-authored strings. One that does not parse compares as NaN
  // against every watermark, and `Math.max` over it poisons the answer for good.
  assert.equal(newestHumanComment([comment({ createdAt: "not a date" })]), undefined);
});
