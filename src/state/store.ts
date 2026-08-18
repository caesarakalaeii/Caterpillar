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
 *   questions/   NNN-question.md / NNN-answer.md
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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
 * any of them: `GH-caesarakalaeii-all-chat-724` does not say where the owner ends and the
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
 * That argument covers writes that COMPLETED before the `add`. It says nothing about a
 * write that lands during the commit itself, and that window is real: `stageCommitPush` is
 * several subprocess spawns wide, and store writes are plain `writeFile` + `touched()` that
 * do NOT take the mutex — deliberately, since holding it across a session's minutes-long
 * write-then-commit window is the deadlock `exclusively` exists to avoid. A session's
 * `publishArtifact` landing between the `add -A tasks` and a naive `dirty = false` would be
 * in neither the commit nor the flag, and the next housekeeping `pull` would `clean -ffdq`
 * it away — the destroyed-task incident again, through a two-hundred-millisecond hole
 * instead of a two-minute one. So the flag is backed by a monotonic write COUNTER
 * (`writeGeneration`): `stageCommitPush` samples it before the first `add` and clears
 * `dirty` only if it has not moved. A write that raced the commit leaves the flag set, the
 * next `pull` declines, and the next commit carries the file. Erring towards "dirty" costs
 * an interval; erring the other way costs a task.
 *
 * The same counter closes the mirror-image window inside `pull` itself, and for the same
 * reason: `dirty` is a sample, and `pull` does a network `fetch` before it does anything
 * destructive. A write landing in that gap was invisible to the check at the top and
 * deleted by the `clean` at the bottom — the original incident, still reachable after the
 * flag was added. `pullNow` therefore re-reads the generation after its fetch and declines
 * the reset if it moved. Read it as one rule with two instances rather than two tricks:
 * anything that samples `dirty` and then spends time before touching the tree must
 * re-check that nothing was written while it was not looking.
 *
 * `pull` is NOT the only destructive reset in this file, and the `dirty` gate protects
 * only that one. `rebaseOnto` — reached from `push` when the remote has moved — opens with
 * `reset --hard HEAD`, and its salvage path resets to the remote outright. Both run under
 * the mutex, so no other GIT command interleaves, but a session's plain `writeFile` is not
 * under the mutex and a write landing in that window is reverted with everything else.
 * Three things keep it acceptable rather than merely unnoticed. It is far narrower than
 * the pull window — microseconds inside one already-running git command, against the
 * minutes between a `writeState` and its commit. It only happens on a rejected push, which
 * needs another runner to have written the branch in the same instant. And it is not new:
 * `reset --hard` was what the old code did on EVERY pull, and this is the residue of that
 * after the dangerous case was removed. Closing it properly means writes taking the mutex,
 * which is what `exclusively` is for — so if a session is ever seen losing a write here,
 * that is the fix, not another flag.
 */
export class StateStore {
  private readonly root: string;
  private readonly git: Git;

  /** Serialises every git invocation in this checkout. See the class docstring. */
  private readonly serial: Serial;

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
   * `body` receives a handle rather than nothing because the mutex is deliberately not
   * re-entrant (see `Serial`): calling `this.commitAndPush` from inside would deadlock, so
   * the handle exposes the unlocked body of it instead. Nothing else on the store may be
   * called from in here — the handle is the entire vocabulary.
   */
  exclusively<T>(body: (tree: ExclusiveTree) => Promise<T>): Promise<T> {
    return this.serial.run(() =>
      body({
        commitAndPush: (message, remote, branch) => this.stageCommitPush(message, remote, branch),
        pull: async (remote, branch) => {
          // Same gate as the public `pull`, for the same reason: a caller holding the tree
          // for a write-then-commit unit may still want a refresh at the top of it, and it
          // is no safer here than anywhere else while something is uncommitted.
          if (this.dirty) return "skipped";
          await this.pullNow(remote, branch);
          return "pulled";
        },
      }),
    );
  }

  /** True while a write is waiting for its commit. Diagnostics, and `pull`'s gate. */
  get hasUncommittedState(): boolean {
    return this.dirty;
  }

