# Caterpillar

A long-running autonomous coding agent supervisor. Survives context exhaustion, pod
restarts, and machine boundaries.

**Architecture and rationale: [`DESIGN.md`](DESIGN.md).** Read it first — the decisions
there are chosen deliberately, several against the obvious default, and the reasons are
not recoverable from the code.

**Picking up mid-stream: [`HANDOFF.md`](HANDOFF.md)** — current status, live credential
IDs, environment quirks, and the traps already paid for.

**Status: deployed, running, and proven end to end** in the `caterpillar` namespace since
2026-08-13 — leasing, sessions, handoff, verification, both forges, and both trackers.
The first in-cluster task took a spec from the state repo through two sessions and a
context handoff to a merged pull request, with the supervisor's own §12 gates — not the
agent's word — deciding it was done. The **tracker path is proven too**: a GitHub issue
labelled `agent` became a task 23 seconds later and ran through to `done` and a closed
issue, including one round trip through `ask_human` when the agent hit a supervisor bug it
could not work around.

Work reaches it three ways: label a tracker item `agent` and intake renders a spec (§14);
run `/brainstorm` in Discord to refine an idea into a plan that is reviewed and then cut
into wave-tagged tasks (§14.3); or commit a `tasks/<id>/spec.md` into the state repo by
hand for full control over the acceptance criteria. See `HANDOFF.md`.

To hand a GitHub issue or Vikunja task to the agent, label it `agent` and put an `agent`
block in the body — `acceptance` is required, since a task with no machine-checkable
criteria can never be marked done (§12):

````
```agent
repos:
  - owner/name          # optional on GitHub — defaults to the issue's own repo
acceptance:
  - "npm test"
```
````

An item without one is refused, and commented on **once** explaining what to write.

**On GitHub the author must have push access** — `OWNER`, `MEMBER` or `COLLABORATOR`.
Labelling someone else's issue is not enough to run it, because the author can edit their
own body after the label is applied and `acceptance` is executed as shell on the runner.
To hand an outside contributor's request to the agent, open your own issue referencing
theirs. Vikunja has no such check and needs none — writing to a project already requires
an account someone provisioned (§14.1).

Repos are bounded too: an item may only name repos on its workspace's own forge, and
never the state repo (§9.1). A `codeberg.org/...` sibling in a GitHub workspace is
refused rather than half-working.

A repo the workspace's credential cannot **reach** is refused the same way, with the near
miss named: `acme/allchat` for a repo called `all-chat` used to become a task, get claimed,
and die in `git clone` a session later on a 422 that named the App installation rather than
the repo (§9.1.1). If the forge cannot be asked at that moment the item goes through
anyway — a 500 from GitHub is not evidence that an App was uninstalled.

In Vikunja the editor cannot put `agent` on the fence line, so put it as the first line
*inside* a code block instead — intake accepts either position.

### Dev environments

A repo needing a toolchain the runner does not have — lua, go, a compiler — usually needs
to say nothing at all. At the start of every session the runner looks for a `flake.nix` or
`shell.nix` **in the repo** and builds that devShell, so the agent works in the same
environment the tests were written in, and the acceptance gate runs in it too (§8.1).

Declare one only when the repo has no nix expression:

````
```agent
repos:
  - owner/name
acceptance:
  - "lua -v && busted"
toolchain:
  mode: nix
  packages: [lua5_1, luarocks, gcc]
```
````

`packages` are nixpkgs attribute names. Declaring `mode: nix` also adds `nix` to the task's
`requires`, so only a runner that can build the environment will claim it. `mode: inherit`
is the escape hatch: it uses the runner's own environment and ignores a `flake.nix` the
repo carries for its humans.

**A toolchain is not a capability.** `requires` is for facts about a machine that cannot be
provisioned — a GPU, a USB device, a human. Anything a runner can install for itself
belongs here instead; putting it in `requires` produces a task no runner ever claims, which
reads as a stuck scheduler rather than a missing tool.

## Development

Any node from **22.18** up, including 26. There is no build step for development and no
flag to remember — node runs the TypeScript directly:

```bash
npm install --ignore-scripts
npm run check          # typecheck, sources AND tests
npm test               # unit tests
npm run build          # emit to dist/
```

A flake is still provided (`nix develop` — node, git, jq, sops, age, kubectl, kustomize),
but nothing here needs it.

**The source is deliberately erasable-syntax-only**, enforced by `erasableSyntaxOnly` in
`tsconfig.json`. Node *erases* types rather than transforming them, so any construct that
emits runtime code — a parameter property, an enum, a namespace — type-checks perfectly
and then fails to LOAD with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, per file, before a single
test in it registers. Write `private readonly x: T` as a field and assign it in the
constructor. `tsconfig.test.json` applies the same rule to test files, which the build
excludes; CI runs the whole suite on node 22 and 26, because the failure is a load error
on one version and invisible on the other.

22.18 is the floor because that is the first release to strip types without a flag.

`--ignore-scripts` is deliberate: no dependency lifecycle scripts run on install.
`.npmrc` pins exact versions and refuses same-day releases, because pi's API is young
and dependency bumps are reviewed code changes (`DESIGN.md` §15).

## Layout

