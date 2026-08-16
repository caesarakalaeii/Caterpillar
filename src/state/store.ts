/**
 * Git-backed task state. See DESIGN.md §4.
 *
 * Layout per task:
 *   spec.md      immutable — front-matter + prose goal, written once at intake
 *   state.json   mutable control record
 *   journal.md   APPEND-ONLY — the audit trail, and the source of truth on recovery
 *   handoff.md   OVERWRITTEN each session — the baton, deliberately bounded
 *   questions/   NNN-question.md / NNN-answer.md
 *   sessions/    NNN.jsonl.gz — pi transcripts
 *
 * journal.md grows; handoff.md does not. That asymmetry is the point: an
 * append-forever handoff document eventually consumes the context window it exists
 * to preserve.
 *
 * Only the supervisor writes here, using its own credential. Task-scoped forge
 * tokens never cover the state repo, so the audit trail cannot be rewritten by the
 * thing being audited (DESIGN.md §9.3).
 */
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { GitError, type Git } from "./git.ts";
import {
  asTaskId,
  asWorkspaceName,
  parseRepoRef,
  type Capability,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type ToolchainSpec,
  type TrackerRef,
} from "../domain/task.ts";

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

export class StateStore {
  private readonly root: string;
  private readonly git: Git;

  constructor(root: string, git: Git) {
    this.root = root;
    this.git = git;
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
    if (kind !== "implement" && kind !== "brainstorm") {
      throw new SpecParseError(task, "`kind` must be `implement` or `brainstorm`");
    }

    // A brainstorm may declare none: its gate is the review council's verdict on the
    // plan it produces, not §12's acceptance commands (§14.3). It is the ONLY exception,
    // and it exists because a refinement conversation has nothing to run.
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
      // before this field existed and a hand-written one need not know about it.
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
  async readIntakeRejection(
    task: TaskId,
  ): Promise<{ readonly digest: string; readonly reason: string } | undefined> {
    const path = this.intakePath(task);
    if (!existsSync(path)) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as {
      readonly digest: string;
      readonly reason: string;
    };
  }

  async writeIntakeRejection(
    task: TaskId,
    record: { readonly digest: string; readonly reason: string },
  ): Promise<void> {
    await mkdir(join(this.root, "intake"), { recursive: true });
    await writeFile(
      this.intakePath(task),
      `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  /** Idempotent: the success path clears unconditionally. */
  async clearIntakeRejection(task: TaskId): Promise<void> {
    await rm(this.intakePath(task), { force: true });
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
  }

  /** Append-only. Never rewrite existing journal content. */
  async appendJournal(task: TaskId, session: number, body: string): Promise<void> {
    const dir = this.taskDir(task);
    await mkdir(dir, { recursive: true });
    const entry = [
      `\n## Session ${session} — ${new Date().toISOString()}`,
      "",
      body.trim(),
      "",
    ].join("\n");
    await appendFile(join(dir, "journal.md"), entry, "utf8");
  }

  /** Overwritten every handoff — this file must not grow without bound. */
  async writeHandoff(task: TaskId, body: string): Promise<void> {
    const dir = this.taskDir(task);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "handoff.md"), `${body.trim()}\n`, "utf8");
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
  }

  /** Mirror of `writeQuestion`. The file's existence is what marks a question answered. */
  async writeAnswer(task: TaskId, index: number, answer: string): Promise<void> {
    const dir = join(this.taskDir(task), "questions");
    await mkdir(dir, { recursive: true });
    const name = `${String(index).padStart(3, "0")}-answer.md`;
    await writeFile(join(dir, name), `${answer.trim()}\n`, "utf8");
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

  async readAnswer(task: TaskId, index: number): Promise<string | undefined> {
    const name = `${String(index).padStart(3, "0")}-answer.md`;
    const path = join(this.taskDir(task), "questions", name);
    if (!existsSync(path)) return undefined;
    return readFile(path, "utf8");
  }

  /** Commit and push all pending state changes with the supervisor's credential. */
  async commitAndPush(message: string, remote: string, branch: string): Promise<void> {
    // Each path is staged only when it exists: `git add` fails the WHOLE command on a
    // pathspec that matches nothing (`fatal: pathspec 'tasks' did not match any files`),
    // and neither directory is guaranteed. A freshly bootstrapped state repo has no
    // `tasks/` at all, and a repo that has never refused an intake item has no `intake/`
    // — so the first rejection on a new runner would otherwise throw here rather than
    // record anything.
    for (const path of ["tasks", "intake"]) {
      if (existsSync(join(this.root, path))) await this.git.run("add", "-A", path);
    }
    if (await this.git.hasUncommittedChanges()) {
      await this.git.run("commit", "-m", message);
    }
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
   * dirty tree, and this runs from the poll loop, which would then log the same failure
   * and retry it forever — a livelock in the recovery path, which is worse than the
   * failure it recovers from. Discarding uncommitted changes is also exactly what the old
   * `reset --hard <remote>` did, so nothing is lost here that survived before: the point
   * of this method is protecting local COMMITS, which that reset destroyed.
   */
  private async rebaseOnto(remote: string, branch: string): Promise<void> {
    await this.git.run("reset", "--hard", "HEAD");

    const rebased = await this.git.tryRun("rebase", `${remote}/${branch}`);
    if (rebased.code === 0) return;

    // Two writers touched the same file. Leave the repo usable rather than mid-rebase —
    // a checkout stuck in a rebase fails every subsequent git call with a message about
    // the rebase rather than about the conflict.
    await this.git.tryRun("rebase", "--abort");
    throw new GitError(["rebase", `${remote}/${branch}`], rebased);
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
   */
  async pull(remote: string, branch: string): Promise<void> {
    await this.git.run("fetch", remote, branch);

    const ahead = await this.git.tryRun("rev-list", "--count", `${remote}/${branch}..HEAD`);
    const unpushed = ahead.code === 0 && ahead.stdout.trim() !== "0";

    if (unpushed) {
      await this.rebaseOnto(remote, branch);
    } else {
      await this.git.run("reset", "--hard", `${remote}/${branch}`);
    }

    // Untracked leftovers are removed only where a task can be invented from one. The
    // rest of the checkout is left alone: this runs every poll, and a clean sweep of the
    // whole repo would delete whatever an operator was in the middle of.
    for (const path of ["tasks", "intake"]) {
      if (existsSync(join(this.root, path))) await this.git.run("clean", "-ffdq", path);
    }
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
