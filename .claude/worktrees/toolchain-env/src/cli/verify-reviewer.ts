/**
 * Verifies the REVIEWER App — the second identity that approves and merges (§12.1).
 *
 *   npm run verify:reviewer -- --pem ./caterpillar-reviewer.private-key.pem \
 *     --app-id 654321 --repo caesarakalaeii/Caterpillar
 *
 * Checks, in order:
 *   1. the PEM signs a valid App JWT and GitHub reports the App identity
 *   2. it is a DIFFERENT app from the one that opens pull requests — pass
 *      `--author-app-id` to have that asserted rather than eyeballed
 *   3. it is installed on the named repo
 *   4. a token can be minted scoped to that repo with `pull_requests: write` and
 *      `contents: write`, and nothing else
 *
 * What it deliberately does NOT do is approve or merge anything. There is no such thing
 * as a harmless test merge, and an approval left on a real PR is a lie about who read it.
 * The one property that cannot be proven without a live PR — that GitHub counts this
 * app's approval against branch protection — is called out at the end so nobody records
 * a green run here as proof of it.
 *
 * The token is never printed.
 */
import { readFile } from "node:fs/promises";
import { signAppJwt } from "../forge/github-app.ts";

const API_BASE = "https://api.github.com";

interface Args {
  readonly pem: string;
  readonly appId: string;
  readonly repo: string;
  readonly installationId?: string;
  readonly authorAppId?: string;
}

const parseArgs = (argv: readonly string[]): Args => {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === undefined || !key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    map.set(key.slice(2), value);
    i += 1;
  }

  const pem = map.get("pem");
  const appId = map.get("app-id");
  const repo = map.get("repo");
  if (pem === undefined || appId === undefined || repo === undefined) {
    throw new Error(
      "usage: --pem <path> --app-id <id> --repo <owner/name> " +
        "[--installation-id <id>] [--author-app-id <id>]",
    );
  }

  const installationId = map.get("installation-id");
  const authorAppId = map.get("author-app-id");
  return {
    pem,
    appId,
    repo,
    ...(installationId !== undefined ? { installationId } : {}),
    ...(authorAppId !== undefined ? { authorAppId } : {}),
  };
};

const gh = async <T>(route: string, token: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${API_BASE}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${route} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as T;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const pem = await readFile(args.pem, "utf8");
  const name = args.repo.split("/").at(1);
  if (name === undefined) throw new Error("--repo must be owner/name");

  const jwt = signAppJwt(args.appId, pem);
  console.log("✓ signed an App JWT with the reviewer private key");

  const app = await gh<{
    readonly id: number;
    readonly slug: string;
    readonly owner: { readonly login: string };
  }>("/app", jwt);
  console.log(`✓ GitHub accepted it — app '${app.slug}' owned by ${app.owner.login}`);

  if (args.authorAppId !== undefined) {
    if (String(app.id) === args.authorAppId || args.appId === args.authorAppId) {
      // This is the whole point of a second identity. GitHub blocks a pull request's
      // author from approving it, so an approval from the app that opened the PR is
      // rejected — and one that somehow succeeded would mean branch protection was
      // never enforcing anything (DESIGN.md §9.1).
      console.error(
        "✗ this is the SAME app that opens pull requests. Its approval would be " +
          "refused as a self-approval, and the council could never merge. Create a " +
          "separate GitHub App for the reviewer.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`✓ distinct from the authoring app (${args.authorAppId})`);
  }

  const installations = await gh<
    readonly { readonly id: number; readonly account: { readonly login: string } | null }[]
  >("/app/installations", jwt);

  if (installations.length === 0) {
    console.error(
      "✗ the reviewer App is not installed anywhere. It must be installed on the same " +
        "repositories the agent opens PRs against.",
    );
    process.exitCode = 1;
    return;
  }
  for (const installation of installations) {
    console.log(
      `✓ installed on ${installation.account?.login ?? "(unknown)"} — installation id ${installation.id}`,
    );
  }

  const installationId = args.installationId ?? String(installations[0]?.id ?? "");

  const minted = await gh<{
    readonly expires_at: string;
    readonly permissions: Readonly<Record<string, string>>;
    readonly repositories?: readonly { readonly full_name: string }[];
  }>(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({
      repositories: [name],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    }),
  });

  const scoped = minted.repositories?.map((r) => r.full_name).join(", ") ?? "(all)";
  console.log(`✓ minted a token expiring ${minted.expires_at}, scoped to: ${scoped}`);
  console.log(`  granted: ${JSON.stringify(minted.permissions)}`);

  if (minted.permissions["pull_requests"] !== "write") {
    console.error(
      "✗ the installation did not grant `pull_requests: write`. Without it the reviewer " +
        "can neither approve nor merge — grant it on the installation, not the App.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nAll checks passed. The token was never printed.");
  console.log(
    "\nNot verified here, and not verifiable without a real pull request: that GitHub " +
      "counts THIS app's approval towards a required review on your protected branch. " +
      "The first council merge is that test. If it fails, the app is on a bypass list " +
      "or the ruleset requires a code owner it is not.",
  );
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
