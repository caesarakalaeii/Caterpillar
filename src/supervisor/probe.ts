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
  private readonly options: GitProgressProbeOptions;

  constructor(options: GitProgressProbeOptions) {
    this.options = options;
  }

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
    const forkPoint = await this.options.worktrees.branchPoint(worktree);
    const previous = state.progress.lastHeadOid ?? forkPoint;
    const committed = head !== undefined && previous !== undefined && head !== previous;

    // Against the FORK POINT, not against `previous`: this is the standing total the
    // journal reports (`commitNote`), and a session resuming a branch needs to know that
    // eighteen commits are on it even when this session added none of them. Measuring from
    // the previous head would answer zero on exactly those sessions — which is what GH-96's
    // journal already said, four times, while the work sat on the branch.
    //
    // Counted only with a fork point. `commitsSince` answers with nothing rather than
    // throwing on a base the worktree does not carry, so passing a missing base would turn
    // "cannot tell" into "nothing there" — the one reading a resumed session must never be
    // given.
    const commits =
      forkPoint === undefined
        ? undefined
        : (await this.options.worktrees.commitsSince(worktree, forkPoint)).length;

    return {
      // The head observed now becomes the next session's baseline.
      committed,
      acceptanceImproved: false,
      stepCompleted: false,
      ...(head !== undefined ? { headOid: head } : {}),
      ...(previous !== undefined ? { baselineOid: previous } : {}),
      ...(commits !== undefined ? { commits } : {}),
    };
  }
}
