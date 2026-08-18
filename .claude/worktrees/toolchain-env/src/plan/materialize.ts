/**
 * A proposed plan → real tasks. See DESIGN.md §14.3.
 *
 * Pure: no IO, no git, no clock. Everything that decides what gets created and in what
 * order is decidable from the plan alone, which is what makes the dangerous part of this
 * testable — a bug here creates tasks that can never be claimed, or a wave numbering that
 * lets a dependent start before the thing it depends on.
 *
 * Two rules carry the whole file:
 *
 *   `blockedBy` is the authority. `wave` is DERIVED from it, by longest-path layering, and
 *   exists only so a listing reads well and a claim can be ordered without walking the
 *   graph. Anything that changes the edges recomputes the layers.
 *
 *   A cycle is a REJECTED PLAN, not a crash. The agent proposed it, so the agent is told
 *   what it did and asked again — the same round trip a blocking review verdict takes.
 */
import {
  asTaskId,
  type Capability,
  type PlanMembership,
  type ProposedPlan,
  type ProposedTask,
  type RepoRef,
  type TaskId,
  type TaskSpec,
  type WorkspaceName,
} from "../domain/task.ts";

const KNOWN_CAPABILITIES: readonly string[] = [
  "linux",
  "k8s",
  "net",
  "gpu",
  "usb",
  "human-present",
];

export interface MaterialisedTask {
  readonly spec: TaskSpec;
  readonly plan: PlanMembership;
}

export type MaterialiseResult =
  | { readonly kind: "plan"; readonly tasks: readonly MaterialisedTask[] }
  | { readonly kind: "rejected"; readonly reason: string };

export interface MaterialiseOptions {
  readonly parent: TaskId;
  readonly workspace: WorkspaceName;
  /** Repos the brainstorm itself was scoped to — the fallback for a task that names none. */
  readonly defaultRepos: readonly RepoRef[];
}

/** `host/owner/name` or `owner/name`, matching intake and the store. */
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

/**
 * Child ids are positional: `<parent>-01`, `-02`, …
 *
 * Derived from the parent and the index rather than from the title, for the same reason
 * `taskIdFor` is derived from a tracker ref: a title is prose and prose gets edited. They
 * also sort in creation order, which is the tie-break the claim loop falls back on.
 */
export const childId = (parent: TaskId, index: number): TaskId =>
  asTaskId(`${parent}-${String(index + 1).padStart(2, "0")}`);

const reject = (reason: string): MaterialiseResult => ({ kind: "rejected", reason });

export const materialise = (
  plan: ProposedPlan,
  options: MaterialiseOptions,
): MaterialiseResult => {
  if (plan.tasks.length === 0) {
    return reject("The plan contains no tasks. Propose at least one, or say the work is not worth doing.");
  }

  const byLocalId = new Map<string, number>();
  for (const [index, task] of plan.tasks.entries()) {
    if (task.localId.trim().length === 0) return reject("Every task needs a `localId`.");
    if (byLocalId.has(task.localId)) {
      return reject(`Two tasks share the localId \`${task.localId}\`; they must be unique.`);
    }
    byLocalId.set(task.localId, index);
  }

  for (const task of plan.tasks) {
    if (task.acceptance.length === 0) {
      // The same rule intake enforces (§14): a task with no machine-checkable criteria
      // can never satisfy §12, so it could never be marked done. Catching it here means
      // the agent is told while it still has the context to fix it.
      return reject(
        `Task \`${task.localId}\` has no acceptance criteria. Every task needs at least ` +
          `one command that must exit 0, or it can never be verified as done.`,
      );
    }
    for (const capability of task.requires) {
      if (!KNOWN_CAPABILITIES.includes(capability)) {
        return reject(
          `Task \`${task.localId}\` requires '${capability}', which is not a capability any ` +
            `runner advertises (${KNOWN_CAPABILITIES.join(", ")}). It would never be claimed.`,
        );
      }
    }
    for (const dependency of task.dependsOn) {
      if (!byLocalId.has(dependency)) {
        return reject(
          `Task \`${task.localId}\` depends on \`${dependency}\`, which is not in the plan.`,
        );
      }
      if (dependency === task.localId) {
        return reject(`Task \`${task.localId}\` depends on itself.`);
      }
    }
  }

  const waves = layer(plan.tasks);
  if (waves.kind === "cycle") {
    return reject(
      `The plan has a dependency cycle: ${waves.cycle.join(" → ")}. Break it — two tasks ` +
        `that each need the other are one task.`,
    );
  }

  const tasks: MaterialisedTask[] = [];
  for (const [index, task] of plan.tasks.entries()) {
    const repos = resolveRepos(task, options.defaultRepos);
    if (repos === undefined) {
      return reject(
        `Task \`${task.localId}\` names a repo that is not \`owner/name\` or ` +
          `\`host/owner/name\`: ${task.repos.join(", ")}`,
      );
    }

    const id = childId(options.parent, index);
    tasks.push({
      spec: {
        id,
        workspace: options.workspace,
        kind: "implement",
        goal: [`# ${task.title}`, "", task.goal.trim(), "", `Part of plan ${options.parent}.`].join("\n"),
        repos,
        requires: task.requires as readonly Capability[],
        acceptance: task.acceptance,
      },
      plan: {
        parent: options.parent,
        wave: waves.waves[index] ?? 0,
        blockedBy: task.dependsOn.map((local) => childId(options.parent, byLocalId.get(local) ?? 0)),
      },
    });
  }

  return { kind: "plan", tasks };
};

