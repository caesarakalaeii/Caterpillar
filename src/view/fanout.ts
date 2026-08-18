/**
 * One HTTP GET per runner, and what to do when one of them does not answer.
 * See DESIGN.md §18.
 *
 * The viewer holds no credential of any kind: its data source is the same `/api/*` routes
 * every runner already serves out of the checkout it maintains anyway. What it must carry
 * is the IDENTITY the proxy vouched for \u2014 the runners' `web.requireForwardedUser` is a
 * fail-closed check on the Ingress losing its forward-auth annotations, and relaxing it so
 * a viewer could talk to them would punch exactly the hole that check exists to notice. So
 * the header the viewer received is forwarded, and a runner's port stays useless to
 * anything in the cluster that cannot present an identity Authelia signed for.
 *
 * A runner that times out or refuses is REPORTED, not swallowed. A dashboard that silently
 * drops a replica is worse than one that has none, because a missing runner reads as an
 * idle runner \u2014 and "three of the four are idle" is a sentence an operator will act on.
 */
import type { RunnerEndpoint } from "./discovery.ts";

/** What one runner answered, or why it did not. */
export type RunnerReply<T> =
  | { readonly runner: RunnerEndpoint; readonly ok: true; readonly value: T }
  | { readonly runner: RunnerEndpoint; readonly ok: false; readonly error: string };

export interface FanoutOptions {
  /** Milliseconds one runner gets before it is called unreachable. */
  readonly timeoutMs: number;
  /** Injected so tests drive real sockets or none at all. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** The header name the identity arrives in, e.g. `remote-user`. */
  readonly forwardedUserHeader: string;
}

export interface FanoutRequest {
  /** Path on the runner, always starting with `/api/` or `/healthz`. */
  readonly path: string;
  /** The identity to forward, when the incoming request carried one. */
  readonly user?: string;
}

/**
 * The one place a request leaves the viewer.
 *
 * Every method is a GET. There is no `post` here and there should never be one: the viewer
 * is a second read-only front door or it is a mistake, and the absence of a write verb in
 * this file is the cheapest way to keep that checkable.
 */
export class Fanout {
  private readonly options: FanoutOptions;

  constructor(options: FanoutOptions) {
    this.options = options;
  }

  /**
   * Ask every runner the same question, in parallel, and keep both answers and failures.
   *
   * `Promise.all` over per-runner catches rather than `allSettled` on the raw fetches: a
   * rejection has to be attributed to the runner that produced it, and the attribution is
   * the whole point.
   */
  async all<T>(
    runners: readonly RunnerEndpoint[],
    request: FanoutRequest,
  ): Promise<readonly RunnerReply<T>[]> {
    return Promise.all(runners.map((runner) => this.one<T>(runner, request)));
  }

  /**
   * The first runner that answers, with the failures alongside.
   *
   * For data that is IDENTICAL everywhere: the state repo is the fleet's shared surface, so
   * a task list, a spec, a journal and a stored transcript are the same bytes on every
   * replica, and asking four is four times the work for one answer. The failures are still
   * returned, because "you are reading this from the one runner that is up" is worth
   * saying.
   *
   * Sequential on purpose. Racing four requests and taking the winner would make an
   * ordinary page load four times as much work on a fleet where the first runner is
   * healthy, which it almost always is.
   */
  async first<T>(
    runners: readonly RunnerEndpoint[],
    request: FanoutRequest,
  ): Promise<{ readonly value?: T; readonly failures: readonly RunnerReply<T>[]; readonly from?: RunnerEndpoint }> {
    const failures: RunnerReply<T>[] = [];
    for (const runner of runners) {
      const reply = await this.one<T>(runner, request);
      if (reply.ok) return { value: reply.value, failures, from: runner };
      failures.push(reply);
    }
    return { failures };
  }

  /** One runner, one GET, never throwing. */
  async one<T>(runner: RunnerEndpoint, request: FanoutRequest): Promise<RunnerReply<T>> {
    const call = this.options.fetch ?? fetch;
    // An abort rather than a bare `Promise.race`: a page must not keep a socket open to a
    // wedged runner for as long as the process lives, and four of those per refresh is a
    // file-descriptor leak with a countdown on it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await call(`${runner.base}${request.path}`, {
        method: "GET",
        signal: controller.signal,
        headers: this.headers(request),
      });
      if (!response.ok) {
        return { runner, ok: false, error: `${response.status} ${response.statusText}`.trim() };
      }
      return { runner, ok: true, value: (await response.json()) as T };
    } catch (error: unknown) {
      return { runner, ok: false, error: reason(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A body rather than JSON \u2014 a raw transcript is served as `text/plain` and an artifact as
   * octet-stream, and re-encoding either would change the bytes an operator downloaded.
   */
  async bytes(
    runners: readonly RunnerEndpoint[],
    request: FanoutRequest,
  ): Promise<{ readonly body?: Buffer; readonly type?: string; readonly failures: readonly string[] }> {
    const call = this.options.fetch ?? fetch;
    const failures: string[] = [];

    for (const runner of runners) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await call(`${runner.base}${request.path}`, {
          method: "GET",
          signal: controller.signal,
          headers: this.headers(request),
        });
        if (!response.ok) {
          failures.push(`${runner.name}: ${response.status}`);
          continue;
        }
        return {
          body: Buffer.from(await response.arrayBuffer()),
          type: response.headers.get("content-type") ?? "application/octet-stream",
          failures,
        };
      } catch (error: unknown) {
        failures.push(`${runner.name}: ${reason(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return { failures };
  }

  private headers(request: FanoutRequest): Record<string, string> {
    return {
      accept: "application/json",
      // Forwarded rather than minted. The viewer authenticates nobody: it repeats what the
      // proxy in front of IT asserted, so a runner sees the same identity it would have
      // seen when the Ingress pointed at it directly.
      ...(request.user === undefined ? {} : { [this.options.forwardedUserHeader]: request.user }),
    };
  }
}

/** A failure an operator can read: `AbortError` on its own says nothing about a timeout. */
const reason = (error: unknown): string => {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError"
      ? "timed out"
      : error.message;
  }
  return String(error);
};
