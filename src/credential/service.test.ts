/**
 * End-to-end test of the credential path: a real unix socket, a real helper process,
 * and git's actual line protocol. Only the Forge is faked.
 *
 * The wiring is what breaks in practice — protocol framing, socket lifecycle, scope
 * refusal — so this exercises all three rather than unit-testing the parser again.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { asTaskId, type RepoRef, type TaskId } from "../domain/task.ts";
import type { CheckStatus, Forge, GitCredential, PrRequest, PrResult } from "../forge/types.ts";
import { assertInScope } from "../forge/types.ts";
import { CredentialService, taskSocketPath, type ActiveCredential } from "./service.ts";

const HELPER = fileURLToPath(new URL("../cli/credential-helper.ts", import.meta.url));

const REPO: RepoRef = { host: "github.com", owner: "acme", name: "Caterpillar" };
const OTHER_REPO: RepoRef = { host: "github.com", owner: "acme", name: "Sisyphus" };
const STATE_REPO: RepoRef = { host: "github.com", owner: "acme", name: "caterpillar-state" };
const SCOPE = { host: "github.com", stateRepo: STATE_REPO };

const TASK = asTaskId("T-1");
const OTHER_TASK = asTaskId("T-2");

class FakeForge implements Forge {
  readonly kind = "fake";
  minted = 0;

  private readonly allowed: readonly RepoRef[];
  private readonly token: string;

  constructor(allowed: readonly RepoRef[], token = "fake-forge-token") {
    this.allowed = allowed;
    this.token = token;
  }

  async credential(repo: RepoRef): Promise<GitCredential> {
    assertInScope(repo, this.allowed);
    this.minted += 1;
    return { username: "x-access-token", password: this.token };
  }
  async openPr(_repo: RepoRef, _request: PrRequest): Promise<PrResult> {
    throw new Error("unused");
  }
  async checks(_repo: RepoRef, _ref: string): Promise<CheckStatus> {
    throw new Error("unused");
  }
  async approve(): Promise<void> {
    throw new Error("unused");
  }
  async merge(): Promise<void> {
    throw new Error("unused");
  }
  async revoke(): Promise<void> {}
}

/**
 * Invoke the helper exactly as git would.
 *
 * The argument ORDER is load-bearing. git appends the operation AFTER the arguments
 * configured in `credential.helper`, so the real invocation is
 * `--socket <path> get`, not `get --socket <path>`. This harness used to pass them
 * the other way round, which is precisely why a helper that declined every real
 * request had four green tests sitting on top of it.
 */
const runHelper = (socketPath: string, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HELPER, "--socket", socketPath, "get"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end(request);
  });

const dir = await mkdtemp(join(tmpdir(), "caterpillar-cred-"));
const service = new CredentialService();
await service.start(dir);

/** Where a task's helper would be told to connect. */
const socketFor = (task: TaskId): string => taskSocketPath(dir, task);

/**
 * Activate a task and hold the lease for teardown.
 *
 * Every test closes its own leases afterwards, because a socket left listening would
 * make the NEXT test's "this task has no credential" assertion pass for the wrong
 * reason — the failure mode this whole file exists to catch.
 */
const held: { close(): Promise<void> }[] = [];
const activate = async (task: TaskId, active: ActiveCredential): Promise<void> => {
  held.push(await service.activate(task, active));
};

afterEach(async () => {
  await Promise.all(held.splice(0).map((lease) => lease.close()));
});

