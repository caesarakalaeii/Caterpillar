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

NixOS-friendly — everything comes from the flake:

```bash
nix develop            # node 22, git, jq, sops, age, kubectl, kustomize
npm install --ignore-scripts
npm run check          # typecheck
npm test               # unit tests
npm run build          # emit to dist/
```

**Node 22 specifically, not "22 or newer".** The tests and the `verify:*` scripts run
TypeScript through `--experimental-transform-types`, which node 26 **removed** — and
strip-only mode cannot parse the parameter properties this codebase uses throughout, so
on node 26 `npm test` fails to load a single file. `src/credential/service.test.ts`
spawns the credential helper with the same flag, so it fails there for the same reason.
CI pins node 22; a workstation with a newer node needs one too.

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
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
| `src/agent/runner.ts` | Assembles a session: worktree, tools, prompt, budget. |
| `src/intake/spec.ts` | Tracker item → `TaskSpec`. Pure, no IO (§14). |
| `src/intake/ingest.ts` | Idempotent tracker → state-repo ingestion (§14). |
| `src/supervisor/verifier.ts` | Independent completion gates (§12). |
| `src/supervisor/probe.ts` | Progress evidence from git, not self-report. |
| `src/supervisor/loop.ts` | Claim → run → handoff/park/verify (§6). |
| `src/notify/discord.ts` | Discord webhook — questions, parks, outcomes (§11.2). |
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
   eventually consumes the context window it exists to preserve.
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

- The **inbound** Discord bridge: `!answer` (§7) and `!task <repo> <goal>` (§14 path 3).
  A question still lands in `tasks/<id>/questions/` and waits there until a human commits
  the answer by hand.
  The **outbound** half is implemented (§11.2). It is active only when a `webhook-url`
  key exists in the mounted `caterpillar-discord` secret; without one `index.ts` uses
  `NullNotifier` and the supervisor runs silently.

Deployed via `caesar-deployment` at `apps/workloads/caterpillar`. `HANDOFF.md` has the
live topology, the credential rules, and an unresolved security note.
