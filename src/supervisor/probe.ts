/**
 * Progress evidence gathering. See DESIGN.md §11.1.
 *
 * "Did anything happen?" is answered from the repo, not from the agent's account of
 * itself — an agent going in circles will still narrate progress convincingly.
 *
 * A commit is the strongest signal and the cheapest to check: compare the task
 * branch head against the one recorded at the end of the previous session.
 */
import type { TaskSpec, TaskState } from "../domain/task.ts";
import type { WorktreeManager } from "../workspace/worktree.ts";
import type { ProgressEvidence } from "./progress.ts";

export interface GitProgressProbeOptions {
  readonly worktrees: WorktreeManager;
}

export class GitProgressProbe {
  constructor(private readonly options: GitProgressProbeOptions) {}

  async probe(spec: TaskSpec, state: TaskState): Promise<ProgressEvidence> {
    const repo = spec.repos[0];
    if (repo === undefined) {
      return { committed: false, acceptanceImproved: false, stepCompleted: false };
    }

    const worktree = await this.options.worktrees.ensureWorktree(repo, spec.id);
    const git = this.options.worktrees.gitAt(worktree);
    const head = await git.revParse("HEAD");

    const previous = state.progress.lastHeadOid;
    const committed = head !== undefined && previous !== undefined && head !== previous;

    return {
      // On the first session there is no baseline, so a commit cannot be proven.
      // Recording the head now makes the next session's comparison meaningful.
      committed,
      acceptanceImproved: false,
      stepCompleted: false,
      ...(head !== undefined ? { headOid: head } : {}),
    };
  }
}