| Path | Role |
|---|---|
| `src/domain/task.ts` | Core vocabulary. Depends on nothing. |
| `src/config/` | Runner + workspace profiles. **Never holds secrets.** |
| `src/config/scope.ts` | The configured bound on repos a task may reach (§9.1). |
| `src/state/git.ts` | Typed git CLI wrapper. |
| `src/state/lease.ts` | Git-ref CAS leasing + fencing heartbeat (§5). |
| `src/state/store.ts` | Task directories: spec, state, journal, handoff (§4). |
| `src/forge/` | `Forge` interface + GitHub App and Forgejo/Codeberg (§9.1, §9.4). `reach.ts` / `catalog.ts` answer whether a named repo can be reached, and offer the ones that can (§9.1.1). |
| `src/tracker/` | `Tracker` interface + Vikunja and GitHub Issues (§9.5). |
| `src/credential/` | Credential service + git helper protocol (§9.2). |
| `src/secrets/load.ts` | Mounted SOPS secrets → forge factories and trackers. |
| `src/workspace/worktree.ts` | Bare mirrors + per-task worktrees, and reaping the finished ones (§3.1). |
| `src/workspace/toolchain.ts` | The one environment every task command runs in (§8.1). |
| `src/workspace/usage.ts` | What is on the work volume, by category. Read-only, idle-only (§11). |
| `src/llm/credentials.ts` | The rotating OAuth credential as a locked file (§9.6). |
| `src/llm/credential-holder.ts` | The one pod that owns and refreshes it, over HTTP (§9.6). |
| `src/llm/credential-client.ts` | A runner's read-only view of it. Never writes (§9.6). |
| `src/llm/outage.ts` | Provider outage vs. the task's own error. Pure, no IO (§6.3). |
| `src/supervisor/cooldown.ts` | The runner's back-off after a refusal. Pure, clock injected (§6.3). |
| `src/agent/limits.ts` | Context budget and the handoff trigger (§6.1). |
| `src/agent/exec.ts` | The agent's shell with a per-command ceiling — the hang detector (§6.4). |
| `src/agent/journal.ts` | Bounded journal view for prompts. Pure, no IO (§4.1). |
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
| `src/agent/steering.ts` | The buffer between a human typing and a session reading (§7.3). |
| `src/agent/runner.ts` | Assembles a session: worktree, tools, prompt, budget. |
| `src/intake/spec.ts` | Tracker item → `TaskSpec`. Pure, no IO (§14). |
| `src/intake/ingest.ts` | Idempotent tracker → state-repo ingestion (§14). |
| `src/supervisor/verifier.ts` | Independent completion gates (§12). |
| `src/review/lenses.ts` | The council's three reviewer prompts (§12.1). |
| `src/review/decide.ts` | Three verdicts → one decision. Pure, no IO (§12.1). |
| `src/review/council.ts` | Runs the reviewers in the task's worktree, read-only (§12.1). |
| `src/plan/brainstorm.ts` | `/brainstorm` → a brainstorm task. Pure, no IO (§14.3). |
| `src/plan/materialize.ts` | Plan → child tasks, waves and cycle detection. Pure (§14.3). |
| `src/plan/maintain.ts` | Re-checks a plan's edges when one of its tasks finishes (§14.3). |
| `src/notify/threads.ts` | Thread ↔ task, so a reply in a thread needs no id (§14.3). |
| `src/supervisor/probe.ts` | Progress evidence from git, not self-report. |
| `src/supervisor/loop.ts` | Claim → run → handoff/park/verify (§6). |
| `src/notify/http.ts` | The retrying JSON client every Discord path shares. |
| `src/notify/discord.ts` | Notification rendering + the webhook transport (§11.2). |
| `src/notify/bot.ts` | The bot's REST half — messages, threads. The only transport that can carry buttons (§7.1). |
| `src/notify/gateway.ts` | Discord gateway websocket — messages, interactions, presence (§7). |
| `src/notify/activity.ts` | What the bot advertises it is working on. Rendering is pure (§7.2). |
| `src/notify/commands.ts` | `!answer` parsing. Pure, no IO (§7). |
| `src/notify/components.ts` | Buttons and modals, and the `custom_id` codec. Pure (§7.1). |
| `src/notify/slash.ts` | The registered command set + what an interaction means. Pure (§7.1). |
| `src/notify/interactions.ts` | Interaction payloads and the 3-second callback (§7.1). |
| `src/notify/replies.ts` | What the bot says back. Pure, no IO. |
| `src/notify/bridge.ts` | Joins all four inbound surfaces onto one `Command` union (§7.1). |
| `src/supervisor/inbox.ts` | Hands chat commands to the poll loop, which owns the repo. |
| `src/supervisor/snapshot.ts` | In-memory task view, so a listing answers inside Discord's 3s budget. |
| `src/metrics/registry.ts` | Prometheus exposition (§11). |
| `src/obs/log.ts` | Structured JSON-line logging to stdout (§11). |
| `src/obs/ring.ts` | The last N log lines, in memory, as the logger's own sink (§18). |
| `src/obs/live.ts` | The session in flight, so it is visible before its transcript exists (§18). |
| `src/web/html.ts` | Tagged template that escapes by default. Every string here is agent-authored (§18). |
| `src/web/view.ts` | Read models. Reads only — the whole security argument for the view (§18). |
| `src/web/transcript.ts` | A pi transcript → renderable turns. Pure, no IO (§18). |
| `src/web/pages.ts` | The pages. Given a view model, returns HTML (§18). |
| `src/web/server.ts` | Routing, security headers, and the `GET`/`HEAD`-only gate (§18). |
| `src/view/discovery.ts` | Which runners exist, from the headless Service's SRV record. No kube API (§18). |
| `src/view/fanout.ts` | One GET per runner, forwarding the identity, reporting the failures (§18). |
| `src/view/aggregate.ts` | Four runners' answers merged into one page (§18). |
| `src/view/server.ts` | The viewer's own front door, with every §18 rule re-asserted. |
| `src/digest/day.ts` | Local day boundaries and DST. Pure, clock injected (§19). |
| `src/digest/collect.ts` | A day's facts, diffed out of the state repo's history (§19). |
| `src/digest/changes.ts` | Diffstat and commit subjects from local mirrors. No network (§19). |
| `src/digest/render.ts` | The one document Discord, git and the web view all get (§19). |
| `src/digest/summarise.ts` | The prose paragraph. No tools, and never fails a digest (§19). |
| `src/digest/publish.ts` | Claim the day, publish it, release the claim if that failed (§19). |
| `src/cluster/guard.ts` | The namespace allowlist. Empty denies everything (§20). |
| `src/cluster/names.ts` | The only path from a model string to a URL or a LogQL selector (§20). |
| `src/cluster/redact.ts` | Kind allowlist and Secret redaction. Pure, and the whole boundary (§20). |
| `src/cluster/client.ts` | Logs, events and describe. `node:https` with the cluster CA (§20). |
| `src/remediation/policy.ts` | `alerts/policy.yaml` — which alerts may become tasks. Pure (§20). |
| `src/remediation/receiver.ts` | The Alertmanager webhook. Answers fast, writes nothing, trusts nothing (§20). |
| `src/remediation/queue.ts` | Firing alert → `spec.md`, on the loop's thread of control (§20). |
| `src/redis/client.ts` | The nine-method Redis surface. The driver stops here (§21). |
| `src/redis/guarded.ts` | The one place a Redis failure becomes a value instead of a throw (§21). |
| `src/redis/inbox.ts` | Chat intents over a list, outcomes over a reply channel (§21). |
| `src/redis/snapshot.ts` | The task list as ONE key, cached in process for autocomplete (§21). |
| `src/redis/presence.ts` | Which runners are alive. Advisory, for display only (§21). |
| `src/redis/cancel.ts` | `/cancel` reaching a session that is already running (§21). |
| `src/redis/steering.ts` | A human's guidance reaching that same session (§7.3, §21). |
| `src/redis/plane.ts` | One decision at boot: Redis, or the objects that were already there (§21). |

## Invariants worth not breaking

These are enforced in code, not just documented. If a change makes one of them
awkward, the change is probably wrong.

1. **The agent never holds a credential.** Pushes go through a git credential helper;
   PRs and tracker writes go through supervisor-implemented tools. Session transcripts
   are committed to git, so a token in `argv` is a token in git history.
2. **The agent cannot declare itself done.** `done` only *claims* completion; the
   supervisor independently runs the acceptance criteria and checks CI, and then a review
   council of three reviewers reads the change itself (§12.1). Any one blocking objection
   sends it back, and an abstention is never an approval. Nothing merges as the identity
   that opened the PR: GitHub will not let a pull request's author approve it, and that
   refusal is the only thing making branch protection a real gate — so the council
   approves and merges through a *second* App, or not at all.
