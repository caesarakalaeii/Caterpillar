/**
 * The per-alert remediation policy. See DESIGN.md §20.
 *
 * A firing Alertmanager alert becomes a task only if an operator has said, in advance,
 * what that alert means and how a fix for it is verified. That statement lives in the
 * STATE REPO at `alerts/policy.yaml`, not in this repo and not in a ConfigMap: adding an
 * alert must be a commit to the thing the supervisor already polls, not a redeploy.
 *
 * Pure: no IO, no git, no network. Everything here is decidable from the document alone,
 * which is what makes it testable and what lets the reader (a sibling task) treat a
 * refusal as data rather than as an exception escaping from a file read.
 *
 * There is deliberately NO `namespaces` field. Which namespaces a session may read is
 * supervisor configuration — an operator-set bound on the whole process — not something
 * an entry in a file the alert path consults should be able to widen for itself.
 */
import { parse as parseYaml } from "yaml";
import {
  asWorkspaceName,
  isTaskId,
  KNOWN_CAPABILITIES,
  parseRepoRef,
  type Capability,
  type RepoRef,
  type TaskId,
  type WorkspaceName,
} from "../domain/task.ts";

/** The only `version` this parser understands. Bump deliberately, never silently. */
export const POLICY_VERSION = 1;

export interface AlertPolicyEntry {
  /** Exact match against the alert's `alertname` label. */
  readonly alertname: string;
  readonly workspace: WorkspaceName;
  /** Repos the remediation task may touch. Becomes its token scope (§9.1). */
  readonly repos: readonly RepoRef[];
  /**
   * Commands that must exit 0 before the task can be marked done (§12). Non-empty by
   * construction: a remediation task ends in a pull request like any other, so a policy
   * entry with nothing to run would create a task nothing could ever finish.
   */
  readonly acceptance: readonly string[];
  readonly requires: readonly Capability[];
  /** Prose prepended to the rendered goal — what this alert usually means. */
  readonly goalPrefix?: string;
  /** A runbook URL, surfaced in the goal so the session does not have to find it. */
  readonly runbook?: string;
  /**
   * How many non-terminal tasks this alertname may have at once. One by default: an
   * alert that keeps firing while a fix is in review must not open a second task saying
   * the same thing.
   */
  readonly maxOpenTasks: number;
}

export interface AlertPolicy {
  readonly version: number;
  readonly entries: readonly AlertPolicyEntry[];
}

/** A policy that opts nothing in. What a state repo with no `alerts/` means. */
export const EMPTY_POLICY: AlertPolicy = { version: POLICY_VERSION, entries: [] };

/**
 * A malformed policy document, reported with enough context to fix it.
 *
 * Modelled on `SpecParseError` in `state/store.ts`, and typed for the same reason: the
 * caller is a supervisor loop that must distinguish "the operator wrote this wrong" —
 * which deserves one clear message and no retry — from an IO failure that a later poll
 * might survive. A bare `Error` makes those two indistinguishable at the catch site.
 *
 * The message always names the entry (by alertname when there is one, by index when the
 * entry is broken enough not to have one) and the field, because the operator reading it
 * is looking at a file with several entries in it.
 */
export class PolicyParseError extends Error {
  constructor(detail: string) {
    super(`alerts/policy.yaml is invalid: ${detail}`);
    this.name = "PolicyParseError";
  }
}

/** How an entry is named in an error message before its `alertname` is known to be good. */
const where = (index: number, alertname?: unknown): string =>
  typeof alertname === "string" && alertname.length > 0
    ? `alerts[${index}] (${alertname})`
    : `alerts[${index}]`;

const TOP_LEVEL_KEYS = ["version", "alerts"] as const;

const ENTRY_KEYS = [
  "alertname",
  "workspace",
  "repos",
  "acceptance",
  "requires",
  "goalPrefix",
  "runbook",
  "maxOpenTasks",
] as const;

/**
 * Unknown keys are refused rather than ignored.
 *
 * `acceptence:` is the mistake that matters. Ignored, it produces an entry with no
 * acceptance commands — and since a remediation task's whole completion gate is those
 * commands, the typo would either be caught three layers later or, worse, quietly
 * create tasks nothing can ever mark done. Failing on the typo costs one clear message.
 */
