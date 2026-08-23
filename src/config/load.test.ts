/**
 * Tests for the sections whose DEFAULTS are load-bearing — `web` (DESIGN.md §18), `digest`
 * (§19), `cluster` (§20) and `remediation` (§20).
 *
 * All four default to off, and all four do something outward-facing when they are on: one
 * opens a port that answers with agent transcripts, one posts to a shared channel and
 * commits to a shared repo, one reads a live cluster with the supervisor's own
 * ServiceAccount, and one opens a port on which a firing alert becomes a task. A runner
 * someone started on a laptop must not begin doing any of it because it was upgraded, and
 * one that HAS been told to must not silently do it wrongly — unauthenticated, at an hour a
 * misspelt zone quietly turned into UTC, or against a namespace nobody allowed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError, loadConfig } from "./load.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const BASE = {
  capabilities: ["linux"],
  // Required, and validated in identity.test.ts. Present here only so these tests are
  // about the `web` section rather than about a config that will not load.
  identity: {
    name: "caterpillar-agent[bot]",
    email: "316492202+caterpillar-agent[bot]@users.noreply.github.com",
  },
  stateRepo: { url: "https://example.invalid/state.git", branch: "main", path: "/work/state" },
  paths: { mirrors: "/work/mirrors", tasks: "/work/tasks" },
  secretsDir: "/etc/caterpillar/secrets",
  llm: {
    auth: "proxy",
    baseUrl: "http://llm-proxy",
    modelId: "m",
    providerId: "p",
    contextWindow: 200000,
    maxTokens: 32000,
  },
  workspaces: {
    primary: {
      forge: { kind: "github", host: "github.com", owner: "acme", apiBase: "https://api.github.com" },
      secretRef: "caterpillar-github-app",
    },
  },
};

const load = async (over: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadConfig>>> => {
  const root = await mkdtemp(join(tmpdir(), "caterpillar-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ ...BASE, ...over }), "utf8");
  process.env["RUNNER_ID"] = "test-runner";
  return loadConfig(path);
};

test("a config that says nothing about the web view does not serve one", async () => {
  // The view exposes every transcript the fleet has produced. A runner on a laptop must
  // not start answering for them because it was upgraded.
  const config = await load({});
  assert.equal(config.web.enabled, false);
});

test("enabling it takes the documented defaults", async () => {
  const config = await load({ web: { enabled: true } });

  assert.equal(config.web.enabled, true);
  assert.equal(config.web.port, 8080);
  assert.equal(config.web.logCapacity, 500);
  assert.equal(config.web.refreshSeconds, 10);
  assert.equal(config.web.requireForwardedUser, false);
  assert.equal(config.web.forwardedUserHeader, "remote-user");
});

test("every field can be set", async () => {
  const config = await load({
    web: {
      enabled: true,
      port: 9999,
      logCapacity: 50,
      refreshSeconds: 3,
      requireForwardedUser: true,
      forwardedUserHeader: "X-Auth-User",
    },
  });

  assert.equal(config.web.port, 9999);
  assert.equal(config.web.logCapacity, 50);
  assert.equal(config.web.refreshSeconds, 3);
  assert.equal(config.web.requireForwardedUser, true);
  assert.equal(config.web.forwardedUserHeader, "x-auth-user", "matched against a lowercased header");
});

test("a non-boolean where a boolean belongs is refused rather than coerced", async () => {
  // `requireForwardedUser: "false"` is truthy in JavaScript and false in intent. Coercing
  // it either way silently produces the opposite of what the operator wrote.
  await assert.rejects(() => load({ web: { enabled: "yes" } }), ConfigError);
  await assert.rejects(
    () => load({ web: { enabled: true, requireForwardedUser: "true" } }),
    ConfigError,
  );
});

test("a port that is not a port is refused", async () => {
  await assert.rejects(() => load({ web: { enabled: true, port: 0 } }), ConfigError);
  await assert.rejects(() => load({ web: { enabled: true, port: 70000 } }), ConfigError);
  await assert.rejects(() => load({ web: { enabled: true, port: 8080.5 } }), ConfigError);
});

test("a config that says nothing about the digest does not publish one", async () => {
  const config = await load({});

  assert.equal(config.digest.enabled, false);
  assert.equal(config.digest.hour, 18);
  assert.equal(config.digest.timeZone, "Europe/Berlin");
  assert.equal(config.digest.summarise, true, "the prose is the point of asking for one");
});

test("the digest hour is a wall-clock hour, not a number", async () => {
  await assert.rejects(() => load({ digest: { enabled: true, hour: 24 } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, hour: -1 } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, hour: 18.5 } }), ConfigError);
});

test("a timezone that is not a zone is refused, even with the digest off", async () => {
  // Checked while disabled on purpose. Otherwise the typo is found the day someone
  // enables it — in the cluster, at 18:00, inside the poll loop.
  await assert.rejects(() => load({ digest: { timezone: "Europe/Duesseldorf" } }), ConfigError);
  await assert.rejects(() => load({ digest: { enabled: true, timezone: "+02:00" } }), ConfigError);

  const config = await load({ digest: { enabled: true, timezone: "UTC", hour: 0 } });
  assert.equal(config.digest.timeZone, "UTC");
  assert.equal(config.digest.hour, 0);
});

test("the prose can be turned off without losing the digest", async () => {
  const config = await load({ digest: { enabled: true, summarise: false } });

  assert.equal(config.digest.enabled, true);
  assert.equal(config.digest.summarise, false);
  await assert.rejects(() => load({ digest: { summarise: "no" } }), ConfigError);
});

test("a config that says nothing about the cluster reads none of it", async () => {
  // Two closed defaults rather than one: not enabled, and — should someone enable it
  // without saying more — no namespace either. See `cluster/guard.ts` for why an empty
  // allowlist has to mean deny-all.
  const config = await load({});

  assert.equal(config.cluster.enabled, false);
  assert.deepEqual(config.cluster.namespaces, []);
  assert.equal(config.cluster.lokiUrl, "http://loki.monitoring.svc.cluster.local:3100");
  assert.equal(config.cluster.kubeApiUrl, "https://kubernetes.default.svc");
  assert.equal(config.cluster.maxLogLines, 2000);
});

test("enabling cluster reads without a namespace list is allowed and reads nothing", async () => {
  // Deliberately not a startup failure. A half-finished ConfigMap should produce a runner
  // that refuses every read, says so in its log and counts the denials — not a supervisor
  // that will not start because of a feature nothing may be using yet.
  const config = await load({ cluster: { enabled: true } });

  assert.equal(config.cluster.enabled, true);
  assert.deepEqual(config.cluster.namespaces, []);
});

test("every cluster field can be set", async () => {
  const config = await load({
    cluster: {
      enabled: true,
      namespaces: ["caterpillar", "monitoring"],
      lokiUrl: "http://grafana.monitoring.svc/api/datasources/proxy/1",
      kubeApiUrl: "https://kubernetes.default.svc:443",
      maxLogLines: 500,
    },
  });

  assert.deepEqual(config.cluster.namespaces, ["caterpillar", "monitoring"]);
  assert.equal(config.cluster.lokiUrl, "http://grafana.monitoring.svc/api/datasources/proxy/1");
  assert.equal(config.cluster.kubeApiUrl, "https://kubernetes.default.svc:443");
  assert.equal(config.cluster.maxLogLines, 500);
});

test("cluster.enabled is a boolean and nothing else", async () => {
  await assert.rejects(() => load({ cluster: { enabled: "true" } }), ConfigError);
});

test("a namespace list with a non-string entry is refused, not stringified", async () => {
  // Otherwise a `null` becomes the allowlist entry "null", which matches nothing and is
  // reported as a denial rather than as the config error it is.
  await assert.rejects(
    () => load({ cluster: { enabled: true, namespaces: ["caterpillar", null] } }),
    ConfigError,
  );
  await assert.rejects(() => load({ cluster: { enabled: true, namespaces: "caterpillar" } }), ConfigError);
});

test("maxLogLines is clamped down to the built-in ceiling, and nonsense is refused", async () => {
  const generous = await load({ cluster: { enabled: true, maxLogLines: 100000 } });
  assert.equal(generous.cluster.maxLogLines, 2000, "a config cannot raise the built-in cap");

  await assert.rejects(() => load({ cluster: { maxLogLines: 0 } }), ConfigError);
  await assert.rejects(() => load({ cluster: { maxLogLines: 12.5 } }), ConfigError);
  await assert.rejects(() => load({ cluster: { maxLogLines: "many" } }), ConfigError);
});

test("a config that says nothing about remediation opens no webhook port", async () => {
  // The default that matters most of the three: this listener is the only one that can
  // cause a task to exist, and a task is a session with a shell and a forge credential
  // (DESIGN.md §20).
  const config = await load({});

  assert.equal(config.remediation.enabled, false);
  assert.equal(config.remediation.port, 8081);
});

test("the remediation port is validated even with the receiver off", async () => {
  // Same reasoning as the digest's timezone: a typo in a field nobody is using is
  // otherwise discovered the day someone enables it, in the cluster, at boot.
  await assert.rejects(() => load({ remediation: { port: 0 } }), ConfigError);
  await assert.rejects(() => load({ remediation: { port: 70000 } }), ConfigError);
  await assert.rejects(() => load({ remediation: { port: 8081.5 } }), ConfigError);
  await assert.rejects(() => load({ remediation: { enabled: "yes" } }), ConfigError);

  const config = await load({ remediation: { enabled: true, port: 9101 } });
  assert.equal(config.remediation.enabled, true);
  assert.equal(config.remediation.port, 9101);
});

test("worktree reaping is on by default, because a full volume is not opt-in", async () => {
  // The one section here whose default is ON, and deliberately so. Every other default in
  // this file is off because turning it on does something outward-facing — a port, a
  // channel, a cluster read. Reaping does something inward-facing and unavoidable: without
  // it a replica's 20Gi volume grows by one full checkout per task it has ever worked,
  // forever, and an operator who has to configure a garbage collector before the disk stops
  // filling has not been given a garbage collector.
  const config = await load({});

  assert.equal(config.workspace.reap.intervalHours, 24);
  assert.equal(config.workspace.reap.keepHours, 72);
});

test("both reaping numbers can be set, and nonsense in either is refused", async () => {
  const config = await load({ workspace: { reap: { intervalHours: 6, keepHours: 12 } } });
  assert.equal(config.workspace.reap.intervalHours, 6);
  assert.equal(config.workspace.reap.keepHours, 12);

  // A keep-age that arrives as a string is the failure worth refusing loudly: `num()`
  // would not coerce it, but a section that silently fell back to the default would leave
  // an operator who wrote "12" believing they had shortened it.
  await assert.rejects(
    () => load({ workspace: { reap: { keepHours: "12" } } }),
    (error: unknown) =>
      error instanceof ConfigError && /workspace\.reap\.keepHours/.test(error.message),
  );
  await assert.rejects(
    () => load({ workspace: { reap: { intervalHours: null } } }),
    (error: unknown) =>
      error instanceof ConfigError && /workspace\.reap\.intervalHours/.test(error.message),
  );
});

test("a store quota with no hysteresis is refused rather than corrected", async () => {
  // `max-free` at or below `min-free` means nix has already met its target the moment it
  // starts collecting, so it collects on EVERY build and frees almost nothing each time.
  // From outside that reads as "the quota is on and not working", which is the worst of
  // the three possible states. Either number could be the typo, so neither is guessed at.
  await assert.rejects(() => load({ toolchain: { minFreeGb: 20, maxFreeGb: 20 } }), ConfigError);
  await assert.rejects(() => load({ toolchain: { minFreeGb: 20, maxFreeGb: 5 } }), ConfigError);
  await assert.rejects(() => load({ toolchain: { minFreeGb: -1 } }), ConfigError);
});

test("the store quota defaults on, and 0 is the off switch", async () => {
  // On by default unlike the caches: an unbounded store is how a runner fills the node it
  // shares with every other pod, and that is not a cluster-only hazard.
  const defaults = await load({});
  assert.equal(defaults.toolchain.minFreeGb, 5);
  assert.equal(defaults.toolchain.maxFreeGb, 20);

  // 0 disables it, and the pair check must not fire on the way past — off means neither
  // number applies, so an untouched maxFreeGb is not a misconfiguration.
  const off = await load({ toolchain: { minFreeGb: 0 } });
  assert.equal(off.toolchain.minFreeGb, 0);
});

test("a config written before the usage measurement existed still loads", async () => {
  // `paths.root` is new and every deployed ConfigMap omits it. Requiring it would refuse
  // to load a config that was correct the day before this shipped.
  const config = await load({});

  assert.equal(config.paths.root, "/work", "the parent both mirrors and tasks live under");
  assert.equal(config.usage.intervalHours, 1);
  assert.equal(config.usage.deadlineSeconds, 120);
});

test("the work root and the measurement interval can both be set", async () => {
  const config = await load({
    paths: { mirrors: "/vol/m", tasks: "/vol/t", root: "/vol" },
    usage: { intervalHours: 6, deadlineSeconds: 30 },
  });

  assert.equal(config.paths.root, "/vol");
  assert.equal(config.usage.intervalHours, 6);
  assert.equal(config.usage.deadlineSeconds, 30);
});

test("a work root with no common parent falls back to the tasks directory, never to /", async () => {
  // Measuring `/` inside a container reports the IMAGE's free space as the work volume's,
  // which is wrong in the reassuring direction — the graph looks healthy as the PVC fills.
  const config = await load({ paths: { mirrors: "/a/mirrors", tasks: "/b/c/tasks" } });

  assert.equal(config.paths.root, "/b/c/tasks");
});

test("a non-numeric interval is refused rather than coerced", async () => {
  await assert.rejects(() => load({ usage: { intervalHours: "hourly" } }), ConfigError);
  await assert.rejects(() => load({ usage: { deadlineSeconds: null } }), ConfigError);
});

/**
 * The `redis` block (DESIGN.md §21).
 *
 * Its default matters for a different reason from the four above: turning it ON does
 * nothing outward-facing at all — it moves four ephemeral structures out of this process
 * so a separate one can see them. What matters is that turning it off, or leaving it off,
 * yields exactly the runner that has always worked. So the assertions here are mostly
 * about the shape being validated whether it is used or not, which is `digestConfig`'s
 * argument: a typo in a field nobody is using is otherwise discovered the day someone
 * enables it, in the cluster, by a supervisor that throws at boot.
 */
