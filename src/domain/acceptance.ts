/**
 * The acceptance gate and how an amendment changes it. See DESIGN.md §12.3.
 *
 * `spec.md` is immutable, so a criterion that turns out to be unsatisfiable is replaced by
 * an append-only amendment carrying a whole new list. Three surfaces then have to say what
 * changed — the session prompt, the verifier's report and the task page — and each of them
 * needs the same two facts: the list as filed, and the amendments in order.
 *
 * Pure and dependency-free on purpose. The store reads these records off disk
 * (`state/store.ts`); nothing here touches a file, so a page or a prompt can be tested
 * against a literal.
 */

/**
 * One append-only amendment to a task's acceptance criteria.
 *
 * `acceptance` is a WHOLE-LIST replacement rather than a positional patch. A positional
 * diff against an immutable file reads as noise six months later — "replace entry 2"
 * means nothing without the file open beside it — whereas the full list is the gate,
 * written out, in the record that changed it.
 *
 * Amendments are never merged and never applied in sequence: the highest-numbered one
 * wins entirely. Merging would resurrect a criterion an earlier amendment deliberately
 * removed, and there is no way for the writer of amendment 3 to know it was doing that.
 *
 * `why` is required. Without it the record is a hand-edited `spec.md` with extra steps.
 */
export interface AcceptanceAmendment {
  /** The `NNN` in the file name, as a number. Monotonically increasing from 1. */
  readonly index: number;
  /** The complete replacement acceptance list. */
  readonly acceptance: readonly string[];
  /** Why the criteria as filed could not stand. Human-facing, and load-bearing. */
  readonly why: string;
  /** Who decided — an operator handle, or the subsystem that filed it. */
  readonly author: string;
  /** ISO 8601, stamped by the writer. */
  readonly at: string;
}

/**
 * A task's gate, as filed and as amended, carried together.
 *
 * Both halves or neither: `filed` alone cannot say why anything changed, and `history`
 * alone cannot say what a criterion replaced. `history` is empty for the overwhelming
 * majority of tasks, and every consumer must render exactly as it did before amendments
 * existed in that case.
 */
export interface AmendedAcceptance {
  /** `spec.md`'s own list — what intake actually wrote. */
  readonly filed: readonly string[];
  /** Every amendment, oldest first. The last one, if any, is the gate in force. */
  readonly history: readonly AcceptanceAmendment[];
}

/** What an amendment did to the list: the criteria it dropped and the ones it introduced. */
export interface AcceptanceChange {
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

/**
 * Which criteria an amendment dropped and which it introduced.
 *
 * Compared as SETS, not positionally: order decides only which command the verifier runs
 * first and every one of them has to pass, so a reordered list has changed nothing.
 * Reporting a reorder as two removals and two additions would put a criterion nobody
 * touched under "added", and the whole point of these reports is that a reader can trust
 * the named criterion is the one that moved.
 */
export const acceptanceChange = (
  filed: readonly string[],
  inForce: readonly string[],
): AcceptanceChange => ({
  removed: filed.filter((entry) => !inForce.includes(entry)),
  added: inForce.filter((entry) => !filed.includes(entry)),
});