3. **The agent cannot write the state repo.** Task-scoped tokens never cover it, so the
   audit trail cannot be rewritten by the thing being audited.
4. **Every push verifies the lease first.** Claim-time exclusion is not enough — a
   partitioned runner must not resurrect stale work.
5. **The journal appends; `handoff.md` is overwritten.** An append-forever handoff
   eventually consumes the context window it exists to preserve. The journal keeps every
   entry on disk — one file per entry under `journal/`, so two runners recording the same
   task write different paths and their commits still rebase — but reaches a prompt as a
   bounded VIEW: repeats collapsed, oldest entries elided and declared, because
   append-only and unbounded-in-context are different properties and only the first is
   wanted (§4.1).
6. **The tracker is a view; git is authoritative.** Lifecycle mirroring happens after
   the state repo is written and pushed, and a mirroring failure only logs — an
   unreachable tracker must never fail a task. Discord is a view on the same terms: a
   failed notification logs `notify.failed` and never rewrites the state it announces.
7. **A task is never blamed for the provider.** When the model provider refuses — spend
   limit, rate limit, outage, expired credential — the task returns to `ready` untouched,
   its progress record is not written, and the **runner** backs off on a doubling
   cooldown instead of claiming the next task and failing identically. An account limit
   reached at 10:00 otherwise takes the whole queue with it in under a minute, which is
   exactly what happened on 2026-08-15 (§6.3).
8. **The web view cannot write, and everything on it is untrusted.** Anything but `GET`
   or `HEAD` is 405 before routing; every handler goes through `web/view.ts`, which only
   reads. Prose on those pages is model-authored and quotes whatever the agent read, so
   the template escapes by default, the CSP is `default-src 'none'` with no
   `unsafe-inline`, and an artifact is served as an attachment rather than as a document
   on the origin that also serves the transcripts (§18).
9. **An agent can only push the branch it is standing on.** Task worktrees share their
   mirror's config, and `clone --mirror` sets `remote.origin.mirror`, which silently made
   every agent `git push` a force-push of *every* ref — including `main`, at whatever
   commit the mirror last fetched. `configure` unsets it and pins
   `remote.origin.push = HEAD`, so no incantation an agent types can move a branch other
   than its own (§3, DESIGN.md).
10. **A mirror refresh never writes a branch a worktree holds.** One bare mirror serves
    every task on a repo, and `clone --mirror` fetches `+refs/*:refs/*` — so once any task
    pushed, the fetch tried to write a local head that task's worktree had checked out and
    git refused the *whole* fetch, parking every later task on that repo. The refspecs
    subtract `^refs/heads/agent/*` and one exclusion per branch `git worktree list` reports
    as held, because deriving it from the worktrees survives an agent renaming its own
    branch and a naming convention does not (§3, DESIGN.md).
11. **A day is claimed before it is published, and the claim is released if publishing
    failed.** `refs/digests/<date>` is won by one runner in the fleet with the same
    compare-and-swap that claims a task, and a failed CAS is never read as "someone else
    did it" without checking the ref — a rejected push is also what a dead network looks
    like. The asymmetry is the point: publishing twice is visible, while a day marked
    published and never published is silent, and nothing would ever revisit it (§19).
12. **No command from the agent's shell runs without a ceiling.** pi's bash tool
    documents its `timeout` as *"Defaults to no timeout"*, so without one the model
    decides whether a command may block forever — and a hung command holds its task's slot
    for as long as it hangs, while the heartbeat keeps renewing that lease and `/healthz`
    keeps answering 200. A runner that looks healthier the longer it is wedged. The
    housekeeping loop and any other slot keep running (`concurrency`, §6.5), which makes it
    worse to find rather than better: at the default of one slot the runner does nothing and
    still reports itself healthy. `BoundedExecutionEnv` both
    defaults *and* clamps `limits.commandTimeoutSeconds` (900), in the agent's shell and
    the review council's — it was the council's that wedged, for 2h42m, on an `npm test`
    whose subprocess never exited. `limits.maxSessionSeconds` is the backstop, not the
    fix: four hours is an outage, not a hang detector (§6.4).
13. **Cluster access is read-only, supervisor-held, and bound to one task kind.** The
    ServiceAccount token never leaves the supervisor — `kubectl` in the agent's shell was
    rejected precisely because the credential would then belong to the pod and every task
    on the runner would inherit it. `cluster_logs`, `cluster_events` and `cluster_describe`
    bind only for `kind: remediation`, every one of them checks the namespace against
    `cluster.namespaces` before any IO, an empty allowlist denies everything, and no model
    string reaches a URL path or a LogQL selector without passing the Kubernetes name
    grammar. `cluster_describe` reads eleven kinds and returns a Secret as key names and
    byte lengths: RBAC cannot express "keys but not values", so `cluster/redact.ts` is the
    entire boundary and is tested as one (§20).
14. **Redis is never authoritative, and a Redis outage degrades rather than fails.** It
    carries the ephemeral cross-process plane and only that — chat inbox, task snapshot,
    presence, cancel signals — because the Discord bot is its own process and cannot reach
    into the supervisor's heap. Leases, task state, the journal and the audit trail stay on
    git refs: `assertHeld` fences by comparing an **exact OID**, and a key that can
    evaporate leaves nothing to compare against, so that fence fails *open* while ref CAS
    fails *closed*. Every operation in `src/redis/` is bounded by a timeout and passes
    through `RedisGuard`, which turns a failure into today's in-memory answer and a
    throttled warn line; nothing there may throw into the poll loop. `redis.enabled`
    defaults to false, and with it off the runner is byte-for-byte what it has always been
    (§21).

## The web view

A read-only dashboard on `https://caterpillar.caes.ar`, behind the cluster's Authelia —
what is running where, the fleet's logs, the messages of the sessions in flight, every
stored transcript, and each task's spec, journal, questions, council verdicts and
artifacts. `/intake` is where a **refusal** shows up: a labelled item that could not become
a task, an alert that fired with no policy entry, and whether the alert receiver is
listening at all.

Every runner serves it on its own port, in-cluster. In front of them sits
**`caterpillar-view`** — the same image with a different command — which discovers the ready
pods through the headless Service and **aggregates**: task data from the first healthy
responder, because the state repo is identical everywhere, and the live sessions and log
rings unioned across all of them, because those exist in one process's memory each. A
replica that does not answer is rendered as unreachable next to its name rather than
dropped, since a missing runner reads as an idle one. It holds no credential, no volume and
no ServiceAccount token, and it forwards the `Remote-User` header it received rather than
asking the runners to relax their own check (§18).

It is off unless a runner is told otherwise:

```json
"web": { "enabled": true, "port": 8080, "requireForwardedUser": true }
```

