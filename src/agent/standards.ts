/**
 * The engineering standards every session is held to. See DESIGN.md §12.2.
 *
 * They live in their own module for one reason: the agent that writes the code and the
 * council that grades it are given the SAME text. Written twice they drift, and a drifted
 * standard is worse than none — the task comes back from review over a rule its session
 * was never told, which costs a full round trip and looks from outside like the reviewer
 * being capricious.
 *
 * The content is Google's engineering practices, distilled rather than quoted: the code
 * review standard ("approve once it definitely improves the overall health of the
 * codebase, even if it is not perfect"), what to look for in a change, and the change
 * author's guide to writing a description. They are stated as instructions to an agent
 * rather than as advice to a team, because that is the reader.
 *
 * These are prompt text and prompt text is not free — every one of these lines is paid
 * for on every session, and on every reviewer of every round. They are kept to what
 * changes behaviour. A rule the model already follows by default is a rule that costs
 * tokens and buys nothing.
 */

/**
 * What "good code" means here, author-facing.
 *
 * Ordered by how expensive the mistake is to undo, not by how often it is made: a change
 * that does three things at once cannot be reviewed or reverted, and no amount of good
 * naming rescues it.
 */
export const CODE_HEALTH_STANDARD = `## Code health

The standard is the one Google reviews against: every change must leave the codebase
**healthier than it found it**. Not perfect — there is no perfect code, only better code,
and a change held back for perfection is a change that never lands.

- **One change, one purpose.** A pull request does one thing. A refactor and a fix in the
  same diff cannot be reviewed as either, cannot be reverted separately, and cannot be
  bisected. If you find unrelated breakage, record it in the journal and leave it alone.
- **Fit what is here.** Read the surrounding code before you add to it. A pattern this
  codebase already uses beats a better one it does not, because the next reader knows the
  first one. Never reformat code you are not changing — it buries the change in noise.
- **Solve the problem in front of you.** An abstraction with one caller is a guess about
  a second one. A configuration knob nobody asked for is a branch nobody tests.
- **Complexity is the defect.** If it cannot be understood at a glance, it is too clever.
  Your reader is a fresh session with none of your context, on a bad day, in a hurry.
- **Name things for that reader.** A name says what a thing is or does, in whole words.
  \`d\`, \`tmp\`, \`data\`, \`doIt\` and \`Manager\` say nothing at all.
- **Comments record WHY.** What the code does is in the code; why it is this way, what you
  tried that did not work, and what breaks if someone changes it are only in your head
  until you write them down.
- **Handle every error path.** Recover or propagate. Logged-and-continued-past leaves
  half-written state, which is the expensive kind of bug and the hard kind to find.
- **Leave nothing dead.** No commented-out code, no unused export, no \`TODO\` without a
  reason and something concrete to do.`;

/**
 * Test-first, and why the commit order is the part that is actually enforceable.
 *
 * The discipline leaves no trace in the final tree — a change written test-first and one
 * with a test bolted on afterwards are byte-identical when they land. The order of the
 * commits is the only durable evidence, which is why it is asked for here as a mechanical
 * requirement rather than as a virtue, and read back in `review/tdd.ts`.
 *
 * The carve-out at the end is load-bearing in the other direction. Without it a session
 * asked to fix a typo in a README invents a test for the README, and a rule that produces
 * absurd work is a rule the next session learns to ignore in the cases that matter.
 */