test("a config that says nothing about redis keeps everything in this process", async () => {
  const config = await load({});

  assert.equal(config.redis.enabled, false);
  assert.equal(config.redis.url, "redis://localhost:6379");
  assert.equal(config.redis.commandTimeoutMs, 1000);
  assert.equal(config.redis.keyPrefix, "caterpillar:");
  // No credential in config, ever. The password is a secret and lives under `secretRef`.
  assert.equal(config.redis.secretRef, undefined);
  assert.equal("password" in (config.redis as unknown as Record<string, unknown>), false);
});

test("an enabled redis carries its url, prefix and secret reference", async () => {
  const config = await load({
    redis: {
      enabled: true,
      url: "rediss://redis-ha.all-chat.svc.cluster.local:6379",
      secretRef: "caterpillar-redis",
      commandTimeoutMs: 250,
      keyPrefix: "fleet-a:",
    },
  });

  assert.equal(config.redis.enabled, true);
  assert.equal(config.redis.url, "rediss://redis-ha.all-chat.svc.cluster.local:6379");
  assert.equal(config.redis.secretRef, "caterpillar-redis");
  assert.equal(config.redis.commandTimeoutMs, 250);
  assert.equal(config.redis.keyPrefix, "fleet-a:");
});

test("a url with the wrong scheme is refused, even with redis disabled", async () => {
  // Not a connection that fails once: an `http://` here is a client retrying a nonsense
  // endpoint forever while every read on the plane quietly times out and degrades, which
  // in the logs looks exactly like a Redis that is merely down.
  await assert.rejects(() => load({ redis: { url: "http://redis:6379" } }), ConfigError);
  await assert.rejects(() => load({ redis: { url: "redis-ha:6379" } }), ConfigError);
  await assert.rejects(() => load({ redis: { enabled: true, url: "" } }), ConfigError);

  const tls = await load({ redis: { url: "rediss://redis:6380" } });
  assert.equal(tls.redis.url, "rediss://redis:6380");
});