`requireForwardedUser` refuses any request that did not arrive with Authelia's
`Remote-User` header. That is not a second login — anything inside the cluster can set a
header — it is a fail-closed check on an Ingress whose forward-auth annotations get
dropped, which would otherwise publish every transcript and look like a working deployment.

Locally: set `web.enabled`, run `npm start`, and open `http://localhost:8080`.

The viewer, locally, against runners you name yourself:

```sh
VIEW_RUNNERS=one=http://localhost:8080 VIEW_REQUIRE_FORWARDED_USER=false \
  VIEW_PORT=8090 npm run start:view
```

## Where the disk went

The scaling mechanisms — a bare mirror per repo, a worktree per task with its own
`node_modules`, a nix store per replica — fill a volume, and for a long time nothing in
this process could say which of them did it. Now the supervisor measures its own `work`
volume and reports it in both places it reports anything else:

```
caterpillar_work_fs_bytes{runner,kind="total"|"free"}   # from statfs
caterpillar_work_bytes{runner,category}                  # mirrors|tasks|nix|other
caterpillar_work_entry_bytes{runner,category,name}       # the largest few, `other` for the rest
caterpillar_work_partial{runner}                         # 1 when the walk ran out of time
caterpillar_work_measured_timestamp_seconds{runner}      # how stale the numbers above are
```

and as a **Disk** section on `/runner` in the web view, with the largest tasks and mirrors
named. Alert on `caterpillar_work_fs_bytes` — it is the only figure that also counts what
another process on the volume is using — and use the categories to find out who.

Three properties of the walk are deliberate and worth knowing before reading a graph:

- **Idle-only and hourly.** It runs from the same branch of the poll loop as the nix store
  collection, because it is one `stat` per file over a tree with a `node_modules` per task
  and it spends that time inside this process rather than inside nix. Idle means no slot is
  occupied, so on a runner that is never idle it never runs — which is why the page shows a
  timestamp as prominently as the bytes.
- **Apparent size**, like `du --apparent-size`, not allocated blocks. It is what a human
  means by "this checkout is 400 MB". The "is the volume full" question is answered exactly
  by `kind="free"`, which needs no summing at all.
- **Read-only**, without exception, and it can never fail a poll. A measurement that hits
  its deadline reports what it has with `caterpillar_work_partial` set rather than throwing
  the work away or blocking the loop.

Both knobs default sensibly and `0` turns the whole thing off:

```json
"usage": { "intervalHours": 1, "deadlineSeconds": 120 }
```

## The daily digest

One document a day — what moved, what it cost, what it changed in the code, and what is
still waiting on you — posted to Discord, committed to `digests/<date>.md` in the state
repo, and served at `/digests` in the web view. Same text in all three places (§19).

It is off unless a runner is told otherwise:

```json
"digest": { "enabled": true, "hour": 18, "timezone": "Europe/Berlin", "summarise": true }
```

- **`hour` + `timezone`** — when a day is considered over, on a local wall clock. The
  digest for the 16th covers 18:00 on the 15th to 18:00 on the 16th, so nothing falls
  between two days. A named IANA zone, never a fixed offset: `+02:00` is an hour wrong for
  seven months a year and says nothing about it.
- **`summarise`** — whether a model writes the opening paragraph. Everything else is
  measured from the state repo's git history and costs nothing; this is the only part that
  spends tokens. Turn it off and the report stays, minus the prose.

**Exactly one runner in a fleet publishes each day.** The first to reach the hour creates
`refs/digests/<date>` with the same compare-and-swap that claims a task (§5), and the
others find it taken. A pod that was rolled through the cutoff still publishes when it
comes back — catch-up reaches back one day, so a runner returning after a week does not
post seven digests at once.

Two things it will tell you about itself rather than fake:

- **a missing paragraph says why** — a provider outage prints a line where the prose would
  have been, because a digest that silently lost it looks exactly like one that never had
  a summariser;
- **a diff it cannot see says so** — a task branch lives in the mirror of the runner that
  worked it, so on another runner the digest names the repo it cannot read instead of
  printing `0 files changed` about a merged pull request.

Enabling it needs nothing else: no new secret, no port, no Deployment. It runs on the
existing poll loop and uses the notifier that is already configured.

## Reading the cluster

A session created by a firing alert (`kind: remediation`, §20) needs evidence: what the pod
logged, what Kubernetes said about it, what the object actually looks like. It gets three
tools — `cluster_logs`, `cluster_events`, `cluster_describe` — and **no way to write
anything**.

Off unless a runner is told otherwise, and the namespace list is the whole bound:

```json
"cluster": { "enabled": true, "namespaces": ["caterpillar", "monitoring"], "maxLogLines": 2000 }
```

- **`namespaces`** — which namespaces are readable, and nothing else widens it. There is no
  per-task and no per-alert list: a bound an alert payload could extend for itself is not a
  bound. **Empty denies everything**, so `enabled: true` with the list forgotten produces a
  runner that refuses every read, warns at startup and counts the denials — not one that
  reads the cluster.
- **`lokiUrl`, `kubeApiUrl`** — defaulted to the in-cluster addresses. Loki is plain HTTP
  (`SingleBinary`, `gateway.enabled: false`, so there is no nginx in front); the kube API is
  HTTPS verified against the cluster CA the ServiceAccount volume projects. There is no
  option to skip that verification and no fallback that quietly does.

The supervisor performs every call, so **the agent never holds the token**. That is the same
rule as everywhere else (§9.2), and it is why these are tools rather than `kubectl` in the
agent's shell: an ambient pod credential would belong to the pod, and every task that ever
ran on the runner would inherit cluster access with no allowlist between it and the API.

Two bounds are in code rather than configuration, deliberately, because widening them should
be a review:

- `cluster_describe` reads **eleven kinds** and no others — the workload kinds, `ConfigMap`,
  `Secret`, `Service`, `Ingress`, `PersistentVolumeClaim`. No nodes, no namespaces, nothing
  cluster-scoped.
- a **Secret comes back as key names and byte lengths.** Kubernetes RBAC cannot express
  "read a Secret's keys but not its values", so the supervisor's ServiceAccount does hold
  `get secrets` and `cluster/redact.ts` is the entire boundary — which is why it is a pure
  function with an adversarial test file that asserts on the serialized output, including
  the `last-applied-configuration` annotation where an earlier `kubectl apply` leaves a
  verbatim copy of the values. ConfigMaps are returned in full, on purpose: most
  misconfigurations live there.

Denials are visible: `caterpillar_cluster_reads_total{tool,outcome}` counts `ok`, `denied`
and `error` separately, because an allowlist that is wrong otherwise looks exactly like a
session that failed to diagnose anything.

Unlike the digest, this one does need something outside the ConfigMap: the supervisor's
ServiceAccount needs `get`/`list` on those kinds in those namespaces, granted by a Role per
namespace in the deployment repo. Nothing here creates or requests that permission — a runner
whose Role is missing gets a 403 and reports it as a failed read, which is the right shape of
failure for a permission an operator has not granted.