export const TEST_FIRST_STANDARD = `## Test-first, without exception

You write the test BEFORE the code it tests. Not afterwards, not "once it works". The loop
is three steps and none of them is optional:

1. **Red.** Write the smallest test that states the next piece of behaviour. Run it. WATCH
   IT FAIL. A test you never saw fail proves nothing — it may assert nothing, it may not
   be picked up by the runner at all, it may already have been passing.
2. **Green.** Write the least code that makes it pass. Run it again.
3. **Refactor.** Clean up with the test green, and run it after.

**Commit the failing test as its own commit, then the code that makes it pass.** This is
not a preference about git. The finished diff looks identical whichever order you worked
in, so the commit order is the ONLY evidence that the test came first — and the review
council is shown it.

- A bug fix starts with a test that REPRODUCES the bug and fails for the right reason. If
  it fails with a different error than the bug produces, you have not reproduced it yet.
- Test behaviour through the surface a caller uses, not internals. A test that breaks on
  every refactor is a tax, not a safety net.
- One reason to fail per test, and a name that says what it asserts.
- **Never weaken a test to go green.** If an existing test fails, either your change is
  wrong or that test described the old behaviour on purpose. Decide which, and say which
  in the commit message. Deleting an assertion to make a suite pass is the worst thing you
  can do in this codebase, and there is a reviewer whose whole job is looking for it.
- Coverage is not the goal and neither is a test per function. The goal is that every
  behaviour you added or changed has a test that FAILS if it regresses.

The only carve-out, and it is narrow: documentation, comments, formatting and pure
configuration have no behaviour to test. Everything that executes does.`;

/**
 * Everything the fleet says to a human, in one place.
 *
 * Google's change-author guide is the spine of the first two paragraphs. The last two are
 * this system's own: `ask_human` and the journal have no equivalent on a human team, and
 * both are places where a session's output is the only thing a reader will ever have.
 */
export const WRITING_STANDARD = `## What you write is read by someone who was not there

Every artefact you produce outlives the session that wrote it. Write for the stranger who
finds it.

**Commit messages.** First line: imperative mood, roughly 70 characters or fewer, saying
what the commit DOES — "Refuse a spec that declares no repos", never "fix stuff", "changes"
or "wip". Then a blank line, then a body that says what changed and WHY: the problem, what
you considered and rejected, what a reader would otherwise have to reconstruct from the
diff. A one-line message on a non-trivial change is work you have left for an archaeologist.

**Pull request descriptions.** The title is that first line again. The body says, in prose
a reviewer reads before the diff:
  - what the change does;
  - why it is needed — the problem, not the solution restated;
  - how it was tested, naming the tests you added and what they would catch;
  - anything deliberately left undone, and why.
A list of the files you touched is not a description. The diff already says that.

**Questions to a human.** \`ask_human\` spends someone's attention and parks the task until
they answer. Earn it: say what you were doing, what you found, what you have already ruled
out, and the one decision you need — with the options, when there are options. A question
answerable in a word is a good question. "How should I proceed?" is not one.

**Journal entries and handoffs.** The next session has your task and none of your context.
Name files, name commands, name the exact next step. Record what you TRIED and what did
not work: every dead end you leave out is one the next session walks down again.

Throughout: plain language, no marketing, no hedging, no apologies, no exclamation marks.
Report what is true — including when what is true is that something does not work.`;

/**
 * The reviewer's half, and deliberately NOT in `AUTHOR_STANDARDS`.
 *
 * It exists to stop a council being a bottleneck, and its central sentence — approve once
 * the change improves code health, even imperfect — is permission to let something merge.
 * Given to the author it reads as permission to ship whatever survives a lenient reading,
 * which is the opposite of its purpose.
 */
export const REVIEW_STANDARD = `## The standard you review against

From Google's code review guidelines, and it is what lets a council be strict without
becoming a bottleneck:

> Approve a change once it definitely improves the overall health of the codebase, even if
> it is not perfect.

There is no perfect code, only better code. You are not entitled to the change you would
have written.

- **Technical facts overrule preferences.** "This throws when the list is empty, and intake
  permits an empty list" is a fact. "I would have used a map" is a preference.
- **Style is settled by the surrounding code**, not by you, and not by the style you know
  best.
- **Say why.** A finding the author cannot act on costs a session and buys nothing. Where
  the fix is not obvious from the problem, name it.
- **Prefix anything you want said but not fixed with \`Nit:\`** and set \`blocking: false\`.
- **Say what is good, too.** The agent that reads this verdict writes the next change.`;

/** What every session that writes code is given, in the order it should be read. */
export const AUTHOR_STANDARDS = [
  CODE_HEALTH_STANDARD,
  TEST_FIRST_STANDARD,
  WRITING_STANDARD,
].join("\n\n");
