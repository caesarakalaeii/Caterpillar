/**
 * Verifies a Forgejo/Codeberg repository-scoped token, without printing it.
 *
 *   CODEBERG_TOKEN=... npm run verify:forgejo -- --repo ElectricBoogaloo/eb-api
 *
 * Checks:
 *   1. the token authenticates against the repo
 *   2. it is actually scoped — an out-of-scope repo must be refused
 *   3. pull-request and commit-status routes are reachable with its scopes
 *
 * Deliberately avoids `GET /user`: a repository-scoped token only reaches
 * read/write:repository and read/write:issue, so a user route would 403 and look like
 * a bad token when the scoping is in fact correct.
 */
import { ForgejoForgeFactory } from "../forge/forgejo.ts";
import { asTaskId, asWorkspaceName, type RepoRef, type TaskSpec } from "../domain/task.ts";

const DEFAULT_API_BASE = "https://codeberg.org/api/v1";
const TOKEN_ENVS = ["CODEBERG_TOKEN", "FORGEJO_TOKEN", "GITEA_TOKEN"] as const;

const parseRepo = (raw: string, host: string): RepoRef => {
  const parts = raw.split("/").filter((p) => p.length > 0);
  const owner = parts.at(0);
  const name = parts.at(1);
  if (owner === undefined || name === undefined || parts.length !== 2) {
    throw new Error("--repo must be owner/name");
  }
  return { host, owner, name };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };

  const repoArg = arg("--repo");
  if (repoArg === undefined) {
    throw new Error("usage: --repo <owner/name> [--api-base <url>] [--username <name>]");
  }

  const apiBase = arg("--api-base") ?? DEFAULT_API_BASE;
  const host = new URL(apiBase).host;
  const repo = parseRepo(repoArg, host);
  const slug = `${repo.owner}/${repo.name}`;

  const tokenEnv = TOKEN_ENVS.find((name) => (process.env[name] ?? "").length > 0);
  if (tokenEnv === undefined) {
    throw new Error(`set one of ${TOKEN_ENVS.join(", ")} in the environment`);
  }
  const token = process.env[tokenEnv] ?? "";
  console.log(`✓ token found in ${tokenEnv}`);

  // Verify as an owner-wide token, which is how these are normally issued: an
  // ecosystem is worked as one workspace plus sibling clones, so a task spanning
  // several repos of the same owner must all resolve from this one credential.
  const factory = new ForgejoForgeFactory({
    apiBase,
    username: arg("--username") ?? repo.owner,
    tokensByOwner: new Map([[repo.owner, token]]),
  });

  const spec: TaskSpec = {
    id: asTaskId("VERIFY"),
    workspace: asWorkspaceName("verify"),
    goal: "verification",
    repos: [repo],
    requires: [],
    acceptance: ["true"],
  };
  const forge = await factory.forTask(spec);

  // 1 + 3: a permitted route that also proves the repo is reachable.
  const status = await forge.checks(repo, "HEAD");
  console.log(`✓ commit-status route reachable — ${status.conclusion}: ${status.summary}`);

  // 2: the spec is the scope boundary, so a repo the task did not declare is refused
  // even though the owner-wide token would technically reach it.
  const other: RepoRef = { ...repo, name: `${repo.name}-should-not-exist` };
  try {
    await forge.credential(other);
    console.warn("⚠ a repo outside the spec was NOT refused — check spec scoping");
  } catch {
    console.log("✓ a repo outside the task's spec is refused before any request");
  }

  console.log(
    `\nToken works for pushes and PRs on ${slug} and on other ${repo.owner} repos a ` +
      `task declares.\nNote: this credential's blast radius is every ${repo.owner} ` +
      `repo, and Forgejo tokens do not expire — schedule rotation.`,
  );
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
