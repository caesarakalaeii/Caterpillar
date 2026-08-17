/**
 * Bringing the state-repo checkout into existence, and keeping it configured.
 *
 * The PVC outlives every pod that mounts it, so "set on clone" means "set once, in some
 * pod that no longer exists". Anything the supervisor needs the checkout to be must
 * therefore be re-asserted on every start, not applied at creation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Git } from "./git.ts";
import { ensureStateCheckout } from "./bootstrap.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const IDENTITY = {
  name: "caterpillar-agent[bot]",
  email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
};

/** A bare remote with one commit on `main`, and a place to check it out. */
const fixture = async (): Promise<{ readonly url: string; readonly path: string }> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-bootstrap-"));
  roots.push(root);

  const url = join(root, "origin.git");
  const seed = join(root, "seed");
  const setup = new Git(root);
  await setup.run("init", "--bare", "--initial-branch=main", url);
  await setup.run("clone", url, seed);

  const git = new Git(seed);
  await git.run("config", "user.email", "seed@example.invalid");
  await git.run("config", "user.name", "seed");
  await git.run("commit", "--allow-empty", "-m", "seed");
  await git.run("push", "origin", "HEAD:main");

  return { url, path: join(root, "state") };
};

const identityOf = async (path: string): Promise<{ name: string; email: string }> => {
  const git = new Git(path);
  return {
    name: await git.run("config", "--get", "user.name"),
    email: await git.run("config", "--get", "user.email"),
  };
};

test("a fresh checkout is configured with the identity it was given", async () => {
  const { url, path } = await fixture();

  await ensureStateCheckout({ path, url, branch: "main", identity: IDENTITY });

  assert.deepEqual(await identityOf(path), IDENTITY);
});

test("an existing checkout has its identity brought up to date", async () => {
  // The defect. Identity was applied only on the clone, and the clone happens once in
  // the life of a PVC — so correcting the configured identity changed nothing at all on
  // any runner that already had a checkout, which is every runner that has ever run. The
  // supervisor kept authoring the audit trail as the old name, with a ConfigMap in front
  // of it saying otherwise.
  const { url, path } = await fixture();

  await ensureStateCheckout({
    path,
    url,
    branch: "main",
    identity: { name: "caterpillar", email: "caterpillar@users.noreply.github.com" },
  });
  await ensureStateCheckout({ path, url, branch: "main", identity: IDENTITY });

  assert.deepEqual(await identityOf(path), IDENTITY);
});

test("an existing checkout is reused, not re-cloned", async () => {
  // Crash recovery is "fetch and reclaim", never "start again": a re-clone would discard
  // whatever a killed pod had written and not yet pushed.
  const { url, path } = await fixture();

  await ensureStateCheckout({ path, url, branch: "main", identity: IDENTITY });
  const git = new Git(path);
  await git.run("commit", "--allow-empty", "-m", "work in progress");
  const local = await git.run("rev-parse", "HEAD");

  await ensureStateCheckout({ path, url, branch: "main", identity: IDENTITY });

  assert.equal(
    await git.run("rev-parse", "HEAD"),
    local,
    "an unpushed commit must survive a restart",
  );
});
