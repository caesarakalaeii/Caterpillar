/**
 * The namespace guard for supervisor-mediated cluster reads. See DESIGN.md §20.
 *
 * Modelled on `assertWorkspaceScope` in `forge/types.ts`, and for the same reason: a bound
 * the operator set has to be checked in one named place that throws, not spread through
 * the callers as an `if` each of them could forget. Every method on the client calls this
 * BEFORE any IO, and `client.test.ts` proves that per method by injecting a request
 * function that fails the test if it is ever reached.
 *
 * The allowlist comes from `config.cluster.namespaces` and only from there. There is no
 * per-task and no per-alert namespace list, deliberately: an entry in a file the alert
 * path consults could then widen its own access, which is not a bound at all (§20,
 * "There is deliberately no `namespaces` field").
 */

export class NamespaceNotAllowedError extends Error {
  constructor(namespace: string, allowed: readonly string[]) {
    super(
      allowed.length === 0
        ? `namespace '${namespace}' is not readable: this runner has no cluster namespace ` +
            `allowlist configured, so every namespace is denied. An operator sets ` +
            `cluster.namespaces in the supervisor's ConfigMap; nothing in a task or an ` +
            `alert can widen it`
        : `namespace '${namespace}' is not readable. Allowed namespaces are: ` +
            `${allowed.join(", ")}. This is supervisor configuration ` +
            `(cluster.namespaces) and cannot be widened from a session`,
    );
    this.name = "NamespaceNotAllowedError";
  }
}

/**
 * Throw unless `ns` is one the operator allowed.
 *
 * An EMPTY allowlist denies everything. That is the whole reason this is a function with a
 * test rather than an `includes` at the call site: "no list configured" and "allow
 * everything" are the same expression in most idioms, and the misconfiguration this
 * feature can actually suffer — a `cluster.enabled: true` with the namespaces field
 * forgotten — must fail closed and say why.
 *
 * Exact string comparison, not case-insensitive and not prefix-matched. Kubernetes
 * namespace names are already lowercase by grammar, so folding case would only add a way
 * for two spellings to mean one namespace; and a prefix match would turn `monitoring`
 * into a grant over `monitoring-staging`.
 */
export const assertNamespaceAllowed = (ns: string, allowed: readonly string[]): void => {
  if (!allowed.includes(ns)) throw new NamespaceNotAllowedError(ns, allowed);
};
