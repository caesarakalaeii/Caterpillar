/**
 * Supervisor-side credential service. See DESIGN.md §9.2.
 *
 * git in the agent's shell invokes the helper, which asks this service over a unix
 * socket. The token therefore never lands in `argv`, `.git/config`, an env var, or
 * on disk — which is what keeps it out of the session transcripts we commit.
 *
 * This is leak hygiene, not a wall: the agent shares a container with the supervisor
 * and could speak to this socket directly. The real boundary is the token's scope
 * (§9.1). The socket design exists because it costs little and keeps the agent-side
 * contract unchanged if the trust domains are ever split.
 *
 * Only the currently-leased task has an active credential. A request arriving with no
 * active task is refused rather than served from a previous one.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoRef } from "../domain/task.ts";
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

export class CredentialService {
  private active: ActiveCredential | undefined;
  private server: Server | undefined;

  /** Bind the service to the task the supervisor just claimed. */
  setActive(active: ActiveCredential): void {
    this.active = active;
  }

  /** Called when a task completes, parks, or the lease is lost. */
  clearActive(): void {
    this.active = undefined;
  }

  async start(socketPath: string): Promise<void> {
    await mkdir(dirname(socketPath), { recursive: true });
    await rm(socketPath, { force: true });

    const server = createServer((socket) => {
      void this.handle(socket);
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
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(socket: Socket): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const line = buffer.slice(0, newline);
      buffer = "";

      void this.answer(line)
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

  private async answer(line: string): Promise<CredentialAnswer> {
    const request = JSON.parse(line) as CredentialRequest;

    const active = this.active;
    if (active === undefined) {
      throw new Error("no task is currently active — refusing to issue a credential");
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