after(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

test("serves a credential for a repo in the active task's scope", async () => {
  const forge = new FakeForge([REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n",
  );

  assert.equal(output, "username=x-access-token\npassword=fake-forge-token\n\n");
  assert.equal(forge.minted, 1);
});

test("two concurrent tasks are served their own credentials, not each other's", async () => {
  // The blocker this keying exists to remove. With a single `active` slot the service
  // answered whichever task registered LAST, so on a runner working two tasks the first
  // task's agent got the second's token — with nothing adversarial happening, on the
  // ordinary path, for both repos it asked about.
  const forgeA = new FakeForge([REPO], "token-for-task-A");
  const forgeB = new FakeForge([OTHER_REPO], "token-for-task-B");

  await activate(TASK, { forge: forgeA, repos: [REPO], scope: SCOPE });
  await activate(OTHER_TASK, { forge: forgeB, repos: [OTHER_REPO], scope: SCOPE });

  const [a, b] = await Promise.all([
    runHelper(
      socketFor(TASK),
      "protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n",
    ),
    runHelper(
      socketFor(OTHER_TASK),
      "protocol=https\nhost=github.com\npath=acme/Sisyphus.git\n\n",
    ),
  ]);

  assert.match(a, /^password=token-for-task-A$/m);
  assert.match(b, /^password=token-for-task-B$/m);
  assert.equal(forgeA.minted, 1);
  assert.equal(forgeB.minted, 1);
});

test("a task is not served another task's repo, even on its own socket", async () => {
  // The narrowing filter, per task rather than per runner: task A holding a valid
  // credential is not a reason to answer A about a repo only B declared.
  const forgeA = new FakeForge([REPO, OTHER_REPO]);
  const forgeB = new FakeForge([OTHER_REPO]);

  await activate(TASK, { forge: forgeA, repos: [REPO], scope: SCOPE });
  await activate(OTHER_TASK, { forge: forgeB, repos: [OTHER_REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/Sisyphus.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forgeA.minted, 0);
  assert.equal(forgeB.minted, 0);
});

test("clearing one task leaves the other served", async () => {
  // A session that finishes must not be able to take a concurrent one's credential with
  // it. That was structurally impossible to get right with a single global `clearActive`.
  const forgeA = new FakeForge([REPO]);
  const forgeB = new FakeForge([OTHER_REPO], "token-for-task-B");

  const leaseA = await service.activate(TASK, { forge: forgeA, repos: [REPO], scope: SCOPE });
  await activate(OTHER_TASK, { forge: forgeB, repos: [OTHER_REPO], scope: SCOPE });

  await leaseA.close();

  const refused = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n",
  );
  const served = await runHelper(
    socketFor(OTHER_TASK),
    "protocol=https\nhost=github.com\npath=acme/Sisyphus.git\n\n",
  );

  assert.equal(refused, "");
  assert.equal(forgeA.minted, 0);
  assert.match(served, /^password=token-for-task-B$/m);
});

test("a closed task's socket is unlinked from the directory", async () => {
  // Not tidiness: a socket file left behind is a path a helper can still be configured
  // with, and the next `listen()` on it fails with EADDRINUSE — so a resumed task would
  // be unable to open the very socket it needs.
  const forge = new FakeForge([REPO]);
  const lease = await service.activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  assert.equal(existsSync(socketFor(TASK)), true);
  await lease.close();
  assert.equal(existsSync(socketFor(TASK)), false);

  // Idempotent: the loop's lease-lost path and the session's `finally` can both fire.
  await lease.close();
});

test("a leftover socket from a previous process does not block a restart", async () => {
  // A pod killed mid-session leaves a bound socket on the PVC. Without the sweep in
  // `start()`, activating that same task after the restart fails with EADDRINUSE — the
  // restart could not finish the task it was restarted for.
  const stale = await mkdtemp(join(tmpdir(), "caterpillar-cred-stale-"));
  await writeFile(taskSocketPath(stale, TASK), "not really a socket");

  const restarted = new CredentialService();
  await restarted.start(stale);
  assert.equal(existsSync(taskSocketPath(stale, TASK)), false);

  const forge = new FakeForge([REPO]);
  const lease = await restarted.activate(TASK, { forge, repos: [REPO], scope: SCOPE });
  const output = await runHelper(
    lease.socketPath,
    "protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n",
  );

  assert.match(output, /^password=fake-forge-token$/m);
  await restarted.stop();
  await rm(stale, { recursive: true, force: true });
});

test("refuses a repo outside the active task's scope", async () => {
  const forge = new FakeForge([REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/some-other-repo.git\n\n",
  );

  // Silence means "no credential"; git then reports a normal auth failure.
  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses when the named task has no active credential", async () => {
  // Nothing is activated, so nothing is listening — the helper cannot connect and stays
  // silent, which is the same answer git gets from a refusal.
  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n",
  );

  assert.equal(output, "");
});

test("real git gets a usable credential out of the helper", async () => {
  // The end of the chain the unit tests keep missing: REAL git, invoking the helper
  // its own way, through a real socket. `credential fill` is the same code path a
  // clone or push takes to resolve a credential, minus the network — so this pins
  // git's actual argv convention rather than our belief about it.
  //
  // The operator's own config is neutralised: a global `url.<ssh>.insteadOf` or a
  // configured `gh` helper would otherwise answer first and hide a broken helper.
  const forge = new FakeForge([REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        `credential.helper=!${process.execPath} ${HELPER} --socket ${socketFor(TASK)}`,
        "-c",
        "credential.useHttpPath=true",
        "credential",
        "fill",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end("protocol=https\nhost=github.com\npath=acme/Caterpillar.git\n\n");
  });

  assert.match(output, /^username=x-access-token$/m);
  assert.match(output, /^password=fake-forge-token$/m);
  assert.equal(forge.minted, 1);
});

test("refuses when git sent no path (useHttpPath not enabled)", async () => {
  const forge = new FakeForge([REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await runHelper(socketFor(TASK), "protocol=https\nhost=github.com\n\n");

  // Without a path we cannot tell repos apart, so serving anything would risk
  // handing the wrong repo's token to a push.
  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses a host the workspace does not own, even when the task declared it", async () => {
  // The attack this exists to stop: `spec.repos` is free text from an issue body, and
  // the clone URL is built from `repo.host`. Matching the request against the task's
  // own declared list is a tautology — the attacker wrote the list. A runner that
  // clones `evil.example.com/acme/Caterpillar` with the helper attached gets
  // a 401 back, and the helper must NOT answer it.
  //
  // This is also the ORDER assertion: the hostile repo IS in the task's `repos` list, so
  // the only thing that can refuse it is `assertWorkspaceScope` running first.
  const hostile: RepoRef = { host: "evil.example.com", owner: "acme", name: "Caterpillar" };
  const forge = new FakeForge([REPO, hostile]);
  await activate(TASK, { forge, repos: [REPO, hostile], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=evil.example.com\npath=acme/Caterpillar.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses a repo inside the workspace scope but outside the task's repos", async () => {
  // The other half of the ordering. This repo passes `assertWorkspaceScope` — same host,
  // not the state repo — and is refused purely by the task's own narrowing list, which is
  // what makes the two checks distinguishable rather than one check counted twice.
  const forge = new FakeForge([REPO, OTHER_REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/Sisyphus.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses the supervisor's own state repo", async () => {
  // DESIGN.md §9.3: the audit trail cannot be writable by the thing being audited.
  // The state repo is on the same host as the workspace, so the host check does not
  // reach it — it needs naming explicitly.
  const forge = new FakeForge([REPO, STATE_REPO]);
  await activate(TASK, { forge, repos: [REPO, STATE_REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=github.com\npath=acme/caterpillar-state.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses the state repo under a different casing", async () => {
  // GitHub resolves `Caterpillar-State` and `caterpillar-state` to the same repo, so a
  // case-sensitive comparison is not an exclusion at all.
  const disguised: RepoRef = { host: "GitHub.com", owner: "Acme", name: "Caterpillar-State" };
  const forge = new FakeForge([REPO, disguised]);
  await activate(TASK, { forge, repos: [REPO, disguised], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=https\nhost=GitHub.com\npath=Acme/Caterpillar-State.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses a plaintext http request for an in-scope repo", async () => {
  // `credential.useHttpPath=true` is set on config the agent can add remotes to, so an
  // `http://` remote for a real in-scope repo would otherwise get the installation
  // token sent as cleartext Basic auth.
  const forge = new FakeForge([REPO]);
  await activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const output = await runHelper(
    socketFor(TASK),
    "protocol=http\nhost=github.com\npath=acme/Caterpillar.git\n\n",
  );

  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("a task id that could escape the socket directory is refused outright", async () => {
  // `TaskId` is a brand, not a guarantee — it is `asTaskId(...)` over text that may have
  // come from an issue body. A path built from it is checked rather than trusted.
  assert.throws(() => taskSocketPath(dir, asTaskId("../escape")), /not a usable task id/);
  assert.throws(() => taskSocketPath(dir, asTaskId("..")), /not a usable task id/);
});

test("closing a lease does not wait on a stalled helper connection", async () => {
  // `server.close()` refuses new connections but calls back only once every EXISTING one
  // has ended. `close()` is now taken in the session runner's `finally`, so a helper that
  // connected and then said nothing — a wedged git, a killed child — would hang that
  // `finally`, and with it the supervisor, not merely the task.
  //
  // Revoking a credential is also the exact moment an in-flight request for it should
  // stop, so the connection is destroyed rather than drained.
  const forge = new FakeForge([REPO]);
  const lease = await service.activate(TASK, { forge, repos: [REPO], scope: SCOPE });

  const stalled = connect(lease.socketPath);
  await new Promise<void>((resolve, reject) => {
    stalled.once("connect", () => resolve());
    stalled.once("error", reject);
  });

  await Promise.race([
    lease.close(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("close() waited on a stalled connection")), 2_000),
    ),
  ]);

  stalled.destroy();
  assert.equal(existsSync(socketFor(TASK)), false);
});

test("an over-long socket path is refused with a message that names the cause", async () => {
  // The kernel caps `sun_path` at 107 bytes, and `listen()` past it reports EADDRINUSE —
  // so without this check the operator is told there is a stale socket in the way of a
  // path that has never existed. Reachable for real: task ids here are long and the
  // socket directory is rooted wherever the installer was pointed.
  assert.throws(
    () => taskSocketPath(`/${"d".repeat(100)}`, TASK),
    /kernel allows 107/,
  );
});
