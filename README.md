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

Work reaches it two ways: label a tracker item `agent` and intake renders a spec (§14),
or commit a `tasks/<id>/spec.md` into the state repo by hand for full control over the
acceptance criteria. See `HANDOFF.md`.

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
| `src/agent/limits.ts` | Context budget and the handoff trigger (§6.1). |
| `src/agent/journal.ts` | Bounded journal view for prompts. Pure, no IO (§4.1). |
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
| `src/agent/runner.ts` | Assembles a session: worktree, tools, prompt, budget. |
| `src/intake/spec.ts` | Tracker item → `TaskSpec`. Pure, no IO (§14). |
| `src/intake/ingest.ts` | Idempotent tracker → state-repo ingestion (§14). |
| `src/supervisor/verifier.ts` | Independent completion gates (§12). |
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
   supervisor independently runs the acceptance criteria and checks CI.
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

## Verifying a GitHub App setup

```bash
npm run verify:github-app -- --pem <key.pem> --app-id <id> --repo <owner/name>
```

Signs a JWT, prints the installation id, mints a repo-scoped token, and echoes the
granted permissions. Never prints the token.

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
