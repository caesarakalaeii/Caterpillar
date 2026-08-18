/**
 * Supervisor-side credential service. See DESIGN.md §9.2.
 *
 * git in the agent's shell invokes the helper, which asks this service over a unix
 * socket. The token therefore never lands in `argv`, `.git/config`, an env var, or
 * on disk — which is what keeps it out of the session transcripts we commit.
 *
 * This is leak hygiene, not a wall: the agent shares a container with the supervisor
 * and could speak to any of these sockets directly. The real boundary is the token's
 * scope (§9.1). The socket design exists because it costs little and keeps the
 * agent-side contract unchanged if the trust domains are ever split.
 *
 * Credentials are keyed by TASK, one listening socket each. Only a task that is
 * currently active has a socket at all, and a request arriving on a task's socket is
 * answered from that task's entry or refused — never from another task's.
 *
 * That keying is what makes concurrency safe. With a single `active` slot the service
 * answered whichever task called `setActive` last, so two sessions on one runner meant
 * task A's agent could be handed task B's repo credential — by accident, on the ordinary
 * path, with nothing adversarial happening. Per-task keying does not make the socket a
 * wall; it removes that accident.
 *
 * WHY A SOCKET PER TASK, rather than one socket and a per-task token in the request.
 *
 * The token route looks cheaper and is not. Wherever the token would be carried, it has
 * to reach git, and the only place git reads it from is `credential.helper` — which lives
 * in the repository's COMMON config, shared by a mirror and every worktree of it. A
 * per-task token written there is no more per-task than a per-task socket path written
 * there, so it needs exactly the same worktree-scoped config machinery
 * (`WorktreeManager.configureTask`), and then adds a protocol change and a secret to
 * generate, store, compare and expire on top. `parseInvocation` was verified against real
 * git's argv ordering once and is worth not re-opening for nothing.
 *
 * With a socket per task the identity is the connection, so there is no field to forge by
 * accident and nothing to keep in sync: a helper either reaches a task's socket or it
 * reaches nothing. A deliberately adversarial agent can name another task's socket path,
 * but it could equally read another task's token out of a config file it can also read —
 * neither design is an access control, and §9.1 is still the boundary.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isTaskId, type RepoRef, type TaskId } from "../domain/task.ts";
import { assertWorkspaceScope, type Forge, type WorkspaceScope } from "../forge/types.ts";
import { parseRepoPath, type CredentialAnswer, type CredentialRequest } from "./protocol.ts";

export interface ActiveCredential {
  readonly forge: Forge;
  /**
   * Repos the current task declared. A NARROWING filter, never the boundary: this list
   * comes from the spec, which comes from a tracker item or a plan the agent wrote.
   * `scope` is what the operator configured, and it is checked first.
   */
  readonly repos: readonly RepoRef[];
  /** The configured bound this task's workspace cannot reach past. */
  readonly scope: WorkspaceScope;
}

/**
 * A task's live credential binding. `close()` is idempotent, so the caller can put it in
 * a `finally` and the loop can also revoke it early when a lease is lost.
 *
 * Handed back rather than left to the caller to remember, because the previous shape —
 * `setActive()` here, `clearActive()` on every exit path over there — is exactly the
 * pairing that breaks under concurrency: one task's terminal path called the single
 * global `clearActive()` and revoked a task that was still running.
 */
export interface CredentialLease {
  /** Socket this task's git config must point at. */
  readonly socketPath: string;
  close(): Promise<void>;
}

const SOCKET_SUFFIX = ".sock";

/**
 * The kernel's `sun_path` limit, minus its terminator.
 *
 * Checked explicitly because the failure is otherwise a lie: `listen()` on an over-long
 * unix path reports **EADDRINUSE**, not a name-length error, so the operator goes hunting
 * for a stale socket that does not exist. Reachable in practice — the task ids this fleet
 * generates are long, and `install-runner.sh` roots the directory under an operator-chosen
 * `$ROOT` that can be arbitrarily deep.
 */
const SUN_PATH_MAX = 107;

/**
 * Where a task's socket lives, given the directory the service was started in.
 *
 * Exported so `WorktreeManager` and `index.ts` can name the same path without the
 * service having to be reachable from them: the worktree config is written by a
 * component that has no business holding a credential.
 *
 * A `TaskId` is already constrained to `[A-Za-z0-9._-]` (`isTaskId`), so it cannot
 * traverse out of the directory — but this is a path built from a spec that may have
 * come from an issue body, so it is checked here too rather than assumed.
 */
export const taskSocketPath = (dir: string, task: TaskId): string => {
  if (!isTaskId(task)) throw new Error(`'${task}' is not a usable task id for a socket path`);

  const path = join(dir, `${task}${SOCKET_SUFFIX}`);
  if (Buffer.byteLength(path) > SUN_PATH_MAX) {
    throw new Error(
      `credential socket path is ${Buffer.byteLength(path)} bytes and the kernel allows ` +
        `${SUN_PATH_MAX}: ${path}. Point CRED_SOCKET at a shorter directory.`,
    );
  }
  return path;
};

