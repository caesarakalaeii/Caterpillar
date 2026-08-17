/**
 * Bring the state-repo checkout into existence. See DESIGN.md §4, §6.2.
 *
 * The supervisor's durable state lives on a PVC that starts empty, and a pod restart
 * must be safe at any instant — so this is idempotent: an existing checkout is left
 * alone (crash recovery is "fetch and reclaim", not "re-clone"), and a missing one is
 * cloned.
 *
 * Identity is configured locally rather than inherited: on a machine runner the
 * operator's global git identity would otherwise author the audit trail.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Git, type GitEnvProvider } from "./git.ts";

export interface StateCheckoutOptions {
  readonly path: string;
  readonly url: string;
  readonly branch: string;
  readonly identity: { readonly name: string; readonly email: string };
  /**
   * Credential for the clone. Passed explicitly rather than taken from a `Git`,
   * because `Git.at()` deliberately does not carry a credential across directories.
   */
  readonly envProvider?: GitEnvProvider;
}

const isDirectory = async (path: string): Promise<boolean> =>
  stat(path)
    .then((entry) => entry.isDirectory())
    .catch(() => false);

/** Returns a Git bound to the checkout, carrying the state-repo credential. */
export const ensureStateCheckout = async (options: StateCheckoutOptions): Promise<Git> => {
  const git = new Git(options.path, process.env, options.envProvider);

  if (!(await isDirectory(`${options.path}/.git`))) {
    const parent = dirname(options.path);
    await mkdir(parent, { recursive: true });

    // Cloned from the parent: the target does not exist yet, so a Git bound to it has
    // no working directory to run in.
    const cloner = new Git(parent, process.env, options.envProvider);
    await cloner.run("clone", "--branch", options.branch, options.url, options.path);
  }

  // Re-asserted on EVERY start, not applied at creation. The checkout lives on a PVC
  // that outlives every pod that mounts it, so a clone happens once in the life of a
  // volume — and configuring the identity there meant that correcting it in the
  // ConfigMap changed nothing on any runner that already had a checkout, which is every
  // runner that has ever run. The supervisor went on authoring the audit trail as the
  // old name with a config in front of it saying otherwise, and nothing said so.
  //
  // Cheap and idempotent: two `git config` writes on a local file, once per process.
  await git.run("config", "user.name", options.identity.name);
  await git.run("config", "user.email", options.identity.email);
  return git;
};
