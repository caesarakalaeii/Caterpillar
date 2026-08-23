/**
 * Git-backed task state. See DESIGN.md §4.
 *
 * Layout per task:
 *   spec.md      immutable — front-matter + prose goal, written once at intake
 *   state.json   mutable control record
 *   journal/     APPEND-ONLY — one file per entry: the audit trail, and the source of
 *                truth on recovery. `journal.md` is the legacy single-file form and is
 *                still read, never written and never deleted.
 *   handoff.md   OVERWRITTEN each session — the baton, deliberately bounded
 *   questions/   NNN-question.md / NNN-answer.md / NNN-options.json
 *   sessions/    NNN.jsonl.gz — pi transcripts
 *
 * The journal grows; handoff.md does not. That asymmetry is the point: an
 * append-forever handoff document eventually consumes the context window it exists
 * to preserve.
 *
 * The journal is SHARDED — one file per entry rather than one file appended to —
 * because a single append-only file is the worst possible shape for concurrent
 * writers. Two runners that record the same task used to append to the same last line
 * of `journal.md`, and no rebase can ever apply that; sharded, they write different
 * paths and both commits apply. See DESIGN.md §4.1 and §4.3.
 *
 * Only the supervisor writes here, using its own credential. Task-scoped forge
 * tokens never cover the state repo, so the audit trail cannot be rewritten by the
 * thing being audited (DESIGN.md §9.3).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  EFFECTS_KEPT,
  effectFileName,
  isEffectRequestId,
  prunableEffects,
  type EffectAge,
  type EffectRecord,
  type EffectVerb,
} from "./effects.ts";
import { GitError, type Git } from "./git.ts";
import { Serial } from "./serial.ts";
import {
  asTaskId,
  asWorkspaceName,
  isTaskId,
  isTerminal,
  parseRepoRef,
  type Capability,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type ToolchainSpec,
  type TrackerRef,
} from "../domain/task.ts";
import {
  EMPTY_POLICY,
  isAlertFingerprint,
  parsePolicy,
  type AlertPolicy,
} from "../remediation/policy.ts";
import {
  isScheduleId,
  parseSchedule,
  ScheduleParseError,
  SCHEDULE_TASK_PREFIX,
  type Schedule,
} from "../schedule/definition.ts";
import { isOccurrenceId } from "../schedule/occurrence.ts";

/**
 * What the supervisor remembers about one firing alert (DESIGN.md §20).
 *
 * Written on every decision the receiver makes about an alert — refused, rate-limited,
 * or accepted — not only on a refusal, because the same record answers two questions:
 * "have I already told someone about this?" and "which alertname does task
 * `ALERT-<fingerprint>` belong to?". The second is not recoverable from a fingerprint,
 * which is a hash.
 */
export interface AlertRefusal {
  readonly fingerprint: string;
  readonly alertname: string;
  /** Why the receiver refused, or how it handled the alert. Human-facing. */
  readonly reason: string;
  /** The task this alert produced, when it produced one. */
  readonly task?: TaskId;
  /** Stamped by the writer, for an operator wondering how long this has been so. */
  readonly at?: string;
  /**
   * Set while a merged fix for this alert is being re-verified (DESIGN.md §20). Absent
   * before the merge, and cleared once a verdict is reached.
   */
  readonly verify?: AlertVerification;
}

/**
 * A merged remediation fix, and what Alertmanager has said since (DESIGN.md §20).
 *
 * Lives on the alert record rather than on `state.json` because the fingerprint is what
 * the evidence is keyed by: the deliveries arrive at a receiver that knows a fingerprint
 * and nothing about tasks, and `alerts/refusals/` is the one place this fleet already
 * writes per-fingerprint facts. Putting it on the task's state would have made the alert
 * path look up a task by fingerprint on every delivery, which is the join this record
 * exists to avoid.
 *
 * A record here is also what makes the re-verification survive a deploy. Keel rolls the
 * pod on every push to main and the settle window outlives that, so a window held in
 * memory would be lost — and the task would go to `done` with nothing having checked, which
 * is the exact silent success §20 closes.
 */
export interface AlertVerification {
  /** When the pull request merged. Every other timestamp is compared against this. */
  readonly mergedAt: string;
  /** The window this fix gets, from the policy entry or the supervisor's default. */
  readonly settleSeconds: number;
  /** When Alertmanager last delivered this fingerprint as firing since the merge. */
  readonly lastFiringAt?: string;
  /** When Alertmanager delivered it as resolved. The only positive evidence of a clear. */
  readonly resolvedAt?: string;
}

/** What became of one occurrence of one schedule. */
export type ScheduleOutcome = "fired" | "skipped" | "refused";

/**
 * The ledger entry for one occurrence (DESIGN.md §22).
 *
 * Written for a FIRED occurrence as well as a skipped one, and that is what makes the
 * skipped ones legible: "the precheck said no" and "nothing is polling this schedule" are
 * the same silence otherwise, and the first is the normal case for a schedule whose whole
 * job is to notice something occasionally.
 *
 * Durable and pushed rather than in memory, for the reason §14.2 gives about Keel rolling
 * the pod on every push to main: an in-memory note of "already handled 09:00" is emptied
 * by a deploy, and the claim ref is the only thing that then stops a second task.
 */
export interface ScheduleRecord {
  readonly schedule: string;
  /** `YYYY-MM-DDTHHMMZ`, as `occurrenceId` renders it. */
  readonly occurrence: string;
  readonly outcome: ScheduleOutcome;
  /** The task this occurrence produced, when it produced one. */
  readonly task?: TaskId;
  /** Why it was skipped or refused — a precheck's exit code, a parse error. Human-facing. */
  readonly detail?: string;
  /** Stamped by the writer. */
  readonly at?: string;
}

/** Every schedule that parsed, and the ones that did not, from one pass over the tree. */
export interface ScheduleListing {
  readonly schedules: readonly Schedule[];
  /** One entry per file that could not be read as a schedule. Shown on `/intake`. */
  readonly errors: readonly { readonly schedule: string; readonly message: string }[];
}

/**
 * Why intake refused one tracker item (DESIGN.md §14.2).
 *
 * `digest` is the suppression key and the ONLY field whose meaning is load-bearing: a
 * record whose digest still matches the item means "already told them, say nothing".
 * Everything else is decoration for a human reading `/intake`, and every one of those
 * fields is OPTIONAL — records written before they existed have none, and a reader that
 * required them would treat every one of them as unreadable and re-comment on the first
 * poll after a deploy. That is the exact tracker spam §14.2 exists to prevent, so the
 * shape widens and never narrows.
 *
 * `url`, `title` and `workspace` are here because the task id cannot be turned back into
 * any of them: `GH-acme-all-chat-724` does not say where the owner ends and the
 * repo begins, so a page keyed on these records could otherwise show a reason and no link
 * to the thing being refused.
 */
export interface IntakeRejection {
  readonly digest: string;
  readonly reason: string;
  /** Stamped by the writer. Absent on records written before it was stamped. */
  readonly at?: string;
  /** The tracker item's web URL, for a page that wants to link to what was refused. */
  readonly url?: string;
  readonly title?: string;
  readonly workspace?: string;
}

/** A rejection record together with the task id its file name encodes. */
export interface IntakeRejectionRecord extends IntakeRejection {
  readonly task: TaskId;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Caps on `artifacts/` (DESIGN.md §17). Deliberately small — see the comment there. */
export const ARTIFACT_BYTES = 1024 * 1024;
export const ARTIFACT_COUNT = 10;

/**
 * An artifact name is a single path segment inside the task directory, chosen by an
 * AGENT. No separators, no dots that could climb out — the same reasoning as a task id,
 * and here the input is model-authored rather than merely human-authored.
 */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isArtifactName = (name: string): boolean =>
  ARTIFACT_NAME.test(name) && !name.includes("..");

/**
 * A digest is filed under a calendar date, and that date becomes a file name.
 *
 * Fully anchored: the value arrives from a URL and from a ref name, and a path segment
 * built from an unchecked one climbs out of `digests/` exactly as a task id would.
 */
const DIGEST_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isDigestDate = (date: string): boolean => DIGEST_DATE.test(date);

export class SpecParseError extends Error {
  constructor(task: TaskId, detail: string) {
    super(`spec.md for ${task} is invalid: ${detail}`);
    this.name = "SpecParseError";
  }
}

/**
 * One append-only amendment to a task's acceptance criteria (DESIGN.md §12.3).
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
 * The keys an amendment file may carry.
 *
 * Everything else is refused rather than ignored. `repos` is the forge token's scope, so
 * changing it is a §9.1 blast-radius decision and not a chat command; `workspace`,
 * `requires`, `toolchain` and `kind` decide where and how the task runs; and a wrong
 * prose goal deserves a fresh task with clean history rather than an overlay that makes
 * the filed document a lie. A file naming one of those is a human asking for something
 * this mechanism does not do, and answering it with a silent partial application would be
 * worse than refusing.
 */
const AMENDMENT_KEYS: readonly string[] = ["acceptance", "why", "author", "at"];

export class AmendmentParseError extends Error {
  constructor(task: TaskId, file: string, detail: string) {
    super(`amendment ${file} for ${task} is invalid: ${detail}`);
    this.name = "AmendmentParseError";
  }
}

interface SpecFrontMatter {
  readonly workspace?: unknown;
  readonly kind?: unknown;
  readonly repos?: unknown;
  readonly requires?: unknown;
  readonly acceptance?: unknown;
  readonly toolchain?: unknown;
  readonly tracker?: unknown;
}

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Strict list parsing for fields where dropping an entry changes behaviour.
 *
 * `acceptance` and `repos` must never be filtered silently: quietly discarding an entry
 * would shrink the completion gate or the token scope without anyone noticing. Fail
 * loudly and name the offending entry instead.
 *
 * What actually coerces here, checked against the parser rather than assumed: `true`,
 * `8.0`, `null`, `~` — and an unquoted command containing `: `, which becomes a MAPPING
 * (`- npm test: unit` parses to `{"npm test": "unit"}`). That last one is the realistic
 * mistake. `no`, `yes`, `on` and `off` stay strings: the `yaml` package is YAML 1.2,
 * where only `true`/`false` are booleans, so an earlier version of this note naming `no`
 * was wrong.
 */
const requireStringArray = (
  value: unknown,
  field: string,
  task: TaskId,
): readonly string[] => {
  if (!Array.isArray(value)) throw new SpecParseError(task, `\`${field}\` must be a list`);

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new SpecParseError(
        task,
        `\`${field}[${index}]\` must be a string, got ${typeof entry} (${JSON.stringify(entry)}) — ` +
          `quote it if YAML is coercing it`,
      );
    }
    return entry;
  });
};

/**
 * One `amendments/NNN.yaml` document.
 *
 * Strict in both directions: an unknown key is a refusal (see `AMENDMENT_KEYS`), and a
 * missing or mistyped known key is too. This file replaces the completion gate of a task
 * that may already be running, so a field this cannot make sense of must stop the read
 * rather than be dropped — a partially applied amendment is a gate nobody wrote.
 */
const parseAmendment = (
  value: unknown,
  task: TaskId,
  file: string,
  index: number,
): AcceptanceAmendment => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AmendmentParseError(task, file, "not a mapping");
  }

  const forbidden = Object.keys(value).filter((key) => !AMENDMENT_KEYS.includes(key));
  if (forbidden.length > 0) {
    throw new AmendmentParseError(
      task,
      file,
      `an amendment may only replace \`acceptance\` — refusing \`${forbidden.join("`, `")}\`. ` +
        "Changing repos, workspace, requires, toolchain, kind or the goal needs a new task, " +
        "not an amendment",
    );
  }

  const raw = value as {
    readonly acceptance?: unknown;
    readonly why?: unknown;
    readonly author?: unknown;
    readonly at?: unknown;
  };

  if (!Array.isArray(raw.acceptance)) {
    throw new AmendmentParseError(task, file, "`acceptance` must be a list");
  }
  const acceptance = raw.acceptance.map((entry, at) => {
    if (typeof entry !== "string") {
      throw new AmendmentParseError(
        task,
        file,
        `\`acceptance[${at}]\` must be a string, got ${typeof entry} ` +
          `(${JSON.stringify(entry)}) — quote it if YAML is coercing it`,
      );
    }
    return entry;
  });
  if (acceptance.length === 0) {
    // Same rule as `readSpec`: a task with no machine-checkable criteria can never satisfy
    // §12, so an amendment that emptied the list would make the task uncloseable.
    throw new AmendmentParseError(
      task,
      file,
      "`acceptance` must list at least one command — an amendment cannot leave a task " +
        "with nothing the supervisor can run",
    );
  }

  for (const field of ["why", "author", "at"] as const) {
    if (typeof raw[field] !== "string" || raw[field] === "") {
      throw new AmendmentParseError(task, file, `\`${field}\` must be a non-empty string`);
    }
  }

  return {
    index,
    acceptance,
    why: raw.why as string,
    author: raw.author as string,
    at: raw.at as string,
  };
};

