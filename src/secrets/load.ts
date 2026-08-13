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
        `(expected {"owners": {...}, "repos": {...}})`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `secret '${profile.secretRef}' key 'tokens.json' must be an object of the form ` +
        `{"owners": {"<owner>": "<token>"}, "repos": {"<owner>/<name>": "<token>"}}`,
    );
  }

  const shape = parsed as { readonly owners?: unknown; readonly repos?: unknown };
  const tokensByOwner = readTokenMap(shape.owners, "owners", profile.secretRef);
  const tokensByRepo = readTokenMap(shape.repos, "repos", profile.secretRef);

  if (tokensByOwner.size === 0 && tokensByRepo.size === 0) {
    throw new Error(
      `secret '${profile.secretRef}' key 'tokens.json' contains no tokens — add at ` +
        `least one owner-wide token under "owners"`,
    );
  }

  const options: ForgejoOptions = {
    apiBase: profile.forge.apiBase,
    username: await bundle.read("username"),
    tokensByOwner,
    ...(tokensByRepo.size > 0 ? { tokensByRepo } : {}),
  };
  return new ForgejoForgeFactory(options);
};

/** Parse one token sub-map, naming keys but never values in errors. */
const readTokenMap = (
  value: unknown,
  field: string,
  secretRef: string,
): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  if (value === undefined || value === null) return map;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`secret '${secretRef}' tokens.json '${field}' must be an object`);
  }

  for (const [key, token] of Object.entries(value as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`secret '${secretRef}' tokens.json ${field}['${key}'] must be a non-empty string`);
    }
    map.set(key, token);
  }
  return map;
};
