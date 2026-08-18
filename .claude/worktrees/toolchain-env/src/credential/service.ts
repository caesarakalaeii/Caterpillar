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
import type { Forge } from "../forge/types.ts";
import { parseRepoPath, type CredentialAnswer, type CredentialRequest } from "./protocol.ts";

export interface ActiveCredential {
  readonly forge: Forge;
  /** Repos the current task declared — the only ones that will be served. */
  readonly repos: readonly RepoRef[];
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
