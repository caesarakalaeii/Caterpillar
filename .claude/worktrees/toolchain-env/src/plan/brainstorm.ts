/**
 * Starting a brainstorm. See DESIGN.md §14.3.
 *
 * Pure: everything that decides what a brainstorm task IS, decided from the request
 * alone. The IO — creating the thread, writing the state repo — belongs to the bridge and
 * the loop respectively, and neither of them should be where the id scheme lives.
 */
import {
  asTaskId,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type WorkspaceName,
} from "../domain/task.ts";
import type { WorkspaceProfile } from "../config/types.ts";

/**
 * A brainstorm's id is its Discord thread id.
 *
 * Globally unique without coordination, collision-free across runners, and its own
 * reverse index: given a message in a thread, the task it belongs to is derivable without
 * a lookup table. The same discipline as `taskIdFor` (§14) — derived from something
 * external and immutable, never from a title a human will edit.
 */
export const brainstormId = (threadId: string): TaskId => asTaskId(`BS-${threadId}`);

/** `owner/name` or `host/owner/name`. */
export const parseRepo = (raw: string): RepoRef | undefined => {
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

/**
 * Which workspace a repo belongs to.
 *
 * Matched on host and owner, because that is what a workspace actually is: one forge,
 * one owner, one credential bundle (§3.1). A single configured workspace is used as the
 * fallback — with only one there is nothing to disambiguate, and refusing would make the
 * common setup the awkward one.
 */
export const resolveWorkspace = (
  workspaces: ReadonlyMap<WorkspaceName, WorkspaceProfile>,
  repo: RepoRef,
): WorkspaceProfile | undefined => {
  for (const profile of workspaces.values()) {
    if (profile.forge.host === repo.host && profile.forge.owner === repo.owner) return profile;
  }
  return workspaces.size === 1 ? [...workspaces.values()][0] : undefined;
};

/**
 * The spec for a brainstorm task.
 *
 * `acceptance` is empty, which every other path refuses. It is allowed here and only
 * here: a brainstorm produces a plan rather than a change, so §12's gates have nothing to
 * run, and its gate is the review council's verdict on that plan instead (§14.3).
 */
export const brainstormSpec = (options: {
  readonly id: TaskId;
  readonly workspace: WorkspaceName;
  readonly topic: string;
  readonly repo: RepoRef;
  readonly author: string;
}): TaskSpec => ({
  id: options.id,
  workspace: options.workspace,
  kind: "brainstorm",
  goal: [
    `# ${options.topic.split("\n")[0] ?? options.topic}`,
    "",
    options.topic.trim(),
    "",
    `Raised by ${options.author} in Discord. Refine it with them, in the thread this task ` +
      `was created from, and end with \`submit_plan\`.`,
  ].join("\n"),
  repos: [options.repo],
  requires: [],
  acceptance: [],
});
