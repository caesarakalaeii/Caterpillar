import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conflictGuidance,
  landingFor,
  mergeNote,
  parseConflicts,
  stopsTheSequence,
} from "./mergeability.ts";

test("a base branch that requires a merge queue is enqueued, not merged", () => {
  assert.equal(landingFor("required"), "enqueue");
});

test("a base branch with no merge queue is merged directly", () => {
  assert.equal(landingFor("absent"), "merge");
});

test("a forge that cannot say whether a queue exists still gets merged", () => {
  // The constraint is explicit: an unanswerable question must not block the merge. A
  // Forgejo host, a GraphQL field the token cannot read, a 500 — all take the old path.
  assert.equal(landingFor("unknown"), "merge");
});

test("a queued pull request stops the multi-repo sequence", () => {
  // §9.4.1 merges in declared order and stops at the first failure. A queue is not a
  // failure, but it is not a completed merge either: the later repo would land against a
  // base whose counterpart is still waiting its turn.
  assert.equal(stopsTheSequence("queued"), true);
});

test("a completed merge lets the next repo in the sequence go", () => {
  assert.equal(stopsTheSequence("merged"), false);
});

test("the note names what merged and what is only queued", () => {
  const note = mergeNote([
    { slug: "acme/gateway", pr: 7, outcome: "merged" },
    { slug: "acme/extension", pr: 3, outcome: "queued" },
  ]);
  assert.ok(note !== undefined);
  assert.match(note, /acme\/gateway#7/);
  assert.match(note, /acme\/extension#3/);
  assert.match(note, /queue/i);
});

test("a note for one merged pull request does not talk about queues", () => {
  const note = mergeNote([{ slug: "acme/gateway", pr: 7, outcome: "merged" }]);
  assert.ok(note !== undefined);
  assert.match(note, /merged/i);
  assert.doesNotMatch(note, /queue/i);
});

test("a note for a single queued pull request says the merge has not happened", () => {
  const note = mergeNote([{ slug: "acme/gateway", pr: 7, outcome: "queued" }]);
  assert.ok(note !== undefined);
  assert.match(note, /queue/i);
  // "in queue" is its own state — reporting it as merged is the failure mode this exists
  // to prevent, because a human reading "merged" stops watching.
  assert.doesNotMatch(note, /^Approved by the review council and merged\.$/);
});

test("nothing to report is not a merge report", () => {
  assert.equal(mergeNote([]), undefined);
});

test("a clean merge-tree run reports no conflicts", () => {
  // `git merge-tree --write-tree` exits 0 and prints the tree oid alone.
  const conflicts = parseConflicts({
    code: 0,
    stdout: "1c1b4945b9cf36400d0636e0c5fcfa146f9bbd9a\n",
  });
  assert.equal(conflicts, undefined);
});

test("a conflicted merge-tree run names every conflicting path, once, sorted", () => {
  // The real shape: the tree oid, then one `mode oid stage\tpath` line per stage of each
  // conflicted path, then a blank line, then git's messages.
  const stdout = [
    "1c1b4945b9cf36400d0636e0c5fcfa146f9bbd9a",
    "100644 86bba901de6526d849fcca3181beda8cdd68551e 1\tsrc/forge/types.ts",
    "100644 b43516968f1450627da6739ce2559ee81be68c1a 2\tsrc/forge/types.ts",
    "100644 17071c3aeb11955e486e54716fb080c6ef1680a8 3\tsrc/forge/types.ts",
    "100644 0000000000000000000000000000000000000000 2\tDESIGN.md",
    "",
    "Auto-merging src/forge/types.ts",
    "CONFLICT (content): Merge conflict in src/forge/types.ts",
  ].join("\n");

  // Three stage lines for one path are one conflicting file, and `hunks` is deliberately
  // absent: counting markers means reading the blobs of `tree`, which needs git.
  assert.deepEqual(parseConflicts({ code: 1, stdout }), {
    tree: "1c1b4945b9cf36400d0636e0c5fcfa146f9bbd9a",
    files: [{ path: "DESIGN.md" }, { path: "src/forge/types.ts" }],
  });
});

test("a merge-tree that could not run at all reports nothing rather than a clean tree", () => {
  // Exit 2 and up is git failing, not a conflict: an unknown base, a missing object. A
  // caller told "no conflicts" would then merge into a base it never compared against.
  assert.equal(parseConflicts({ code: 2, stdout: "", stderr: "not something we can merge" }), "unknown");
});

test("the prompt section names the base, the files and the hunk counts", () => {
  const section = conflictGuidance("main", {
    tree: "abc123",
    files: [
      { path: "src/forge/types.ts", hunks: 3 },
      { path: "DESIGN.md" },
    ],
  });

  assert.ok(section !== undefined);
  assert.match(section, /main/);
  assert.match(section, /src\/forge\/types\.ts/);
  assert.match(section, /3 hunks/);
  assert.match(section, /DESIGN\.md/);
  // The instruction, not just the diagnosis: this exists so the rebase happens as
  // ordinary work rather than as a terminal-looking failure at the gate.
  assert.match(section, /rebase/i);
});

test("a branch that merges cleanly gets no prompt section", () => {
  assert.equal(conflictGuidance("main", undefined), undefined);
});
