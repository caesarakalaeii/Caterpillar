/**
 * Config loading. See DESIGN.md §3.1, §10.
 *
 * Config comes from a ConfigMap-mounted JSON file plus a few env vars for
 * pod identity. Secrets are NOT here — only `secretRef` names pointing into the
 * mounted secret directory, so a config dump can never leak a credential.
 */
import { readFile } from "node:fs/promises";
import { asWorkspaceName, type Capability, type WorkspaceName } from "../domain/task.ts";
import type { LlmConfig, RunnerConfig, WorkspaceProfile } from "./types.ts";

export class ConfigError extends Error {
  constructor(detail: string) {
    super(`invalid configuration: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Shape of the on-disk config file. Validated into RunnerConfig. */
interface RawConfig {
  readonly capabilities?: unknown;
  readonly stateRepo?: {
    readonly url?: unknown;
    readonly branch?: unknown;
    readonly path?: unknown;
    readonly secretRef?: unknown;
  };
  readonly paths?: { readonly mirrors?: unknown; readonly tasks?: unknown };
  readonly lease?: { readonly heartbeatSeconds?: unknown; readonly staleAfterSeconds?: unknown };
  readonly handoff?: { readonly thresholdFraction?: unknown };
  readonly limits?: { readonly maxSessionsPerTask?: unknown; readonly noProgressLimit?: unknown };
  readonly llm?: Record<string, unknown>;
  readonly workspaces?: Record<string, unknown>;
  readonly pollSeconds?: unknown;
  readonly secretsDir?: unknown;
}

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value;
};

const num = (value: unknown, field: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${field} must be a finite number`);
  }
  return value;
};

const KNOWN_CAPABILITIES: readonly Capability[] = [
  "linux",
  "k8s",
  "net",
  "gpu",
  "usb",
  "human-present",
];

const capabilities = (value: unknown): readonly Capability[] => {
  if (!Array.isArray(value)) throw new ConfigError("capabilities must be an array");
  return value.map((entry) => {
    if (typeof entry !== "string" || !KNOWN_CAPABILITIES.includes(entry as Capability)) {
      throw new ConfigError(
        `unknown capability '${String(entry)}' (known: ${KNOWN_CAPABILITIES.join(", ")})`,
      );
    }
    return entry as Capability;
  });
};

