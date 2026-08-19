import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { asTaskId, asWorkspaceName, type TaskSpec } from "../domain/task.ts";
import { GitHubAppForgeFactory, signAppJwt, summarise } from "./github-app.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("signs a three-part RS256 JWT whose expiry is inside GitHub's 10 minute limit", () => {
  const now = 1_700_000_000_000;
  const jwt = signAppJwt("123456", pem, now);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString()) as {
    alg: string;
  };
  assert.equal(header.alg, "RS256");

  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(payload.iss, "123456");
  // iat is backdated to tolerate clock skew against GitHub.
  assert.ok(payload.iat < Math.floor(now / 1000));
  // GitHub rejects exp more than 600s out; we must stay strictly inside.
  assert.ok(payload.exp - payload.iat < 600);
});

test("no CI signal at all is reported as 'none', not success", () => {
  // The §12 gate must not read "nothing ran" as "everything passed".
  const status = summarise({ check_runs: [] }, { state: "pending", total_count: 0 });
  assert.equal(status.conclusion, "none");
});

test("check runs alone are green — an EMPTY combined status is not pending", () => {
  // GitHub answers /status with `state: "pending"` on a ref that has NO statuses at all,
  // and a repo whose CI is Actions-only never gets any: the signal lives entirely in
  // check-runs. ORing that state into the pending branch made §12 unsatisfiable for
  // every such repo — the first intake-sourced task claimed done, was rejected with
  // "CI has not finished: 0 check(s) still running" over a green PR, re-ran, and
  // eventually gave up and asked a human. `total_count`, not `state`, says whether the
  // combined status is worth reading.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "GitGuardian" }] },
    { state: "pending", total_count: 0 },
  );
  assert.equal(status.conclusion, "success", status.summary);
});

test("a genuinely pending commit status still blocks a green check run", () => {
  // The other half of the fix: an empty combined status is ignorable, a populated one
  // is not. Without this the correction would wave through a ref whose legacy status
  // has not reported yet.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "lint" }] },
    { state: "pending", total_count: 1 },
  );
  assert.equal(status.conclusion, "pending");
});

test("a pending verdict never claims zero checks are running", () => {
  // "0 check(s) still running" is what the operator saw for two sessions. A summary
  // that contradicts its own verdict sends whoever reads it looking in the wrong place.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "lint" }] },
    { state: "pending", total_count: 1 },
  );
  assert.equal(status.summary.includes("0 check"), false, status.summary);
});

test("a failing check run wins over passing ones", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "completed", conclusion: "failure", name: "test" },
      ],
    },
    { state: "success", total_count: 1 },
  );
  assert.equal(status.conclusion, "failure");
  assert.match(status.summary, /test/);
});

test("an incomplete run is pending even when others passed", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "in_progress", conclusion: null, name: "test" },
      ],
    },
    { state: "success", total_count: 1 },
  );
  assert.equal(status.conclusion, "pending");
});

test("neutral and skipped conclusions do not count as failures", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "skipped", name: "optional" },
        { status: "completed", conclusion: "neutral", name: "advisory" },
      ],
    },
    { state: "success", total_count: 0 },
  );
  assert.equal(status.conclusion, "success");
});

test("a failing legacy combined status is respected even with no check runs", () => {
  // External CI that only posts statuses must not be invisible to the gate.
  const status = summarise({ check_runs: [] }, { state: "failure", total_count: 2 });
  assert.equal(status.conclusion, "failure");
});

test("a partial check-run list is pending, never success", () => {
  // The §12 CI gate used to run on one unpaginated request, which returns GitHub's
  // default of 30. A matrix build whose failing job landed on page 2 came back as
  // success and was squash-merged red. `total_count` was not even declared on the
  // response type, so the truncation was undetectable.
  const status = summarise(
    {
      total_count: 42,
      check_runs: [{ status: "completed", conclusion: "success", name: "test (1)" }],
    },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "pending");
  assert.match(status.summary, /1 of 42/);
});

test("a complete check-run list is judged normally", () => {
  const status = summarise(
    {
      total_count: 2,
      check_runs: [
        { status: "completed", conclusion: "success", name: "test" },
        { status: "completed", conclusion: "success", name: "lint" },
      ],
    },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "success");
});

test("a response without total_count is trusted as complete", () => {
  // GHES and the test fixtures predating pagination omit it. Treating absence as
  // truncation would make every such ref permanently pending.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "failure", name: "test" }] },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "failure");
});

