# Caterpillar

A long-running autonomous coding agent supervisor. Survives context exhaustion, pod
restarts, and machine boundaries.

**Architecture and rationale: [`DESIGN.md`](DESIGN.md).** Read it first — the decisions
there are chosen deliberately, several against the obvious default, and the reasons are
not recoverable from the code.

**Picking up mid-stream: [`HANDOFF.md`](HANDOFF.md)** — current status, live credential
IDs, environment quirks, and the traps already paid for.

**Status:** the supervisor runs end to end — leasing, sessions, handoff, verification,
both forges, and the Vikunja tracker. Not yet deployed; see *Not yet built* below.

## Development

NixOS-friendly — everything comes from the flake:

```bash
nix develop            # node 22, git, jq, sops, age, kubectl, kustomize
npm install --ignore-scripts
npm run check          # typecheck
npm test               # unit tests
npm run build          # emit to dist/
```

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
| `src/tracker/` | `Tracker` interface + Vikunja; GitHub Issues still a stub (§9.5). |
| `src/credential/` | Credential service + git helper protocol (§9.2). |
| `src/secrets/load.ts` | Mounted SOPS secrets → forge factories and trackers. |
| `src/workspace/worktree.ts` | Bare mirrors + per-task worktrees. |
| `src/agent/limits.ts` | Context budget and the handoff trigger (§6.1). |
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
| `src/agent/runner.ts` | Assembles a session: worktree, tools, prompt, budget. |
| `src/supervisor/verifier.ts` | Independent completion gates (§12). |
| `src/supervisor/probe.ts` | Progress evidence from git, not self-report. |
| `src/supervisor/loop.ts` | Claim → run → handoff/park/verify (§6). |
| `src/metrics/registry.ts` | Prometheus exposition (§11). |

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
   unreachable tracker must never fail a task.

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

## Not yet built

- GitHub Issues tracker (HTTP)
- Discord bridge (inbound `!answer`, outbound webhook)
- intake ingesters
- `caesar-deployment` manifests and ArgoCD Application
