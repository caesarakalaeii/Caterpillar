/**
 * git credential helper protocol. See `gitcredentials(7)`.
 *
 * git speaks a trivial line protocol on stdin/stdout: `key=value` lines, a blank
 * line, and an operation verb passed as argv. Parsing is pure and lives here so it
 * can be tested without a socket or a git process.
 *
 * Repo identity comes from `path`, which git only sends when `credential.useHttpPath`
 * is true. Without it every repo on a host looks identical and per-repo token
 * selection silently degrades to "first token wins" — see `configureCredentials`.
 */

export interface CredentialRequest {
  readonly protocol?: string;
  readonly host?: string;
  /** e.g. `caesarakalaeii/Caterpillar.git` — requires credential.useHttpPath=true. */
  readonly path?: string;
  readonly username?: string;
}

export interface CredentialAnswer {
  readonly username: string;
  readonly password: string;
}

/** Parse git's `key=value` block. Unknown keys are ignored, as the protocol requires. */
export const parseRequest = (input: string): CredentialRequest => {
  const request: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    request[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }

  return {
    ...(request["protocol"] !== undefined ? { protocol: request["protocol"] } : {}),
    ...(request["host"] !== undefined ? { host: request["host"] } : {}),
    ...(request["path"] !== undefined ? { path: request["path"] } : {}),
    ...(request["username"] !== undefined ? { username: request["username"] } : {}),
  };
};

/** Serialize the answer git expects on stdout. */
export const formatAnswer = (answer: CredentialAnswer): string =>
  `username=${answer.username}\npassword=${answer.password}\n\n`;

/** What the helper was asked to do, and where to ask. */
export interface HelperInvocation {
  /** `get`, `store` or `erase`; undefined when git passed none. */
  readonly operation: string | undefined;
  readonly socketPath: string | undefined;
}

/**
 * Parse the credential helper's argv.
 *
 * git appends the operation as the LAST argument, AFTER whatever the configured
 * `credential.helper` string already carried — so a helper configured as
 * `!caterpillar-cred --socket /run/caterpillar/cred.sock` is invoked as
 *
 *     caterpillar-cred --socket /run/caterpillar/cred.sock get
 *
 * The socket path is therefore a bare, non-`--` argument sitting BEFORE the operation.
 * "First argument that is not a flag" picks the socket path, not `get`, and the helper
 * then silently declines every request — verified against real git, which is what made
 * this worth a pure function and a test rather than an inline `find`.
 */
export const parseInvocation = (argv: readonly string[]): HelperInvocation => {
  let socketPath: string | undefined;
  const operands: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--socket") {
      socketPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    operands.push(arg);
  }

  return { operation: operands.at(-1), socketPath };
};

/**
 * Split `owner/name.git` into its parts.
 *
 * Returns undefined rather than guessing when the path is absent or malformed: a
 * wrong guess here would hand a token for the wrong repo to the wrong push.
 */
export const parseRepoPath = (
  path: string | undefined,
): { readonly owner: string; readonly name: string } | undefined => {
  if (path === undefined) return undefined;
  const segments = path.replace(/\.git$/, "").split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return undefined;

  const name = segments.at(-1);
  const owner = segments.at(-2);
  if (owner === undefined || name === undefined) return undefined;
  return { owner, name };
};
