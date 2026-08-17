/**
 * The runner half of the fleet credential. See DESIGN.md §9.6.
 *
 * `FileCredentialStore` solves exactly one concurrency problem: several *processes on one
 * filesystem* refreshing a rotating token. Its lock is a directory, so its blast radius is
 * the volume it sits on. That is enough for one supervisor and it is not enough for a
 * fleet, because the cluster has no ReadWriteMany storage class — every replica gets its
 * own volume, so every replica would get its own COPY of the credential.
 *
 * Copies are what makes this fatal rather than merely wasteful. An Anthropic OAuth refresh
 * ROTATES the refresh token: the moment replica A refreshes, the token in B's copy, C's
 * copy and D's copy is one the provider has already invalidated. The fleet locks itself
 * out roughly an hour after it starts, and it does so silently — every replica works right
 * up until its access token expires.
 *
 * So the credential stops being a file each runner owns and becomes a service exactly one
 * pod owns (`credential-holder.ts`). This class is what a runner talks to it with, and the
 * whole point of it is that it NEVER WRITES and never refreshes. There is one writer in
 * the fleet, it is the holder, and it holds the only copy.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** Bearer token env var. Shared with the holder; see `HOLDER_TOKEN_ENV` there. */
export const HOLDER_TOKEN_ENV = "LLM_CREDENTIAL_TOKEN";

/**
 * Serve a cached credential only while it has at least this long to live.
 *
 * Deliberately LARGER than pi's own five-minute `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`. If it
 * were smaller, this cache could hand back a credential pi immediately judges stale, and
 * every request would take the refresh path — a cache that guarantees the miss it exists
 * to avoid.
 */
const CACHE_MARGIN_MS = 10 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

export class CredentialHolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialHolderError";
  }
}

/**
 * Raised when something asks a RUNNER to write the fleet's credential.
 *
 * Not an oversight and not a TODO: a runner that could write could rotate, and a runner
 * that could rotate is the multi-writer problem this component was built to delete.
 */
export class CredentialReadOnlyError extends Error {
  constructor(operation: string) {
    super(
      `a runner cannot ${operation} the fleet credential — it is owned by the credential ` +
        `holder, which is the only writer. Run 'npm run llm:login' and seed the holder's ` +
        `volume instead`,
    );
    this.name = "CredentialReadOnlyError";
  }
}

export interface HttpCredentialStoreOptions {
  /** Base URL of the holder, e.g. `http://caterpillar-credentials:8081`. */
  readonly baseUrl: string;
  /** Shared bearer token. Absent means the holder is running without one. */
  readonly token?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * A `CredentialStore` backed by the holder rather than by a file.
 *
 * pi reaches for a store in two places and they want opposite things from this class:
 *
 *   `read` — every `getAuth`, so once per model request. Answered from cache when the
 *   cached token still has real life left, because the holder guarantees freshness on the
 *   way out and an access token stays valid until `expires` regardless of how many times
 *   the refresh token has rotated underneath it.
 *
 *   `modify` — only when pi judges the credential to be expiring. See the method.
 */
export class HttpCredentialStore implements CredentialStore {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly http: typeof fetch;
  /** Last credential the holder served, by provider id. Never written to disk. */
  private cache = new Map<string, Credential>();

  constructor(options: HttpCredentialStoreOptions) {
    // Trailing slashes make `${base}/v1/...` double up; normalise once here rather
    // than at four call sites.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const cached = this.cache.get(providerId);
    if (cached !== undefined && !expiringSoon(cached)) return cached;

    return await this.fetchCredential(providerId, "GET");
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const body = await this.request<{ readonly credentials?: readonly CredentialInfo[] }>(
      "GET",
      "/v1/credentials",
    );
    return body?.credentials ?? [];
  }

  /**
   * Ask the HOLDER to refresh. Never run `fn`.
   *
   * This is the one place where this class knowingly departs from the letter of pi's
   * `CredentialStore` contract, and it is the entire reason it exists. pi calls `modify`
   * with a callback that, for an expiring OAuth credential, invokes
   * `anthropicOAuth.refresh` — a network call that mints a new access token AND INVALIDATES
   * THE REFRESH TOKEN IT WAS GIVEN. Running that here would rotate the fleet's credential
   * from a replica that does not own it and cannot persist it: the holder's copy becomes
   * dead on the spot, and every other replica dies with it at its next refresh.
   *
   * So the callback is dropped on the floor and the request goes to the holder, which runs
   * the identical refresh under its own lock and against the single durable copy. What
   * comes back is what `fn` would have produced, so pi's caller cannot tell the difference
   * — `resolveStoredOAuth` checks the returned credential is still `type: "oauth"` and
   * carries on.
   *
   * The double-checked locking pi relies on is not lost, only moved: the holder re-reads
   * under its lock and skips the refresh if another runner's request already did it, which
   * is exactly what pi's own `if (!expiresSoon(current)) return undefined` does today.
   */
  async modify(
    providerId: string,
    _fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return await this.fetchCredential(providerId, "POST", options?.signal);
  }

  /**
   * Always throws. `logout` is a fleet-wide act and a runner is not entitled to it.
   *
   * pi calls this only from `Models.logout`, which nothing in the supervisor calls — so in
   * practice this is a tripwire for a future caller rather than a path anything takes.
   */
  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    throw new CredentialReadOnlyError(`delete the '${providerId}' credential from`);
  }

  /** Shared by `read` and `modify`; the verb is the only difference. */
  private async fetchCredential(
    providerId: string,
    method: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<Credential | undefined> {
    const route =
      method === "GET"
        ? `/v1/credentials/${encodeURIComponent(providerId)}`
        : `/v1/credentials/${encodeURIComponent(providerId)}/refresh`;

    const body = await this.request<{ readonly credential?: Credential }>(method, route, signal);
    const credential = body?.credential;

    // A holder that has no credential is a holder nobody has seeded yet. Cache nothing:
    // the operator is about to copy a file in, and this process must notice.
    if (credential === undefined) {
      this.cache.delete(providerId);
      return undefined;
    }

    this.cache.set(providerId, credential);
    return credential;
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    // The caller's signal AND a timeout: a holder that accepts the connection and then
    // never answers would otherwise hang a session for as long as the pod lives.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}${route}`, {
        method,
        signal: combined,
        headers: {
          accept: "application/json",
          ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
        },
      });
    } catch (cause) {
      // Never echo the body of anything on this route — it carries a live token.
      throw new CredentialHolderError(
        `could not reach the credential holder at ${this.baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    // The holder says "nothing stored" with 404, which is not an error here: a runner that
    // starts before the credential is seeded should idle, exactly as it does today.
    if (response.status === 404) return undefined;

    if (!response.ok) {
      throw new CredentialHolderError(
        `credential holder at ${this.baseUrl} answered ${method} ${route} with ` +
          `${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }
}

/** Mirrors pi's own `expiresSoon`, with this class's larger margin. */
const expiringSoon = (credential: Credential): boolean =>
  credential.type === "oauth" && Date.now() + CACHE_MARGIN_MS >= credential.expires;