Without `cluster.enabled` a remediation task still runs — it gets the ordinary control verbs
and diagnoses from the repository. It does not crash, and it does not quietly acquire the
reads either.

## Alerts that become tasks

The fifth intake path (§14, §20). Alertmanager posts a firing alert to the supervisor's own
webhook port, and if an operator has already said what that alert means, it becomes a
`kind: remediation` task that runs like any other one and ends in a pull request.

```json
"remediation": { "enabled": true, "port": 8081 }
```

It needs one secret — `caterpillar-remediation`, key `webhook-token` — and **refuses to
start without it**. This is the only listener in the process that can cause a task to
exist, and a task is a session with a shell and a forge credential, so an unauthenticated
one is a remote code execution path. The token is compared in constant time; `/healthz`
answers ahead of the check, because the kubelet probes the pod directly and a probe that
gets 401 restarts a healthy container forever.

An alert becomes a task only if `alerts/policy.yaml` **in the state repo** has an entry for
its `alertname`, and that entry supplies the workspace, the repos and the acceptance
commands verbatim — nothing here synthesises a completion gate. An unlisted alert is
refused *once*, durably, in `alerts/refusals/<fingerprint>.json`: Alertmanager re-sends a
firing alert every few minutes and Keel rolls the pod on every push, so anything remembered
in memory would re-notify all day. The task id is `ALERT-<fingerprint>`, which is what makes
an alert firing for an hour one task rather than twenty.

**The session cannot touch the cluster.** Not a restart, not a scale, not a silence. The
cluster is evidence — read-only observations the supervisor performs — and the only output
is a pull request that the review council reads like any other. A fix that is not code is a
legitimate outcome, and the session is told so explicitly, because the alternative is a
plausible patch attached to an incident nobody diagnosed.

Turning this on touches four things in the deployment repo and one file in the state repo,
in an order that matters. **`docs/remediation-runbook.md`** is the end-to-end guide: the
order of operations, how to test the webhook by hand with `curl`, two worked
`alerts/policy.yaml` entries, the three levers for turning it off in a hurry, and what to do
about a 401, a 403 or an empty Loki result.

## Turning on Redis

Nothing needs it. `redis.enabled` defaults to false and every runner has run that way from
the beginning — the chat inbox, the task snapshot, presence, cancels, steering and the thread
bindings are six objects in the supervisor's heap. Turn it on when something else needs to see
them, which for now means one thing: the Discord bot becoming its own process, in its own pod,
unable to reach into a heap it is not in.

```json
"redis": {
  "enabled": true,
  "url": "redis://redis-ha.all-chat.svc.cluster.local:6379",
  "secretRef": "caterpillar-redis",
  "commandTimeoutMs": 1000,
  "keyPrefix": "caterpillar:"
}
```

The password is a credential, so it is not in that block. If `secretRef` is set, the key
`password` is read from the mounted secret directory like every other credential (§9); a
Redis reachable only inside the namespace's NetworkPolicy needs no `secretRef` at all.
`keyPrefix` is what lets two fleets share one server without a staging supervisor draining
production's chat inbox.

**What it does not do** is as important as what it does. No lease moves, no task state moves,
no journal entry moves. `assertHeld` still compares an exact OID against a git ref, and §21
of DESIGN.md argues at length why that is not a decision anyone should revisit: a fence over
a key that can evaporate fails *open*, which is how two runners end up working one branch.

**When Redis goes away**, the fleet degrades to exactly the configuration above with
`enabled` set back to false. Every operation is bounded by `commandTimeoutMs` and passes
through `RedisGuard`, which logs one throttled `redis.degraded` line per operation per 30
seconds and returns the in-memory answer. A cancel that cannot be read is *not pending*; a
presence that cannot be written is *one runner missing from a page*; a snapshot that cannot
be fetched is *the last one this process saw*; a steer that cannot be pushed is *guidance the
human is told did not land*, rather than one they are told did. The supervisor keeps claiming
and working tasks throughout, because none of that is where the work lives.

Steering is the one of the six that changes what a human is *told* when Redis is off, and it
says so deliberately: with no Redis the supervisor can steer a session in its own process and
nothing else, so a message for a task running on another machine is answered "I could not reach
the runner working it" rather than "sent to the session". Two machines sharing a state repo with
no Redis is a supported arrangement, and it is the one where the difference is visible.

```
redis.degraded    operation=presence.heartbeat failures=3 error=...
redis.recovered   operation=presence.heartbeat failures=41
```

To exercise the real driver rather than the in-memory one, point the suite at a server:

```bash
REDIS_TEST_URL=redis://localhost:6399 npm test
```

Four extra tests register and the contract in `src/redis/contract.test.ts` runs a third time,
against the same `createDriver` the supervisor uses. Without the variable they do not
register at all, which is what keeps `npm test` green on a machine with nothing on 6379 —
and running it *with* one is worth doing before touching `src/redis/`, because the last
defect found there was a cold start that only a real socket could show.

## Passing work between machines

Inputs never move. A game install, a USB device, a human — a task that needs one declares
`requires` and the agent runs where it already is (§8). Only *derived outputs* travel, and
`publish_artifact` carries the small ones:

```
publish_artifact(name: "sublevel-scan.json", path: "out/scan.json", note: "754 of 3513 sublevels carry resources")
```

They land in `tasks/<id>/artifacts/` in the state repo, capped at **1 MiB and 10 per task** —
every runner clones that repo and git keeps whatever lands there forever, so the cap is the
design rather than a safety net. An agent that hits it is told to summarise.

Artifacts flow along **`blockedBy` edges**: before a session starts, the supervisor stages
the artifacts of every task this one is blocked by and names the paths in the prompt. The
dependency graph a plan already carries decides the flow, so there is no second notion of
which task feeds which to keep in step.

Large binaries have a designed seam and no implementation — see DESIGN.md §17.1.

## Adding a runner with capabilities

The cluster pod advertises `linux, net`. A task that declares `requires: [usb]` or
`human-present` is claimable by **nobody** until a runner that has those exists — it sits
`ready` forever, looking like a stuck scheduler rather than a missing machine.

```bash
scripts/install-runner.sh --capabilities linux,usb,human-present --from-cluster
```

It derives the config from the deployed one (`--from-cluster` reads the ConfigMap, or pass
`--config FILE`) and overrides only the machine-specific parts: capabilities, the paths,
and where secrets are read from. That is deliberate — both runners share one state repo, so
they must agree about workspaces, limits and the model, and a hand-written second config is
a silent divergence waiting to happen. `--dry-run` prints the config and the unit without
writing either.