const workspace = (name: string, value: unknown): WorkspaceProfile => {
  if (value === null || typeof value !== "object") {
    throw new ConfigError(`workspace '${name}' must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const forge = raw["forge"];
  if (forge === null || typeof forge !== "object") {
    throw new ConfigError(`workspace '${name}' is missing 'forge'`);
  }
  const f = forge as Record<string, unknown>;
  const kind = str(f["kind"], `workspaces.${name}.forge.kind`);
  if (kind !== "github" && kind !== "forgejo") {
    throw new ConfigError(`workspaces.${name}.forge.kind must be 'github' or 'forgejo'`);
  }

  const tracker = raw["tracker"];
  const profile: WorkspaceProfile = {
    name: asWorkspaceName(name),
    forge: {
      kind,
      host: str(f["host"], `workspaces.${name}.forge.host`),
      owner: str(f["owner"], `workspaces.${name}.forge.owner`),
      apiBase: str(f["apiBase"], `workspaces.${name}.forge.apiBase`),
    },
    secretRef: str(raw["secretRef"], `workspaces.${name}.secretRef`),
  };

  if (tracker === null || tracker === undefined) return profile;

  const t = tracker as Record<string, unknown>;
  const trackerKind = str(t["kind"], `workspaces.${name}.tracker.kind`);
  if (trackerKind !== "github-issues" && trackerKind !== "vikunja") {
    throw new ConfigError(
      `workspaces.${name}.tracker.kind must be 'github-issues' or 'vikunja'`,
    );
  }

  const optionalLabel = (field: string): string | undefined => {
    const value = t[field];
    return value === undefined ? undefined : str(value, `workspaces.${name}.tracker.${field}`);
  };
  const wipLabel = optionalLabel("wipLabel");
  const needsHumanLabel = optionalLabel("needsHumanLabel");

  return {
    ...profile,
    tracker: {
      kind: trackerKind,
      apiBase: str(t["apiBase"], `workspaces.${name}.tracker.apiBase`),
      ingestLabel: str(t["ingestLabel"], `workspaces.${name}.tracker.ingestLabel`),
      ...(wipLabel !== undefined ? { wipLabel } : {}),
      ...(needsHumanLabel !== undefined ? { needsHumanLabel } : {}),
    },
  };
};

/**
 * Validate the LLM block.
 *
 * `auth` defaults to `proxy` so an existing config keeps working. Subscription mode
 * demands `credentialsPath` up front rather than failing at the first session: the
 * OAuth login needs a browser, so discovering it is missing inside a pod is
 * discovering it too late.
 */
const llmConfig = (llm: Record<string, unknown>): LlmConfig => {
  const auth = llm["auth"] ?? "proxy";
  if (auth !== "proxy" && auth !== "subscription") {
    throw new ConfigError("llm.auth must be 'proxy' or 'subscription'");
  }

  const credentialsPath = llm["credentialsPath"];
  if (auth === "subscription" && credentialsPath === undefined) {
    throw new ConfigError(
      "llm.credentialsPath is required when llm.auth is 'subscription' — it must " +
        "point at writable, durable storage (the PVC), because refreshing the token " +
        "rotates it",
    );
  }

  return {
    auth,
    // Unused by subscription mode, but still required: a config that silently
    // stops pointing anywhere when auth flips is worse than one that repeats itself.
    baseUrl: str(llm["baseUrl"], "llm.baseUrl"),
    modelId: str(llm["modelId"], "llm.modelId"),
    providerId: str(llm["providerId"], "llm.providerId"),
    contextWindow: num(llm["contextWindow"], "llm.contextWindow"),
    maxTokens: num(llm["maxTokens"], "llm.maxTokens"),
    ...(credentialsPath === undefined
      ? {}
      : { credentialsPath: str(credentialsPath, "llm.credentialsPath") }),
  };
};

export const loadConfig = async (path: string): Promise<RunnerConfig> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as RawConfig;

  const runnerId = process.env["RUNNER_ID"];
  if (runnerId === undefined || runnerId.length === 0) {
    throw new ConfigError("RUNNER_ID must be set (use the pod name via fieldRef)");
  }

  const workspaces = new Map<WorkspaceName, WorkspaceProfile>();
  for (const [name, value] of Object.entries(raw.workspaces ?? {})) {
    workspaces.set(asWorkspaceName(name), workspace(name, value));
  }
  if (workspaces.size === 0) throw new ConfigError("at least one workspace is required");

  const llm = raw.llm ?? {};

  return {
    runnerId,
    capabilities: capabilities(raw.capabilities),
    stateRepo: {
      url: str(raw.stateRepo?.url, "stateRepo.url"),
      branch: str(raw.stateRepo?.branch, "stateRepo.branch"),
      path: str(raw.stateRepo?.path, "stateRepo.path"),
      ...(raw.stateRepo?.secretRef === undefined
        ? {}
        : { secretRef: str(raw.stateRepo.secretRef, "stateRepo.secretRef") }),
    },
    paths: {
      mirrors: str(raw.paths?.mirrors, "paths.mirrors"),
      tasks: str(raw.paths?.tasks, "paths.tasks"),
    },
    lease: {
      heartbeatSeconds: num(raw.lease?.heartbeatSeconds, "lease.heartbeatSeconds", 60),
      staleAfterSeconds: num(raw.lease?.staleAfterSeconds, "lease.staleAfterSeconds", 300),
    },
    handoff: {
      thresholdFraction: num(raw.handoff?.thresholdFraction, "handoff.thresholdFraction", 0.7),
    },
    limits: {
      maxSessionsPerTask: num(raw.limits?.maxSessionsPerTask, "limits.maxSessionsPerTask", 20),
      noProgressLimit: num(raw.limits?.noProgressLimit, "limits.noProgressLimit", 3),
    },
    llm: llmConfig(llm),
    workspaces,
    pollSeconds: num(raw.pollSeconds, "pollSeconds", 30),
    secretsDir: str(raw.secretsDir, "secretsDir"),
  };
};
