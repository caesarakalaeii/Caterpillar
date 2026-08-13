/**
 * Persistent credential store for pi-ai. See DESIGN.md §9.6.
 *
 * pi-ai ships only an in-memory store — persistence is the embedder's job. A
 * supervisor needs a real one for a specific reason: an OAuth refresh **rotates the
 * refresh token**, and pi runs that refresh inside `modify`, so the store has to be
 * WRITABLE and durable. That rules out the obvious answer:
 *
 *   A mounted Kubernetes Secret is READ-ONLY. Putting the subscription credential
 *   there means the first refresh fails, and after the access token's hour is up the
 *   supervisor is locked out until someone logs in again by hand.
 *
 * So the credential lives on the PVC beside the git mirrors, seeded once from a login
 * performed on a machine that has a browser (`npm run llm:login`).
 *
 * `modify` is the only write path, and pi depends on it being serialized: concurrent
 * requests must not double-refresh a rotated token — the loser would persist a refresh
 * token the provider has already invalidated. Serialization here is a lock directory,
 * which is atomic on POSIX and works across processes, not just across async callers.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** How long to wait for another process to finish a refresh before giving up. */
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;
/** A lock older than this belonged to a process that died mid-refresh. */
const LOCK_STALE_MS = 60_000;

export class CredentialLockError extends Error {
  constructor(path: string) {
    super(
      `could not acquire the credential lock at ${path} within ${LOCK_TIMEOUT_MS}ms — ` +
        `another process is refreshing, or a previous one died holding it`,
    );
    this.name = "CredentialLockError";
  }
}

/** On-disk shape: provider id → credential. Mirrors pi's own auth.json. */
type CredentialFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  /** JSON file on durable, WRITABLE storage — the PVC, not a Secret mount. */
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.load())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    // Metadata only — never the secrets themselves.
    return Object.entries(await this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  /**
   * Serialized read-modify-write. pi refreshes OAuth tokens inside this callback,
   * so the lock is what stops two concurrent sessions from racing a token rotation.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    await this.lock(options?.signal);
    try {
      const file = await this.load();
      // Re-read inside the lock: the point is that `fn` sees what the previous
      // holder wrote, not what we read before waiting for it.
      const next = await fn(file[providerId]);
      if (next === undefined) return file[providerId];

      await this.save({ ...file, [providerId]: next });
      return next;
    } finally {
      await this.unlock();
    }
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.lock(options?.signal);
    try {
      const file = await this.load();
      if (!(providerId in file)) return;

      const { [providerId]: _removed, ...rest } = file;
      await this.save(rest);
    } finally {
      await this.unlock();
    }
  }

  private async load(): Promise<CredentialFile> {
    const raw = await readFile(this.path, "utf8").catch(() => undefined);
    if (raw === undefined || raw.length === 0) return {};

    try {
      return JSON.parse(raw) as CredentialFile;
    } catch {
      // Never echo the body — it is a live refresh token.
      throw new Error(`credential file ${this.path} is not valid JSON`);
    }
  }

  /** Atomic: write a temp file, then rename over the target. */
  private async save(file: CredentialFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    // 0600 at creation, not chmod after — a token must never be world-readable,
    // not even for the moment between the two calls.
    await writeFile(temp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }

  private get lockPath(): string {
    return join(dirname(this.path), `${this.path.split("/").pop() ?? "auth"}.lock`);
  }

  /**
   * `mkdir` is the lock: atomic on POSIX, and unlike an O_EXCL file it leaves
   * nothing to clean up if the process is SIGKILLed mid-write.
   */
  private async lock(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(this.lockPath);
        return;
      } catch {
        if (await this.breakStaleLock()) continue;
        if (Date.now() >= deadline) throw new CredentialLockError(this.lockPath);
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  /** A pod that was killed mid-refresh leaves the lock behind; time it out. */
  private async breakStaleLock(): Promise<boolean> {
    const { stat } = await import("node:fs/promises");
    const held = await stat(this.lockPath).catch(() => undefined);
    if (held === undefined) return true;
    if (Date.now() - held.mtimeMs < LOCK_STALE_MS) return false;

    await rm(this.lockPath, { recursive: true, force: true });
    return true;
  }

  private async unlock(): Promise<void> {
    await rm(this.lockPath, { recursive: true, force: true });
  }
}
