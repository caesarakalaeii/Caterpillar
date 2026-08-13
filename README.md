# Caterpillar

A long-running autonomous coding agent supervisor. Survives context exhaustion, pod
restarts, and machine boundaries.

**Architecture and rationale: [`DESIGN.md`](DESIGN.md).** Read it first — the decisions
there are chosen deliberately, several against the obvious default, and the reasons are
not recoverable from the code.

**Status:** skeleton. Boundaries are defined and typechecked; forge, tracker, notifier,
and the session/verifier wiring are stubs that throw.

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
| `src/forge/` | `Forge` interface + GitHub App / Forgejo stubs (§9.1, §9.4). |
| `src/tracker/` | `Tracker` interface + GitHub Issues / Vikunja stubs (§9.5). |
| `src/agent/limits.ts` | Context budget and the handoff trigger (§6.1). |
| `src/agent/tools.ts` | Supervisor-mediated control-plane tools (§13). |
| `src/agent/session.ts` | Runs one pi session. |
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

## Not yet built

- forge implementations (JWT signing, token minting, PR + checks calls)
- tracker implementations (Vikunja and GitHub Issues HTTP)
- `SessionRunner` / `Verifier` / `ProgressProbe` wiring in `src/index.ts`
- workspace mirrors and per-task worktrees
- git credential helper binary
- Discord bridge (inbound `!answer`, outbound webhook)
- intake ingesters
- `caesar-deployment` manifests and ArgoCD Application