test("the timeout and the enabled flag are validated rather than coerced", async () => {
  await assert.rejects(() => load({ redis: { commandTimeoutMs: 0 } }), ConfigError);
  await assert.rejects(() => load({ redis: { commandTimeoutMs: -5 } }), ConfigError);
  await assert.rejects(() => load({ redis: { commandTimeoutMs: 1.5 } }), ConfigError);
  await assert.rejects(() => load({ redis: { commandTimeoutMs: "fast" } }), ConfigError);
  // `"false"` is truthy in JavaScript and false in intent. Refusing the string is the
  // only reading that cannot silently mean the opposite of what was written.
  await assert.rejects(() => load({ redis: { enabled: "false" } }), ConfigError);
});

test("housekeeping defaults to the poll interval and is never slower than it", async () => {
  // The guarantee the two-loop split (DESIGN.md §6.4) is worth having is "chat, intake and
  // leadership are never noticed later than they were before". Housekeeping running slower
  // than claiming would break exactly that, and it would break it silently: nothing fails,
  // a human just waits longer for `/resume` than they did on the single loop.
  const plain = await load({});
  assert.equal(plain.pollSeconds, 30);
  assert.equal(plain.housekeepingSeconds, 30, "unset, it tracks pollSeconds");

  // Tracks a NON-default pollSeconds too. Defaulting to a constant would have left a
  // runner configured for a five-second poll doing housekeeping every thirty.
  const eager = await load({ pollSeconds: 5 });
  assert.equal(eager.housekeepingSeconds, 5);

  // Faster than the poll is allowed: housekeeping costs a fetch and a few array filters,
  // and the human waiting on `/resume` is the thing being optimised.
  const faster = await load({ pollSeconds: 60, housekeepingSeconds: 10 });
  assert.equal(faster.housekeepingSeconds, 10);

  // Slower is clamped rather than refused. It is a coherent thing to have written and the
  // right answer is knowable, so failing to boot over it would be worse than correcting it.
  const slower = await load({ pollSeconds: 15, housekeepingSeconds: 600 });
  assert.equal(slower.housekeepingSeconds, 15);

  await assert.rejects(() => load({ housekeepingSeconds: "often" }), ConfigError);
});

