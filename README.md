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
| `src/state/git.ts` | Typed git CLI wrapper. |
| `src/state/lease.ts` | Git-ref CAS leasing + fencing heartbeat (§5). |
| `src/state/store.ts` | Task directories: spec, state, journal, handoff (§4). |
| `src/forge/` | `Forge` interface + GitHub App and Forgejo/Codeberg (§9.1, §9.4). |
| `src/tracker/` | `Tracker` interface + Vikunja and GitHub Issues (§9.5). |
| `src/credential/` | Credential service + git helper protocol (§9.2). |
| `src/secrets/load.ts` | Mounted SOPS secrets → forge factories and trackers. |
| `src/workspace/worktree.ts` | Bare mirrors + per-task worktrees. |
| `src/workspace/toolchain.ts` | The one environment every task command runs in (§8.1). |
| `src/llm/outage.ts` | Provider outage vs. the task's own error. Pure, no IO (§6.3). |
| `src/supervisor/cooldown.ts` | The runner's back-off after a refusal. Pure, clock injected (§6.3). |
| `src/agent/limits.ts` | Context budget and the handoff trigger (§6.1). |
| `src/agent/journal.ts` | Bounded journal view for prompts. Pure, no IO (§4.1). |
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
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
| `src/notify/gateway.ts` | Discord gateway websocket — messages and interactions (§7). |
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
5. **`journal.md` appends; `handoff.md` is overwritten.** An append-forever handoff
   eventually consumes the context window it exists to preserve. The journal keeps every
   entry on disk, but reaches a prompt as a bounded VIEW — repeats collapsed, oldest
   entries elided and declared — because append-only and unbounded-in-context are
   different properties and only the first is wanted (§4.1).
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
8. **An agent can only push the branch it is standing on.** Task worktrees share their
   mirror's config, and `clone --mirror` sets `remote.origin.mirror`, which silently made
   every agent `git push` a force-push of *every* ref — including `main`, at whatever
   commit the mirror last fetched. `configure` unsets it and pins
   `remote.origin.push = HEAD`, so no incantation an agent types can move a branch other
   than its own (§3, DESIGN.md).

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
`npm run llm:login` on the machine. A script that could pull private keys onto a
workstation would be a worse problem than a manual copy.

Then work reaches it by capability, never by address (§8): an agent already running
elsewhere calls `handoff(requires: ["usb"])`, the task returns to `ready`, this runner
claims it on its next poll and appends to the **same** journal.

`nix` is the one capability you do not have to declare: the runner probes for it at boot and
advertises it if it is there (§8.1). Listing it explicitly still works and is kept — a
machine that advertises it without having it gets a warning at boot rather than a silent
correction, since it may be about to gain it.

## Verifying a GitHub App setup

```bash
npm run verify:github-app -- --pem <key.pem> --app-id <id> --repo <owner/name>
```

Signs a JWT, prints the installation id, mints a repo-scoped token, and echoes the
granted permissions. Never prints the token.

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
| `application-id` + `guild-id` | `npm run discord:register` (§7.1) | `/answer` and friends never appear in the client; `!answer` still works |

Where both a webhook and a bot token exist, **the bot sends the notifications**. Discord
refuses interactive components from a webhook the application does not own, so a question
with an Answer button on it can only come from the bot; the webhook remains the fallback
and renders the typed `!answer` instruction instead (§7.1).

The bot needs the **MESSAGE_CONTENT** privileged intent enabled in the Discord developer
portal. Without it every message arrives with empty content and no command ever matches —
a checkbox, not something code can detect or fix.

## Brainstorming a plan

```
/brainstorm topic:"make intake accept Linear issues" repo:acme/widget
```

Opens a thread and creates a brainstorm task in it. The agent reads the repo and asks one
question at a time — answer in the thread, where the task id is implied, so `!answer yes`
is the whole command. When the shape is settled it proposes a decomposition, the review
council reads it with plan-specific lenses, and on a pass the tasks are created with a
`wave` and a `blockedBy` (§14.3).

To abandon one, `/cancel <task>` parks it and **closes its thread** — a last word saying
so, then archived. The task is never claimed again; the thread keeps its history and
un-archives if anyone posts in it. Nothing is deleted: parking already stops all work, and
`journal.md` is the audit trail. To reclaim the disk, `git rm -r tasks/<id>` in the state
repo by hand, once no lease is held.

Waves describe what **may** run concurrently. One runner still works one task at a time —
actual parallelism means scaling the Deployment, which the git-ref leasing already makes
safe. A rejected plan creates nothing.

## Registering the slash commands

```bash
npm run discord:register     # reads bot-token, application-id and guild-id from the secret
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npm run discord:register
```

Guild-scoped, so the commands appear instantly. Registration is a full replace: the
`COMMANDS` array in `src/notify/slash.ts` **is** the surface, and re-running this is a
no-op rather than a duplicate. It is a deploy-time step, not a boot-time one — the
supervisor restarts on every rollout and would otherwise write the same set once per pod.

The bot must have been invited with the `applications.commands` scope. An invite built
with `scope=bot` alone joins the guild and registers nothing, and the failure is a 403
that reads like a bad token.

Deployed via `caesar-deployment` at `apps/workloads/caterpillar`. `HANDOFF.md` has the
live topology, the credential rules, and an unresolved security note.
