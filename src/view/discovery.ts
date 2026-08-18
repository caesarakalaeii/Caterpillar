/**
 * Which runners exist, asked of DNS rather than of Kubernetes. See DESIGN.md §18.
 *
 * The viewer is a second Deployment that holds no state-repo credential, no forge token, no
 * Anthropic credential, no PVC and no ServiceAccount token. Listing pods through the
 * Kubernetes API would undo the last of those: it needs RBAC, a mounted token, and a
 * rolebinding to review \u2014 for a fact the cluster already publishes.
 *
 * `caterpillar-headless` is a headless Service with a named `web` port, so
 * `_web._tcp.caterpillar-headless.<ns>.svc.cluster.local` enumerates exactly the READY
 * pods, by stable name, and shrinks and grows with `kubectl scale`. No replica count in a
 * ConfigMap to fall out of step with the StatefulSet, and no membership list to maintain.
 *
 * The SRV target is the pod's stable DNS name (`caterpillar-0.caterpillar-headless.…`),
 * which is what makes a runner nameable on the page: a merged log line has to say which
 * process produced it, and an IP would make that unreadable.
 */
import { promises as dns } from "node:dns";

/** One runner the viewer can talk to. */
export interface RunnerEndpoint {
  /**
   * Short, human-facing name \u2014 the pod name, taken from the first label of the SRV target.
   * Used as the display name and as the key a log line is tagged with.
   */
  readonly name: string;
  /** The base URL to fan out to, without a trailing slash. */
  readonly base: string;
}

export interface Discovery {
  /** The runners believed to be ready right now. Never throws; empty on failure. */
  runners(): Promise<readonly RunnerEndpoint[]>;
}

export interface SrvRecord {
  readonly name: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

export interface SrvDiscoveryOptions {
  /** The full SRV name, e.g. `_web._tcp.caterpillar-headless.caterpillar.svc.cluster.local`. */
  readonly service: string;
  /** Injected so the tests do not need a resolver. Defaults to Node's. */
  readonly resolveSrv?: (name: string) => Promise<readonly SrvRecord[]>;
  /** Told when resolution fails, so an empty page is explainable. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Turn a SRV target into the two things the viewer needs.
 *
 * The port comes from the record rather than from configuration: it is the `web` port the
 * Service declares, so a runner whose port is changed in one manifest does not need the
 * viewer's manifest changed to match.
 *
 * The name is the first DNS label, with the trailing dot handled: `caterpillar-0.` and
 * `caterpillar-0` are the same host, and a page that showed one of them with a dot on the
 * end would look like a bug in the aggregation rather than in the formatting.
 */
export const endpointOf = (record: SrvRecord): RunnerEndpoint => {
  const host = record.name.replace(/\.$/, "");
  const name = host.split(".")[0] ?? host;
  return { name, base: `http://${host}:${record.port}` };
};

export class SrvDiscovery implements Discovery {
  private readonly options: SrvDiscoveryOptions;

  constructor(options: SrvDiscoveryOptions) {
    this.options = options;
  }

  /**
   * Resolve, sorted by name so the page does not reshuffle between refreshes.
   *
   * Never throws. A resolver failure is a dashboard that says it can see no runners, which
   * is a fact an operator can act on; an exception here would be a 500 on every page of a
   * process whose entire job is to be readable when things are wrong.
   */
  async runners(): Promise<readonly RunnerEndpoint[]> {
    const resolve = this.options.resolveSrv ?? defaultResolve;
    try {
      const records = await resolve(this.options.service);
      return [...records]
        .map(endpointOf)
        .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    } catch (error: unknown) {
      this.options.onError?.(error);
      return [];
    }
  }
}

const defaultResolve = async (name: string): Promise<readonly SrvRecord[]> => dns.resolveSrv(name);

/**
 * A fixed list, for a workstation and for the tests.
 *
 * Outside a cluster there is no SRV record and no headless Service, and the alternative to
 * this is a viewer that can only ever be run in Kubernetes \u2014 which would make the one thing
 * worth testing by hand impossible to test by hand.
 */
export class StaticDiscovery implements Discovery {
  private readonly endpoints: readonly RunnerEndpoint[];

  constructor(endpoints: readonly RunnerEndpoint[]) {
    this.endpoints = endpoints;
  }

  runners(): Promise<readonly RunnerEndpoint[]> {
    return Promise.resolve(this.endpoints);
  }
}

/**
 * Parse `caterpillar-0=http://host:8080,caterpillar-1=http://…` into endpoints.
 *
 * The escape hatch for running the viewer outside the cluster. A bare URL is allowed and
 * names itself by its host, because typing the name twice for a one-off is friction with
 * no safety in it.
 */
export const parseRunnerList = (value: string): readonly RunnerEndpoint[] => {
  const out: RunnerEndpoint[] = [];
  for (const entry of value.split(",").map((part) => part.trim())) {
    if (entry === "") continue;
    const split = entry.indexOf("=");
    const name = split === -1 ? undefined : entry.slice(0, split).trim();
    const base = (split === -1 ? entry : entry.slice(split + 1)).trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) continue;
    out.push({ name: name === undefined || name === "" ? hostOf(base) : name, base });
  }
  return out;
};

const hostOf = (base: string): string => {
  try {
    return new URL(base).hostname;
  } catch {
    return base;
  }
};