const resolveRepos = (
  task: ProposedTask,
  fallback: readonly RepoRef[],
): readonly RepoRef[] | undefined => {
  if (task.repos.length === 0) return fallback.length > 0 ? fallback : undefined;

  const parsed: RepoRef[] = [];
  for (const raw of task.repos) {
    const repo = parseRepo(raw);
    if (repo === undefined) return undefined;
    parsed.push(repo);
  }
  return parsed;
};

export type LayerResult =
  | { readonly kind: "waves"; readonly waves: readonly number[] }
  | { readonly kind: "cycle"; readonly cycle: readonly string[] };

/**
 * Assign each task a wave: 0 when nothing blocks it, otherwise one past its latest blocker.
 *
 * LONGEST path, not shortest. A task blocked by something in wave 0 and something in wave
 * 2 belongs in wave 3, and taking the shortest would put it in 1 — where it would be
 * claimed alongside a dependency that has not run. The wave is a scheduling hint, but a
 * wrong one invites exactly the parallelism it exists to make safe.
 */
export const layer = (
  tasks: readonly { readonly localId: string; readonly dependsOn: readonly string[] }[],
): LayerResult => {
  const index = new Map(tasks.map((task, i) => [task.localId, i]));
  const waves = new Array<number>(tasks.length).fill(-1);
  // Depth-first with an explicit visiting set, so the cycle can be NAMED rather than
  // reported as "there is one somewhere".
  const visiting: string[] = [];
  const done = new Set<string>();

  const visit = (localId: string): number | readonly string[] => {
    if (done.has(localId)) return waves[index.get(localId) ?? 0] ?? 0;

    const seen = visiting.indexOf(localId);
    if (seen !== -1) return [...visiting.slice(seen), localId];

    visiting.push(localId);
    const position = index.get(localId);
    const task = position === undefined ? undefined : tasks[position];

    let wave = 0;
    for (const dependency of task?.dependsOn ?? []) {
      const resolved = visit(dependency);
      if (Array.isArray(resolved)) return resolved;
      wave = Math.max(wave, (resolved as number) + 1);
    }

    visiting.pop();
    done.add(localId);
    if (position !== undefined) waves[position] = wave;
    return wave;
  };

  for (const task of tasks) {
    const result = visit(task.localId);
    if (Array.isArray(result)) return { kind: "cycle", cycle: result };
  }

  return { kind: "waves", waves };
};

/**
 * Recompute waves for a set of already-materialised tasks.
 *
 * Used after a plan revision, and cheap enough to run whenever the edges move. Ids that
 * are not in the set are treated as wave 0 — a blocker outside the plan (a task that was
 * already `done` and removed, say) does not push its dependents down a layer.
 */
export const relayer = (
  tasks: readonly { readonly id: TaskId; readonly blockedBy: readonly TaskId[] }[],
): ReadonlyMap<TaskId, number> => {
  const result = layer(
    tasks.map((task) => ({
      localId: task.id,
      dependsOn: task.blockedBy.filter((id) => tasks.some((t) => t.id === id)),
    })),
  );

  const waves = new Map<TaskId, number>();
  if (result.kind === "cycle") {
    // Should be unreachable: every path into this validated the graph first. Falling back
    // to wave 0 keeps everything claimable rather than wedging the whole plan.
    for (const task of tasks) waves.set(task.id, 0);
    return waves;
  }

  for (const [i, task] of tasks.entries()) waves.set(task.id, result.waves[i] ?? 0);
  return waves;
};
