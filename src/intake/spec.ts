/**
 * Tracker item → `TaskSpec`. See DESIGN.md §14.
 *
 * Pure: no IO, no git, no network. Everything here is decidable from the item alone,
 * which is what makes intake's one dangerous property testable — a bug that produces a
 * non-deterministic id would create a fresh duplicate task on every poll.
 *
 * The contract with a human is a fenced `agent` block in the item body:
 *
 * ```agent
 * repos:
 *   - owner/name
 * requires:
 *   - linux
 * acceptance:
 *   - "npm test"
 * ```
 *
 * A fenced block rather than YAML front matter, because the body is not ours: GitHub
 * renders a leading `---` as a horizontal rule, and a Vikunja description arrives as
 * HTML stripped back to text (§9.5), where front matter does not survive as front
 * matter. A fenced block is unambiguous in both and stays legible to the person writing
 * the issue.
 */
import { parse as parseYaml } from "yaml";
import {
  asTaskId,
  KNOWN_CAPABILITIES,
  type Capability,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type TrackerRef,
  type WorkspaceName,
} from "../domain/task.ts";
import type { TrackerItem } from "../tracker/types.ts";

/**
 * Every fenced block in the body, with its info string and its contents.
 *
 * Matched permissively so a trailing space cannot hide a block, and scanned as a list
 * rather than assuming the first fence is ours — an issue body often contains example
 * code alongside the configuration.
 */
const FENCED = /^[ \t]*```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/**
 * Locate the `agent` block, accepting the marker on the fence line OR as the first line
 * inside it.
 *
 * ```` ```agent ```` is the natural markdown form and what GitHub users will write. It is
 * NOT expressible in Vikunja: TipTap's code block carries a language attribute, not
 * arbitrary fence text, so the marker can only be the first line of the content. Accepting
 * both is what makes one documented contract work on both trackers.
 */
const findAgentBlock = (
  body: string,
): { readonly yaml: string; readonly matched: string } | undefined => {
  // `matchAll` on a sticky/global regex needs a fresh lastIndex per call; `matchAll`
  // handles that internally, but the literal is shared, so never call `exec` on it.
  for (const match of body.matchAll(FENCED)) {
    const [matched, info = "", contents = ""] = match;
    if (info.toLowerCase() === "agent") return { yaml: contents, matched };

    const newline = contents.indexOf("\n");
    const firstLine = (newline === -1 ? contents : contents.slice(0, newline)).trim();
    if (firstLine.toLowerCase() === "agent") {
      return { yaml: newline === -1 ? "" : contents.slice(newline + 1), matched };
    }
  }
  return undefined;
};

/** How a human is told what to write. Repeated verbatim into the tracker comment. */
const TEMPLATE = [
  "```agent",
  "repos:",
  "  - owner/name",
  "acceptance:",
  '  - "the command that must exit 0"',
  "```",
].join("\n");

export type IngestResult =
  | { readonly kind: "spec"; readonly spec: TaskSpec }
  | { readonly kind: "rejected"; readonly reason: string };

export interface RenderOptions {
  readonly workspace: WorkspaceName;
  /**
   * The repo the item itself lives in, when the tracker has one. Used only as the
   * fallback for an undeclared `repos` — a GitHub issue about a repo almost always
   * means that repo, while a Vikunja task has none and must say.
   */
  readonly defaultRepo?: RepoRef;
}

/**
 * Reduce tracker-supplied text to one safe path segment.
 *
 * The id becomes a directory name under `tasks/`, so a separator or a `..` surviving
 * here would let a tracker item write outside the task tree. Collapsing everything that
 * is not alphanumeric also makes the id stable against cosmetic renames.
 */
const segment = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const PREFIX: Record<string, string> = { "github-issues": "GH", vikunja: "VK" };

/**
 * Deterministic id for a tracker item — the whole basis of intake's idempotency.
 *
 * The ingester skips an item whose task directory already exists, and intake runs on
 * every poll, so anything time- or order-dependent here would mean a new task every 30
 * seconds. Derived from the ref alone, never from the title, which humans edit.
 */
export const taskIdFor = (ref: TrackerRef): TaskId => {
  const prefix = PREFIX[ref.kind] ?? segment(ref.kind).toUpperCase();
  const parts = [prefix, ...(ref.container === undefined ? [] : [segment(ref.container)]), segment(ref.id)];
  return asTaskId(parts.filter((p) => p.length > 0).join("-"));
};

/** `host/owner/name` or `owner/name` (host defaults to github.com). */
const parseRepo = (raw: string): RepoRef | undefined => {
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length === 3) {
    const [host, owner, name] = parts as [string, string, string];
    return { host, owner, name };
  }
  if (parts.length === 2) {
    const [owner, name] = parts as [string, string];
    return { host: "github.com", owner, name };
  }
  return undefined;
};