It does **not** fetch secrets or log in to the model. Copy the secret directories yourself
(`<root>/secrets/<secretRef>/<key>`, the same layout Kubernetes mounts) and run
`npm run llm:login -- --out <root>/credentials/anthropic.json` on the machine — the `--out`
is required, and the `--` is what stops npm from eating the flag. A script that could pull
private keys onto a workstation would be a worse problem than a manual copy.

Then work reaches it by capability, never by address (§8): an agent already running
elsewhere calls `handoff(requires: ["usb"])`, the task returns to `ready`, this runner
claims it on its next poll and appends to the **same** journal.

`nix` is the one capability you do not have to declare: the runner probes for it at boot and
advertises it if it is there (§8.1). Listing it explicitly still works and is kept — a
machine that advertises it without having it gets a warning at boot rather than a silent
correction, since it may be about to gain it.

## Scaling the fleet in the cluster

```bash
kubectl -n caterpillar scale statefulset/caterpillar --replicas=4
```

Nothing else. Task claiming is a compare-and-swap on a git ref with a fencing token (§5),
so replicas coordinate through the state repo and never with each other. Two things had to
exist first, and both are singletons that must stay at one replica:

| | Why a fleet needs it |
|---|---|
| `caterpillar-credentials` | Refreshing the Anthropic token **rotates the refresh token**, and the cluster has no `ReadWriteMany` storage class. N replicas would hold N copies and the first refresh would invalidate N−1 of them (§9.6). One pod owns it; runners read it over HTTP and never write. |
| `caterpillar-nix-cache` | Every replica materialises its own `/nix`, so N replicas would fetch the same 3.8G closure N times over the public internet. A pull-through cache in front of `cache.nixos.org` makes that one internet fetch and N−1 LAN copies (§8.1). |

Two config fields turn them on, and a fleet's ConfigMap carries **both** credential fields
because one object configures the runners and the holder:

```jsonc
"llm": {
  "credentialsUrl":  "http://caterpillar-credentials:8081",   // the RUNNERS read this
  "credentialsPath": "/work/credentials/anthropic.json"       // the HOLDER writes this
},
"toolchain": {
  "substituters": ["http://caterpillar-nix-cache/"],
  "trustedPublicKeys": [],       // none needed: the proxy passes upstream signatures through
  "minFreeGb": 8,                // below this much free on the NODE, nix collects mid-build
  "maxFreeGb": 25                // …until this much is free again
}
```

The third thing a fleet needs is the one nobody configures, because it defaults to on: each
replica **reaps its own task worktrees**. A worktree is a full checkout plus whatever a
session installs into it, per repo the task declares, and until this existed nothing ever
removed one — so a replica's 20Gi volume grew monotonically with every task it had ever
worked. The supervisor removes a task's checkout when it is done, when it failed, or when it
loses the lease to another replica; a sweep from the idle poll catches whatever a killed pod
left behind. Tasks that hand off or are waiting on a human keep their checkout, so answering
a question does not cost a re-clone. Both numbers are tunable and neither usually needs to
be:

```jsonc
"workspace": {
  "reap": { "intervalHours": 24, "keepHours": 72 }
}
```

`credentialsUrl` **wins** in a runner. That precedence is load-bearing: a runner preferring
the path would open a private copy on its own volume and start rotating a token its peers
are using. A runner with only `credentialsPath` — a machine runner, a local `docker run` —
is unchanged and fully supported.

What bounds the replica count is not this repo: node disk (each replica claims its own
`work` + `nix` volumes from a node-local storage class) and the **subscription's
per-account rate limit**, which is shared with your own interactive usage. The fleet
degrades rather than failing tasks when it is hit (§6.3), but many replicas contending for
one subscription mostly produces many runners in cooldown. Scaling *down* leaves the claims
behind — Kubernetes never deletes a StatefulSet's volumes.

> **A volume's requested size is not a quota, and this is the trap.** Under `local-path` a
> PVC is a directory on the node's own filesystem; the 15Gi request schedules the pod and
> the provisioner enforces nothing. A nix store that grows to 60Gi does not get ENOSPC at
> 15 — it fills the **node** and takes every other pod on it down. No storage class here
> behaves differently, and `ephemeral-storage` limits do not cover a PersistentVolume.
>
> `minFreeGb`/`maxFreeGb` above are the real bound: below `minFreeGb` free on the node's
> disk, nix collects **mid-build** until `maxFreeGb` is free. Measured against the node
> rather than the volume on purpose — replicas share a disk, so per-store ceilings that are
> each individually fine still add up to a full node. It bounds *growth*, which is the only
> time a store gets bigger; `gcKeepDays` still decides what is worth keeping. On by default
> at 5/20, because an unbounded store is how a runner takes down the machine it is on and
> a workstation is no different. `minFreeGb: 0` turns it off.
>
> The **work** volume is bounded separately, by worktree reaping (§3.1).

## Who the fleet commits as

Every commit the supervisor makes to the state repo and every commit the agent makes in a
task worktree carries one configured identity:

```json
"identity": {
  "name": "caterpillar-agent[bot]",
  "email": "316492202+caterpillar-agent[bot]@users.noreply.github.com"
}
```

It is **required** — there is no default, because a default is a claim about who wrote an
audit trail and a wrong one is unnoticeable after the fact. A runner without it refuses to
start rather than pick a name for you.

The id prefix is load-bearing and the loader refuses the address without it. A bare
`<login>@users.noreply.github.com` looks inert and is not: it is GitHub's pre-2017
personal noreply form, so GitHub resolves it to whoever holds that login and signs your
fleet's work with their name and avatar. That is not hypothetical — it is why this field
exists (DESIGN.md §9.7). Get the id for an App's bot account from:

```bash
gh api users/<slug>%5Bbot%5D --jq .id
```

which is a **different** number from the App id in the secret: the App id names the
application, this names the account it commits as.

**And nothing it writes carries a second name.** No `Co-Authored-By` trailer, no "Generated
with" footer, no 🤖, no model or tool name — in commit messages, PR titles and bodies,
review comments, journal entries or code comments. The only attribution is Caterpillar
itself, and it is already on the commit as the identity above.

This is a rule in the system prompts because the default is the opposite: a model reaches
for those trailers unprompted, having learned them from a corpus full of them, and the
fleet was signing its work with the name of the harness it resembles. A second name in the
message body also contradicts the configured author, which is the exact failure this
section exists to prevent. It is enforced in three prompts — the agent's, the review
council's shared preamble, and the digest summariser — because they publish to three
different places (DESIGN.md §9.7).

## Verifying a GitHub App setup

```bash
npm run verify:github-app -- --pem <key.pem> --app-id <id> --repo <owner/name>
```

Signs a JWT, prints the installation id, checks the installation can actually reach the
repo you named — suggesting the near miss when it cannot (§9.1.1) — mints a repo-scoped
token, and echoes the granted permissions. Never prints the token.

## Verifying the reviewer App

```bash
npm run verify:reviewer -- --pem <reviewer-key.pem> --app-id <id> --repo <owner/name> \
  --author-app-id <the app that opens PRs>
```