  /**
   * Record that the working tree has been written.
   *
   * Every write path calls this. It is a method rather than a bare assignment so that the
   * one place the flag is set is greppable, and so a future write helper that forgets it
   * is visible as an absence rather than as a missing `= true`.
   */
  private touched(): void {
    this.dirty = true;
    this.writeGeneration += 1;
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

  async readSpec(task: TaskId): Promise<TaskSpec> {
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
   * The front matter is serialised with the YAML library rather than concatenated,
   * because the goal is tracker prose: a human can paste `---` or `acceptance:` into an
   * issue body, and hand-built front matter would let that terminate the block early and
   * silently redefine the completion gate. The goal goes strictly after the closing
   * delimiter, where `readSpec`'s regex takes everything remaining as prose.
   */
  async writeSpec(spec: TaskSpec): Promise<void> {
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
    this.touched();
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
    await mkdir(join(this.root, "intake"), { recursive: true });
    await writeFile(
      this.intakePath(task),
      `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    this.touched();
  }

  /** Idempotent: the success path clears unconditionally. */
  async clearIntakeRejection(task: TaskId): Promise<void> {
    await rm(this.intakePath(task), { force: true });
    this.touched();
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
    this.touched();
  }

  /** Idempotent, like `clearIntakeRejection`: the success path clears unconditionally. */
  async clearAlertRefusal(fingerprint: string): Promise<void> {
    if (!isAlertFingerprint(fingerprint)) return;
    await rm(this.alertRefusalPath(fingerprint), { force: true });
    this.touched();
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
    const dir = this.taskDir(state.id);
    await mkdir(dir, { recursive: true });
    const next: TaskState = { ...state, updatedAt: new Date().toISOString() };
    await writeFile(join(dir, "state.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.touched();
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
        this.touched();
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
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
    const dir = this.taskDir(task);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "handoff.md"), `${body.trim()}\n`, "utf8");
    this.touched();
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
    const dir = join(this.taskDir(task), "sessions");
    await mkdir(dir, { recursive: true });
    const name = `${String(session).padStart(3, "0")}.jsonl.gz`;
    await writeFile(join(dir, name), gzipSync(Buffer.from(jsonl, "utf8")));
    this.touched();
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
  async pendingQuestion(task: TaskId): Promise<{ readonly index: number; readonly question: string } | undefined> {
    const dir = join(this.taskDir(task), "questions");
    if (!existsSync(dir)) return undefined;
    const files = await readdir(dir);
    const questions = files.filter((f) => f.endsWith("-question.md")).sort();
    const last = questions.at(-1);
    if (last === undefined) return undefined;

    const index = Number.parseInt(last.slice(0, 3), 10);
    const answer = `${String(index).padStart(3, "0")}-answer.md`;
    if (files.includes(answer)) return undefined;

    return { index, question: await readFile(join(dir, last), "utf8") };
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

  async writeQuestion(task: TaskId, index: number, question: string): Promise<void> {
    const dir = join(this.taskDir(task), "questions");
    await mkdir(dir, { recursive: true });
    const name = `${String(index).padStart(3, "0")}-question.md`;
    await writeFile(join(dir, name), `${question.trim()}\n`, "utf8");
    this.touched();
  }

  /** Mirror of `writeQuestion`. The file's existence is what marks a question answered. */
  async writeAnswer(task: TaskId, index: number, answer: string): Promise<void> {
    const dir = join(this.taskDir(task), "questions");
    await mkdir(dir, { recursive: true });
    const name = `${String(index).padStart(3, "0")}-answer.md`;
    await writeFile(join(dir, name), `${answer.trim()}\n`, "utf8");
    this.touched();
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
    const dir = join(this.taskDir(task), "reviews");
    await mkdir(dir, { recursive: true });
    const name = `${String(index).padStart(3, "0")}-verdict.md`;
    await writeFile(join(dir, name), `${body.trim()}\n`, "utf8");
    this.touched();
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
    this.touched();
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
    if (!isDigestDate(date)) throw new Error(`'${date}' is not a date this can be filed under`);

    const dir = join(this.root, "digests");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${date}.md`), `${body.trimEnd()}\n`, "utf8");
    this.touched();
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
   * first `add`. Writes do not take the mutex, so a session's `publishArtifact` or
   * `appendJournal` can land inside this method — after its file would have been staged,
   * before the flag is cleared. Such a write is in neither the commit nor the flag, and the
   * next `pull` would `clean -ffdq` it out of existence; a session then goes hours to its
   * next commit with the loss already taken. Leaving the flag set costs one skipped pull.
   */
  commitAndPush(message: string, remote: string, branch: string): Promise<void> {
    return this.serial.run(() => this.stageCommitPush(message, remote, branch));
  }

  /** The body of `commitAndPush`, assuming the caller already holds the mutex. */
  private async stageCommitPush(message: string, remote: string, branch: string): Promise<void> {
    // Sampled BEFORE the first `add`, so any write that this commit might have missed —
    // including one racing the very first `git add` — moves it. See the docstring above.
    const staged = this.writeGeneration;

    // Each path is staged only when it exists: `git add` fails the WHOLE command on a
    // pathspec that matches nothing (`fatal: pathspec 'tasks' did not match any files`),
    // and none of these directories is guaranteed. A freshly bootstrapped state repo has
    // no `tasks/` at all, a repo that has never refused an intake item has no `intake/`,
    // and one whose first digest is not yet due has no `digests/` — so the first rejection
    // on a new runner would otherwise throw here rather than record anything.
    //
    // `alerts/` is in the list because it is the only thing that makes an alert refusal
    // reach the remote at all (§20). It is also where the operator's `policy.yaml` lives,
    // which the supervisor never writes — staging a path it does not write costs nothing.
    for (const path of ["tasks", "intake", "digests", "alerts"]) {
      if (existsSync(join(this.root, path))) await this.git.run("add", "-A", path);
    }
    if (await this.git.hasUncommittedChanges()) {
      await this.git.run("commit", "-m", message);
    }
    // Everything written into the tree BEFORE this commit began is now in it, so `pull` may
    // safely run again: it rebases local commits rather than discarding them. If a write
    // landed while we were committing, the generation moved and the flag stays set — that
    // file may not be in the commit, and a pull must keep declining until one carries it.
    if (this.writeGeneration === staged) this.dirty = false;

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
   * does a human hand-committing a spec (§14.4), which HANDOFF.md documents as a
   * supported workflow. `Git.run` throws on any non-zero exit, so a non-fast-forward
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
   * discard can hit. The caller holds the mutex, so no other git command interleaves — but
   * a session's `writeFile` does not take the mutex, and one landing between the `add -A`
   * above and this reset is reverted. The window is microseconds wide and only opens on a
   * rejected push; the class docstring says why that is accepted rather than patched, and
   * what the real fix would be.
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
   * spent on them is in HANDOFF.md.
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
   */
  pull(remote: string, branch: string): Promise<"pulled" | "skipped"> {
    return this.serial.run(async () => {
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
   * Holding the mutex and having seen a clean tree is NOT enough, and this is the subtlest
   * corner of the whole invariant. Store writes deliberately do not take the mutex, so
   * `dirty` is only a sample of the instant it was read — and the `fetch` below is a
   * network round trip, hundreds of milliseconds during which a write can land. The
   * destructive part comes AFTER that, so a `writeSpec` arriving mid-fetch is deleted by
   * the `clean -ffdq tasks` at the bottom having never been visible to the check at the
   * top.
   *
   * That is not hypothetical: it is the five-destroyed-tasks incident, and it was still
   * reachable after the `dirty` gate was added. It surfaced the moment the work loop began
   * pulling before each claim, which put a pull in the same instant as a `/brainstorm`
   * creating a task — the spec was written between this method's `fetch` and its `clean`,
   * and vanished before the `commitAndPush` three lines later could stage it. The commit
   * then found nothing to commit and reported success.
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
    for (const path of ["tasks", "intake", "alerts"]) {
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