/** `host/owner/name` or `owner/name` (host defaults to github.com). */
const parseRepo = (raw: string): RepoRef => {
  const parsed = parseRepoRef(raw);
  if (parsed === undefined) throw new Error(`cannot parse repo reference '${raw}'`);
  return parsed;
};

/**
 * `toolchain:` from the front matter (DESIGN.md §8.1).
 *
 * Strict, and it must agree with `intake/spec.ts`: intake accepting what this refuses
 * would write a spec.md that can never be read back, leaving a task in the queue that
 * nothing can claim and nothing can explain (§14.1).
 */
const parseToolchain = (value: unknown, task: TaskId): ToolchainSpec | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecParseError(task, "`toolchain` must be a mapping");
  }

  const raw = value as { readonly mode?: unknown; readonly packages?: unknown };
  if (raw.mode !== "nix" && raw.mode !== "inherit") {
    throw new SpecParseError(task, "`toolchain.mode` must be `nix` or `inherit`");
  }
  if (raw.packages === undefined) return { mode: raw.mode };

  return {
    mode: raw.mode,
    // Strict for the same reason `acceptance` is: silently dropping a package produces an
    // environment that is missing exactly one tool, which reads as a repo problem.
    packages: requireStringArray(raw.packages, "toolchain.packages", task),
  };
};

/**
 * A runner id inside a file name.
 *
 * The id is a pod name in the fleet and an arbitrary string in a test, and it becomes a
 * path segment — so it is reduced to characters that cannot climb out of `journal/` or
 * confuse a sort. An id that reduces to nothing still gets a name, because the shard
 * must be written regardless of what the operator called the runner.
 */
const sanitiseRunnerId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned === "" ? "runner" : cleaned;
};

/**
 * `<zero-padded-session>-<iso-ish-timestamp>-<runner>.md`.
 *
 * Sorts chronologically as a plain string sort, which is what `readJournal` and the
 * digest's window query both rely on. The timestamp keeps ISO's field order and drops
 * the punctuation git and shells would rather not see.
 */
const journalShardName = (session: number, at: Date, runner: string): string => {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
  return `${String(session).padStart(4, "0")}-${stamp}-${runner}.md`;
};

/** The sidecar holding one question's enumerated choices, if it offered any. */
const optionsFileName = (index: number): string => `${String(index).padStart(3, "0")}-options.json`;

/**
 * The question a task is currently parked on.
 *
 * `options` is present only when the agent enumerated choices (DESIGN.md §7). It is what a
 * one-press answer resolves against: the button carries an index into this list, because a
 * `custom_id` has no room for the text.
 */
export interface PendingQuestion {
  readonly index: number;
  readonly question: string;
  readonly options?: readonly string[];
}

/**
 * Every top-level directory the supervisor writes, and therefore the broadest thing a
 * commit may stage.
 *
 * Used by `stageCommitPush` only when there is NO write-then-commit unit to scope to — see
 * there.
 *
 * Deliberately NOT shared with `pullNow`'s sweep list, which is `tasks`, `intake`, `alerts`
 * and leaves `digests` alone. That difference predates this constant and is left as it was:
 * changing what a `reset --hard` reaches is not a change to make while passing through, and
 * the two lists answer different questions — this one is "what may this commit carry", that
 * one is "what may a refresh destroy".
 */
const WRITABLE_TREE: readonly string[] = ["tasks", "intake", "digests", "alerts", "schedules"];

/** What `pull` moved aside, and where it put it. */
export interface SalvagedCommits {
  /** `refs/salvaged/<oid>` — local to this checkout, and on its volume. */
  readonly ref: string;
  readonly commit: string;
  /** Git's own account of the conflict. */
  readonly detail: string;
}

/**
 * The git a caller may run while it holds the checkout exclusively.
 *
 * Deliberately tiny. `StateStore`'s public methods each take the mutex themselves and it
 * is not re-entrant, so calling one from inside `exclusively` deadlocks; this handle is the
 * unlocked equivalent of the two that matter, and its narrowness is what stops the mistake
 * being available in the first place. Plain filesystem writes on the store are fine from
 * inside — they run no git.
 */
export interface ExclusiveTree {
  commitAndPush(message: string, remote: string, branch: string): Promise<void>;
  pull(remote: string, branch: string): Promise<"pulled" | "skipped">;
}

/**
 * What one exclusive hold on the checkout knows about itself.
 *
 * Carried in an `AsyncLocalStorage` so that a write and the commit that persists it can
 * recognise each other without being passed a token by hand — which matters because the
 * writes are made through the store's ordinary public methods, several call frames down
 * from whoever took the hold.
 *
 * `wrote` is the reason this is an object rather than the `true` it used to be. See
 * `StateStore.pending`: a commit inside a hold stages the paths that hold wrote, and
 * nothing else, which is what keeps N concurrent sessions out of each other's commits.
 */
interface Hold {
  /** Pathspecs written under this hold and not yet committed by it. */
  readonly wrote: Set<string>;
}

/**
 * The one working copy of the state repo.
 *
 * **Hard invariant: every method here that runs git holds `serial` for the whole of it,
 * and every method that WRITES the working tree marks it dirty.** Both halves became
 * load-bearing when the supervisor split its timing into two loops (DESIGN.md §6.4): a
 * housekeeping loop that pulls, drains chat, ingests and publishes, and a work loop that
 * runs one session at a time. They are independent, so they run concurrently, and this is
 * ONE checkout.
 *
 * Without the mutex the two interleave `git add` and `git commit` in that checkout:
 * `index.lock` at best, and at worst a commit carrying half of the other writer's state —
 * which is precisely the reasoning `src/supervisor/inbox.ts` gives for why the Discord
 * bridge does not touch git at all. The bridge queues and the loop drains; these two loops
 * cannot do that for each other, because both of them ARE loops, so they take a lock.
 *
 * The mutex alone is not enough for `pull`, and that is the second half. `pull` does
 * `reset --hard` and `clean -ffdq` over `tasks/`, `intake/` and `alerts/` — see its own
 * note about the five tasks that cost destroyed. Mutual exclusion only says the pull does
 * not run DURING a `git add`; it says nothing about a pull landing between a session's
 * `writeState` and the `commitAndPush` that was going to persist it, which is a window of
 * minutes and the exact shape of the incident. So writes set `dirty`, `commitAndPush`
 * clears it, and `pull` declines while it is set and reports that it did. The housekeeping
 * loop simply tries again on its next tick; a session commits at defined points
 * (`Supervisor.recordSession`, `Supervisor.push`), so the window always closes.
 *
 * `dirty` deliberately errs towards "yes": it is set by any write, including one whose
 * commit later turns out to be a no-op. A pull skipped for no reason costs one interval;
 * a pull taken for no reason costs a session.
 *
 * One flag is enough for two writers, and that is worth being explicit about because it
 * looks like it should not be. Housekeeping committing a `/resume` while a session is
 * halfway through `recordSession` clears the flag on the strength of ITS commit — and that
 * is sound, because `stageCommitPush` stages `tasks`, `intake`, `digests` and `alerts` with
 * `add -A`, which is the whole of what the supervisor ever writes. Whoever commits carries
 * the other's pending files with it, so the tree afterwards is genuinely clean and the flag
 * is not lying. What the two writers lose is attribution, not durability: one commit
 * message undersells its contents, which is a far better trade than a destroyed task.
 * `store.test.ts` pins it, and narrowing `add -A` to per-task pathspecs would break it —
 * the `add -A` property is what makes one writer's commit speak for the other's files.
 *
 * **Writes take the mutex too, one write at a time.** They did not, and the argument for
 * that was careful and wrong. It went: a write is a `writeFile`, `pull` declines while
 * `dirty` is set, and holding the lock across a session's minutes-long write-then-commit
 * window is the deadlock `exclusively` exists to avoid. Every clause is true and the
 * conclusion still does not follow, because `dirty` is a SAMPLE. Both destructive paths in
 * this file spend several subprocess spawns in the working tree AFTER the last time they
 * could check it — `pullNow` between its post-fetch re-check and its `clean -ffdq`, and
 * `rebaseOnto` between its `reset --hard HEAD` and the end of its salvage — and an unlocked
 * write landing in there is deleted having been visible to nothing.
 *
 * That was not caught by reasoning about it. It was caught as a FLAKE: one CI run in three,
 * `an answer from the bridge unparks the task on the REMOTE`, where an answer from Discord
 * reported `applied`, wrote `questions/004-answer.md`, had it deleted by the work loop's
 * pre-claim pull, and then pushed a `state.json` saying the question had been answered — the
 * answer gone from the one file the next session reads it out of (§4.1). The same red job
 * skipped the image build, so a deploy silently did not happen either.
 *
 * The deadlock objection is answered by SCOPE: `write` holds the lock for one `writeFile`,
 * never for a write-then-commit unit, and no public write is reachable from inside a
 * critical section — `exclusively`'s handle exposes `commitAndPush` and `pull` and nothing
 * else, precisely so that stays true. What a write can now do is wait out a fetch. Losing it
 * was the alternative.
 *
 * `dirty` and its write COUNTER (`writeGeneration`) stay, and are no longer the only line.
 * `stageCommitPush` samples the counter before its first `add` and clears `dirty` only if it
 * has not moved; `pullNow` re-reads it after its fetch and declines the reset if it did. With
 * writes serialised, neither can now be moved by a write in this process — they are the
 * belt to the mutex's braces, they still hold against anything else sharing the checkout
 * (`serial` is injectable for exactly that), and a guard whose incident is written down is
 * not one to delete because it has become hard to reach. Erring towards "dirty" costs an
 * interval; erring the other way costs a task.
 *
 * What the mutex does NOT do is make a read-then-write atomic. A caller that reads state,
 * decides, and writes it back can still have a pull land in the middle and write a decision
 * made against the previous remote. That is what `exclusively` is for, it is unchanged by
 * this, and no caller has needed it yet.
 */
/**
 * Replace a file so that a concurrent reader sees the old contents or the new, never neither.
 *
 * `writeFile` truncates and then writes, so there is a window in which the file on disk is
 * short. The mutex orders WRITES against each other; it does nothing about reads, and reads of
 * `state.json` are constant and mostly outside it — `survey` reads every task once per poll, the
 * web view renders from it, `/task` answers from a snapshot built out of it.
 *
 * Observed as `SyntaxError: Unexpected end of JSON input` out of `JSON.parse` in `readState`,
 * under a machine loaded enough to widen the window. In the loop that is worse than an error,
 * because `survey` wraps its read in a `catch`: the task silently drops out of that pass's
 * snapshot and out of its thread bindings, so a listing goes briefly wrong and a message typed
 * in that task's thread finds no binding — a fast read that is not a right one, which §7.1
 * already has an incident about.
 *
 * `rename` within one directory is atomic on POSIX, so the swap is what a reader observes. The
 * temp name carries the pid and a counter rather than a random suffix, because two writers in
 * one directory must not be able to choose the same one, and `Math.random` is not a guarantee.
 */
let scratchCounter = 0;

