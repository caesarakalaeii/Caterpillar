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
import type { StateRepoConfig, WorkspaceProfile } from "../config/types.ts";
import { parseStateRepoUrl, StateRepoCredentials } from "../state/credential.ts";
import {
  GitHubAppForgeFactory,
  trackerTokenSource,
  type GitHubAppOptions,
} from "../forge/github-app.ts";
import { ForgejoForgeFactory, type ForgejoOptions } from "../forge/forgejo.ts";
import type { ForgeFactory } from "../forge/types.ts";
import type { Tracker } from "../tracker/types.ts";
import { GitHubIssuesTracker, type GitHubIssuesOptions } from "../tracker/github-issues.ts";
import { VikunjaTracker, type VikunjaOptions } from "../tracker/vikunja.ts";

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
  private readonly dir: string;
  private readonly secretRef: string;

  constructor(dir: string, secretRef: string) {
    this.dir = dir;
    this.secretRef = secretRef;
  }

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

/**
 * Build the credential for the supervisor's own state-repo pushes (DESIGN.md §9.3).
 *
 * Returns undefined when no `secretRef` is configured, which means "the checkout is
 * already authenticated" — true for local development, never in the cluster.
 */
export const loadStateCredentials = async (
  stateRepo: StateRepoConfig,
  secretsDir: string,
  apiBase: string,
): Promise<StateRepoCredentials | undefined> => {
  if (stateRepo.secretRef === undefined) return undefined;

  const bundle = new SecretBundle(secretsDir, stateRepo.secretRef);
  return new StateRepoCredentials(
    {
      appId: await bundle.read("app-id"),
      installationId: await bundle.read("installation-id"),
      privateKeyPem: await bundle.read("private-key.pem"),
      apiBase,
    },
    parseStateRepoUrl(stateRepo.url),
  );
};

/**
 * Build the Tracker for a workspace, or `undefined` when it has none.
 *
 * Expected keys:
 *   vikunja       — vikunja-token  (a dedicated agent token, scoped per DESIGN.md §9.5)
 *   github-issues — app-id, installation-id, private-key.pem  (the workspace's own
 *                   GitHub App; no second credential, see tracker/github-issues.ts)
 *
 * A workspace with no tracker block is a supported configuration: the tracker is a
 * view, never authoritative, so the supervisor runs perfectly well without one.
 */
export const loadTracker = async (
  profile: WorkspaceProfile,
  secretsDir: string,
): Promise<Tracker | undefined> => {
  const config = profile.tracker;
  if (config === undefined) return undefined;

  const bundle = new SecretBundle(secretsDir, profile.secretRef);

  if (config.kind === "github-issues") {
    if (profile.forge.kind !== "github") {
      // The tracker borrows the forge's App credential, so there is nothing to mint
      // from. Caught here rather than at the first transition, which would fail after
      // the supervisor had already moved the authoritative state in git.
      throw new Error(
        `workspace '${profile.name}' uses the github-issues tracker but its forge is ` +
          `'${profile.forge.kind}' — the tracker mints its token from the GitHub App, ` +
          `so it needs a github forge in the same workspace`,
      );
    }

    const app: GitHubAppOptions = {
      appId: await bundle.read("app-id"),
      installationId: await bundle.read("installation-id"),
      privateKeyPem: await bundle.read("private-key.pem"),
      apiBase: config.apiBase,
    };
    const source = trackerTokenSource(app);

    const options: GitHubIssuesOptions = {
      apiBase: config.apiBase,
      owner: profile.forge.owner,
      ingestLabel: config.ingestLabel,
      token: () => source.token(),
      ...(config.wipLabel !== undefined ? { wipLabel: config.wipLabel } : {}),
      ...(config.needsHumanLabel !== undefined
        ? { needsHumanLabel: config.needsHumanLabel }
        : {}),
    };
    return new GitHubIssuesTracker(options);
  }

  const options: VikunjaOptions = {
    apiBase: config.apiBase,
    token: await bundle.read("vikunja-token"),
    ingestLabel: config.ingestLabel,
    ...(config.wipLabel !== undefined ? { wipLabel: config.wipLabel } : {}),
    ...(config.needsHumanLabel !== undefined
      ? { needsHumanLabel: config.needsHumanLabel }
      : {}),
  };
  return new VikunjaTracker(options);
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
