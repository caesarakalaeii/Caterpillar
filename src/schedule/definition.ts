/**
 * `schedules/<id>.yaml` — one scheduled unit of work. See DESIGN.md §22.
 *
 * Pure: no IO, no git, no network. Everything about a schedule is decidable from the
 * document alone, which is what lets the intake pass refuse a malformed one at the moment
 * it is committed rather than at the moment it would have fired.
 *
 * IN THE STATE REPO, not in this repo and not in a ConfigMap, for the reason
 * `alerts/policy.yaml` gives (§20): adding scheduled work must be a commit to the thing
 * the supervisor already polls — reviewable, revertable, live on the next cycle — rather
 * than a redeploy. The supervisor never writes one; there is no `writeSchedule`.
 *
 * ONE FILE PER SCHEDULE rather than one list, unlike the alert policy. Two reasons, and
 * both come from what an operator does with these: a schedule is edited on its own and a
 * diff naming the file says which one changed, and a malformed schedule then costs itself
 * alone. A single document would make one bad cron expression refuse every schedule in
 * the fleet, which is the failure mode the per-file layout exists to avoid.
 */
import { parse as parseYaml } from "yaml";
import { isTimeZone } from "../digest/day.ts";
import {
  asTaskId,
  asWorkspaceName,
  isTaskId,
  KNOWN_CAPABILITIES,
  parseRepoRef,
  type Capability,
  type RepoRef,
  type TaskId,
  type WorkspaceName,
} from "../domain/task.ts";
import { isOccurrenceId, parseCron, type ScheduleTrigger } from "./occurrence.ts";

/** The only `version` this parser understands. Bump deliberately, never silently. */
export const SCHEDULE_VERSION = 1;

/** Prefix for every task id this intake path creates. Also the filter for counting them. */
export const SCHEDULE_TASK_PREFIX = "SCHED-";

/**
 * A bounded command run before a session is started (§22).
 *
 * The cheap answer to the residual §11.1 admits: work whose only blocker is external state
 * currently costs a whole session to discover that there was nothing to do. Exit 0 and the
 * occurrence becomes a task; anything else records a skipped occurrence and spends no
 * session at all.
 */
export interface Precheck {
  /** Run in the task's toolchain environment, in the first repo's worktree. */
  readonly command: string;
  /**
   * Ceiling on the command. A precheck exists to be cheaper than a session, so one that
   * can run for an hour defeats its own purpose — and it runs on the housekeeping loop,
   * which everything else on that loop is waiting for.
   */
  readonly timeoutSeconds: number;
}

/** How long a precheck may run when the schedule does not say. */
export const DEFAULT_PRECHECK_TIMEOUT_SECONDS = 120;

/** The most a schedule may ask for. See `precheckTimeout` for why there is a ceiling. */
export const MAX_PRECHECK_TIMEOUT_SECONDS = 600;

export interface Schedule {
  /** The file's own name without its extension. Becomes part of every task id it creates. */
  readonly id: string;
  readonly version: number;
  readonly trigger: ScheduleTrigger;
  readonly workspace: WorkspaceName;
  /** Repos the tasks may touch. Becomes their token scope (§9.1). */
  readonly repos: readonly RepoRef[];
  /** The goal handed to each session, verbatim. */
  readonly prompt: string;
  /**
   * Commands that must exit 0 before a task from this schedule can be marked done (§12).
   * Non-empty by construction: a schedule that cannot express machine-checkable completion
   * may not exist.
   */
  readonly acceptance: readonly string[];
  readonly requires: readonly Capability[];
  /** Absent means every occurrence becomes a task. */
  readonly precheck?: Precheck;
  /**
   * Whether occurrences fire. True unless the file says otherwise.
   *
   * A switch rather than "delete the file", because deleting it loses the prompt and the
   * acceptance commands someone wrote and makes turning the schedule back on a rewrite.
   */
  readonly enabled: boolean;
  /**
   * How many non-terminal tasks this schedule may have at once. One by default: a weekly
   * audit whose last task is still in review must not open a second one saying the same
   * thing. `maxOpenTasks` in `alerts/policy.yaml`, for the identical reason (§20).
   */
  readonly maxOpenTasks: number;
}

/**
 * A malformed schedule, reported with enough context to fix it.
 *
 * Typed like `PolicyParseError`, and for the reason recorded there: the caller must tell
 * "the operator wrote this wrong" — one clear message, shown on `/intake`, no retry — from
 * an IO failure a later poll might survive.
 */
export class ScheduleParseError extends Error {
  /** The schedule this is about, so a page can name it without parsing the message. */
  readonly schedule: string;

  constructor(schedule: string, detail: string) {
    super(`schedules/${schedule}.yaml is invalid: ${detail}`);
    this.name = "ScheduleParseError";
    this.schedule = schedule;
  }
}