export class CredentialService {
  private readonly active = new Map<TaskId, ActiveCredential>();
  private readonly servers = new Map<TaskId, Server>();
  /**
   * Connections currently open on each task's socket.
   *
   * Held so `deactivate` can destroy them. `server.close()` refuses NEW connections and
   * calls back only once every existing one has ended — so a helper that connected and
   * then stalled would leave that promise pending forever, and `deactivate` is now in the
   * session runner's `finally`. One wedged git process would hang the supervisor rather
   * than one task. Revoking a credential is also exactly the moment an in-flight request
   * for it should stop, so destroying is the correct answer and not merely the safe one.
   */
  private readonly connections = new Map<TaskId, Set<Socket>>();
  private dir: string | undefined;

  /**
   * Prepare the socket directory and sweep whatever a previous process left in it.
   *
   * The sweep is not tidiness. A pod that was killed mid-session leaves a bound socket
   * file behind on the PVC; `listen()` on an existing path fails with EADDRINUSE, so
   * without this a restart could not re-activate the very task it was restarted to
   * finish. Stale entries are safe to delete precisely because nothing is listening on
   * them — this process holds every live one.
   */
  async start(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    this.dir = dir;

    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(SOCKET_SUFFIX))
        .map((entry) => rm(join(dir, entry), { force: true })),
    );
  }

  /** Where this service's sockets live. Throws before `start()`. */
  socketDir(): string {
    const dir = this.dir;
    if (dir === undefined) throw new Error("credential service has not been started");
    return dir;
  }

  /**
   * Bind a credential to one task and open its socket.
   *
   * Re-activating a task that already has a lease replaces the credential in place and
   * keeps the socket: a resumed session gets a freshly minted forge, and rebinding the
   * path would race any git process the previous session left running.
   */
  async activate(task: TaskId, credential: ActiveCredential): Promise<CredentialLease> {
    const socketPath = taskSocketPath(this.socketDir(), task);
    this.active.set(task, credential);

    if (!this.servers.has(task)) {
      await rm(socketPath, { force: true });

      const live = new Set<Socket>();
      this.connections.set(task, live);

      const server = createServer((socket) => {
        live.add(socket);
        socket.on("close", () => live.delete(socket));
        void this.handle(task, socket);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      // Same-user in one container, but do not rely on the umask.
      await chmod(socketPath, 0o600);
      this.servers.set(task, server);
    }

    let closed = false;
    return {
      socketPath,
      close: async () => {
        if (closed) return;
        closed = true;
        await this.deactivate(task);
      },
    };
  }

  /**
   * Revoke one task's credential and unlink its socket.
   *
   * Per task, and only that task: a session that finishes must not be able to take a
   * concurrent one's credential with it. Safe to call for a task that has none, so the
   * lease-lost path in the supervisor loop can fire without knowing whether the session
   * already unwound.
   */
  async deactivate(task: TaskId): Promise<void> {
    this.active.delete(task);

    const server = this.servers.get(task);
    this.servers.delete(task);

    const live = this.connections.get(task);
    this.connections.delete(task);
    for (const socket of live ?? []) socket.destroy();

    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (this.dir !== undefined) {
      await rm(taskSocketPath(this.dir, task), { force: true }).catch(() => undefined);
    }
  }

  /** Close every socket. Used at shutdown and by tests. */
  async stop(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((task) => this.deactivate(task)));
  }

  private async handle(task: TaskId, socket: Socket): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const line = buffer.slice(0, newline);
      buffer = "";

      void this.answer(task, line)
        .then((answer) => {
          socket.end(`${JSON.stringify(answer)}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          socket.end(`${JSON.stringify({ error: message })}\n`);
        });
    });

    socket.on("error", () => socket.destroy());
  }

  private async answer(task: TaskId, line: string): Promise<CredentialAnswer> {
    const request = JSON.parse(line) as CredentialRequest;

    // The task comes from WHICH socket the request arrived on, not from anything in the
    // request — so there is no field for a caller to get wrong or to spoof by mistake.
    // A socket can outlive its entry by the width of a `deactivate`, and that window is
    // a refusal rather than a fallback to some other task's credential.
    const active = this.active.get(task);
    if (active === undefined) {
      throw new Error(`task '${task}' has no active credential — refusing to issue one`);
    }

    const parsed = parseRepoPath(request.path);
    if (parsed === undefined) {
      throw new Error(
        "credential request carried no usable repo path — set credential.useHttpPath=true",
      );
    }

    const host = request.host;
    if (host === undefined) throw new Error("credential request carried no host");

    // git tells us the protocol it is about to authenticate over. `useHttpPath=true` is
    // set on repo config the agent can add remotes to, so an `http://` remote for a repo
    // that IS in scope would otherwise get the token sent as cleartext Basic auth.
    if (request.protocol !== undefined && request.protocol !== "https") {
      throw new Error(
        `refusing to serve a credential over '${request.protocol}' — the token would ` +
          `travel in clear; use an https remote`,
      );
    }

    // FIRST, against what the operator configured. Doing this before the `repos` lookup
    // matters: the lookup below compares the request with the task's own declared list,
    // and a task that declared a hostile host would match itself.
    assertWorkspaceScope({ host, owner: parsed.owner, name: parsed.name }, active.scope);

    const repo = active.repos.find(
      (candidate) =>
        candidate.host === host &&
        candidate.owner === parsed.owner &&
        candidate.name === parsed.name,
    );
    if (repo === undefined) {
      throw new Error(
        `no credential for ${host}/${parsed.owner}/${parsed.name} — it is not in this task's scope`,
      );
    }

    const credential = await active.forge.credential(repo);
    return { username: credential.username, password: credential.password };
  }
}
