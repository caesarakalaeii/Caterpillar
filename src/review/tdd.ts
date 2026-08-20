/**
 * Test-first evidence, computed by the supervisor and handed to the council. See
 * DESIGN.md §12.2.
 *
 * TDD is invisible in a diff. A change written test-first and a change with a test bolted
 * on afterwards produce the SAME tree, so no reviewer reading `git diff` can tell them
 * apart — and a reviewer that cannot tell them apart grades the claim rather than the
 * work. The one durable trace the discipline leaves is the ORDER of the commits, which is
 * why the author's prompt asks for the failing test to be its own commit: not as a git
 * habit, but so that the thing being enforced is observable at all.
 *
 * This is pure, and it decides NOTHING. It states which commits touched tests, which
 * touched source, and which source commits arrived with no test anywhere behind them. The
 * `tests` lens reads that and reaches a verdict; a docs-only change and a spike that was
 * later covered both have legitimate shapes, and only a reader can tell which is which.
 * The moment this file returns "block" the council has been replaced by a regex.
 */

import type { CommitTouched } from "../workspace/worktree.ts";

/**
 * One commit on the task's branch. The series arrives oldest first.
 *
 * Aliased rather than redeclared: `WorktreeManager.commitsSince` is the only producer,
 * and a second structurally-identical interface here would be free to drift from it
 * without a single test failing.
 */
export type Commit = CommitTouched;

/**
 * What a path counts as.
 *
 * `other` is the carve-out that keeps this credible: documentation, licences and
 * lockfiles are not source, so a README fix is not reported as untested work. Get that
 * wrong and the lens learns to skip the whole section.
 */
export type PathKind = "test" | "source" | "other";

/** Filenames that are the change, not code — no failing test precedes a typo fix. */
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".rst", ".adoc", ".txt"]);
const NON_SOURCE_FILES = new Set([
  "license",
  "licence",
  "notice",
  "authors",
  "codeowners",
  ".gitignore",
  ".gitattributes",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.sum",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
  "flake.lock",
]);

/**
 * Directory names that mean "everything under here is a test".
 *
 * `testdata` and `fixtures` are in here deliberately: a golden file is part of the test
 * that reads it, and counting it as source would flag a test-only commit as untested.
 */
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "testdata",
  "fixtures",
  "e2e",
  "it",
]);

/**
 * Is this path a test?
 *
 * Deliberately polyglot. The fleet is pointed at whatever repository an operator owns, and
 * a classifier that only knows `*.test.ts` reports every Go, Python and Java change as
 * having no tests — which is worse than having no classifier, because it is confidently
 * wrong in a section a reviewer is told to trust.
 */
export const classifyPath = (path: string): PathKind => {
  const segments = path.split("/").filter((s) => s.length > 0);
  const name = segments[segments.length - 1] ?? path;
  const lower = name.toLowerCase();

  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))) {
    return "test";
  }

  const dot = lower.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const lowerBase = base.toLowerCase();

  // An AFFIX is required, never a bare stem, and that is not fussiness — `src/intake/
  // spec.ts` in this repository builds a task spec and is production code. Matching a
  // whole filename of `spec` would classify it as a test and report every change to it as
  // covered, which is the exact inversion this module exists to prevent.
  //
  // `test_ingest.py`, `handler_test.go`, `tdd.test.ts`, `user_spec.rb`:
  if (/^(test|spec)s?[._-]/.test(lowerBase) || /[._-](test|spec)s?$/.test(lowerBase)) {
    return "test";
  }
  // `FooTest.java`, `UserSpec.scala`, `RenderIT.java` — CamelCase carries the boundary
  // instead of a separator, so it is matched on the ORIGINAL case, not the folded one.
  if (/[a-z0-9](Test|Tests|Spec|Specs|IT)$/.test(base)) return "test";

  if (NON_SOURCE_FILES.has(lower)) return "other";
  if (dot > 0 && DOC_EXTENSIONS.has(lower.slice(dot))) return "other";

  return "source";
};

/** One commit, with what it touched resolved. */
export interface ClassifiedCommit extends Commit {
  readonly touchesTest: boolean;
  readonly touchesSource: boolean;
}

export interface TestFirstEvidence {
  readonly commits: readonly ClassifiedCommit[];
  /** Did the change touch source at all? False for a docs-only or config-only change. */
  readonly touchesSource: boolean;
  /** Did it touch a test anywhere in the series? */
  readonly touchesTest: boolean;
  /**
   * Source commits that landed with no test in them and none in any commit before them.
   *
   * The signal, and the only one. A source commit AFTER a test commit is the green or the
   * refactor half of the loop and is not a finding.
   */
  readonly unpreceded: readonly ClassifiedCommit[];
}

export const testFirstEvidence = (commits: readonly Commit[]): TestFirstEvidence => {
  const classified: ClassifiedCommit[] = commits.map((commit) => {
    const kinds = commit.files.map(classifyPath);
    return {
      ...commit,
      touchesTest: kinds.includes("test"),
      touchesSource: kinds.includes("source"),
    };
  });

  const unpreceded: ClassifiedCommit[] = [];
  let testSeen = false;
  for (const commit of classified) {
    // Checked BEFORE the flag is set, so a commit carrying both its test and its code
    // counts as covered by itself. Splitting red from green is the habit the prompt asks
    // for; squashing them still shows the test arriving with the code, which is the
    // property worth having, and demanding two commits would enforce the ceremony
    // instead of the discipline.
    if (commit.touchesSource && !commit.touchesTest && !testSeen) unpreceded.push(commit);
    if (commit.touchesTest) testSeen = true;
  }

  return {
    commits: classified,
    touchesSource: classified.some((c) => c.touchesSource),
    touchesTest: testSeen,
    unpreceded,
  };
};

const shape = (commit: ClassifiedCommit): string =>
  commit.touchesTest && commit.touchesSource
    ? "test + source"
    : commit.touchesTest
      ? "test"
      : commit.touchesSource
        ? "source"
        : "neither";

/**
 * The evidence as the reviewer sees it.
 *
 * Facts and their order, with no recommendation attached. The lens is told what this
 * means; saying it twice, here, would put a verdict in the supervisor's mouth and the
 * reviewer would defer to it.
 */
export const renderEvidence = (evidence: TestFirstEvidence): string => {
  if (evidence.commits.length === 0) {
    // Reachable — `branchPoint` returns undefined on a repo whose default branch cannot be
    // resolved locally. An empty section would be read as "no source commits", which is a
    // different and much stronger claim than "we could not look".
    return "The commit series could not be determined, so there is no order to read here. Establish it yourself with `git log`.";
  }

  const lines = evidence.commits.map(
    (commit) => `1. \`${commit.oid}\` — ${commit.subject} _(${shape(commit)})_`,
  );

  if (!evidence.touchesSource) {
    lines.push("", "No commit in this series touched source. There is no test-first order to read.");
  } else if (!evidence.touchesTest) {
    lines.push("", "**No commit in this series touched a test file.**");
  } else if (evidence.unpreceded.length > 0) {
    lines.push(
      "",
      `**${evidence.unpreceded.length} source commit(s) landed before any test existed:** ` +
        evidence.unpreceded.map((c) => `\`${c.oid}\``).join(", "),
    );
  } else {
    lines.push("", "Every source commit had a test in it or before it.");
  }

  return lines.join("\n");
};