/**
 * The `bot` block (DESIGN.md §7).
 *
 * The default is the whole point: a config that says nothing about the bot must produce
 * exactly the runner that has always existed, connecting to Discord itself. Every other
 * assertion here is about the one mistake that is silent — a mode nobody validated.
 */
test("a config that says nothing about the bot runs it in-process, as it always has", async () => {
  const config = await load({});

  assert.equal(config.bot.mode, "in-process");
  assert.equal(config.bot.port, 9091);
});

test("an external bot is carried through with its own port", async () => {
  const config = await load({ bot: { mode: "external", port: 9092 } });

  assert.equal(config.bot.mode, "external");
  // Its own port, not the supervisor's: the two run in one namespace and one number
  // meaning both is an EADDRINUSE in whichever pod loses.
  assert.equal(config.bot.port, 9092);
});

test("a misspelled mode fails the boot rather than quietly connecting twice", async () => {
  // The failure this prevents is invisible otherwise: `extrenal` falling back to
  // in-process gives a supervisor AND a standalone bot both connected to Discord and both
  // acting, which is the duplicate-acting failure the split exists to prevent.
  await assert.rejects(() => load({ bot: { mode: "extrenal" } }), ConfigError);
  await assert.rejects(() => load({ bot: { mode: "" } }), ConfigError);
  await assert.rejects(() => load({ bot: { port: "9091" } }), ConfigError);
});

