/**
 * End-to-end test of the credential path: a real unix socket, a real helper process,
 * and git's actual line protocol. Only the Forge is faked.
 *
 * The wiring is what breaks in practice — protocol framing, socket lifecycle, scope
 * refusal — so this exercises all three rather than unit-testing the parser again.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RepoRef } from "../domain/task.ts";
import type { CheckStatus, Forge, GitCredential, PrRequest, PrResult } from "../forge/types.ts";
import { assertInScope } from "../forge/types.ts";
import { CredentialService } from "./service.ts";

const HELPER = fileURLToPath(new URL("../cli/credential-helper.ts", import.meta.url));

const REPO: RepoRef = { host: "github.com", owner: "caesarakalaeii", name: "Caterpillar" };

class FakeForge implements Forge {
  readonly kind = "fake";
  minted = 0;

  constructor(private readonly allowed: readonly RepoRef[]) {}

  async credential(repo: RepoRef): Promise<GitCredential> {
    assertInScope(repo, this.allowed);
    this.minted += 1;
    return { username: "x-access-token", password: "ghs_fake_token" };
  }
  async openPr(_repo: RepoRef, _request: PrRequest): Promise<PrResult> {
    throw new Error("unused");
  }
  async checks(_repo: RepoRef, _ref: string): Promise<CheckStatus> {
    throw new Error("unused");
  }
  async revoke(): Promise<void> {}
}

/** Invoke the helper exactly as git would. */
const runHelper = (socketPath: string, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", HELPER, "get", "--socket", socketPath],
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
const socketPath = join(dir, "cred.sock");
const service = new CredentialService();
await service.start(socketPath);

after(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

test("serves a credential for a repo in the active task's scope", async () => {
  const forge = new FakeForge([REPO]);
  service.setActive({ forge, repos: [REPO] });

  const output = await runHelper(
    socketPath,
    "protocol=https\nhost=github.com\npath=caesarakalaeii/Caterpillar.git\n\n",
  );

  assert.equal(output, "username=x-access-token\npassword=ghs_fake_token\n\n");
  assert.equal(forge.minted, 1);
});

test("refuses a repo outside the active task's scope", async () => {
  const forge = new FakeForge([REPO]);
  service.setActive({ forge, repos: [REPO] });

  const output = await runHelper(
    socketPath,
    "protocol=https\nhost=github.com\npath=caesarakalaeii/some-other-repo.git\n\n",
  );

  // Silence means "no credential"; git then reports a normal auth failure.
  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});

test("refuses when no task is active", async () => {
  service.clearActive();

  const output = await runHelper(
    socketPath,
    "protocol=https\nhost=github.com\npath=caesarakalaeii/Caterpillar.git\n\n",
  );

  assert.equal(output, "");
});

test("refuses when git sent no path (useHttpPath not enabled)", async () => {
  const forge = new FakeForge([REPO]);
  service.setActive({ forge, repos: [REPO] });

  const output = await runHelper(socketPath, "protocol=https\nhost=github.com\n\n");

  // Without a path we cannot tell repos apart, so serving anything would risk
  // handing the wrong repo's token to a push.
  assert.equal(output, "");
  assert.equal(forge.minted, 0);
});
