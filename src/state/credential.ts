/**
 * Credential for the supervisor's own state-repo git calls. See DESIGN.md §9.3.
 *
 * The state repo is where the audit trail lives, so the thing being audited must not
 * be able to write it. That shapes every choice here:
 *
 *   - it is NOT served over the credential socket. That socket exists for the agent's
 *     shell (§9.2); putting the state repo on it would hand the agent the credential
 *     that rewrites its own history.
 *   - it is NOT written into `.git/config`, and NOT passed in argv, where the agent
 *     shares a container and can read `ps`.
 *   - it rides in the environment of the individual git child process, via
 *     `GIT_CONFIG_*` and an `http.extraHeader`. `process.env` never holds it, so the
 *     agent's bash tool does not inherit it.
 *
 * Same posture as §9.2: leak hygiene rather than a wall — same-uid processes can read
 * `/proc/<pid>/environ` while the call is in flight. The real boundary is the token's
 * scope, which is one repo and `contents: write`, nothing else.
 *
 * The token is an installation token, so it expires in an hour and is re-minted on
 * demand. A supervisor that runs for days therefore never holds a long-lived one.
 */
import type { RepoRef } from "../domain/task.ts";
import { GitHubApiError, signAppJwt, type GitHubAppOptions } from "../forge/github-app.ts";
import type { GitEnvProvider } from "./git.ts";

/** Re-mint this long before expiry so a slow push never straddles the boundary. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;

/**
 * Narrower than a task token: the state repo needs commits and nothing else. No
 * pull_requests (there are no PRs against it), no issues, no checks.
 */
const STATE_PERMISSIONS = { contents: "write", metadata: "read" } as const;

interface InstallationTokenResponse {
  readonly token: string;
  readonly expires_at: string;
}

/**
 * Parse a state repo clone URL into a RepoRef.
 *
 * Exported for testing. HTTPS only: the token is delivered as an HTTP header, so an
 * `ssh://`/`git@` remote would silently ignore it and fall back to whatever key the
 * host happens to have — which on a workstation runner is the operator's own.
 */
export const parseStateRepoUrl = (url: string): RepoRef => {
  if (!url.startsWith("https://")) {
    throw new Error(
      `state repo URL must be https so the App token can authenticate it, got '${url}'`,
    );
  }

  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/\.git$/, "").split("/").filter((p) => p.length > 0);
  const owner = parts.at(0);
  const name = parts.at(1);
  if (owner === undefined || name === undefined || parts.length !== 2) {
    throw new Error(`state repo URL must be https://<host>/<owner>/<name>, got '${url}'`);
  }

  return { host: parsed.host, owner, name };
};

/**
 * Build the git environment carrying a token.
 *
 * Exported for testing. `http.extraHeader` with Basic auth is GitHub's documented way
 * to use an installation token, and unlike a credential helper it leaves nothing on
 * disk. `GIT_CONFIG_COUNT` scopes it to this one invocation.
 */
export const tokenGitEnv = (token: string): NodeJS.ProcessEnv => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraheader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  // Never prompt: a wedged supervisor waiting on a terminal that does not exist looks
  // exactly like a hung task.
  GIT_TERMINAL_PROMPT: "0",
});

export class StateRepoCredentials {
  private cached: { readonly token: string; readonly expiresAt: number } | undefined;

  constructor(
    private readonly app: GitHubAppOptions,
    readonly repo: RepoRef,
  ) {}

  /** Use as `new Git(path, process.env, credentials.gitEnv)`. */
  readonly gitEnv: GitEnvProvider = async () => tokenGitEnv(await this.token());

  private async token(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
      return cached.token;
    }

    const jwt = signAppJwt(this.app.appId, this.app.privateKeyPem);
    const route = `/app/installations/${this.app.installationId}/access_tokens`;

    const response = await fetch(`${this.app.apiBase}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repositories: [this.repo.name],
        permissions: STATE_PERMISSIONS,
      }),
    });

    if (!response.ok) {
      // A 422 here almost always means the App is not installed on the state repo —
      // it is a separate repository from the ones tasks touch.
      throw new GitHubApiError(response.status, route, await response.text());
    }

    const body = (await response.json()) as InstallationTokenResponse;
    this.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }
}
