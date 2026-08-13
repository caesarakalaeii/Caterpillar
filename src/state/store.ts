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
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import type { Git } from "./git.ts";
import {
  asTaskId,
  asWorkspaceName,
  type Capability,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type TrackerRef,
} from "../domain/task.ts";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class SpecParseError extends Error {
  constructor(task: TaskId, detail: string) {
    super(`spec.md for ${task} is invalid: ${detail}`);
    this.name = "SpecParseError";
  }
}

interface SpecFrontMatter {
  readonly workspace?: unknown;
  readonly repos?: unknown;
  readonly requires?: unknown;
  readonly acceptance?: unknown;
  readonly tracker?: unknown;
}

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** `host/owner/name` or `owner/name` (host defaults to github.com). */
const parseRepo = (raw: string): RepoRef => {
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length === 3) {
    const [host, owner, name] = parts as [string, string, string];
    return { host, owner, name };
  }
  if (parts.length === 2) {
    const [owner, name] = parts as [string, string];
    return { host: "github.com", owner, name };
  }
  throw new Error(`cannot parse repo reference '${raw}'`);
};

export class StateStore {
  constructor(
    private readonly root: string,
    private readonly git: Git,
  ) {}

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

    const acceptance = asStringArray(meta.acceptance);
    if (acceptance.length === 0) {
      // Enforced at intake too, but re-checked here: a task with no machine-checkable
      // criteria can never satisfy §12, so it could never be marked done.
      throw new SpecParseError(
        task,
        "`acceptance` must list at least one command — a task without machine-checkable " +
          "criteria can never be verified as done",
      );
    }

    const repos = asStringArray(meta.repos).map(parseRepo);
    if (repos.length === 0) throw new SpecParseError(task, "`repos` must list at least one repo");

    return {
      id: task,
      workspace: asWorkspaceName(meta.workspace),
      goal: goal.trim(),
      repos,
      requires: asStringArray(meta.requires) as readonly Capability[],
      acceptance,
      ...(isTrackerRef(meta.tracker) ? { tracker: meta.tracker } : {}),
    };
  }

  async readState(task: TaskId): Promise<TaskState> {
    const raw = await readFile(join(this.taskDir(task), "state.json"), "utf8");
    return JSON.parse(raw) as TaskState;
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

  async writeQuestion(task: TaskId, index: number, question: string): Promise<void> {
    const dir = join(this.taskDir(task), "questions");
    await mkdir(dir, { recursive: true });
    const name = `${String(index).padStart(3, "0")}-question.md`;
    await writeFile(join(dir, name), `${question.trim()}\n`, "utf8");
  }

  async readAnswer(task: TaskId, index: number): Promise<string | undefined> {
    const name = `${String(index).padStart(3, "0")}-answer.md`;
    const path = join(this.taskDir(task), "questions", name);
    if (!existsSync(path)) return undefined;
    return readFile(path, "utf8");
  }

  /** Commit and push all pending state changes with the supervisor's credential. */
  async commitAndPush(message: string, remote: string, branch: string): Promise<void> {
    await this.git.run("add", "-A", "tasks");
    if (!(await this.git.hasUncommittedChanges())) return;
    await this.git.run("commit", "-m", message);
    await this.git.run("push", remote, `HEAD:${branch}`);
  }

  async pull(remote: string, branch: string): Promise<void> {
    await this.git.run("fetch", remote, branch);
    await this.git.run("reset", "--hard", `${remote}/${branch}`);
  }
}

const isTrackerRef = (value: unknown): value is TrackerRef => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["kind"] === "string" && typeof candidate["id"] === "string";
};
