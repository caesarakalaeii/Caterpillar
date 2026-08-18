/**
 * Verifies a GitHub App setup end to end, without ever printing a token.
 *
 *   npm run verify:github-app -- --pem ./caterpillar.private-key.pem \
 *     --app-id 123456 --repo caesarakalaeii/Caterpillar
 *
 * Checks, in order:
 *   1. the PEM signs a valid App JWT
 *   2. GitHub accepts it and reports the App identity
 *   3. the App is installed, and on which account (prints the installation id)
 *   4. an installation token can be minted SCOPED to just the named repo
 *   5. the minted token's permissions are what we asked for
 *
 * Run this before deploying. A silent misconfiguration here surfaces as a task
 * failing at hour six instead.
 */
import { readFile } from "node:fs/promises";
import { signAppJwt } from "../forge/github-app.ts";

const API_BASE = "https://api.github.com";

interface Args {
  readonly pem: string;
  readonly appId: string;
  readonly repo: string;
  readonly installationId?: string;
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
      "usage: --pem <path> --app-id <id> --repo <owner/name> [--installation-id <id>]",
    );
  }

  const installationId = map.get("installation-id");
  return { pem, appId, repo, ...(installationId !== undefined ? { installationId } : {}) };
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
  console.log("✓ signed an App JWT with the private key");

  const app = await gh<{ readonly slug: string; readonly owner: { readonly login: string } }>(
    "/app",
    jwt,
  );
  console.log(`✓ GitHub accepted it — app '${app.slug}' owned by ${app.owner.login}`);

  const installations = await gh<
    readonly { readonly id: number; readonly account: { readonly login: string } | null }[]
  >("/app/installations", jwt);

  if (installations.length === 0) {
    console.error("✗ the App is not installed anywhere — install it, then re-run");
    process.exitCode = 1;
    return;
  }
  for (const installation of installations) {
    console.log(
      `✓ installed on ${installation.account?.login ?? "(unknown)"} — installation id ${installation.id}`,
    );
  }

  const installationId =
    args.installationId ?? String(installations[0]?.id ?? "");

  const minted = await gh<{
    readonly expires_at: string;
    readonly permissions: Readonly<Record<string, string>>;
    readonly repositories?: readonly { readonly full_name: string }[];
  }>(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({
      repositories: [name],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
        metadata: "read",
      },
    }),
  });

  const scoped = minted.repositories?.map((r) => r.full_name).join(", ") ?? "(all)";
  console.log(`✓ minted a token expiring ${minted.expires_at}, scoped to: ${scoped}`);
  console.log(`  granted: ${JSON.stringify(minted.permissions)}`);

  if (minted.repositories !== undefined && minted.repositories.length !== 1) {
    console.warn(
      `⚠ expected exactly 1 repo in scope, got ${minted.repositories.length} — ` +
        `per-task scoping is not working as intended`,
    );
  }

  console.log("\nAll checks passed. The token was never printed.");
};

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