/**
 * Reachability (DESIGN.md §9.1).
 *
 * The 422 these cover cost a real brainstorm its whole session: `/brainstorm
 * caesarakalaeii/allchat` for a repo called `all-chat` reached `git clone --mirror`
 * before anything noticed, and the message named the installation rather than the repo.
 */
const REPO_LIST = [
  "caesarakalaeii/Caterpillar",
  "caesarakalaeii/all-chat",
  "caesarakalaeii/all-chat-extension",
];

const github = (
  handler: (route: string, init?: RequestInit) => unknown,
): { readonly factory: GitHubAppForgeFactory; readonly routes: string[] } => {
  const routes: string[] = [];
  const factory = new GitHubAppForgeFactory(
    {
      appId: "1",
      installationId: "153385932",
      privateKeyPem: pem,
      apiBase: "https://api.github.test",
      fetch: (input, init) => {
        const route = input.replace("https://api.github.test", "");
        routes.push(`${init?.method ?? "GET"} ${route}`);
        const body = handler(route, init);
        return Promise.resolve(
          body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    },
    { host: "github.com" },
  );
  return { factory, routes };
};

/** The two routes reachability needs: a metadata token, then the installation's repos. */
const installationServer =
  (slugs: readonly string[]) =>
  (route: string): unknown => {
    if (route.endsWith("/access_tokens")) {
      return { token: "ghs_metadata", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }
    if (route.startsWith("/installation/repositories")) {
      return { total_count: slugs.length, repositories: slugs.map((full_name) => ({ full_name })) };
    }
    throw new Error(`unexpected route ${route}`);
  };

test("a repo the App cannot see is named, and the near miss is offered", async () => {
  const { factory } = github(installationServer(REPO_LIST));

  const unreachable = await factory.unreachable([
    { host: "github.com", owner: "caesarakalaeii", name: "allchat" },
  ]);

  assert.equal(unreachable.length, 1);
  const reason = unreachable[0]?.reason ?? "";
  assert.match(reason, /caesarakalaeii\/allchat/, "the refusal must name the repo asked for");
  assert.match(reason, /caesarakalaeii\/all-chat/, "and the one the App can actually see");
  assert.match(reason, /installed/, "and say what to do about it if the name was right");
});

test("repos the App can see are not reported, and one listing serves them all", async () => {
  const { factory, routes } = github(installationServer(REPO_LIST));

  assert.deepEqual(
    await factory.unreachable([
      { host: "github.com", owner: "caesarakalaeii", name: "Caterpillar" },
      { host: "github.com", owner: "caesarakalaeii", name: "all-chat" },
    ]),
    [],
  );

  // Twice over, to prove the TTL cache holds: intake and the claim loop both ask, and a
  // request per repo per pass against a 5000/hour installation budget is what §14.2 is
  // already rationing.
  await factory.unreachable([{ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }]);

  const listings = routes.filter((route) => route.includes("/installation/repositories"));
  assert.equal(listings.length, 1, `one listing, not ${listings.length}: ${routes.join(", ")}`);
});

test("a miss is confirmed against a FRESH listing before it becomes a refusal", async () => {
  // The cache is five minutes wide, and a repo created a minute ago is not in it. Refusing
  // on a stale absence would tell a human their brand-new repo does not exist — so a miss
  // costs one re-read, which the hit path never pays.
  let installed: readonly string[] = ["caesarakalaeii/Caterpillar"];
  const { factory, routes } = github((route) => installationServer(installed)(route));

  const first = await factory.unreachable([
    { host: "github.com", owner: "caesarakalaeii", name: "brand-new" },
  ]);
  assert.equal(first.length, 1, "genuinely absent, on two readings");
  assert.equal(
    routes.filter((r) => r.includes("/installation/repositories")).length,
    2,
    "the miss was confirmed rather than trusted",
  );

  // The App is installed on it a moment later. No waiting out the TTL.
  installed = ["caesarakalaeii/Caterpillar", "caesarakalaeii/brand-new"];
  assert.deepEqual(
    await factory.unreachable([{ host: "github.com", owner: "caesarakalaeii", name: "brand-new" }]),
    [],
  );
});

test("a repo on another forge is refused as off-workspace, not as uninstalled", async () => {
  // Same door, both bounds. `/brainstorm` resolves a workspace by host and owner but falls
  // back to the only configured one, so a Codeberg repo can arrive at a GitHub factory —
  // and "the App is not installed on it" would be a true sentence that sends the operator
  // to the wrong settings page.
  const { factory, routes } = github(installationServer(REPO_LIST));

  const unreachable = await factory.unreachable([
    { host: "codeberg.org", owner: "eb", name: "eb-api" },
  ]);

  assert.equal(unreachable.length, 1);
  assert.match(unreachable[0]?.reason ?? "", /github\.com/);
  assert.deepEqual(routes, [], "an off-host repo must not cost a request to establish");
});

test("an installation whose repo list cannot be read THROWS rather than refusing", async () => {
  // Load-bearing: every caller fails open on a throw. A 500 from GitHub is not evidence
  // that an App was uninstalled, and turning it into one would refuse a `/brainstorm`, or
  // park a task, over a blip.
  const { factory } = github((route) => {
    if (route.endsWith("/access_tokens")) {
      return { token: "ghs_metadata", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }
    return new Response("upstream is having a moment", { status: 500 });
  });

  await assert.rejects(
    factory.unreachable([{ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }]),
    /500/,
  );
});

test("a listing truncated by the page cap throws rather than inventing an absence", async () => {
  // The same reasoning as the check-run cap above: an incomplete list cannot answer
  // "is this repo missing" in either direction, and the safe answer is "cannot say".
  const { factory } = github((route) => {
    if (route.endsWith("/access_tokens")) {
      return { token: "ghs_metadata", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }
    // Claims far more repos than it ever returns, so the loop runs out of pages.
    return { total_count: 5000, repositories: [{ full_name: "caesarakalaeii/all-chat" }] };
  });

  await assert.rejects(
    factory.unreachable([{ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }]),
    /repositor/,
  );
});

test("a 422 from the mint names the repo at fault, not just the installation", async () => {
  // This is the message the credential helper prints into a failing `git clone`, so it is
  // the last chance to say something useful — a task whose repo was uninstalled AFTER it
  // was created still lands here.
  const { factory } = github((route, init) => {
    if (route.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { repositories?: string[] };
      if (body.repositories === undefined) {
        return { token: "ghs_metadata", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      }
      return new Response(JSON.stringify({ message: "Unprocessable Entity" }), { status: 422 });
    }
    if (route.startsWith("/installation/repositories")) {
      return {
        total_count: REPO_LIST.length,
        repositories: REPO_LIST.map((full_name) => ({ full_name })),
      };
    }
    throw new Error(`unexpected route ${route}`);
  });

  const forge = await factory.forTask({
    id: asTaskId("BS-1539331435477860432"),
    workspace: asWorkspaceName("caesar"),
    goal: "g",
    repos: [{ host: "github.com", owner: "caesarakalaeii", name: "allchat" }],
    requires: [],
    acceptance: [],
  });

  await assert.rejects(
    forge.credential({ host: "github.com", owner: "caesarakalaeii", name: "allchat" }),
    (error: Error) => {
      assert.match(error.message, /allchat/, "the 422 must name the repo it was asked for");
      assert.match(error.message, /all-chat/, "and the near miss that explains it");
      return true;
    },
  );
});

test("a 422 the installation listing cannot explain still says what it can", async () => {
  // The enrichment is best-effort by construction: it costs two requests on a failure
  // path, and a helper mid-clone must not lose the original diagnosis to a second failure.
  const { factory } = github((route) => {
    if (route.endsWith("/access_tokens")) {
      return new Response("nope", { status: 422 });
    }
    return new Response("nope", { status: 500 });
  });

  const forge = await factory.forTask({
    id: asTaskId("TASK-422"),
    workspace: asWorkspaceName("caesar"),
    goal: "g",
    repos: [{ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }],
    requires: [],
    acceptance: [],
  });

  await assert.rejects(
    forge.credential({ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }),
    /not installed/,
  );
});

/* ─────────────── open_pr adopts the pull request that already exists ─────────────── */

const REPO = { host: "github.com", owner: "caesarakalaeii", name: "all-chat-extension" } as const;
/** The task shape `forTask` needs: this one spans two repos, which is how #113 arose. */
const SPEC = {
  id: asTaskId("GH-caesarakalaeii-all-chat-543"),
  workspace: asWorkspaceName("caesar"),
  goal: "harden reconnect",
  repos: [{ host: "github.com", owner: "caesarakalaeii", name: "all-chat" }, REPO],
  requires: [],
  acceptance: ["true"],
} as unknown as TaskSpec;
const REQUEST = {
  title: "Harden reconnect",
  body: "…",
  head: "agent/GH-caesarakalaeii-all-chat-543",
  base: "main",
} as const;

/** Token route plus whatever the test wants for the rest. */
const withToken =
  (rest: (route: string, init?: RequestInit) => unknown) =>
  (route: string, init?: RequestInit): unknown => {
    if (route.endsWith("/access_tokens")) {
      return { token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }
    return rest(route, init);
  };

const DUPLICATE = JSON.stringify({
  message: "Validation Failed",
  errors: [
    {
      resource: "PullRequest",
      message:
        "A pull request already exists for caesarakalaeii:agent/GH-caesarakalaeii-all-chat-543.",
    },
  ],
});

test("a second open_pr for the same branch adopts the PR that is already open", async () => {
  // GitHub answers the second POST with a 422, which is a statement about the world already
  // being the way the caller wanted. Treating it as a failure made a whole class of situation
  // unrecoverable from inside a session — a handoff that re-opens, a push whose state write was
  // lost, or a human who opened it by hand while the task was parked, which is exactly how
  // all-chat-extension#113 came to exist.
  const { factory, routes } = github(
    withToken((route, init) => {
      if (init?.method === "POST" && route.endsWith("/pulls")) {
        return new Response(DUPLICATE, { status: 422 });
      }
      if (route.includes("/pulls?")) {
        return [{ number: 113, html_url: "https://github.com/caesarakalaeii/all-chat-extension/pull/113" }];
      }
      throw new Error(`unexpected route ${route}`);
    }),
  );

  const forge = await factory.forTask(SPEC);
  const pr = await forge.openPr(REPO, REQUEST);

  assert.deepEqual(pr, {
    number: 113,
    url: "https://github.com/caesarakalaeii/all-chat-extension/pull/113",
  });
  // Qualified with the owner: an unqualified branch name silently matches nothing on this
  // endpoint, which would turn the adoption into the original 422 with extra steps.
  assert.ok(
    routes.some((r) => r.includes("head=caesarakalaeii%3Aagent%2FGH-caesarakalaeii-all-chat-543")),
    `the lookup must filter by owner-qualified head — got ${routes.join(", ")}`,
  );
});

test("a 422 that is NOT a duplicate still throws, because the agent has to see it", async () => {
  // An unusable base is the case that produced two confusing failures on
  // GH-caesarakalaeii-all-chat-543. Swallowing it would hide the one 422 worth reading.
  const { factory } = github(
    withToken((route, init) => {
      if (init?.method === "POST" && route.endsWith("/pulls")) {
        return new Response(JSON.stringify({ message: "Validation Failed", errors: [{ field: "base" }] }), {
          status: 422,
        });
      }
      if (route.includes("/pulls?")) return [];
      throw new Error(`unexpected route ${route}`);
    }),
  );

  const forge = await factory.forTask(SPEC);
  await assert.rejects(() => forge.openPr(REPO, REQUEST), /422/);
});

test("a duplicate whose PR cannot be found reports the original 422, not a lookup failure", async () => {
  // The lookup is best-effort; the error a human reads must still be the one GitHub gave.
  const { factory } = github(
    withToken((route, init) => {
      if (init?.method === "POST" && route.endsWith("/pulls")) {
        return new Response(DUPLICATE, { status: 422 });
      }
      if (route.includes("/pulls?")) return new Response("nope", { status: 500 });
      throw new Error(`unexpected route ${route}`);
    }),
  );

  const forge = await factory.forTask(SPEC);
  await assert.rejects(() => forge.openPr(REPO, REQUEST), /already exists/);
});

test("the ordinary path still opens one PR and looks nothing up", async () => {
  const { factory, routes } = github(
    withToken((route, init) => {
      if (init?.method === "POST" && route.endsWith("/pulls")) {
        return { number: 7, html_url: "https://github.test/pull/7" };
      }
      throw new Error(`unexpected route ${route}`);
    }),
  );

  const forge = await factory.forTask(SPEC);
  assert.deepEqual(await forge.openPr(REPO, REQUEST), {
    number: 7,
    url: "https://github.test/pull/7",
  });
  assert.equal(routes.filter((r) => r.includes("/pulls?")).length, 0, "no lookup on the happy path");
});