/**
 * The sabotage reviewer's two budgets in `limits` (DESIGN.md §12.1).
 *
 * Both exist to bound a reviewer that copies a checkout and then runs a test suite over
 * and over. The defaults are the whole setting for every operator who never writes them
 * down, so they are asserted exactly rather than "is a number": an undefined leaking
 * through the parse would satisfy a looser assertion and hand the reviewer no budget at
 * all.
 */
test("a config that says nothing about sabotage budgets takes the documented defaults", async () => {
  const config = await load({});

  assert.equal(config.limits.sabotageMaxCommands, 40);
  assert.equal(config.limits.sabotageMinFreeGb, 5);
});

test("both sabotage budgets can be set", async () => {
  const config = await load({ limits: { sabotageMaxCommands: 12, sabotageMinFreeGb: 25 } });

  assert.equal(config.limits.sabotageMaxCommands, 12);
  assert.equal(config.limits.sabotageMinFreeGb, 25);
});

test("a command budget that cannot run a single command is refused", async () => {
  // A reviewer convened with a budget of zero can only abstain, which spends a fifth
  // session on every task and reports nothing. Refused at boot instead.
  const names = async (over: Record<string, unknown>): Promise<void> => {
    await assert.rejects(
      () => load(over),
      (error: unknown) =>
        error instanceof ConfigError && /limits\.sabotageMaxCommands/.test(error.message),
    );
  };

  await names({ limits: { sabotageMaxCommands: 0 } });
  await names({ limits: { sabotageMaxCommands: -1 } });
  // Half a command is a typo, not a budget.
  await names({ limits: { sabotageMaxCommands: 2.5 } });
});