const rejectUnknownKeys = (
  value: Record<string, unknown>,
  known: readonly string[],
  context: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new PolicyParseError(
        `${context} has unknown key \`${key}\` (known keys: ${known.join(", ")}) — ` +
          `check the spelling`,
      );
    }
  }
};

const asMapping = (value: unknown, context: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyParseError(`${context} must be a mapping`);
  }
  return value as Record<string, unknown>;
};

/**
 * Strict list parsing, matching `store.ts` and `intake/spec.ts`.
 *
 * Dropping a non-string entry silently would shrink the completion gate or the token
 * scope, and the realistic way to write one by accident is an unquoted command with a
 * `: ` in it, which YAML reads as a mapping rather than a string.
 */
const strings = (value: unknown, field: string, context: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new PolicyParseError(`${context}: \`${field}\` must be a list`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new PolicyParseError(
        `${context}: \`${field}[${index}]\` must be a string, got ${typeof entry} ` +
          `(${JSON.stringify(entry)}) — quote it if YAML is coercing it`,
      );
    }
    return entry;
  });
};

const optionalString = (
  value: unknown,
  field: string,
  context: string,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PolicyParseError(`${context}: \`${field}\` must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const parseEntry = (raw: unknown, index: number): AlertPolicyEntry => {
  const value = asMapping(raw, where(index));
  rejectUnknownKeys(value, ENTRY_KEYS, where(index, value["alertname"]));

  const context = where(index, value["alertname"]);

  const alertname = value["alertname"];
  if (typeof alertname !== "string" || alertname.trim().length === 0) {
    throw new PolicyParseError(`${context}: \`alertname\` is required and must be a string`);
  }

  const workspace = value["workspace"];
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    throw new PolicyParseError(`${context}: \`workspace\` is required and must be a string`);
  }

  const repoRefs = strings(value["repos"], "repos", context);
  if (repoRefs.length === 0) {
    throw new PolicyParseError(`${context}: \`repos\` must list at least one repository`);
  }
  const repos = repoRefs.map((entry) => {
    const parsed = parseRepoRef(entry);
    if (parsed === undefined) {
      throw new PolicyParseError(
        `${context}: \`repos\` entry '${entry}' is not a repository reference — ` +
          `expected \`owner/name\` or \`host/owner/name\``,
      );
    }
    return parsed;
  });

  // §12 applies to a remediation task unchanged: it ends in a pull request, so the
  // supervisor must have something to run before it can call the work done.
  const acceptance = strings(value["acceptance"], "acceptance", context);
  if (acceptance.length === 0) {
    throw new PolicyParseError(
      `${context}: \`acceptance\` must list at least one command — a remediation task ` +
        `with no machine-checkable criteria can never be verified as done (DESIGN.md §12)`,
    );
  }

  const requires = value["requires"] === undefined
    ? []
    : strings(value["requires"], "requires", context);
  for (const capability of requires) {
    if (!KNOWN_CAPABILITIES.includes(capability as Capability)) {
      // `requires` is the claim predicate (§8). An unknown capability is satisfied by no
      // runner, so a typo here parks the task in the queue forever, looking like a stuck
      // scheduler rather than a spelling mistake.
      throw new PolicyParseError(
        `${context}: \`requires\` entry '${capability}' is not a known capability ` +
          `(${KNOWN_CAPABILITIES.join(", ")}). No runner would ever claim this task.`,
      );
    }
  }

  const maxOpenTasksRaw = value["maxOpenTasks"];
  if (
    maxOpenTasksRaw !== undefined &&
    (typeof maxOpenTasksRaw !== "number" ||
      !Number.isInteger(maxOpenTasksRaw) ||
      maxOpenTasksRaw < 1)
  ) {
    throw new PolicyParseError(
      `${context}: \`maxOpenTasks\` must be a positive integer (got ` +
        `${JSON.stringify(maxOpenTasksRaw)})`,
    );
  }

  const goalPrefix = optionalString(value["goalPrefix"], "goalPrefix", context);
  const runbook = optionalString(value["runbook"], "runbook", context);

  return {
    alertname,
    workspace: asWorkspaceName(workspace),
    repos,
    acceptance,
    requires: requires as readonly Capability[],
    ...(goalPrefix === undefined ? {} : { goalPrefix }),
    ...(runbook === undefined ? {} : { runbook }),
    maxOpenTasks: maxOpenTasksRaw ?? 1,
  };
};