/**
 * A schedule id: the file name, a task id component and a git ref component.
 *
 * Narrower than `isTaskId` deliberately. This is a name a human types into a file name, so
 * there is no cost to requiring it be lowercase-ish and separator-free — and it has to
 * survive being concatenated with an occurrence id, so a dot or a slash in it would make
 * `SCHED-<id>-<occurrence>` ambiguous or unsafe.
 */
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const isScheduleId = (value: string): boolean =>
  SCHEDULE_ID.test(value) && value.length <= 64;

const TOP_LEVEL_KEYS = [
  "version",
  "trigger",
  "workspace",
  "repos",
  "prompt",
  "acceptance",
  "requires",
  "precheck",
  "enabled",
  "maxOpenTasks",
] as const;

const TRIGGER_KEYS = ["cron", "timezone"] as const;

const PRECHECK_KEYS = ["command", "timeoutSeconds"] as const;

const rejectUnknownKeys = (
  schedule: string,
  value: Record<string, unknown>,
  known: readonly string[],
  context: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new ScheduleParseError(
        schedule,
        `${context} has unknown key \`${key}\` (known keys: ${known.join(", ")}) — ` +
          `check the spelling`,
      );
    }
  }
};

const asMapping = (
  schedule: string,
  value: unknown,
  context: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleParseError(schedule, `${context} must be a mapping`);
  }
  return value as Record<string, unknown>;
};

/**
 * Strict list parsing, matching `remediation/policy.ts` and `state/store.ts`.
 *
 * Dropping a non-string entry silently would shrink the completion gate or the token
 * scope, and the realistic way to write one by accident is an unquoted command with a
 * `: ` in it, which YAML reads as a mapping rather than a string.
 */
const strings = (
  schedule: string,
  value: unknown,
  field: string,
): readonly string[] => {
  // An absent key and an empty list are the same thing to this function, so the caller
  // can answer both with the message that says what the field is FOR — `repos` and
  // `acceptance` are each required for a reason worth stating, and "must be a list" says
  // none of it. YAML reads a key with nothing after it as null, which is the shape an
  // operator produces by deleting the entries and leaving the heading.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ScheduleParseError(schedule, `\`${field}\` must be a list`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new ScheduleParseError(
        schedule,
        `\`${field}[${index}]\` must be a string, got ${typeof entry} ` +
          `(${JSON.stringify(entry)}) — quote it if YAML is coercing it`,
      );
    }
    return entry;
  });
};

const requiredString = (
  schedule: string,
  value: unknown,
  field: string,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScheduleParseError(
      schedule,
      `\`${field}\` is required and must be a non-empty string`,
    );
  }
  return value.trim();
};

const trigger = (schedule: string, raw: unknown): ScheduleTrigger => {
  const value = asMapping(schedule, raw, "`trigger`");
  rejectUnknownKeys(schedule, value, TRIGGER_KEYS, "`trigger`");

  const cron = requiredString(schedule, value["cron"], "trigger.cron");
  if (parseCron(cron) === undefined) {
    throw new ScheduleParseError(
      schedule,
      `\`trigger.cron\` '${cron}' is not a cron expression that can fire — five fields ` +
        `(minute hour day-of-month month day-of-week), with \`*\`, lists, ranges and ` +
        `steps. A schedule that never fires is indistinguishable from one nobody is polling`,
    );
  }

  const timeZone = requiredString(schedule, value["timezone"], "trigger.timezone");
  if (!isTimeZone(timeZone)) {
    throw new ScheduleParseError(
      schedule,
      `\`trigger.timezone\` '${timeZone}' is not an IANA zone name — it must be ` +
        `something like 'Europe/Berlin' or 'UTC'. A fixed offset is refused because it ` +
        `is an hour wrong for seven months a year and says nothing about it (§19)`,
    );
  }

  return { cron, timeZone };
};

const precheck = (schedule: string, raw: unknown): Precheck => {
  const value = asMapping(schedule, raw, "`precheck`");
  rejectUnknownKeys(schedule, value, PRECHECK_KEYS, "`precheck`");

  const command = requiredString(schedule, value["command"], "precheck.command");

  const declared = value["timeoutSeconds"];
  if (declared === undefined) {
    return { command, timeoutSeconds: DEFAULT_PRECHECK_TIMEOUT_SECONDS };
  }
  if (
    typeof declared !== "number" ||
    !Number.isInteger(declared) ||
    declared < 1 ||
    declared > MAX_PRECHECK_TIMEOUT_SECONDS
  ) {
    // Capped rather than clamped: an operator who wrote an hour meant a session, not a
    // precheck, and running it on the housekeeping loop would stall everything else that
    // loop is responsible for — the chat drain, intake, the digest.
    throw new ScheduleParseError(
      schedule,
      `\`precheck.timeoutSeconds\` must be an integer between 1 and ` +
        `${MAX_PRECHECK_TIMEOUT_SECONDS} (got ${JSON.stringify(declared)}). A precheck ` +
        `exists to be cheaper than a session; a long one defeats its own purpose`,
    );
  }
  return { command, timeoutSeconds: declared };
};