test("a CI poll interval of zero is refused", async () => {
  // `awaitChecks` sleeps `Math.min(pollMs, remaining)` between polls, so a zero interval
  // is not a fast poll but no poll at all: two GitHub API calls per iteration, uninterrupted,
  // for the whole of `ciSettleSeconds` — twenty minutes at the default. Refused at boot,
  // like the two sabotage budgets beside it.
  //
  // `ciSettleSeconds: 0` needs no such guard: a zero budget skips the wait, which is a
  // coherent way to say "never wait on CI".
  const names = async (over: Record<string, unknown>): Promise<void> => {
    await assert.rejects(
      () => load(over),
      (error: unknown) =>
        error instanceof ConfigError && /limits\.ciPollSeconds/.test(error.message),
    );
  };

  await names({ limits: { ciPollSeconds: 0 } });
  await names({ limits: { ciPollSeconds: -5 } });
});

test("a negative disk floor is refused, but zero is a legitimate no-floor", async () => {
  await assert.rejects(
    () => load({ limits: { sabotageMinFreeGb: -1 } }),
    (error: unknown) =>
      error instanceof ConfigError && /limits\.sabotageMinFreeGb/.test(error.message),
  );

  // Unlike `toolchain.minFreeGb`, 0 means "copy regardless" — the right answer on a dev
  // machine with one replica and no volume to fill.
  const config = await load({ limits: { sabotageMinFreeGb: 0 } });
  assert.equal(config.limits.sabotageMinFreeGb, 0);
});

test("a config that says nothing about schedules fires none", async () => {
  // Off by default, like the digest and for the same reason (§22): a schedule creates
  // tasks in the shared state repo, and a runner someone started on a workstation must
  // not begin doing that because it was upgraded. The claim protocol makes a second
  // firing runner harmless, not welcome.
  const config = await load({});

  assert.equal(config.schedule.enabled, false);
});

test("schedule.enabled is a boolean, not a truthy string", async () => {
  assert.equal((await load({ schedule: { enabled: true } })).schedule.enabled, true);
  await assert.rejects(() => load({ schedule: { enabled: "yes" } }), ConfigError);
});
