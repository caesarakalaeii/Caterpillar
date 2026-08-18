/**
 * Discovery, which is a DNS lookup and nothing else.
 *
 * The property worth pinning is that this needs no Kubernetes API, no RBAC and no mounted
 * ServiceAccount token: the headless Service already publishes one SRV record per ready
 * pod, with a stable name, and it shrinks and grows with `kubectl scale`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointOf, parseRunnerList, SrvDiscovery, StaticDiscovery } from "./discovery.ts";

test("a SRV record becomes a nameable endpoint on its own port", async () => {
  // The port comes from the record, not from the viewer's config: a runner whose `web`
  // port changes in one manifest must not need a second manifest changed to match.
  assert.deepEqual(
    endpointOf({
      name: "caterpillar-0.caterpillar-headless.caterpillar.svc.cluster.local.",
      port: 8080,
      priority: 0,
      weight: 100,
    }),
    {
      name: "caterpillar-0",
      base: "http://caterpillar-0.caterpillar-headless.caterpillar.svc.cluster.local:8080",
    },
  );
});

test("runners are ordered by name so a refresh does not reshuffle the page", async () => {
  // DNS answers in whatever order it likes, deliberately. Numeric collation keeps
  // `caterpillar-10` after `caterpillar-9` rather than between `-1` and `-2`.
  const subject = new SrvDiscovery({
    service: "_web._tcp.caterpillar-headless.caterpillar.svc.cluster.local",
    resolveSrv: () =>
      Promise.resolve(
        ["caterpillar-10", "caterpillar-2", "caterpillar-1"].map((name) => ({
          name: `${name}.caterpillar-headless.caterpillar.svc.cluster.local`,
          port: 8080,
          priority: 0,
          weight: 100,
        })),
      ),
  });

  assert.deepEqual(
    (await subject.runners()).map((runner) => runner.name),
    ["caterpillar-1", "caterpillar-2", "caterpillar-10"],
  );
});

test("a resolver that fails leaves an empty fleet and one warning, not a 500", async () => {
  // This process's entire job is to be readable when things are wrong. A DNS blip must
  // render as "no runners visible", which an operator can act on.
  const errors: unknown[] = [];
  const subject = new SrvDiscovery({
    service: "_web._tcp.nope.invalid",
    resolveSrv: () => Promise.reject(new Error("ENOTFOUND")),
    onError: (error) => errors.push(error),
  });

  assert.deepEqual(await subject.runners(), []);
  assert.equal(errors.length, 1);
});

test("an explicit runner list is the escape hatch for running this outside a cluster", async () => {
  assert.deepEqual(
    parseRunnerList("caterpillar-0=http://10.0.0.1:8080, http://10.0.0.2:8080/ , nonsense"),
    [
      { name: "caterpillar-0", base: "http://10.0.0.1:8080" },
      // A bare URL names itself by host: typing the name twice for a one-off is friction
      // with no safety in it.
      { name: "10.0.0.2", base: "http://10.0.0.2:8080" },
    ],
  );

  const subject = new StaticDiscovery(parseRunnerList("a=http://x:1"));
  assert.deepEqual(await subject.runners(), [{ name: "a", base: "http://x:1" }]);
});
