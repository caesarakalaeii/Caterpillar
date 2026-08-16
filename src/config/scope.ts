/**
 * The configured bound on the repos a task may reach. See DESIGN.md §9.1.
 *
 * This exists because `spec.repos` is not a boundary. It is rendered from an issue
 * body, a Discord brainstorm, or a plan the previous agent wrote — every one of them
 * outside the operator's control. Checking a credential request against `spec.repos`
 * compares an attacker-chosen value against an attacker-chosen list.
 *
 * What IS under the operator's control is the workspace profile and the state repo
 * URL, both of which come from the ConfigMap. That is what a `WorkspaceScope` carries,
 * and it is the thing every credential path is checked against.
 */
import type { RepoRef } from "../domain/task.ts";
import type { WorkspaceScope } from "../forge/types.ts";
import { parseStateRepoUrl } from "../state/credential.ts";
import type { StateRepoConfig, WorkspaceProfile } from "./types.ts";

/**
 * The state repo as a ref, when the URL admits one.
 *
 * Tolerant on purpose. `parseStateRepoUrl` requires https because the App token is
 * delivered as a header, but a local development checkout is legitimately a path or an
 * ssh remote. Failing to parse costs the state-repo exclusion, not the host check —
 * and in the cluster the URL is always https, so the exclusion is always present where
 * it matters. Refusing to start would turn a dev-only shape into an outage.
 */
export const stateRepoRef = (config: StateRepoConfig): RepoRef | undefined => {
  try {
    return parseStateRepoUrl(config.url);
  } catch {
    return undefined;
  }
};

/** The bound for one workspace: its own forge host, minus the state repo. */
export const workspaceScopeOf = (
  profile: WorkspaceProfile,
  stateRepo: RepoRef | undefined,
): WorkspaceScope => ({
  host: profile.forge.host,
  ...(stateRepo === undefined ? {} : { stateRepo }),
});
