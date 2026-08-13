/**
 * Secret loading. See DESIGN.md §9.
 *
 * Secrets arrive as a mounted directory per `secretRef`, one file per key — the shape
 * Kubernetes produces from a SOPS-decrypted Secret. Values are read at startup and
 * held only in memory.
 *
 * Nothing here logs a value, and errors name the missing KEY, never its content. A
 * misconfiguration must be diagnosable from logs that are safe to paste into a ticket.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceProfile } from "../config/types.ts";
import { GitHubAppForgeFactory, type GitHubAppOptions } from "../forge/github-app.ts";
import { ForgejoForgeFactory, type ForgejoOptions } from "../forge/forgejo.ts";
import type { ForgeFactory } from "../forge/types.ts";

export class MissingSecretError extends Error {
  constructor(secretRef: string, key: string) {
    super(
      `secret '${secretRef}' is missing key '${key}' — add it to the SOPS-encrypted ` +
        `Secret and let reloader restart the pod`,
    );
    this.name = "MissingSecretError";
  }
}

/** Reads one key from a mounted secret directory. */
export class SecretBundle {
  constructor(
    private readonly dir: string,
    private readonly secretRef: string,
  ) {}

  async read(key: string): Promise<string> {
    const path = join(this.dir, this.secretRef, key);
    if (!existsSync(path)) throw new MissingSecretError(this.secretRef, key);
    return (await readFile(path, "utf8")).trim();
  }

  async readOptional(key: string): Promise<string | undefined> {
    const path = join(this.dir, this.secretRef, key);
    if (!existsSync(path)) return undefined;
    return (await readFile(path, "utf8")).trim();
  }
}

/**
 * Build the ForgeFactory for a workspace.
 *
 * Expected keys:
 *   github  — app-id, installation-id, private-key.pem
 *   forgejo — username, tokens.json  ({"owner/name": "<repo-scoped token>"})
 */
export const loadForgeFactory = async (
  profile: WorkspaceProfile,
  secretsDir: string,
): Promise<ForgeFactory> => {
  const bundle = new SecretBundle(secretsDir, profile.secretRef);

  if (profile.forge.kind === "github") {
    const options: GitHubAppOptions = {
      appId: await bundle.read("app-id"),
      installationId: await bundle.read("installation-id"),
      privateKeyPem: await bundle.read("private-key.pem"),
      apiBase: profile.forge.apiBase,
    };
    return new GitHubAppForgeFactory(options);
  }

  const raw = await bundle.read("tokens.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not echo the body — it is a map of live tokens.
    throw new Error(
      `secret '${profile.secretRef}' key 'tokens.json' is not valid JSON ` +
        `(expected {"owner/name": "<token>"})`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `secret '${profile.secretRef}' key 'tokens.json' must be an object mapping ` +
        `owner/name to a repository-scoped token`,
    );
  }

  const tokensByRepo = new Map<string, string>();
  for (const [slug, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`tokens.json entry '${slug}' must be a non-empty string`);
    }
    tokensByRepo.set(slug, token);
  }

  const options: ForgejoOptions = {
    apiBase: profile.forge.apiBase,
    username: await bundle.read("username"),
    tokensByRepo,
  };
  return new ForgejoForgeFactory(options);
};