Signs a JWT, asserts the reviewer is a **different** App from the one that opens pull
requests, confirms it is installed on the repo, and mints a token with
`pull_requests: write`. It deliberately approves and merges nothing — there is no harmless
test merge, and an approval left on a real PR is a lie about who read it.

The one property it cannot prove is whether GitHub counts this App's approval towards your
branch protection. The first council merge is that test.

Without a `<secretRef>-reviewer` secret the council still runs and still records verdicts;
a passing task is `done` with its PR open for you to merge (§12.1).

## Verifying a Codeberg token

```bash
CODEBERG_TOKEN=... npm run verify:forgejo -- --repo ElectricBoogaloo/eb-api
```

Confirms the token reaches the repo, that out-of-scope repos are refused, and that the
commit-status route works with its scopes. Avoids `GET /user`, which a
repository-scoped token cannot reach — a 403 there looks like a bad token when the
scoping is in fact correct.

## Verifying a Vikunja token

```bash
VIKUNJA_TOKEN=... npm run verify:vikunja                  # read-only
VIKUNJA_TOKEN=... npm run verify:vikunja -- --task 42     # also writes, use a scratch item
```

Confirms the token authenticates, that agent-labelled items are discoverable, and that
the lifecycle labels exist. Avoids `GET /user` and `GET /tasks/all`, which no API token
can reach. A scope failure is reported as "re-grant this scope", never as a bad token —
Vikunja answers both with 401, and only one of them is worth debugging.

## Verifying a GitHub Issues installation

```bash
npm run verify:github-issues -- --pem <key.pem> --app-id <id> --installation <id>
npm run verify:github-issues -- ... --issue owner/name#7    # also writes, use a scratch issue
```

Mints an installation token with `issues: write` and `metadata: read` and nothing else,
enumerates the installation's repos, lists agent-labelled issues, and checks the
lifecycle labels exist on each repo carrying agent work. A 403 is reported as "the
installation lacks this permission", which is distinct from a 401 — GitHub separates
the two, so the adapter does not conflate them the way Vikunja forces.

## Verifying the Discord webhook

```bash
DISCORD_WEBHOOK_URL=... npm run verify:discord
DISCORD_WEBHOOK_URL=... npm run verify:discord -- --kind question
```

Renders the message, prints it with its length, and POSTs it to the real channel — the
only proof the outbound half works, since everything short of a live request is a stub
agreeing with itself. It leaves one message behind. The URL comes from the environment,
never argv: its last path segment is the credential, and nothing prints it, including on
failure.

## Verifying cluster reads from inside the pod

```bash
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read -- --namespace monitoring
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read -- --skip-loki --json
```

Seven checks in order, each with a remedy on failure: the `cluster` config block, the
projected token and CA, `GET /version` over TLS verified against that CA, each allowlisted
namespace, RBAC through `SelfSubjectAccessReview`, Loki (`/ready` and one real bounded
`query_range`), and the redaction promise against a **real Secret**, rendered through
`cluster/redact.ts` itself rather than a copy that would only agree with itself.

The check worth the most is the **negative** one. Alongside every read it needs, it asserts
`create`, `update`, `patch` and `delete` on `pods` and `deployments` are **denied** — a
preflight that only confirmed the reads it wanted would pass just as cheerfully against a
`cluster-admin` binding and would have certified the opposite of the property this whole
feature rests on. An allowed write verb fails the run.

It must run in a pod: the token and the CA come from the projected ServiceAccount volume,
and there is no flag that skips TLS verification. Outside a cluster it exits non-zero with
one line saying so. `docs/remediation-runbook.md` has the order of operations either side of
it — RBAC, ConfigMap, `alerts/policy.yaml`, the webhook secret, the Alertmanager route — and
how to turn the whole thing off in a hurry.

## Not yet built

- `!task <repo> <goal>` (§14 path 3). As written it carries no acceptance criteria, and
  §14 already refuses specs that have none — it cannot be added without deciding where
  they come from. Intake covers the tracker path; a hand-committed spec covers the rest.

Discord itself is built, both halves, and every part of it is inert until its secret keys
exist in the mounted `caterpillar-discord` secret:

| Key | Enables | Without it |
|---|---|---|
| `webhook-url` | outbound notifications (§11.2) | `NullNotifier` — the supervisor runs silently, unless a bot token is set |
| `bot-token` + `channel-id` | inbound `!answer`, slash commands, buttons (§7) — and outbound notifications *with* buttons | a question waits until a human commits the answer file |
| `application-id` + `guild-id` | the slash commands, registered by the runner itself at boot (§7.1) | `/answer` and friends never appear in the client; `!answer` still works |

The bot's Discord permissions want **Add Reactions** as well as Send Messages, Create Public
Threads and Manage Messages. It is not required: reactions are how a steer typed in a thread is
acknowledged (§7.3), and without the permission the bot says it in words instead. That is one
extra line per steer in a conversation of many short lines, which is the noise the reaction
exists to avoid.

Where both a webhook and a bot token exist, **the bot sends the notifications**. Discord
refuses interactive components from a webhook the application does not own, so a question
with an Answer button on it can only come from the bot; the webhook remains the fallback
and renders the typed `!answer` instruction instead (§7.1).

The bot needs the **MESSAGE_CONTENT** privileged intent enabled in the Discord developer
portal. Without it every message arrives with empty content and no command ever matches —
a checkbox, not something code can detect or fix.

### Listing tasks

```
/tasks                       # everything, most recently updated first
/tasks status:awaiting-human # just the ones waiting on you
/tasks status:done page:2    # the rest of a long listing
```

Ordered **newest first**, which is the difference between a useful listing and a decorative
one: a Discord message caps at 2000 characters so a listing caps at 25 lines, and the order
is what decides which 25. Sorted by task id — which is what walking `tasks/` gives — a fleet
of 39 tasks showed 23 finished ones and hid the task that was running.

The header counts every status over the whole set (`1 running · 4 ready · 31 done`), so the
shape of the backlog is visible without paging to it, and the footer names the exact command
for the next page. `25` per page; `page:` is clamped, so a page past the end is the last page
rather than an error.

### Seeing what it is working on, without asking

Where a bot token exists, the bot's **presence** says what the fleet is doing — visible in
the member list, with nothing to type and no page to open (§7.2):

| presence | what it means |
|---|---|
| `Watching ALERT-6155db · implementing` | one task running, and the phase it is in |
| `Watching 3 tasks running` | several at once — the web view says which |
| `Watching TASK-1 · review · 2 needs you` | working, and two tasks are also waiting on a human |
| `Watching 1 waiting for you` | nothing running; the fleet is stopped until you answer |
| `Watching for work · 4 ready` | idle **with a backlog** — if this persists, something is wrong |
| `Watching for work · nothing queued` | idle with nothing to do |