const writeAtomic = async (path: string, contents: string): Promise<void> => {
  const scratch = `${path}.${process.pid}.${++scratchCounter}.tmp`;
  await writeFile(scratch, contents, "utf8");
  try {
    await rename(scratch, path);
  } catch (error) {
    // A failed rename leaves the scratch file behind, and `git add -A` would commit it.
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
};

export class StateStore {
  private readonly root: string;
  private readonly git: Git;

  /** Serialises every git invocation in this checkout. See the class docstring. */
  private readonly serial: Serial;

  /**
   * Marks the async context that currently holds the checkout, so a write issued from
   * inside a hold is recognised as the holder's own rather than queued behind it. See
   * `exclusive`.
   */
  private readonly holder = new AsyncLocalStorage<Hold>();

  /**
   * True once something has been written into the working tree and not yet committed.
   *
   * Read only by `pull`, and only to decline. See the class docstring for why mutual
   * exclusion on its own does not cover this case.
   */
  private dirty = false;

  /**
   * Incremented by every write. Only ever compared with itself.
   *
   * This is what makes clearing `dirty` after a commit honest. Writes do not hold the
   * mutex, so one can land in the middle of `stageCommitPush`; sampling this before the
   * first `git add` and re-reading it after the commit is how that writer is detected and
   * the flag left set for the next commit to clear. See the class docstring.
   */
  private writeGeneration = 0;

  /**
   * Pathspecs written and not yet committed, relative to the checkout root.
   *
   * **This is what makes a commit carry only its own writer's files, and it became
   * necessary when one runner started working N tasks at once (DESIGN.md §6.4).**
   *
   * `stageCommitPush` used to run `git add -A tasks` (and `intake`, `digests`, `alerts`),
   * which stages the WHOLE directory regardless of who wrote what. With a single session
   * per runner that was harmless to the point of being invisible: the only other writer was
   * housekeeping, and whatever it swept in was a different task's file landing under a
   * slightly imprecise message. With N sessions it stops being cosmetic — the supervisor
   * writes `state.json` at `transition("running")` and deliberately does not push it, so at
   * any moment every OTHER in-flight task has an uncommitted `state.json` sitting in this
   * tree, and the first session to finish committed all of them under its own message.
   *
   * The mutex cannot fix that and neither can `exclusively`: the file has been on disk for
   * the whole of a session, so there is no window to close. The staging itself has to be
   * narrowed, which is what this does — each write records the path it touched, and the
   * commit stages exactly the recorded set.
   *
   * Cleared only when a commit actually carries them, in the same place `dirty` is cleared
   * and under the same generation check. A path recorded twice costs nothing (it is a set),
   * and a path recorded for a write whose commit turns out to be a no-op costs one
   * `git add` of a file with no changes.
   *
   * **Two scopes, and the distinction is the whole of the fix.** A write made INSIDE a hold
   * (`exclusively`) records its path on that hold, and the commit inside the same hold
   * stages only those — so a session commits its own three files and nobody else's. A write
   * made outside any hold records here, and the next unscoped `commitAndPush` stages these.
   *
   * Without the split, scoping the staging would have achieved nothing: `transition
   * ("running")` writes a `state.json` at the START of a session and never commits it, so
   * every other in-flight task's path is in this set for the whole of a session and the
   * first commit to come along would take them all. That is a window minutes wide that no
   * lock can close, because it was already open before the lock was taken.
   *
   * It errs the same way `dirty` does — towards staging — for the same reason: a path
   * staged unnecessarily costs nothing, and a path not staged is a write that never reaches
   * the remote. Which is why a path recorded on a HOLD is also recorded here: if that hold's
   * commit is a no-op, or it throws before committing, the path must still be waiting for
   * somebody.
   */
  private readonly pending = new Set<string>();

  /**
   * Called when `pull` had to move unmergeable local commits aside. Optional because a
   * store with nowhere to report it still recovers correctly — but a fleet that salvages
   * silently is one where two runners are quietly disagreeing about a task and nobody
   * finds out, so the supervisor always passes one.
   */
  private readonly onSalvage: ((event: SalvagedCommits) => void) | undefined;

  /**
   * Which runner this store writes as — it becomes part of every journal shard's name.
   *
   * That is the whole collision argument: two runners recording the same session of the
   * same task at the same instant still write different paths, so their commits commute
   * and rebase onto one another. Defaulted rather than required because the tests and
   * the one-shot CLIs construct stores without a fleet around them; `config.runnerId` is
   * threaded in wherever there is one.
   */
  private readonly runnerId: string;

  /**
   * `serial` is injected rather than always owned so that anything else sharing this
   * checkout — the bootstrap path, a CLI verifier — can be serialised against it too. It
   * defaults to a private one, because a store nobody shares is still a store that must
   * not be entered twice.
   */
  constructor(
    root: string,
    git: Git,
    onSalvage?: (event: SalvagedCommits) => void,
    runnerId?: string,
    serial?: Serial,
  ) {
    this.root = root;
    this.git = git;
    this.onSalvage = onSalvage;
    this.runnerId = sanitiseRunnerId(runnerId ?? "local");
    this.serial = serial ?? new Serial();
  }

  /**
   * Run `body` with the checkout to itself, as one write-then-commit unit.
   *
   * **Nothing in the supervisor calls this yet**, and that is deliberate rather than an
   * oversight — say so here so the next reader does not assume sessions are protected by
   * it. What protects sessions is `dirty` plus its write counter: a session writes without
   * the lock, `pull` declines while anything is uncommitted, and the cost of that route is
   * attribution (another writer's commit may carry these files) rather than durability.
   * This exists for a caller that cannot accept even that cost, and there is one concrete
   * prospect rather than a hypothetical: the `reset --hard` inside `rebaseOnto` is the one
   * destructive path the `dirty` gate does NOT cover, because it fires between an `add` and
   * a commit that the writing session is not party to. The class docstring argues why that
   * window is tolerable today — microseconds wide, only on a rejected push. If it ever
   * stops being tolerable, routing session writes through here is the fix, and that is the
   * plan this method is being kept against. If the window is closed some other way, or a
   * year passes with no caller, delete it: an affordance with no caller and no plan is one
   * to delete.
   *
   * It is the atomic form for anything that writes and then persists:
   * the mutex on its own only says no other writer is inside a `git add`, and a caller that
   * writes, releases, and then calls `commitAndPush` has handed the interval between the
   * two to whoever asks next. `git add -A` stages the WHOLE tree, so that other writer's
   * commit carries this one's half-written files under the wrong message — the mixed commit
   * in the class docstring, arrived at without a single interleaved git call.
   *
   * `body` receives a handle because the mutex is not re-entrant (see `Serial`): the handle
   * exposes the unlocked bodies of `commitAndPush` and `pull`, so a holder can use them
   * without acquiring what it already has.
   *
   * The store's WRITE methods may be called from in here as well, and that is not a
   * loophole: `exclusive` recognises the holding async context, so the holder's own write
   * runs immediately while anybody else's queues. Without that, writes taking the mutex
   * would have made this method a deadlock on its first `appendJournal` — which is exactly
   * how the omission was found (`loop.test.ts` hung rather than failed). Reads were never
   * locked and are unaffected.
   */
  exclusively<T>(body: (tree: ExclusiveTree) => Promise<T>): Promise<T> {
    return this.exclusive(
      () =>
        body({
          commitAndPush: (message, remote, branch) =>
            this.stageCommitPush(message, remote, branch),
          pull: async (remote, branch) => {
            // Same gate as the public `pull`, for the same reason: a caller holding the tree
            // for a write-then-commit unit may still want a refresh at the top of it, and it
            // is no safer here than anywhere else while something is uncommitted.
            if (this.dirty) return "skipped";
            await this.pullNow(remote, branch);
            return "pulled";
          },
        }),
      // A UNIT: writes made in here get a staging set of their own, so this commit carries
      // this caller's files and no concurrent slot's. See `exclusive`'s second parameter.
      true,
    );
  }

  /** True while a write is waiting for its commit. Diagnostics, and `pull`'s gate. */
  get hasUncommittedState(): boolean {
    return this.dirty;
  }

  /**
   * Every working-tree write: under the mutex, and counted.
   *
   * **Writes take the lock.** They did not, and the reasoning for that was explicit — a
   * write is a `writeFile`, `pull` declines while `dirty` is set, and holding the mutex
   * across a session's minutes-long write-then-commit window is the deadlock `exclusively`
   * exists to avoid. The first two halves of that were true and the conclusion still did not
   * hold, because `dirty` is a SAMPLE: `pullNow` re-checks it after its fetch and then spends
   * a `reset --hard` and up to three `clean -ffdq` calls in the working tree. A write landing
   * in THAT window was invisible to every check and deleted by the sweep.
   *
   * It is not hypothetical and it was not caught by reasoning: it was a flake in
   * `loop.test.ts` that failed one CI run in three. An answer from Discord reported
   * `applied`, wrote `questions/004-answer.md`, had it deleted by the work loop's pre-claim
   * pull, and then pushed a `state.json` saying the question was answered — an answer the
   * next session cannot read, in the file that IS the record of it (§4.1). One CI job also
   * skipped the image build over it, so a deploy silently did not happen.
   *
   * The deadlock objection is answered by scope: this holds the lock for ONE write, not for
   * a write-then-commit unit, and no store method calls another public write from inside a
   * critical section — `exclusively`'s handle deliberately exposes only `commitAndPush` and
   * `pull` for exactly this reason. What a write can now do is WAIT, for as long as a pull's
   * fetch takes; losing it was the alternative.
   *
   * `dirty` is set in a `finally`, so a write that threw halfway still counts as one. The
   * flag errs towards "yes" by design (see the class docstring): a pull skipped for no
   * reason costs an interval, and a pull taken over a half-written file costs a task.
   */
  private write<T>(
    /**
     * What this write touches, relative to the root — `tasks/<id>`, `intake`, `digests`,
     * `alerts/refusals`. A DIRECTORY rather than a file, deliberately: several writes put
     * several files under one task, `git add -A <dir>` picks up a removal as readily as a
     * creation (which `clearIntakeRejection` needs), and per-file bookkeeping would have to
     * be right about names this class computes in a dozen places. The unit that matters for
     * attribution is the task, and `tasks/<id>` is exactly that unit.
     */
    pathspec: string,
    body: () => Promise<T>,
  ): Promise<T> {
    return this.exclusive(async () => {
      try {
        return await body();
      } finally {
        this.touched(pathspec);
      }
    });
  }

  /**
   * Take the checkout — unless this async context is already the one holding it.
   *
   * Every mutex-taking entry point goes through here: `write`, `commitAndPush`, `pull` and
   * `exclusively`. That uniformity is the point. Once writes take the lock, a caller inside
   * `exclusively` — which exists precisely so a write and its commit are one unit — would
   * deadlock on its own hold the moment it wrote anything, and `loop.test.ts`'s mutex test
   * did exactly that: it hung the whole file rather than failing, which is how this was
   * found. The same trap waits for `onSalvage`, which `rebaseOnto` invokes with the lock
   * held.
   *
   * `Serial` stays re-entrant-HOSTILE and this does not weaken it: the re-entrancy is
   * scoped to the ASYNC CONTEXT that actually holds the lock, so a write from anywhere
   * else still queues. That identity is why this is `AsyncLocalStorage` and not a boolean —
   * a flag saying "someone holds it" would wave through the very concurrent write the lock
   * exists to order, which is the bug this whole change is about, restored by its own fix.
   * The hazard `Serial`'s docstring warns of — a public method quietly calling another —
   * remains visible: nothing in this class does it, and a reader can still grep for it.
   */
  private exclusive<T>(
    body: () => Promise<T>,
    /**
     * Whether this acquisition is a write-then-commit UNIT rather than one call taking the
     * lock for itself. Only `exclusively` passes true.
     *
     * The distinction decides what the commit inside it stages, and getting it wrong is not
     * subtle in either direction. A unit gets a write set of its own, so its commit carries
     * its own files and no sibling slot's (see `pending`). A bare `commitAndPush` — the
     * bootstrap path, a CLI, the digest — must NOT get one: it wrote nothing under this
     * hold, so a scoped set would be empty and it would stage nothing at all, leaving a
     * `git commit` with an empty index and a `GitError` about a commit with no changes.
     */
    unit = false,
  ): Promise<T> {
    // A nested acquisition runs on the hold it already has, INCLUDING that hold's write set:
    // `applyOutcome` calling `park` is one unit and must commit as one, so the inner call's
    // writes have to join the outer call's staging rather than starting a set of their own.
    if (this.holder.getStore() !== undefined) return body();
    if (!unit) return this.serial.run(body);
    return this.serial.run(() => this.holder.run({ wrote: new Set<string>() }, body));
  }

  /**
   * Record that the working tree has been written.
   *
   * Every write path goes through `write`, which calls this. It is a method rather than a
   * bare assignment so that the one place the flag is set is greppable.
   */
  private touched(pathspec: string): void {
    this.dirty = true;
    this.writeGeneration += 1;
    // Recorded even when the write threw — `write` calls this from a `finally` — for
    // `dirty`'s reason: a half-written file must be staged by the next commit rather than
    // left for a `pull` to reset over.
    //
    // BOTH scopes, always. The hold's set is what its own commit stages; the store's is the
    // backstop for a hold that commits nothing, throws, or never commits at all. See
    // `pending`.
    this.holder.getStore()?.wrote.add(pathspec);
    this.pending.add(pathspec);
  }

  taskDir(task: TaskId): string {
    return join(this.root, "tasks", task);
  }

  /** Task ids present in the state repo. */
  async listTasks(): Promise<readonly TaskId[]> {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => asTaskId(e.name));
  }

  /**
   * The EFFECTIVE spec: `spec.md` with the newest acceptance amendment applied (§12.3).
   *
   * This is the seam every caller already uses, and that is deliberate. An opt-in
   * `readEffectiveSpec` would be a rule each future call site has to remember, and the
   * site that forgot would be the one where the verifier ran a criterion a human had
   * already amended away — exactly the failure amendments exist to prevent. A caller that
   * genuinely wants the document as filed asks for `readBaseSpec` and says so.
   */
  async readSpec(task: TaskId): Promise<TaskSpec> {
    const base = await this.readBaseSpec(task);
    // Highest number wins ENTIRELY: no merge, no sequential application. See
    // `AcceptanceAmendment`.
    const newest = (await this.listAmendments(task)).at(-1);
    if (newest === undefined) return base;
    return { ...base, acceptance: newest.acceptance };
  }

  /**
   * The spec exactly as filed, with no amendment overlay.
   *
   * For a reader that needs the original document rather than the current gate — a page
   * showing what intake actually wrote, or a diff against an amendment. Not for the
   * verifier: see `readSpec`.
   */
  async readBaseSpec(task: TaskId): Promise<TaskSpec> {
    const raw = await readFile(join(this.taskDir(task), "spec.md"), "utf8");
    const match = FRONT_MATTER.exec(raw);
    if (match === null) throw new SpecParseError(task, "missing YAML front matter");

    const [, yamlBlock, goal] = match as unknown as [string, string, string];
    const meta = parseYaml(yamlBlock) as SpecFrontMatter | null;
    if (meta === null || typeof meta !== "object") {
      throw new SpecParseError(task, "front matter is not a mapping");
    }

    if (typeof meta.workspace !== "string") {
      throw new SpecParseError(task, "`workspace` is required");
    }

    const kind = meta.kind === undefined ? "implement" : meta.kind;
    if (kind !== "implement" && kind !== "brainstorm" && kind !== "remediation") {
      throw new SpecParseError(
        task,
        "`kind` must be `implement`, `brainstorm` or `remediation`",
      );
    }

    // A brainstorm may declare none: its gate is the review council's verdict on the
    // plan it produces, not §12's acceptance commands (§14.3). It is the ONLY exception,
    // and it exists because a refinement conversation has nothing to run. `remediation`
    // is deliberately NOT widened into it (§20): an alert-driven task ends in a pull
    // request like any other, so it needs commands the supervisor can run.
    const acceptance =
      kind === "brainstorm" && meta.acceptance === undefined
        ? []
        : requireStringArray(meta.acceptance, "acceptance", task);
    if (acceptance.length === 0 && kind !== "brainstorm") {
      // Enforced at intake too, but re-checked here: a task with no machine-checkable
      // criteria can never satisfy §12, so it could never be marked done.
      throw new SpecParseError(
        task,
        "`acceptance` must list at least one command — a task without machine-checkable " +
          "criteria can never be verified as done",
      );
    }

    const repos = requireStringArray(meta.repos, "repos", task).map(parseRepo);
    if (repos.length === 0) throw new SpecParseError(task, "`repos` must list at least one repo");

    const toolchain = parseToolchain(meta.toolchain, task);

    return {
      id: task,
      workspace: asWorkspaceName(meta.workspace),
      kind,
      goal: goal.trim(),
      repos,
      requires: asStringArray(meta.requires) as readonly Capability[],
      acceptance,
      ...(toolchain === undefined ? {} : { toolchain }),
      ...(isTrackerRef(meta.tracker) ? { tracker: meta.tracker } : {}),
    };
  }

  /** True when this task already exists — the basis of intake's idempotency (§14). */
  async hasTask(task: TaskId): Promise<boolean> {
    return existsSync(join(this.taskDir(task), "spec.md"));
  }

  /**
   * Write `spec.md`. Intake only — the agent never writes a spec (§4.1, §9.3).
   *
   * Refuses to overwrite. `spec.md` is immutable, and rewriting the spec of a task that
   * is already running would change its acceptance criteria mid-flight.
   *
   * When a criterion turns out to be unsatisfiable, the supported route is an
   * AMENDMENT — `writeAmendment`, which appends `amendments/NNN.yaml` and leaves this
   * file untouched. Hand-editing `spec.md` in the state repo is not it: it destroys the
   * record of what the task was actually asked to do, and it is what amendments exist to
   * replace.
   *
   * The front matter is serialised with the YAML library rather than concatenated,
   * because the goal is tracker prose: a human can paste `---` or `acceptance:` into an
   * issue body, and hand-built front matter would let that terminate the block early and
   * silently redefine the completion gate. The goal goes strictly after the closing
   * delimiter, where `readBaseSpec`'s regex takes everything remaining as prose.
   */
  async writeSpec(spec: TaskSpec): Promise<void> {
    return this.write(`tasks/${spec.id}`, async () => {
      const dir = this.taskDir(spec.id);
      const path = join(dir, "spec.md");
      if (existsSync(path)) {
        throw new Error(`spec.md for ${spec.id} already exists and specs are immutable`);
      }

      const frontMatter = stringifyYaml({
        workspace: spec.workspace,
        // Omitted when it is the default, so an ordinary spec looks exactly as it did
        // before this field existed and a hand-written one need not know about it. Every
        // other kind — `brainstorm`, `remediation` — is written out, because losing it
        // would silently turn the task back into an ordinary implementation task on the
        // way back in through `readSpec`.
        ...(spec.kind !== undefined && spec.kind !== "implement" ? { kind: spec.kind } : {}),
        // Always fully qualified, so the host never has to be inferred on the way back in.
        repos: spec.repos.map((r) => `${r.host}/${r.owner}/${r.name}`),
        requires: [...spec.requires],
        acceptance: [...spec.acceptance],
        // Omitted when absent, like `kind`: the overwhelmingly common spec declares no
        // toolchain, and an empty key in every spec.md would suggest one is expected.
        ...(spec.toolchain === undefined
          ? {}
          : {
              toolchain: {
                mode: spec.toolchain.mode,
                ...(spec.toolchain.packages === undefined
                  ? {}
                  : { packages: [...spec.toolchain.packages] }),
              },
            }),
        ...(spec.tracker !== undefined ? { tracker: { ...spec.tracker } } : {}),
      });

      await mkdir(dir, { recursive: true });
      await writeFile(path, `---\n${frontMatter}---\n\n${spec.goal.trim()}\n`, "utf8");
    });
  }

  private amendmentDir(task: TaskId): string {
    return join(this.taskDir(task), "amendments");
  }

  /**
   * Every acceptance amendment for a task, oldest first (DESIGN.md §12.3).
   *
   * Ordered by number so a caller can take `.at(-1)` for the effective one and `.length`
   * for how many times the gate has been argued with. Read-only — the numbering rule
   * stays with `writeAmendment`, as it does for `questions/` and `reviews/`.
   *
   * NOT defensive about an unreadable file, unlike `listIntakeRejections`: that listing
   * feeds a page where one bad record must not cost the rest, whereas this one decides
   * what the supervisor runs. Skipping a malformed amendment here would silently fall
   * back to a criterion a human had already amended away.
   */
  async listAmendments(task: TaskId): Promise<readonly AcceptanceAmendment[]> {
    const dir = this.amendmentDir(task);
    if (!existsSync(dir)) return [];

    const files = (await readdir(dir))
      .flatMap((name) => {
        const digits = /^(\d+)\.yaml$/.exec(name)?.[1];
        return digits === undefined ? [] : [{ name, index: Number.parseInt(digits, 10) }];
      })
      .sort((a, b) => a.index - b.index);

    return Promise.all(
      files.map(async ({ name, index }) =>
        parseAmendment(parseYaml(await readFile(join(dir, name), "utf8")), task, name, index),
      ),
    );
  }

  /**
   * Append one acceptance amendment, allocating the next number (DESIGN.md §12.3).
   *
   * Append-only: this never rewrites or removes an earlier file, so the directory listing
   * IS the audit trail of every time the gate was changed and why. The number comes from
   * the highest one already on disk, which is the same allocation `writeVerdict` and
   * `writeQuestion` get from their callers — taken here rather than passed in because a
   * caller that guessed wrong would overwrite somebody's recorded reasoning.
   *
   * `spec.md` is not touched. That is the point.
   */
  async writeAmendment(
    task: TaskId,
    amendment: {
      readonly acceptance: readonly string[];
      readonly why: string;
      readonly author: string;
    },
  ): Promise<AcceptanceAmendment> {
    return this.write(`tasks/${task}`, async () => {
      const existing = await this.listAmendments(task);
      const index = (existing.at(-1)?.index ?? 0) + 1;
      const record: AcceptanceAmendment = {
        index,
        acceptance: [...amendment.acceptance],
        why: amendment.why,
        author: amendment.author,
        at: new Date().toISOString(),
      };

      const dir = this.amendmentDir(task);
      await mkdir(dir, { recursive: true });
      const name = `${String(index).padStart(3, "0")}.yaml`;
      await writeFile(
        join(dir, name),
        stringifyYaml({
          // `index` is the file name and is deliberately not duplicated inside: two places
          // saying the same number is two places that can disagree.
          acceptance: [...record.acceptance],
          why: record.why,
          author: record.author,
          at: record.at,
        }),
        "utf8",
      );

      // Read back rather than trusted, for `writeSpec`'s reason: a record this store
      // cannot parse would be a gate nothing can read, discovered by the verifier.
      return parseAmendment(parseYaml(await readFile(join(dir, name), "utf8")), task, name, index);
    });
  }

  private intakePath(task: TaskId): string {
    return join(this.root, "intake", `${task}.json`);
  }

  /**
   * Why intake last refused this item, if it did.
   *
   * Durable and pushed, not in-memory: the record suppresses a repeat comment on the
   * tracker, and Keel rolls the pod on every push to main. An in-memory set would
   * re-comment on every deploy for every malformed item.
   */
  async readIntakeRejection(task: TaskId): Promise<IntakeRejection | undefined> {
    const path = this.intakePath(task);
    if (!existsSync(path)) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as IntakeRejection;
  }

  /**
   * Every intake refusal on disk, newest-looking last, for the `/intake` page.
   *
   * The mirror of `listAlertRefusals`, and defensive in the same way and for the same
   * reason: one unreadable record must not cost the whole listing. Here the stakes are
   * lower — this feeds a page rather than a rate limit — but the failure mode is worse to
   * diagnose, because a page that renders nothing looks exactly like a fleet nobody has
   * given work to.
   *
   * The task id comes from the FILE NAME and is validated before it is trusted: these
   * files are written by this process, but a page that turned any string on disk into a
   * `/tasks/<id>` link would be one bad file away from a path it should not build.
   */
  async listIntakeRejections(): Promise<readonly IntakeRejectionRecord[]> {
    const dir = join(this.root, "intake");
    if (!existsSync(dir)) return [];

    const out: IntakeRejectionRecord[] = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isTaskId(id)) continue;
      try {
        const record = JSON.parse(await readFile(join(dir, name), "utf8")) as IntakeRejection;
        out.push({ ...record, task: asTaskId(id) });
      } catch {
        continue;
      }
    }
    return out;
  }

  async writeIntakeRejection(task: TaskId, record: IntakeRejection): Promise<void> {
    return this.write("intake", async () => {
      await mkdir(join(this.root, "intake"), { recursive: true });
      await writeFile(
        this.intakePath(task),
        `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    });
  }

  /** Idempotent: the success path clears unconditionally. */
  async clearIntakeRejection(task: TaskId): Promise<void> {
    return this.write("intake", async () => {
      await rm(this.intakePath(task), { force: true });
    });
  }

  /**
   * The operator's alert policy (DESIGN.md §20).
   *
   * READ ONLY, and there is no `writeAlertPolicy` on purpose: `alerts/policy.yaml` is
   * authored by a human and committed by a human, which is what makes adding an alert a
   * reviewable change rather than something the supervisor can do to itself. The only
   * thing under `alerts/` the supervisor writes is `alerts/refusals/`.
   *
   * A missing file is an EMPTY policy rather than an error. Most state repos have never
   * heard of alerts, and the poll loop calls this every cycle — a throw there would turn
   * "this cluster has not opted in" into a supervisor that logs a failure every 30
   * seconds. A file that exists and does not parse still throws `PolicyParseError`: that
   * one IS an operator mistake and must be visible.
   */
  async readAlertPolicy(): Promise<AlertPolicy> {
    if (!existsSync(this.alertPolicyPath())) return EMPTY_POLICY;
    return parsePolicy(await readFile(this.alertPolicyPath(), "utf8"));
  }

  private alertPolicyPath(): string {
    return join(this.root, "alerts", "policy.yaml");
  }

  /**
   * Whether the operator has written a policy at all.
   *
   * `readAlertPolicy` deliberately answers a missing file with `EMPTY_POLICY`, which is
   * the right thing for the poll loop and the wrong thing for a page: "this cluster has
   * never opted an alert in" and "the file exists and lists nothing" want different
   * sentences, and only one of them is fixed by writing the file.
   */
  async hasAlertPolicy(): Promise<boolean> {
    return existsSync(this.alertPolicyPath());
  }

  private alertRefusalPath(fingerprint: string): string {
    return join(this.root, "alerts", "refusals", `${fingerprint}.json`);
  }

  /**
   * Why the alert receiver last refused this alert, if it did.
   *
   * The same reasoning as `readIntakeRejection`, verbatim: the record suppresses a repeat
   * notification, and Keel rolls the pod on every push to main, so an in-memory set would
   * re-notify for every refused alert on every deploy — and Alertmanager re-sends a
   * firing alert every few minutes, which makes the fleet noisier than the alert.
   *
   * `alertname` is stored rather than derived. A fingerprint is a hash: the alertname is
   * NOT recoverable from it, and `maxOpenTasks` needs to count the open tasks for an
   * alertname (§20). Recording it here is what makes that a lookup instead of a guess.
   */
  async readAlertRefusal(fingerprint: string): Promise<AlertRefusal | undefined> {
    if (!isAlertFingerprint(fingerprint)) return undefined;
    const path = this.alertRefusalPath(fingerprint);
    if (!existsSync(path)) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as AlertRefusal;
  }

  async writeAlertRefusal(fingerprint: string, record: AlertRefusal): Promise<void> {
    return this.write("alerts/refusals", async () => {
      // The fingerprint becomes a file name, so it is checked rather than trusted: it
      // arrives in an HTTP body from outside this process, and `..` is a legal directory
      // name that resolves out of `alerts/` — the same trap a task id is guarded against.
      if (!isAlertFingerprint(fingerprint)) {
        throw new Error(`'${fingerprint}' is not an alert fingerprint this can be filed under`);
      }
      await mkdir(join(this.root, "alerts", "refusals"), { recursive: true });
      await writeFile(
        this.alertRefusalPath(fingerprint),
        `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    });
  }

  /** Idempotent, like `clearIntakeRejection`: the success path clears unconditionally. */
  async clearAlertRefusal(fingerprint: string): Promise<void> {
    return this.write("alerts/refusals", async () => {
      if (!isAlertFingerprint(fingerprint)) return;
      await rm(this.alertRefusalPath(fingerprint), { force: true });
    });
  }

  /**
   * How many tasks this alertname has open right now (DESIGN.md §20).
   *
   * "Open" is `!isTerminal(status)` — the one notion of task status the whole supervisor
   * uses, deliberately not a second one invented here. A `parked` remediation task counts
   * as closed: it is waiting on a human, and a fresh firing of the same alert is exactly
   * the nudge that should be allowed to create a new task rather than be suppressed by a
   * task nobody is working on.
   *
   * Counted by joining `alerts/refusals/` to `tasks/` rather than by parsing ids, because
   * a fingerprint is a hash and does not carry its alertname. A record naming a task that
   * no longer exists contributes nothing, so a manually deleted task frees its slot.
   */
  async countOpenAlertTasks(alertname: string): Promise<number> {
    const records = await this.listAlertRefusals();

    let open = 0;
    for (const record of records) {
      if (record.alertname !== alertname || record.task === undefined) continue;
      const state = await this.tryReadState(record.task).catch(() => undefined);
      if (state !== undefined && !isTerminal(state.status)) open += 1;
    }
    return open;
  }

  /** Every alert record on disk, for counting open tasks per alertname (§20). */
  async listAlertRefusals(): Promise<readonly AlertRefusal[]> {
    const dir = join(this.root, "alerts", "refusals");
    if (!existsSync(dir)) return [];

    const out: AlertRefusal[] = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      // One unreadable record must not cost the whole listing: this feeds a rate limit,
      // and a limit that throws is a limit that blocks every alert rather than one.
      try {
        out.push(JSON.parse(await readFile(join(dir, name), "utf8")) as AlertRefusal);
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Every schedule in the state repo, and every file that failed to be one (§22).
   *
   * BOTH, in one answer, because they are needed together: the housekeeping pass fires the
   * ones that parsed and the intake pass shows the ones that did not. A method that threw
   * on the first bad file would stop a fleet's scheduled work over one typo, which is the
   * failure the per-file layout exists to prevent.
   *
   * A missing `schedules/` is an empty listing rather than an error — the poll loop calls
   * this every pass and most state repos have never heard of schedules (`readAlertPolicy`'s
   * reasoning, §20).
   *
   * READ ONLY. There is no `writeSchedule`, for the reason there is no `writeAlertPolicy`:
   * a schedule is authored and committed by a human, which is what keeps "what work happens
   * unattended" outside the fleet's own reach. The only thing under `schedules/` the
   * supervisor writes is the occurrence ledger.
   */
  async listSchedules(): Promise<ScheduleListing> {
    const dir = join(this.root, "schedules");
    if (!existsSync(dir)) return { schedules: [], errors: [] };

    const schedules: Schedule[] = [];
    const errors: { schedule: string; message: string }[] = [];

    for (const name of (await readdir(dir)).sort()) {
      // `.yaml` only. An operator's `README.md` beside their schedules is notes, not a
      // malformed schedule, and reporting it as one would make the errors list unreadable.
      if (!name.endsWith(".yaml")) continue;
      const id = name.slice(0, -".yaml".length);

      try {
        // The id comes from a DIRECTORY LISTING, so it is validated before it is used: it
        // becomes a task id and a git ref component, and nothing here wrote the file name.
        if (!isScheduleId(id)) {
          throw new ScheduleParseError(
            id,
            `'${id}' is not a schedule identifier — the file name becomes a task id and a ` +
              `git ref component, so it must be letters, digits, \`-\` and \`_\` only`,
          );
        }
        schedules.push(parseSchedule(id, await readFile(join(dir, name), "utf8")));
      } catch (error) {
        errors.push({
          schedule: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { schedules, errors };
  }

  private scheduleRecordPath(schedule: string, occurrence: string): string {
    return join(this.root, "schedules", "occurrences", `${schedule}-${occurrence}.json`);
  }

  /** What became of one occurrence, or nothing if this runner has never settled it. */
  async readScheduleRecord(
    schedule: string,
    occurrence: string,
  ): Promise<ScheduleRecord | undefined> {
    if (!isScheduleId(schedule) || !isOccurrenceId(occurrence)) return undefined;
    const path = this.scheduleRecordPath(schedule, occurrence);
    if (!existsSync(path)) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as ScheduleRecord;
  }

  async writeScheduleRecord(
    schedule: string,
    occurrence: string,
    record: ScheduleRecord,
  ): Promise<void> {
    return this.write("schedules/occurrences", async () => {
      // Both halves become a file name, and neither is written by this class: the schedule
      // id is read off a directory listing and the occurrence is computed from a document
      // an operator wrote. `..` is a legal directory name that resolves out of `schedules/`.
      if (!isScheduleId(schedule) || !isOccurrenceId(occurrence)) {
        throw new Error(
          `'${schedule}' / '${occurrence}' cannot be filed as a schedule occurrence`,
        );
      }
      await mkdir(join(this.root, "schedules", "occurrences"), { recursive: true });
      await writeFile(
        this.scheduleRecordPath(schedule, occurrence),
        `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    });
  }

  /**
   * The whole occurrence ledger, oldest file name first, for the `/intake` page.
   *
   * Defensive in `listAlertRefusals`'s way: one unreadable record must not cost the whole
   * listing, because a page that renders nothing looks exactly like a fleet that has never
   * fired a schedule.
   */
  async listScheduleRecords(): Promise<readonly ScheduleRecord[]> {
    const dir = join(this.root, "schedules", "occurrences");
    if (!existsSync(dir)) return [];

    const out: ScheduleRecord[] = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, name), "utf8")) as ScheduleRecord);
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * How many tasks this schedule has open right now (§22).
   *
   * "Open" is `!isTerminal(status)` — the supervisor's one notion of task status, and
   * deliberately not a second one invented here. A `parked` task counts as closed, exactly
   * as it does for an alert (§20): it is waiting on a human, and the next occurrence is the
   * nudge that should be allowed to open fresh work rather than be suppressed by a task
   * nobody is working on.
   *
   * Counted from the TASK TREE rather than from the ledger, because a schedule's task ids
   * carry the schedule's name (`SCHED-<schedule>-<occurrence>`) and a task deleted by hand
   * should free its slot rather than wedge the schedule forever. The alert path has to join
   * through its ledger only because a fingerprint is a hash and does not carry its name.
   */
  async countOpenScheduleTasks(schedule: string): Promise<number> {
    if (!isScheduleId(schedule)) return 0;
    const prefix = `${SCHEDULE_TASK_PREFIX}${schedule}-`;

    let open = 0;
    for (const task of await this.listTasks()) {
      if (!task.startsWith(prefix)) continue;
      const state = await this.tryReadState(task).catch(() => undefined);
      if (state !== undefined && !isTerminal(state.status)) open += 1;
    }
    return open;
  }

  async readState(task: TaskId): Promise<TaskState> {
    const raw = await readFile(join(this.taskDir(task), "state.json"), "utf8");
    return JSON.parse(raw) as TaskState;
  }

  /**
   * State for a task that may not exist.
   *
   * For callers reacting to a name a HUMAN typed — a mistyped task id in a chat message
   * is an ordinary event, not an exceptional one, and deserves a reply rather than a
   * stack trace.
   */
  async tryReadState(task: TaskId): Promise<TaskState | undefined> {
    if (!existsSync(join(this.taskDir(task), "state.json"))) return undefined;
    return this.readState(task);
  }

  async writeState(state: TaskState): Promise<void> {
    return this.write(`tasks/${state.id}`, async () => {
      const dir = this.taskDir(state.id);
      await mkdir(dir, { recursive: true });
      const next: TaskState = { ...state, updatedAt: new Date().toISOString() };
      await writeAtomic(join(dir, "state.json"), `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  /**
   * Append one journal entry, as its OWN file under `tasks/<id>/journal/`.
   *
   * Append-only is unchanged as an invariant — nothing here rewrites an entry that
   * already exists — but the unit of appending is now a file rather than a line. A
   * single append-only file is the one place the state repo violated the property
   * `commitAndPush` relies on: runners touch disjoint paths, so their histories
   * commute. Two runners appending to `journal.md` collided on the same line and no
   * rebase could ever apply the loser's commit (§4.3). Two runners writing shards write
   * two different files, and both commits apply.
   *
   * The name sorts chronologically and is collision-free: the zero-padded session
   * orders entries the way a reader expects, the timestamp orders two entries of the
   * same session, and the runner id separates two runners that managed both.
   */
  async appendJournal(task: TaskId, session: number, body: string): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = join(this.taskDir(task), "journal");
      await mkdir(dir, { recursive: true });

      const at = new Date();
      const entry = [`## Session ${session} — ${at.toISOString()}`, "", body.trim(), ""].join("\n");

      // Collision within a millisecond on ONE runner is still possible — two entries for
      // the same session, written back to back — and overwriting would silently drop an
      // entry from the audit trail. `wx` fails rather than truncates, so the retry is on
      // the file system's answer and not on a check that another write can race past.
      // Suffixing leaves the sort order alone, because the suffix is the last component.
      for (let n = 1; ; n += 1) {
        const suffix = n === 1 ? this.runnerId : `${this.runnerId}-${n}`;
        try {
          await writeFile(join(dir, journalShardName(session, at, suffix)), entry, {
            encoding: "utf8",
            flag: "wx",
          });
          return;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    });
  }

  /**
   * The whole journal, as one markdown document — what `journal.md` used to be.
   *
   * Legacy content first, then the shards in name order. A state repo that predates the
   * sharding still has a `journal.md`, and it is READ and never rewritten: rewriting it
   * would put the same conflict back, this time in the migration.
   *
   * Undefined when the task has no journal at all, so callers can keep distinguishing
   * "nothing written yet" from "empty" exactly as `readIfPresent` let them.
   */
  async readJournal(task: TaskId): Promise<string | undefined> {
    const legacy = await this.readIfPresent(task, "journal.md");

    const dir = join(this.taskDir(task), "journal");
    const shards = existsSync(dir)
      ? (await readdir(dir)).filter((name) => name.endsWith(".md")).sort()
      : [];

    if (legacy === undefined && shards.length === 0) return undefined;

    const parts: string[] = [];
    if (legacy !== undefined) parts.push(legacy.trimEnd());
    for (const name of shards) {
      parts.push((await readFile(join(dir, name), "utf8")).trim());
    }

    // One blank line between entries, and a leading one: the old file was written by
    // appending `\n## Session …`, so every heading had a blank line above it and
    // `journalForPrompt`'s parser and the digest's evidence both grew up against that.
    return `\n${parts.filter((part) => part !== "").join("\n\n")}\n`;
  }

  /** Overwritten every handoff — this file must not grow without bound. */
  async writeHandoff(task: TaskId, body: string): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = this.taskDir(task);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "handoff.md"), `${body.trim()}\n`, "utf8");
    });
  }

  async readIfPresent(task: TaskId, file: string): Promise<string | undefined> {
    const path = join(this.taskDir(task), file);
    if (!existsSync(path)) return undefined;
    return readFile(path, "utf8");
  }

  /** Store a pi transcript. Gzipped — see DESIGN.md §15 on transcript bloat. */
  async writeSessionTranscript(
    task: TaskId,
    session: number,
    jsonl: string,
  ): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = join(this.taskDir(task), "sessions");
      await mkdir(dir, { recursive: true });
      const name = `${String(session).padStart(3, "0")}.jsonl.gz`;
      await writeFile(join(dir, name), gzipSync(Buffer.from(jsonl, "utf8")));
    });
  }

  /**
   * Session ordinals this task has a stored transcript for, ascending.
   *
   * Sorted NUMERICALLY rather than by file name. The names are zero-padded to three
   * digits, so a lexical sort is right up to session 999 and silently wrong after it —
   * the kind of bug that appears once, on the longest-running task, years in.
   */
  async listSessions(task: TaskId): Promise<readonly number[]> {
    const dir = join(this.taskDir(task), "sessions");
    if (!existsSync(dir)) return [];

    return (await readdir(dir))
      .map((name) => /^(\d+)\.jsonl\.gz$/.exec(name)?.[1])
      .flatMap((digits) => (digits === undefined ? [] : [Number.parseInt(digits, 10)]))
      .sort((a, b) => a - b);
  }

  /**
   * One stored transcript, decompressed. Undefined when there is none.
   *
   * The ordinal reaches this from a URL, so it is checked rather than trusted: anything
   * that is not a positive integer never becomes part of a path.
   */
  async readSessionTranscript(task: TaskId, session: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(session) || session < 1) return undefined;

    const name = `${String(session).padStart(3, "0")}.jsonl.gz`;
    const path = join(this.taskDir(task), "sessions", name);
    if (!existsSync(path)) return undefined;

    return gunzipSync(await readFile(path)).toString("utf8");
  }

  /** Unanswered question, if the task is parked waiting on one. */
  async pendingQuestion(task: TaskId): Promise<PendingQuestion | undefined> {
    const dir = join(this.taskDir(task), "questions");
    if (!existsSync(dir)) return undefined;
    const files = await readdir(dir);
    const questions = files.filter((f) => f.endsWith("-question.md")).sort();
    const last = questions.at(-1);
    if (last === undefined) return undefined;

    const index = Number.parseInt(last.slice(0, 3), 10);
    const answer = `${String(index).padStart(3, "0")}-answer.md`;
    if (files.includes(answer)) return undefined;

    const options = await this.questionOptions(task, index);
    return {
      index,
      question: await readFile(join(dir, last), "utf8"),
      ...(options === undefined ? {} : { options }),
    };
  }

  /**
   * The choices a question offered, when it offered any.
   *
   * Undefined covers three cases on purpose — no sidecar, an unreadable one, and one whose
   * contents are not a list of strings — because the answer to all three is the same: offer
   * the free-text path only. The question is the record and the sidecar is a convenience, so
   * a half-written file must cost the buttons rather than the ability to answer at all.
   */
  private async questionOptions(task: TaskId, index: number): Promise<readonly string[] | undefined> {
    const path = join(this.taskDir(task), "questions", optionsFileName(index));
    if (!existsSync(path)) return undefined;

    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return undefined;
      if (!parsed.every((entry): entry is string => typeof entry === "string")) return undefined;
      return parsed.length === 0 ? undefined : parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Every question this task has asked, with its answer where one was given.
   *
   * `pendingQuestion` answers "is this task blocked right now"; this answers "what has
   * this task needed a human for", which is a different question and the one the web
   * view (DESIGN.md §18) is for. Read-only — the numbering rule stays with the writers.
   */
  async listQuestions(
    task: TaskId,
  ): Promise<readonly { readonly index: number; readonly question: string; readonly answer?: string }[]> {
    const dir = join(this.taskDir(task), "questions");
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const indices = files
      .map((name) => /^(\d+)-question\.md$/.exec(name)?.[1])
      .flatMap((digits) => (digits === undefined ? [] : [Number.parseInt(digits, 10)]))
      .sort((a, b) => a - b);

    return Promise.all(
      indices.map(async (index) => {
        const pad = String(index).padStart(3, "0");
        const question = await readFile(join(dir, `${pad}-question.md`), "utf8");
        const answer = await this.readAnswer(task, index);
        return {
          index,
          question: question.trimEnd(),
          ...(answer === undefined ? {} : { answer: answer.trimEnd() }),
        };
      }),
    );
  }

  /**
   * Every council verdict, oldest first (DESIGN.md §12.1).
   *
   * `latestVerdict` is what the next session reads; this is what a human reads to see
   * whether the council keeps objecting to the same thing.
   */
  async listVerdicts(
    task: TaskId,
  ): Promise<readonly { readonly index: number; readonly body: string }[]> {
    const dir = join(this.taskDir(task), "reviews");
    if (!existsSync(dir)) return [];

    const files = (await readdir(dir))
      .map((name) => /^(\d+)-verdict\.md$/.exec(name)?.[1])
      .flatMap((digits) => (digits === undefined ? [] : [Number.parseInt(digits, 10)]))
      .sort((a, b) => a - b);

    return Promise.all(
      files.map(async (index) => ({
        index,
        body: (await readFile(join(dir, `${String(index).padStart(3, "0")}-verdict.md`), "utf8")).trimEnd(),
      })),
    );
  }

  /**
   * Record a question, and the enumerated choices it offers if it offers any.
   *
   * The options go in a sidecar rather than into the markdown, because they are read back
   * by a button press and parsed — a list embedded in agent-authored prose would have to be
   * recovered from it, and the recovery would be a guess.
   */
  async writeQuestion(
    task: TaskId,
    index: number,
    question: string,
    options?: readonly string[],
  ): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = join(this.taskDir(task), "questions");
      await mkdir(dir, { recursive: true });
      const name = `${String(index).padStart(3, "0")}-question.md`;
      await writeFile(join(dir, name), `${question.trim()}\n`, "utf8");
      if (options !== undefined && options.length > 0) {
        await writeFile(
          join(dir, optionsFileName(index)),
          `${JSON.stringify(options, null, 2)}\n`,
          "utf8",
        );
      }
    });
  }

  /** Mirror of `writeQuestion`. The file's existence is what marks a question answered. */
  async writeAnswer(task: TaskId, index: number, answer: string): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = join(this.taskDir(task), "questions");
      await mkdir(dir, { recursive: true });
      const name = `${String(index).padStart(3, "0")}-answer.md`;
      await writeFile(join(dir, name), `${answer.trim()}\n`, "utf8");
    });
  }

  /**
   * The most recent operator answer, if any.
   *
   * Included in the next session's prompt after a park is lifted — the answer is the
   * whole reason the task became claimable again, so it must not be buried in the
   * journal where the model may skim past it.
   */
  async latestAnswer(task: TaskId): Promise<string | undefined> {
    const dir = join(this.taskDir(task), "questions");
    if (!existsSync(dir)) return undefined;

    const answers = (await readdir(dir)).filter((f) => f.endsWith("-answer.md")).sort();
    const last = answers.at(-1);
    if (last === undefined) return undefined;
    return readFile(join(dir, last), "utf8");
  }

  /**
   * Record one council verdict (DESIGN.md §12.1).
   *
   * Numbered by session and never overwritten, like `questions/`, so a task that went
   * round the council three times keeps all three verdicts. The journal gets the same
   * text — that is what the next session reads — but the journal is a narrative and
   * these are the documents.
   */
  async writeVerdict(task: TaskId, index: number, body: string): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const dir = join(this.taskDir(task), "reviews");
      await mkdir(dir, { recursive: true });
      const name = `${String(index).padStart(3, "0")}-verdict.md`;
      await writeFile(join(dir, name), `${body.trim()}\n`, "utf8");
    });
  }

  /** The most recent verdict, if the council has ever run on this task. */
  async latestVerdict(task: TaskId): Promise<string | undefined> {
    const dir = join(this.taskDir(task), "reviews");
    if (!existsSync(dir)) return undefined;

    const verdicts = (await readdir(dir)).filter((f) => f.endsWith("-verdict.md")).sort();
    const last = verdicts.at(-1);
    if (last === undefined) return undefined;
    return readFile(join(dir, last), "utf8");
  }

  /**
   * Store one small artifact for a task (DESIGN.md §17).
   *
   * The caps are the design, not a safety net: every runner clones this repo and pulls it
   * on every poll, and git keeps whatever lands here forever. An agent that hits one is
   * told to summarise, which is nearly always what was wanted anyway.
   */
  async writeArtifact(task: TaskId, name: string, contents: Buffer): Promise<void> {
    // `listArtifacts` is a READ, and reads deliberately do not take the mutex — so calling
    // it from inside `write` is safe. A public write calling another public WRITE would
    // deadlock (`Serial` is re-entrant-hostile on purpose); none does.
    return this.write(`tasks/${task}`, async () => {
      if (!isArtifactName(name)) {
        throw new Error(
          `'${name}' is not a usable artifact name — letters, digits, dot, dash, underscore`,
        );
      }
      if (contents.byteLength > ARTIFACT_BYTES) {
        throw new Error(
          `'${name}' is ${contents.byteLength} bytes; the limit is ${ARTIFACT_BYTES}`,
        );
      }

      const dir = join(this.taskDir(task), "artifacts");
      await mkdir(dir, { recursive: true });

      const existing = await this.listArtifacts(task);
      if (!existing.includes(name) && existing.length >= ARTIFACT_COUNT) {
        throw new Error(`${task} already has ${existing.length} artifacts; the limit is ${ARTIFACT_COUNT}`);
      }

      await writeFile(join(dir, name), contents);
    });
  }

  async listArtifacts(task: TaskId): Promise<readonly string[]> {
    const dir = join(this.taskDir(task), "artifacts");
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).sort();
  }

  async readArtifact(task: TaskId, name: string): Promise<Buffer | undefined> {
    if (!isArtifactName(name)) return undefined;
    const path = join(this.taskDir(task), "artifacts", name);
    if (!existsSync(path)) return undefined;
    return readFile(path);
  }

  /**
   * What one control-plane effect returned when it landed, or nothing (DESIGN.md §4.4).
   *
   * A READ, so it takes no mutex, and it must never throw: the record is a fast path that
   * lets a replayed verb skip a side effect it already performed, and a missing, truncated
   * or hand-mangled file has to cost a repeated attempt rather than a crashed session. An
   * unreadable record is therefore indistinguishable from an absent one, on purpose.
   *
   * `T` is the caller's claim about what it wrote, not a checked fact — the file is JSON
   * from a previous deploy of this same code. Consumers treat it as a hint: `open_pr` still
   * asks the forge, because if the record and the forge disagree the forge wins.
   */
  async recordedEffect<T>(task: TaskId, requestId: string): Promise<EffectRecord<T> | undefined> {
    if (!isEffectRequestId(requestId)) return undefined;
    const path = join(this.effectsDir(task), effectFileName(requestId));
    if (!existsSync(path)) return undefined;

    try {
      return JSON.parse(await readFile(path, "utf8")) as EffectRecord<T>;
    } catch {
      return undefined;
    }
  }

  /**
   * Record that one effect landed, so a replay of the same call can skip it.
   *
   * ONE FILE per effect, named by the request id. That is the same shape as the journal's
   * shards and for the same reason (§4.1): two runners recording the same task write
   * different paths, so their commits commute and both rebase. A single per-task ledger
   * file would put back the one conflict class §4.3 was written about.
   *
   * Called by the supervisor after the effect, never by the agent — the state repo is not
   * agent-writable (§9.3), which is why this lives here and not in a tool.
   *
   * Pruning happens here rather than in housekeeping because this is the only moment the
   * directory grows, and a cap enforced anywhere else is a cap that depends on a loop
   * having run.
   */
  async recordEffect<T>(
    task: TaskId,
    requestId: string,
    verb: EffectVerb,
    result: T,
  ): Promise<void> {
    return this.write(`tasks/${task}`, async () => {
      const name = effectFileName(requestId);
      const dir = this.effectsDir(task);
      await mkdir(dir, { recursive: true });

      const record: EffectRecord<T> = {
        requestId,
        task,
        verb,
        at: new Date().toISOString(),
        runner: this.runnerId,
        result,
      };
      // Atomic for `readState`'s reason (§4.2): another runner's `recordedEffect` may read
      // this path at any moment, and a truncate-then-write is a window where it reads half
      // a file. Here that would only cost a duplicated effect, which is the whole thing
      // this record exists to prevent.
      await writeAtomic(join(dir, name), `${JSON.stringify(record, null, 2)}\n`);

      await this.pruneEffects(task);
    });
  }

  /**
   * Delete the oldest effect records over `EFFECTS_KEPT`.
   *
   * Private and called only from inside `recordEffect`'s write, so it neither takes the
   * mutex (that would deadlock — `Serial` is re-entrant-hostile) nor records a pathspec of
   * its own: the removal is inside the same `tasks/<id>` unit, and `git add -A <dir>` picks
   * up a deletion as readily as a creation.
   *
   * A record that cannot be read is counted as prunable rather than skipped: it can never
   * answer a replay, so keeping it would let unreadable files hold the cap open forever.
   */
  private async pruneEffects(task: TaskId): Promise<void> {
    const dir = this.effectsDir(task);
    // Only files this class could have written, so a stray name in the directory is left
    // alone rather than deleted — and `effectFileName` below cannot be handed one it would
    // refuse.
    const ids = (await readdir(dir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter(isEffectRequestId);
    if (ids.length <= EFFECTS_KEPT) return;

    const records: EffectAge[] = [];
    for (const requestId of ids) {
      const record = await this.recordedEffect(task, requestId);
      records.push({ requestId, ...(record === undefined ? {} : { at: record.at }) });
    }

    for (const requestId of prunableEffects(records)) {
      await rm(join(dir, effectFileName(requestId)), { force: true });
    }
  }

  private effectsDir(task: TaskId): string {
    return join(this.taskDir(task), "effects");
  }

  /**
   * The published copy of one day's digest (DESIGN.md §19).
   *
   * Kept because Discord is a view and this is the record: a day that scrolled out of the
   * channel, or that a Discord outage swallowed, still exists here — and it is what the
   * web view renders, so there is one document rather than two that can disagree.
   *
   * Overwriting is allowed and never happens: `refs/digests/<date>` is won once, fleet
   * wide, so the second write for a date would be a bug elsewhere. Refusing it here would
   * turn that bug into a released claim and a day published by nobody.
   */
  async writeDigest(date: string, body: string): Promise<void> {
    return this.write("digests", async () => {
      if (!isDigestDate(date)) throw new Error(`'${date}' is not a date this can be filed under`);

      const dir = join(this.root, "digests");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${date}.md`), `${body.trimEnd()}\n`, "utf8");
    });
  }

  /**
   * One digest, or nothing.
   *
   * The date reaches this from a URL, so it is checked rather than trusted — `..` is a
   * legal directory name that resolves to the state repo root, the same trap task ids are
   * guarded against.
   */
  async readDigest(date: string): Promise<string | undefined> {
    if (!isDigestDate(date)) return undefined;

    const path = join(this.root, "digests", `${date}.md`);
    if (!existsSync(path)) return undefined;
    return readFile(path, "utf8");
  }

  /** Published digests, newest first. */
  async listDigests(): Promise<readonly string[]> {
    const dir = join(this.root, "digests");
    if (!existsSync(dir)) return [];

    return (await readdir(dir))
      .map((name) => (name.endsWith(".md") ? name.slice(0, -3) : ""))
      .filter(isDigestDate)
      // ISO dates sort lexically, which is the one thing that format is for.
      .sort((a, b) => b.localeCompare(a));
  }

  async readAnswer(task: TaskId, index: number): Promise<string | undefined> {
    const name = `${String(index).padStart(3, "0")}-answer.md`;
    const path = join(this.taskDir(task), "questions", name);
    if (!existsSync(path)) return undefined;
    return readFile(path, "utf8");
  }

  /**
   * Commit and push all pending state changes with the supervisor's credential.
   *
   * Holds the mutex for the WHOLE of stage-commit-push. Splitting it would put another
   * writer's `git add -A` between this one's add and its commit, and the commit would then
   * carry both — a state.json for a task this runner is not working, pushed under this
   * runner's message. See the class docstring.
   *
   * `dirty` is cleared once the COMMIT lands, not once the push does, and that boundary is
   * chosen rather than convenient. What `dirty` protects against is `pull` resetting over
   * work that exists only in the working tree; a local commit is not in the working tree,
   * and `pull` already goes out of its way to preserve local commits by rebasing them
   * (§4.3). Waiting for the push instead would mean a rejected push — a forge outage, a
   * hook, no network — left the flag set forever, and this runner would stop pulling
   * entirely, silently, until it was restarted. That trade is the wrong way round: a
   * rejected push is a routine event and a wedged runner is not.
   *
   * It is cleared inside the lock and before the push, so a push that throws still leaves
   * a committed tree marked clean, and a `git commit` that throws leaves it dirty.
   *
   * And it is cleared CONDITIONALLY, on the write generation not having moved since the
   * first `add`. Writes now take the mutex, so nothing in THIS process can land inside this
   * method any more — but the check stays: `serial` is injectable, so another component can
   * share this checkout, and the loss it prevents is a file in neither the commit nor the
   * flag, which the next `pull` would `clean -ffdq` out of existence. Leaving the flag set
   * costs one skipped pull.
   */
  commitAndPush(message: string, remote: string, branch: string): Promise<void> {
    return this.exclusive(() => this.stageCommitPush(message, remote, branch));
  }

  /** The body of `commitAndPush`, assuming the caller already holds the mutex. */
  private async stageCommitPush(message: string, remote: string, branch: string): Promise<void> {
    // Sampled BEFORE the first `add`, so any write that this commit might have missed —
    // including one racing the very first `git add` — moves it. See the docstring above.
    const staged = this.writeGeneration;

    // **Exactly what this writer wrote, and nothing else.** See `pending` for the whole
    // argument; the short version is that `git add -A tasks` stages every OTHER in-flight
    // task's uncommitted `state.json` too — `transition("running")` leaves one there for the
    // whole of a session — so on a runner working N tasks at once that is N-1 tasks' state
    // committed under this task's message while their own commits find a clean tree and
    // record nothing.
    //
    // **Narrow inside a unit, broad outside one, and the asymmetry is the design.**
    //
    // Inside a unit (`StateStore.exclusively`, which is what `Supervisor.unit` takes) the
    // hold names the paths that unit wrote, and those are the only ones staged. That is what
    // keeps N concurrent sessions out of each other's commits.
    //
    // Outside one — a bare `commitAndPush` from the bootstrap path, a CLI, or intake — the
    // whole of the writable tree is staged, exactly as it always was. Not laziness: such a
    // caller has no unit to scope to, and it is the ONLY thing that ever commits a change
    // made past this class. `alerts/refusals/` is the concrete case (§20) — a refusal left
    // on disk by a pod that died between its write and its commit was never recorded here,
    // so a narrow stage would leave it forever: uncommitted, and therefore untracked, and
    // therefore swept away by the next `pull`'s `clean -ffdq` with nothing in git to show it
    // had ever existed. `store.test.ts` pins that.
    //
    // The broad list is `tasks`, `intake`, `digests`, `alerts`. `alerts/` also holds the
    // operator's `policy.yaml`, which the supervisor never writes — staging a path it does
    // not write costs nothing.
    //
    // Sampled and cleared rather than iterated in place: a write landing during the `add`
    // loop must be staged by the NEXT commit, not silently dropped from this one because the
    // set was mutated while being walked.
    const hold = this.holder.getStore();
    const staging = hold === undefined ? WRITABLE_TREE : [...hold.wrote];
    hold?.wrote.clear();
    // Whatever this commit is about to stage is no longer outstanding, however it was
    // selected. Only those paths: a unit's commit must not clear a path some other writer
    // recorded and this commit is not staging.
    if (hold === undefined) this.pending.clear();
    else for (const path of staging) this.pending.delete(path);

    // Each path is staged only when it exists: `git add` fails the WHOLE command on a
    // pathspec that matches nothing (`fatal: pathspec 'tasks' did not match any files`),
    // and none of these directories is guaranteed. A freshly bootstrapped state repo has no
    // `tasks/` at all, a repo that has never refused an intake item has no `intake/`, one
    // whose first digest is not yet due has no `digests/` — and inside a unit, a write that
    // threw before its `mkdir` still recorded its pathspec (see `touched`), and
    // `clearIntakeRejection` can remove the last file under one.
    for (const path of staging) {
      if (existsSync(join(this.root, path))) await this.git.run("add", "-A", path);
    }
    // The INDEX, not the working tree. `hasUncommittedChanges` would answer yes because a
    // sibling slot has an uncommitted `state.json` in this same checkout (see the staging
    // note above), and `git commit` against an empty index fails with an error carrying no
    // message. See `Git.hasStagedChanges`.
    if (await this.git.hasStagedChanges()) {
      await this.git.run("commit", "-m", message);
    }
    // Everything written into the tree BEFORE this commit began is now in it, so `pull` may
    // safely run again: it rebases local commits rather than discarding them. If a write
    // landed while we were committing, the generation moved and the flag stays set — that
    // file may not be in the commit, and a pull must keep declining until one carries it.
    //
    // **`pending` is the second condition, and it is what narrow staging made necessary.**
    // The generation check alone assumed a commit carried EVERYTHING outstanding, which was
    // true while staging was `git add -A tasks`. It is not true inside a unit: a commit that
    // staged its own three files leaves every other in-flight task's uncommitted `state.json`
    // exactly where it was. Clearing the flag on the generation alone would then let the very
    // next `pull` do a `reset --hard` and `clean -ffdq` over `tasks/` — which is the incident
    // this flag was introduced for (see `pullNow`), reintroduced by its own fix and aimed at
    // a task that is mid-session rather than one that is mid-write.
    //
    // Both conditions, so the flag errs towards "dirty" exactly as the class docstring says
    // it should: a pull skipped for no reason costs an interval, and a pull taken over an
    // uncommitted file costs a session.
    if (this.writeGeneration === staged && this.pending.size === 0) this.dirty = false;

    // NOT `else return`. A clean tree does not mean there is nothing to push: after a
    // rejected push the tree is clean and the commit is still local. Returning here made
    // that loss permanent in principle — every subsequent call returned before pushing,
    // so the orphaned commit was never re-sent, and the next `pull()` destroyed it.
    await this.push(remote, branch);
  }

  /**
   * Push, rebasing onto the remote if someone else got there first.
   *
   * The state branch is ONE shared resource. Leases are per task, so they say nothing
   * about this: two runners finishing different tasks push to the same branch, and so
   * does a human hand-committing a spec (§14.4), which is a supported workflow.
   * `Git.run` throws on any non-zero exit, so a non-fast-forward
   * rejection used to propagate out of `recordSession` into `parkFailed`, which pushes
   * too and was rejected identically — costing a session's journal, its usage
   * accounting, and leaving the task stranded.
   *
   * Rebase rather than merge: runners touch disjoint `tasks/<id>/` paths, so the histories
   * commute, and a linear state history is the one that reads as a sequence of events.
   */
  private async push(remote: string, branch: string): Promise<void> {
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
      const ahead = await this.git.tryRun(
        "rev-list", "--count", `${remote}/${branch}..HEAD`,
      );
      // A missing remote-tracking ref means we have never fetched; push and find out.
      if (ahead.code === 0 && ahead.stdout.trim() === "0") return;

      const pushed = await this.git.tryRun("push", remote, `HEAD:${branch}`);
      if (pushed.code === 0) return;

      // Anything other than a rejection — no network, no credential, a hook refusing the
      // content — will not be fixed by rebasing onto it, and retrying would just repeat
      // it three times before reporting the same thing.
      if (!isPushRejection(pushed.stderr)) {
        throw new GitError(["push", remote, `HEAD:${branch}`], pushed);
      }

      await this.git.run("fetch", remote, branch);
      await this.rebaseOnto(remote, branch);
    }
    throw new Error(
      `state push to ${remote}/${branch} was rejected ${PUSH_ATTEMPTS} times running — ` +
        `something else is writing the state branch faster than this runner can rebase`,
    );
  }

  /**
   * Replay local commits on top of the remote.
   *
   * The working tree is discarded first, deliberately. `git rebase` refuses outright on a
   * dirty tree, and this runs from a loop that would then log the same failure
   * and retry it forever — a livelock in the recovery path, which is worse than the
   * failure it recovers from. Discarding uncommitted changes is also exactly what the old
   * `reset --hard <remote>` did, so nothing is lost here that survived before: the point
   * of this method is protecting local COMMITS, which that reset destroyed.
   *
   * Since housekeeping and a session now run concurrently, be clear about who that
   * discard can hit — and the answer has changed. The caller holds the mutex, and writes
   * now take it too (`write`), so a session's `writeFile` can no longer land between the
   * `add -A` above and this reset: it waits, and lands after. This used to be the one
   * destructive path the `dirty` gate did not cover, accepted because the window was
   * microseconds wide and only opened on a rejected push. It is closed, by the fix the class
   * docstring named — writes going through the lock — rather than by another flag.
   */
  private async rebaseOnto(remote: string, branch: string): Promise<void> {
    await this.git.run("reset", "--hard", "HEAD");

    const rebased = await this.git.tryRun("rebase", `${remote}/${branch}`);
    if (rebased.code === 0) return;

    // Two writers touched the same file. Leave the repo usable rather than mid-rebase —
    // a checkout stuck in a rebase fails every subsequent git call with a message about
    // the rebase rather than about the conflict.
    await this.git.tryRun("rebase", "--abort");

    // A conflict here is UNRESOLVABLE, not transient, and throwing made it fatal to the
    // runner rather than to the pull: `pollOnce` logs and retries in thirty seconds, and
    // the retry is the identical rebase. Two of a four-replica fleet sat in that loop
    // indefinitely — claiming nothing, draining no chat, answering every probe — and a
    // restart does not help, because the commit is on the volume.
    //
    // The conflict that caused THAT incident no longer exists. It was two runners
    // recording the same task — one has its push refused (a forge outage will do it),
    // keeps the commit, and another takes the task over and pushes its own — colliding
    // on the last line of a single append-only `journal.md`. The journal is now one file
    // per entry (`appendJournal`), so those two runners write different paths and both
    // commits apply. Do not re-derive the old cause from an old comment: if a rebase
    // conflicts here today, it is something else.
    //
    // The salvage below stays regardless, because it is the right backstop for whatever
    // that something else turns out to be — a hand-edited file, a `state.json` written
    // by two runners, a future format that forgets this lesson. It must never be removed
    // in favour of trusting the sharding: the point is that the runner survives a
    // conflict it has never seen before.
    //
    // Resetting unconditionally is not the alternative — `pull` did exactly that once and
    // destroyed five tasks' work (see its note). So the commits are moved aside to a ref
    // and the runner carries on: nothing is destroyed, the ref outlives the pod because
    // the volume does, and a human has an object to look at. The remote wins because it
    // has to: it is what every other runner already agrees on.
    const stranded = await this.git.run("rev-parse", "HEAD");
    const ref = `refs/salvaged/${stranded.slice(0, 12)}`;
    await this.git.tryRun("update-ref", ref, stranded);
    await this.git.run("reset", "--hard", `${remote}/${branch}`);

    this.onSalvage?.({ ref, commit: stranded, detail: rebased.stdout || rebased.stderr });
  }

  /**
   * Refresh the checkout from the remote, keeping anything not yet pushed.
   *
   * This used to be `fetch` + `reset --hard`, which destroyed local commits that a
   * failed push had left behind, and — because `reset` reverts tracked files and leaves
   * untracked ones — left the task directories of a rejected `applyPlan` on disk.
   * `listTasks` enumerates the filesystem, so those became tasks the runner claimed and
   * worked while they existed nowhere in git. That happened: five of them, and the money
   * spent on them was real (`docs/lessons.md`).
   *
   * **It declines outright while the working tree holds uncommitted state**, and returns
   * `"skipped"` to say so. That is the second half of the invariant in the class docstring,
   * and it is not the same guarantee the mutex gives. Since the supervisor's housekeeping
   * and work loops became independent (DESIGN.md §6.4) this runs on a timer that knows
   * nothing about the session: the mutex stops a pull from landing inside a `git add`, but
   * a session's window between `writeState` and the `commitAndPush` that persists it is
   * minutes long, and `reset --hard` plus `clean -ffdq` over `tasks/` inside that window
   * destroys the session's work — which is exactly the incident above, reproduced by a
   * timer instead of by a bug.
   *
   * Skipping is safe and cheap. The state repo is authoritative but not urgent: a
   * refresh deferred by one housekeeping interval changes nothing, because a session
   * commits at defined points (`Supervisor.recordSession`, `Supervisor.push`) and the very
   * next tick after one of those finds a clean tree. The failure mode of the alternative
   * is not symmetrical — it is a destroyed task.
   *
   * **One flag for the whole checkout, so a runner working several tasks at once skips more
   * often** (DESIGN.md §6.5). `transition("running")` leaves an uncommitted `state.json` for
   * the length of a session, so at `concurrency: N` the tree is clean only when every slot
   * is momentarily between commits. That is a refresh RATE rather than a correctness
   * property — skipping is the safe direction, per the asymmetry above — but it is worth
   * knowing, because the work loop's pre-claim pull is what stops this runner opening a
   * session on already-merged work (§6.2) and it is the same call.
   *
   * What keeps it bounded is that a slot commits several times per session and empties at
   * the end of one, so a runner whose slots are not all permanently occupied still refreshes.
   * Two fixes were considered and both rejected, which is why this is written down rather
   * than solved:
   *
   *   - **Per-path dirtiness.** `reset --hard` and `clean -ffdq` are whole-tree, so a
   *     narrower check would let a pull revert a directory another session is mid-write in.
   *     That is a task destroyed to save an interval.
   *   - **Pushing the `running` transition.** It clears the flag promptly and it makes the
   *     fleet's view of a running task honest — but it also makes the task visible as
   *     `running` before the session it names exists, so a `/cancel` arriving in that window
   *     is answered by a park with no session to stop. `loop.test.ts` pins that, and it is
   *     pinning something real.
   */
  pull(remote: string, branch: string): Promise<"pulled" | "skipped"> {
    return this.exclusive(async () => {
      // Checked INSIDE the lock. Outside it, a session could take the lock between the
      // check and the fetch, write, and be reset over by a pull that had already decided
      // the tree was clean.
      if (this.dirty) return "skipped";
      return (await this.pullNow(remote, branch)) ? "pulled" : "skipped";
    });
  }

  /**
   * The body of `pull`. Returns whether it actually refreshed anything.
   *
   * Holding the mutex and having seen a clean tree is NOT enough on its own, and this is the
   * subtlest corner of the whole invariant. `dirty` is a sample of the instant it was read,
   * and the `fetch` below is a network round trip. When writes did not take the mutex, one
   * landing mid-fetch was deleted by the `clean -ffdq tasks` at the bottom having been
   * visible to nothing — and one landing AFTER the re-check below, inside the reset and the
   * clean themselves, could not even be re-checked for.
   *
   * That is not hypothetical: it is the five-destroyed-tasks incident, and it was still
   * reachable after the `dirty` gate was added. It surfaced the moment the work loop began
   * pulling before each claim, which put a pull in the same instant as a `/brainstorm`
   * creating a task — the spec was written between this method's `fetch` and its `clean`,
   * and vanished before the `commitAndPush` three lines later could stage it. The commit
   * then found nothing to commit and reported success. The narrower version of the same
   * window, past the re-check, later cost an operator's answer and read as a flaky test.
   *
   * Writes take the mutex now, so this method has the tree to itself for its whole duration
   * and a write issued during it waits rather than being swept. The re-check below is kept
   * as the second line, not the only one — see the class docstring.
   *
   * So the generation is re-read after the fetch and before anything destructive, exactly
   * as `stageCommitPush` re-reads it after its `add`. A write that raced us leaves the
   * fetch's work in place (it is only a ref update, and harmless) and declines the reset:
   * the tree is now genuinely dirty, so `pull`'s own gate would have refused had it been
   * asked a moment later. Deferring a refresh costs one housekeeping interval; taking it
   * costs a task.
   */
  private async pullNow(remote: string, branch: string): Promise<boolean> {
    const before = this.writeGeneration;
    await this.git.run("fetch", remote, branch);
    // The window the `dirty` check at the top could not see. Everything below this line
    // reverts or deletes working-tree files.
    if (this.writeGeneration !== before || this.dirty) return false;

    const ahead = await this.git.tryRun("rev-list", "--count", `${remote}/${branch}..HEAD`);
    const unpushed = ahead.code === 0 && ahead.stdout.trim() !== "0";

    if (unpushed) {
      await this.rebaseOnto(remote, branch);
    } else {
      await this.git.run("reset", "--hard", `${remote}/${branch}`);
    }

    // Untracked leftovers are removed only where a task can be invented from one. The
    // rest of the checkout is left alone: this runs every poll, and a clean sweep of the
    // whole repo would delete whatever an operator was in the middle of. `digests/` is
    // deliberately NOT swept for the same reason it is staged: an unpushed digest is a
    // day's record waiting for the next commit, not a phantom anything (§19).
    //
    // `alerts/` IS swept. A refusal record whose commit never landed is a suppression
    // that outlives the branch it was written on: the alert stays silenced on this runner
    // while existing nowhere in git, so no other runner agrees and no operator can see
    // why the notification stopped (§20). `policy.yaml` is tracked, so the sweep cannot
    // touch it.
    //
    // `schedules/` is swept on the same terms and for the same reason (§22): an occurrence
    // record whose commit never landed says "this occurrence is settled" on one runner and
    // nowhere else, so the ledger a human reads disagrees with the ledger that stopped the
    // work. The operator's `schedules/*.yaml` are tracked, so the sweep cannot touch them.
    for (const path of ["tasks", "intake", "alerts", "schedules"]) {
      if (existsSync(join(this.root, path))) await this.git.run("clean", "-ffdq", path);
    }
    return true;
  }
}

/** Rebase-and-retry ceiling. Three losses in a row is contention, not a race. */
const PUSH_ATTEMPTS = 3;

/**
 * Whether git refused the push because the remote moved, as opposed to anything else.
 *
 * Matched on stderr because git exits 1 for every push failure alike — a rejection, a
 * dead network, a missing credential and a rejecting hook are indistinguishable by code.
 * Treating them all as rejections would turn "no network" into three rebase attempts
 * against a ref we could not fetch either.
 */
const isPushRejection = (stderr: string): boolean =>
  /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(stderr);

const isTrackerRef = (value: unknown): value is TrackerRef => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["kind"] === "string" && typeof candidate["id"] === "string";
};