/**
 * `schedules/<id>.yaml` → `Schedule`.
 *
 * `id` is the file's own name, supplied by the caller rather than read from the document:
 * a name that lives in two places can disagree with itself, and the file name is the one
 * a human sees in a diff.
 *
 * Throws `ScheduleParseError` and nothing else on a bad document. Every caller turns that
 * into an operator-facing message rather than a stack trace.
 */
export const parseSchedule = (id: string, text: string): Schedule => {
  if (!isScheduleId(id)) {
    throw new ScheduleParseError(
      id,
      `'${id}' is not a schedule identifier — letters, digits, \`-\` and \`_\` only, ` +
        `starting with a letter or digit. It becomes a task id and a git ref component`,
    );
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new ScheduleParseError(
      id,
      `not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // An empty file is a mistake here, unlike an empty `alerts/policy.yaml`: somebody
  // created a schedule file, so they meant to schedule something.
  if (document === null || document === undefined) {
    throw new ScheduleParseError(id, "the file is empty");
  }

  const root = asMapping(id, document, "the document");
  rejectUnknownKeys(id, root, TOP_LEVEL_KEYS, "the document");

  if (root["version"] !== SCHEDULE_VERSION) {
    throw new ScheduleParseError(
      id,
      `\`version\` must be ${SCHEDULE_VERSION} (got ${JSON.stringify(root["version"])}) — ` +
        `this supervisor understands version ${SCHEDULE_VERSION} only`,
    );
  }

  const repoRefs = strings(id, root["repos"], "repos");
  if (repoRefs.length === 0) {
    throw new ScheduleParseError(id, "`repos` must list at least one repository");
  }
  const repos = repoRefs.map((entry) => {
    const parsed = parseRepoRef(entry);
    if (parsed === undefined) {
      throw new ScheduleParseError(
        id,
        `\`repos\` entry '${entry}' is not a repository reference — expected ` +
          `\`owner/name\` or \`host/owner/name\``,
      );
    }
    return parsed;
  });

  const acceptance = strings(id, root["acceptance"], "acceptance");
  if (acceptance.length === 0) {
    throw new ScheduleParseError(
      id,
      "`acceptance` must list at least one command — a schedule that cannot express " +
        "machine-checkable completion may not exist, because the tasks it creates could " +
        "never be verified as done (DESIGN.md §12)",
    );
  }

  const requires = strings(id, root["requires"], "requires");
  for (const capability of requires) {
    if (!KNOWN_CAPABILITIES.includes(capability as Capability)) {
      // `requires` is the claim predicate (§8). An unknown capability is satisfied by no
      // runner, so a typo parks every task this schedule creates in the queue forever,
      // looking like a stuck scheduler rather than a spelling mistake.
      throw new ScheduleParseError(
        id,
        `\`requires\` entry '${capability}' is not a known capability ` +
          `(${KNOWN_CAPABILITIES.join(", ")}). No runner would ever claim these tasks.`,
      );
    }
  }

  const maxOpenTasks = root["maxOpenTasks"];
  if (
    maxOpenTasks !== undefined &&
    (typeof maxOpenTasks !== "number" || !Number.isInteger(maxOpenTasks) || maxOpenTasks < 1)
  ) {
    throw new ScheduleParseError(
      id,
      `\`maxOpenTasks\` must be a positive integer (got ${JSON.stringify(maxOpenTasks)})`,
    );
  }

  const enabled = root["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ScheduleParseError(id, "`enabled` must be true or false");
  }

  return {
    id,
    version: SCHEDULE_VERSION,
    trigger: trigger(id, root["trigger"]),
    workspace: asWorkspaceName(requiredString(id, root["workspace"], "workspace")),
    repos,
    prompt: requiredString(id, root["prompt"], "prompt"),
    acceptance,
    requires: requires as readonly Capability[],
    ...(root["precheck"] === undefined ? {} : { precheck: precheck(id, root["precheck"]) }),
    enabled: enabled ?? true,
    maxOpenTasks: maxOpenTasks ?? 1,
  };
};

/**
 * `SCHED-<schedule>-<occurrence>` — the task id for one occurrence of one schedule.
 *
 * Derived from the two of them and nothing else, which is what makes this path idempotent:
 * two runners that both decide 09:00 is due compute the same directory under `tasks/`, so
 * the loser of the claim race cannot create a second task for the same morning.
 *
 * Returns undefined rather than throwing on inputs that are not those, so a caller refuses
 * with a message instead of a stack trace. An invalid id must never reach the store.
 */
export const scheduleTaskId = (schedule: string, occurrence: string): TaskId | undefined => {
  if (!isScheduleId(schedule) || !isOccurrenceId(occurrence)) return undefined;
  const id = `${SCHEDULE_TASK_PREFIX}${schedule}-${occurrence}`;
  return isTaskId(id) ? asTaskId(id) : undefined;
};

/** True when this task id was created by the schedule path. */
export const isScheduleTaskId = (id: string): boolean => id.startsWith(SCHEDULE_TASK_PREFIX);
