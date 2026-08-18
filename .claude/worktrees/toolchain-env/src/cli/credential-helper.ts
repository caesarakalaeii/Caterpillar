/**
 * git credential helper. Invoked BY GIT, not by a human.
 *
 *   git config credential.helper '!caterpillar-cred --socket /run/caterpillar/cred.sock'
 *
 * Reads git's request on stdin, asks the supervisor's credential service over a unix
 * socket, and writes the answer on stdout. The token exists only in this process's
 * memory for the lifetime of one push.
 *
 * On any failure it exits 0 having printed nothing. That is deliberate: git treats a
 * silent helper as "no credential available" and falls through to its normal error,
 * which is a clear auth failure. A non-zero exit here produces a confusing
 * helper-crashed message that obscures the real cause.
 */
import { connect } from "node:net";
import {
  parseInvocation,
  parseRequest,
  formatAnswer,
  type CredentialAnswer,
} from "../credential/protocol.ts";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const ask = (socketPath: string, payload: string): Promise<CredentialAnswer> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const parsed = JSON.parse(buffer) as CredentialAnswer | { readonly error: string };
        if ("error" in parsed) reject(new Error(parsed.error));
        else resolve(parsed);
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  });

const main = async (): Promise<void> => {
  const { operation, socketPath } = parseInvocation(process.argv.slice(2));

  // `store` and `erase` are no-ops: we mint on demand and never cache on disk.
  if (operation !== "get") return;

  if (socketPath === undefined) {
    process.stderr.write("caterpillar-cred: --socket <path> is required\n");
    return;
  }

  const request = parseRequest(await readStdin());
  const answer = await ask(socketPath, JSON.stringify(request));
  process.stdout.write(formatAnswer(answer));
};

main().catch((error: unknown) => {
  // Stay silent on stdout; git falls through to a normal auth failure.
  process.stderr.write(
    `caterpillar-cred: ${error instanceof Error ? error.message : String(error)}\n`,
  );
});