/**
 * `alerts/policy.yaml` → `AlertPolicy`.
 *
 * Throws `PolicyParseError` and nothing else on a bad document. Every caller is expected
 * to turn that into an operator-facing message rather than a stack trace.
 */
export const parsePolicy = (text: string): AlertPolicy => {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new PolicyParseError(
      `not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // An empty file is a policy that opts nothing in, not a malformed one: an operator who
  // has created the file and not yet filled it in should get no alerts, not a loop that
  // logs a parse failure every poll.
  if (document === null || document === undefined) return EMPTY_POLICY;

  const root = asMapping(document, "the document");
  rejectUnknownKeys(root, TOP_LEVEL_KEYS, "the document");

  if (root["version"] !== POLICY_VERSION) {
    throw new PolicyParseError(
      `\`version\` must be ${POLICY_VERSION} (got ${JSON.stringify(root["version"])}) — ` +
        `this supervisor understands version ${POLICY_VERSION} only`,
    );
  }

  const alerts = root["alerts"];
  if (alerts === undefined || alerts === null) return { version: POLICY_VERSION, entries: [] };
  if (!Array.isArray(alerts)) throw new PolicyParseError("`alerts` must be a list");

  const entries = alerts.map(parseEntry);

  // Duplicates are refused rather than last-wins: two entries for one alertname means the
  // operator believes both are in force, and silently honouring one of them would send a
  // task to the wrong workspace with the wrong acceptance commands.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.alertname)) {
      throw new PolicyParseError(
        `\`alertname\` '${entry.alertname}' appears more than once — one entry per alert`,
      );
    }
    seen.add(entry.alertname);
  }

  return { version: POLICY_VERSION, entries };
};

/** The entry governing an alert, or nothing. An unlisted alert is simply not handled. */
export const lookupPolicy = (
  policy: AlertPolicy,
  alertname: string,
): AlertPolicyEntry | undefined => policy.entries.find((e) => e.alertname === alertname);

/** Prefix for every task id this intake path creates. Also the filter for counting them. */
export const ALERT_TASK_PREFIX = "ALERT-";

/**
 * An Alertmanager fingerprint, as it may appear in a task id.
 *
 * Alertmanager renders a fingerprint as lowercase hex, so constraining it here costs
 * nothing real and keeps every id this path produces inside `isTaskId` — which is what
 * stops a hostile or merely surprising webhook payload from choosing a directory name
 * under `tasks/`. Widening `isTaskId` instead would have relaxed the guard for every
 * other intake path to accommodate one.
 */
const FINGERPRINT = /^[0-9a-f]{1,64}$/;

export const isAlertFingerprint = (value: string): boolean => FINGERPRINT.test(value);

/**
 * `ALERT-<fingerprint>` — the task id for one firing alert.
 *
 * Deterministic and derived from the fingerprint alone, which is what makes this path
 * idempotent: Alertmanager re-sends a firing alert for as long as it fires, and an id
 * that varied would create a fresh task on every repeat.
 *
 * Returns undefined rather than throwing on a fingerprint that is not one, so the caller
 * can refuse the payload with a message instead of a stack trace. An invalid id must
 * never reach the store.
 */
export const alertTaskId = (fingerprint: string): TaskId | undefined => {
  if (!isAlertFingerprint(fingerprint)) return undefined;
  const id = `${ALERT_TASK_PREFIX}${fingerprint}`;
  return isTaskId(id) ? id : undefined;
};

/** True when this task id was created by the alert path. */
export const isAlertTaskId = (id: string): boolean => id.startsWith(ALERT_TASK_PREFIX);
