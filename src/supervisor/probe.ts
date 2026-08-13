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

    // On a first session nothing has recorded a head yet, so the baseline is the point
    // the task branch forked from. Without that fallback the commit that STARTS the work
    // can never be proven and a productive first session is recorded as a stall: SMOKE-1
    // finished with a two-session no-progress streak while its PR sat open, and one more
    // session would have parked it citing "no commit" with a commit on the branch.
    //
    // The fork point is used ONLY as that fallback. Comparing against it forever would
    // make every session after the first commit look productive, and an agent that
    // commits once and then spins would never trip the thrash detector (§11.1).
    const previous =
      state.progress.lastHeadOid ??
      (await this.options.worktrees.branchPoint(worktree));
    const committed = head !== undefined && previous !== undefined && head !== previous;

    return {
      // The head observed now becomes the next session's baseline.
      committed,
      acceptanceImproved: false,
      stepCompleted: false,
      ...(head !== undefined ? { headOid: head } : {}),
      ...(previous !== undefined ? { baselineOid: previous } : {}),
    };
  }
}
