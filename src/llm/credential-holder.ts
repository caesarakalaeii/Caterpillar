/**
 * The holder half of the fleet credential. See DESIGN.md §9.6.
 *
 * One pod in the fleet owns the Anthropic OAuth credential, on its own small volume, and
 * is the ONLY thing that ever refreshes it. Runners read it over HTTP
 * (`credential-client.ts`). The reason is in that file and reduces to: a refresh rotates
 * the refresh token, so N copies of the credential is N-1 copies that are already dead.
 *
 * What this deliberately is NOT is a proxy for the model API. DESIGN.md §2 originally had
 * one — "all runners → in-cluster proxy that holds the credential" — and §9.6 records why
 * it was deleted: an OAuth bearer cannot be forwarded by something that authenticates with
 * `x-api-key`, so the proxy could not carry the traffic. It could always have carried the
 * CREDENTIAL, though, and that is all this does. Runners still talk to api.anthropic.com
 * themselves; only the token comes from here.
 *
 * Nothing here reimplements OAuth. `Models.getAuth` is pi's own public entry point into
 * `resolveStoredOAuth`, which does the double-checked "is it expiring / refresh once /
 * persist the rotation" dance inside `CredentialStore.modify`. Handing it the same
 * `FileCredentialStore` the single-replica deployment used means the refresh path in the
 * fleet is character-for-character the refresh path that already worked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Credential, CredentialStore, Models } from "@earendil-works/pi-ai";
import type { Logger } from "../obs/log.ts";

/** Bearer token env var. Shared with the runner client. */
export const HOLDER_TOKEN_ENV = "LLM_CREDENTIAL_TOKEN";

export interface CredentialHolderOptions {
  /** pi runtime wired to `store`, used only for its `getAuth` refresh path. */
  readonly models: Models;
  /** The single durable copy. A `FileCredentialStore` on this pod's own volume. */
  readonly store: CredentialStore;
  /**
   * Shared bearer token. Optional, and its absence is LOGGED AS A WARNING rather than
   * refused: an operator bringing the fleet up before sealing a secret should get a
   * working cluster and a loud line, not a crash loop. See `authorised`.
   */
  readonly token?: string;
  readonly logger: Logger;
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

const json = (status: number, value: unknown): Reply => ({
  status,
  body: JSON.stringify(value),
});

export const createCredentialHolder = (options: CredentialHolderOptions): Server =>
  createServer((request, response) => {
    void respond(options, request, response);
  });

const respond = async (
  options: CredentialHolderOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let reply: Reply;
  try {
    reply = await route(options, request);
  } catch (error: unknown) {
    // The message may name the provider and the failure mode; it must never carry the
    // token, so nothing from the credential itself is interpolated anywhere here.
    options.logger.error("credential.failed", {
      path: request.url ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
    reply = json(500, { error: "credential holder failed" });
  }

  response.writeHead(reply.status, {
    "content-type": "application/json",
    // A live access token must not sit in any cache, proxy or history.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : reply.body);
};

const route = async (options: CredentialHolderOptions, request: IncomingMessage): Promise<Reply> => {
  const method = request.method ?? "GET";
  // Query strings are meaningless here and a path with one must not miss the route table.
  const path = (request.url ?? "/").split("?")[0] ?? "/";

  // Unauthenticated on purpose: it is what the kubelet probes, it says nothing, and
  // requiring a token would mean putting one in the manifest's probe definition.
  if (path === "/healthz") return json(200, { status: "ok" });

  if (!authorised(options, request)) {
    // 401 with no detail. Which of "absent" or "wrong" it was is useful to an attacker
    // and available to the operator in the log line.
    options.logger.warn("credential.unauthorised", { path, method });
    return json(401, { error: "unauthorised" });
  }

  if (method === "GET" && path === "/v1/credentials") {
    // Metadata only — provider ids and types, never key material. This is what makes it
    // safe for an operator to curl when a runner says it cannot find a credential.
    return json(200, { credentials: await options.store.list() });
  }

  const read = /^\/v1\/credentials\/([^/]+)$/.exec(path);
  if (method === "GET" && read?.[1] !== undefined) {
    return await serve(options, decodeURIComponent(read[1]));
  }

  const refresh = /^\/v1\/credentials\/([^/]+)\/refresh$/.exec(path);
  if (method === "POST" && refresh?.[1] !== undefined) {
    return await serve(options, decodeURIComponent(refresh[1]));
  }

  return json(404, { error: "no such route" });
};

/**
 * Resolve, refreshing if needed, and answer with the credential.
 *
 * GET and POST land here identically, and that is correct rather than lazy. `getAuth`
 * already decides whether a refresh is warranted by looking at `expires`, and it decides
 * it under the store's lock. A "force" variant would be a way for one runner to rotate a
 * token every other runner is happily using — the client's `modify` maps to POST purely
 * so the intent is legible in an access log.
 */
const serve = async (options: CredentialHolderOptions, providerId: string): Promise<Reply> => {
  // The refresh happens HERE, inside pi, under the file lock. Its return value is the
  // request auth, which we deliberately drop: the caller wants the stored credential, and
  // reading it back after `getAuth` is what guarantees a rotation is already persisted.
  await options.models.getAuth(providerId).catch((error: unknown) => {
    // A refresh failure must not be a 500. The stored credential is preserved for retry by
    // pi's own contract, and a runner that gets the expiring token can still use it for
    // whatever validity is left — which beats failing its session outright.
    options.logger.warn("credential.refresh-failed", {
      provider: providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });

  const credential = await options.store.read(providerId);
  if (credential === undefined) {
    // The un-seeded case, and the reason the client treats 404 as "not an error": a fleet
    // brought up before `npm run llm:login` should idle, not crash-loop.
    return json(404, { error: `no credential stored for '${providerId}'` });
  }

  options.logger.debug("credential.served", {
    provider: providerId,
    type: credential.type,
    ...expiryFields(credential),
  });

  return json(200, { credential });
};

/** Seconds of life left, for the log only. Never the token, never the refresh token. */
const expiryFields = (credential: Credential): Record<string, number> =>
  credential.type === "oauth"
    ? { expiresInSeconds: Math.max(0, Math.round((credential.expires - Date.now()) / 1000)) }
    : {};

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length, so
 * the lengths are compared first and a mismatch is an ordinary rejection.
 */
const authorised = (options: CredentialHolderOptions, request: IncomingMessage): boolean => {
  if (options.token === undefined) return true;

  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(options.token);
  return a.length === b.length && timingSafeEqual(a, b);
};