It is rendered from the same surveyed task state the web view uses, so it agrees with
`/tasks` rather than being a second source of truth, and it updates on the housekeeping
timer — which means it stays current *during* a session rather than freezing for the length
of one. Every replica publishes the identical line, so it survives a rollout without a
handover gap. Needs no configuration and no extra Discord permission beyond the bot token
already required above.

## Brainstorming a plan

```
/brainstorm topic:"make intake accept Linear issues" repo:acme/widget
/brainstorm topic:"split the client out of the server" repo:acme/widget, acme/api
```

The `repo:` option takes one repo or several, separated by commas or spaces. They must all
belong to the same workspace — one forge, one owner, one credential bundle — and a list
that crosses two is refused in the thread rather than quietly narrowed to one (§14.3). The
extra repos are checked out beside the first as `repos/<name>` (§9.4.1), and the plan's
child tasks inherit the whole list.

`open_pr` is idempotent: calling it for a branch that already has an open pull request **adopts
that PR** rather than failing, so a handoff, a lost state write, or a human who opened it by hand
does not leave the task unable to record it.

A task spanning several repos opens **one pull request per repo** it changed, and completion
checks CI in every one of them — so a repo it changed without opening a PR for will not merge.
Merging goes in the order the repos were named, stopping at the first failure, because the repos
of one change usually cannot land in either order. If a merge does stop halfway, the message
names which pull requests already landed.

**The `repo:` box autocompletes** from the repos the runner can actually reach, so the name
is picked rather than typed — and the ranking is deliberately forgiving: typing `allchat`
offers `caesarakalaeii/all-chat`. With several repos in the box, a suggestion keeps the ones
already there.

A repo the App cannot reach is still refused **before the task exists**, for the times
somebody types past the suggestions, and the refusal names the near miss:
`repo:caesarakalaeii/allchat` answers *"not one of the 65 repositories this workspace's
GitHub App can see — did you mean `caesarakalaeii/all-chat`?"* rather than opening a thread
that spends a session and parks on a git exit code (§9.1.1). Retype it and run the command
again; nothing was created.

Opens a thread and creates a brainstorm task in it. The agent reads the repos and asks one
question at a time — answer in the thread, where the task id is implied, so `!answer yes`
is the whole command. When the shape is settled it proposes a decomposition, the review
council reads it with plan-specific lenses, and on a pass the tasks are created with a
`wave` and a `blockedBy` (§14.3).

**It does not wait for the queue to drain.** The thread greets you and starts listening
straight away, a busy runner hands over at the end of the session it is in rather than at
the end of the task, and claiming puts a brainstorm ahead of batch work — so the wait is
the tail of one session, not however long the current task runs. Start talking in the
thread immediately; what you type before the agent picks it up is kept, not dropped
(§14.3).

### Talking to a task while it works, and after it stops

Everything typed in a task's thread reaches the task; what it *does* depends on what the task
is doing at the time, and there is no command to remember (§7.3):

| the task is | your message |
|---|---|
| asking a question | answers it — the next session reads it and continues |
| **running** | **steers the live session.** It reads it at the end of the step it is on, keeps its context and its work, and does not restart. Acknowledged with 👀 on your own message |
| `ready` | is journalled, and read at the start of the next session |
| **`parked` or `failed`** | is journalled, **resets the review council's round count**, and comes back with a **Resume** button |
| `done` | says so, and points at `/brainstorm` |

The parked row is the one that matters after a plan stalls. A rejected plan parks at
`maxReviewRounds` (default 3), and resuming it *without saying anything* buys exactly one more
round before it parks again — the council refuses the same plan for the same reason. Guidance is
what breaks that, which is why it is the thing that resets the count and why the notification
says resuming alone will not get past it.

`/resume`, `/cancel` and `/task` take **no task id inside a thread** — the thread is the id.
Typed with one they still address whatever you name, from anywhere.

To abandon one, `/cancel <task>` parks it and **closes its thread** — a last word saying
so, then archived. It works on a task that is *running*, not only on an idle one: the
session stops at the next turn boundary, nothing from it is recorded, and the park lands
on the following poll (the reply says `cancelling` until then). The task is never claimed
again; the thread keeps its history and un-archives if anyone posts in it. Nothing is deleted: parking already stops all work, and
the journal is the audit trail. To reclaim the disk, `git rm -r tasks/<id>` in the state
repo by hand, once no lease is held.

`/resume <task>` brings one back, from `parked` **or** `failed`. That matters more than it
sounds: a task can fail for a reason that has nothing to do with it — a runner brought up
without a usable model credential will fail whatever it claims — and a plan's later waves
are blocked by whatever failed, so a handful of unrelated failures can stall a whole plan.
`done` is the one status `/resume` refuses; coming back from that is a re-run, not a
recovery.

Resuming forgives the no-progress streak and — when guidance was given — the review council's
round count. It never forgives `sessions`: if the task has used its session budget the reply
says so rather than letting you find out when it parks itself again thirty seconds later.

Waves describe what **may** run concurrently. Whether anything actually does is a separate
setting: `concurrency` is how many tasks one replica works at once and defaults to 1, so out
of the box a wave is worked one task at a time by each replica. Raising it, or scaling the
StatefulSet, both work and both are safe for the same reason — the git-ref leasing does not
care whether the competing claimant is another replica or another slot in the same process
(§6.5). A rejected plan creates nothing.

In a fleet, **every replica connects to Discord but exactly one acts on it**, decided by a
compare-and-swap on `refs/chat/holder`. The connections are what keep the bot online
through a rollout; acting four times is what would open four threads for one
`/brainstorm`.

## Registering the slash commands

**Nothing to run.** The runner registers the command set itself at boot, once per change
across the whole fleet, claimed on `refs/commands/<digest>` — so the first pod up on a new
image publishes the new commands and the other three write nothing (§7.1). A changed
`COMMANDS` array is a changed digest; an unchanged one is a boot that registers nothing.
Guild-scoped, so what it publishes appears instantly.

That claim is why this stopped being a chore: it used to be a deploy-time step, and the one
time it was forgotten, an autocompleted `repo:` box shipped as code and stayed a plain text
field in Discord (§9.1.1).

By hand, when you need it:

```bash
npm run discord:register     # reads bot-token, application-id and guild-id from the secret
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npm run discord:register
```

Unconditional, and the escape hatch for what a digest cannot see: commands edited or deleted
**in Discord** leave the ref saying "published" and the guild disagreeing. It is also how a
command set is iterated on against a test guild from a workstation, with no pod and no state
repo. Registration is a full replace either way — the `COMMANDS` array in
`src/notify/slash.ts` **is** the surface.

The bot must have been invited with the `applications.commands` scope. An invite built
with `scope=bot` alone joins the guild and registers nothing, and the failure is a 403
that reads like a bad token — logged as `commands.failed`, and it stops nothing else.

Deployed via `caesar-deployment` at `apps/workloads/caterpillar`. `HANDOFF.md` has the
live topology, the credential rules, and an unresolved security note.