const reject = (reason: string): IngestResult => ({ kind: "rejected", reason });

interface AgentBlock {
  readonly repos?: unknown;
  readonly requires?: unknown;
  readonly acceptance?: unknown;
}

/**
 * Strict list parsing, matching `store.ts`.
 *
 * Filtering a non-string entry would shrink the completion gate or the token scope
 * silently. It also has to agree with `readSpec`: intake accepting what the store later
 * refuses would write a task that can never be read, which is worse than never creating
 * it — the queue would carry an item nothing can claim and nothing can explain.
 */
const strings = (value: unknown, field: string): readonly string[] | string => {
  if (!Array.isArray(value)) return `\`${field}\` must be a list`;
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return (
        `\`${field}[${index}]\` must be a string, got ${typeof entry} ` +
        `(${JSON.stringify(entry)}) — quote it if YAML is coercing it`
      );
    }
    out.push(entry);
  }
  return out;
};

export const renderSpec = (item: TrackerItem, options: RenderOptions): IngestResult => {
  const found = findAgentBlock(item.body);
  if (found === undefined) {
    return reject(
      `No \`agent\` block found. Add one so the supervisor knows how to verify the ` +
        `work — a task without machine-checkable acceptance criteria can never be ` +
        `marked done (DESIGN.md §12):\n\n${TEMPLATE}`,
    );
  }

  let block: AgentBlock | null;
  try {
    block = parseYaml(found.yaml) as AgentBlock | null;
  } catch (error) {
    return reject(
      `The \`agent\` block is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return reject(`The \`agent\` block must be a mapping:\n\n${TEMPLATE}`);
  }

  if (block.acceptance === undefined) {
    return reject(
      `The \`agent\` block has no \`acceptance\`. List at least one command that must ` +
        `exit 0; the supervisor runs them itself, because an agent cannot grade its own ` +
        `homework (DESIGN.md §12):\n\n${TEMPLATE}`,
    );
  }
  const acceptance = strings(block.acceptance, "acceptance");
  if (typeof acceptance === "string") return reject(acceptance);
  if (acceptance.length === 0) {
    return reject("`acceptance` is empty — list at least one command that must exit 0.");
  }

  const declaredRepos = block.repos === undefined ? undefined : strings(block.repos, "repos");
  if (typeof declaredRepos === "string") return reject(declaredRepos);

  let repos: readonly RepoRef[];
  if (declaredRepos === undefined || declaredRepos.length === 0) {
    if (options.defaultRepo === undefined) {
      return reject(
        "`repos` is required for this tracker: the item is not attached to a repository, " +
          "so there is nothing to infer. List `owner/name`, or `host/owner/name` for a " +
          "forge other than github.com.",
      );
    }
    repos = [options.defaultRepo];
  } else {
    const parsed: RepoRef[] = [];
    for (const raw of declaredRepos) {
      const repo = parseRepo(raw);
      if (repo === undefined) {
        return reject(
          `\`repos\` entry '${raw}' is not a repository reference — expected ` +
            `\`owner/name\` or \`host/owner/name\`.`,
        );
      }
      parsed.push(repo);
    }
    repos = parsed;
  }

  const declaredRequires = block.requires === undefined ? [] : strings(block.requires, "requires");
  if (typeof declaredRequires === "string") return reject(declaredRequires);
  for (const entry of declaredRequires) {
    if (!KNOWN_CAPABILITIES.includes(entry as Capability)) {
      // `requires` is the claim predicate (§8). An unknown capability is satisfied by no
      // runner, so a typo here parks the task in the queue forever looking like a stuck
      // scheduler rather than a spelling mistake.
      return reject(
        `\`requires\` entry '${entry}' is not a known capability ` +
          `(${KNOWN_CAPABILITIES.join(", ")}). No runner would ever claim this task.`,
      );
    }
  }

  // The block is configuration, not instruction: left in the goal it reads as a checklist
  // the agent may edit or reinterpret, and the acceptance commands are not its to change.
  const prose = item.body.replace(found.matched, "").replace(/\n{3,}/g, "\n\n").trim();

  return {
    kind: "spec",
    spec: {
      id: taskIdFor(item.ref),
      workspace: options.workspace,
      goal: [`# ${item.title}`, "", prose, "", `Tracker item: ${item.url}`].join("\n").trim(),
      repos,
      requires: declaredRequires as readonly Capability[],
      acceptance,
      tracker: item.ref,
    },
  };
};
