# Handoff

State as of 2026-08-13. Overwrite this file rather than appending to it — an
append-forever handoff eventually consumes the context it exists to preserve (the same
reason `handoff.md` is overwritten and `journal.md` appends, DESIGN.md §4.1).

## Orientation

**Caterpillar** is a long-running autonomous coding agent supervisor. Read
[`DESIGN.md`](DESIGN.md) first — it is the source of truth for intent, the decisions in
it were settled by interview, and several were made *against* the obvious default for
stated reasons. Do not re-litigate them; if one looks wrong, the rationale is written
down next to it.

`README.md` has the file-by-file layout and the six load-bearing invariants.

**The local directory is `~/Hobby/remote-agent` but the project is `Caterpillar`** —
the directory was never renamed. Remote: `github.com/caesarakalaeii/Caterpillar`
(private).

## Environment

NixOS. **There is no `node` or `npm` on PATH.** Everything runs through nix:

```bash
nix develop                                    # node 22, git, jq, sops, age, kubectl
nix shell nixpkgs#nodejs_22 --command npm test  # one-off, what I used throughout
```

- `npm run check` — typecheck (strict, `exactOptionalPropertyTypes`, no `any`)
- `npm test` — 59 tests, all passing at last commit
- Tests need `--experimental-transform-types`, **not** `--experimental-strip-types`:
  strip-only mode cannot parse TypeScript parameter properties, which this codebase
  uses throughout. Already set in `package.json`.
- `sops` is not installed globally either — `nix shell nixpkgs#sops --command sops ...`

## Status

Built, typechecked, and tested end to end:

| Area | State |
|---|---|
| Leasing (git-ref CAS, heartbeat fence) | implemented, tested |
| Context budget + handoff trigger | implemented, tested |
| Credential service + git helper | implemented, integration-tested over a real socket |
| GitHub App forge (mint, PR, checks) | implemented, verified against live GitHub |
| Forgejo/Codeberg forge | implemented, endpoints verified against live Codeberg |
| Session runner | implemented, end-to-end tested with pi's `fauxProvider` |
| Verifier + progress probe | implemented |
| Multi-repo checkout | implemented, tested |
| Vikunja tracker | implemented, unit-tested — **not yet run against the live instance** |
| Supervisor → tracker mirroring | implemented (claim / question / park / done) |
| State-repo credential + bootstrap | implemented, tested — App token, clone-if-missing |
| Container image + CI | written, **never built** (no docker/podman on this machine) |
| `caesar-deployment` manifests | written, `kustomize build` clean, **not pushed** |

Not built yet, in the order I would take them:

1. **Finish the deploy**: the three prerequisites in
   `../caesar-deployment/apps/workloads/caterpillar/README.md` — image published,
   state repo created with the App installed on it, secrets sealed. Then land
   `argocd/apps/caterpillar.yaml` LAST (see the warning below).
2. GitHub Issues tracker (`src/tracker/github-issues.ts` is still a stub; `loadTracker`
   returns `undefined` for it and logs, so a workspace configured for it runs unmirrored
   rather than half-mirrored).
3. Discord bridge (inbound `!answer`), intake ingesters.

## Deployment state (nothing is live)

Written but **uncommitted** in `../caesar-deployment`, plus `Dockerfile` and
`.github/workflows/build-and-push.yml` here.

**`argocd/root-app.yaml` auto-syncs `argocd/apps/` from `main` with `prune` and
`selfHeal`.** Pushing `argocd/apps/caterpillar.yaml` therefore *deploys immediately*.
Land the workload directory first, complete the three prerequisites, and add the
Application only when you want it live.

Decisions the user made by interview (do not re-litigate):

- **LiteLLM deployed alongside**, rather than pointing at Anthropic directly — keeps
  §9.6 intact: one spend-cap choke point, and no provider credential outside the proxy.
- **State repo on GitHub, authenticated with the existing App**, rather than a deploy
  key — no new secret, at the cost of the App needing an installation on that repo.
- **Both workspaces from the start**, reusing the existing Codeberg and Vikunja tokens
  from the electric-boogaloo `.env`.

Still missing before it can sync: an **Anthropic API key** (nothing in the repo or the
`.env` provides one; `scripts/seal-caterpillar-secrets.sh litellm` prompts for it), the
**state repo**, and the **published image**.

## Live credentials

The GitHub App exists and is verified working:

- App slug `caterpillar-agent`, **App ID `4579022`**, **installation ID `153385932`**
- Private key is SOPS-encrypted at
  `../caesar-deployment/apps/workloads/caterpillar/secrets/caterpillar-github-app.enc.yaml`
  (committed as `aca5042`). Keys: `app-id`, `installation-id`, `private-key.pem` —
  matching what `src/secrets/load.ts` reads. The plaintext PEM was shredded.
- That secret is inert: no ArgoCD Application references the directory yet, and the
  `caterpillar` namespace does not exist.
- Verify any time with `npm run verify:github-app -- --pem <p> --app-id <id> --repo <r>`.

Codeberg: the user already has a token covering the whole `ElectricBoogaloo` ecosystem
and wants to keep it. Not yet stored in a secret.

**Vikunja: nothing is provisioned yet.** Before the tracker can run:

1. Create a *dedicated agent* API token (Settings → API Tokens) with exactly the scopes
   in DESIGN.md §9.5 — and not `tasks: delete`.
2. Store it as key `vikunja-token` in the workspace's secret (`loadTracker` reads that
   key; the same secret already holds the forge credentials).
3. Make sure labels `agent-wip` and `needs-human` **exist** — no adapter creates them,
   because the token deliberately has no `labels:create` scope. Names are overridable
   per workspace via `tracker.wipLabel` / `tracker.needsHumanLabel` in config.
4. `VIKUNJA_TOKEN=... npm run verify:vikunja` (read-only), then
   `-- --task <scratch id>` to exercise the write scopes. **This has not been run yet**
   — the routes come from `../electric-boogaloo-workspace/scripts/vikunja.py`, which was
   proven against the live instance, but this implementation has not itself touched it.

## Things learned the hard way

Each of these cost real debugging. They are all encoded in code or tests now; do not
"simplify" them away.

- **pi does not auto-compact.** Compaction lives in the coding-agent harness, not
  `pi-agent-core`. The hazard is a provider context-length error, not silent
  summarisation. DESIGN.md §6.1 was corrected after implementation.
- **Context size must include `cacheRead` + `cacheWrite`.** `input + output` alone
  badly undercounts a cached context, so a 70% threshold would fire far too late.
- **"No merging" is not expressible as a GitHub permission.** `pull_requests: write`
  authorises merge. Branch protection requiring an approving review is what enforces
  it. DESIGN.md §9.1.
- **The agent/supervisor credential boundary is leak hygiene, not a wall.** They share
  a container, so an adversarial agent could reach the socket. The real boundary is
  token scope. DESIGN.md §9.2.
- **Forgejo has no Checks API** (`/check-runs` → 404, verified). Commit statuses are
  the only CI signal, and its `error`/`warning` states have no GitHub equivalent.
- **Forgejo returns `statuses: null`, not `[]`.** Typed and tested. Vikunja does the
  same with a task's `labels`.
- **`--git-common-dir`, not `--git-dir`**, for `info/exclude` in a linked worktree.
  The first attempt silently did nothing.
- **Never set `remote.origin.url` from a worktree** — worktrees share the mirror's
  config, so it rewrites the mirror's fetch URL for every task.
- **Vikunja: `GET /user` and `GET /tasks/all` are unreachable by any API token**, and a
  401 means a missing route scope, not a bad token. Probe `/projects` instead.
- **Vikunja descriptions and comments are HTML, not markdown** (TipTap). A `**bold**`
  note renders as literal asterisks, so prose is escaped and wrapped in `<p>` going out
  and stripped back to text coming in.
- **Vikunja label removal goes through `POST /tasks/{id}/labels/bulk`**, re-sending the
  surviving set. The per-label `DELETE` needs `tasksLabels: delete`, which the agent
  token must not have — it would let the agent strip a label a human applied.
- **Commit signing must be forced off.** A machine runner inherits the operator's global
  git config, and `commit.gpgsign = true` (the default once SSH signing is set up) fails
  every commit with an error naming 1Password rather than anything here. Handled in two
  places, and both are needed: `-c commit.gpgsign=false` on every `Git` invocation, and
  `commit.gpgsign false` written into each worktree's config, because the agent commits
  with its own `git` calls through the bash tool.
- **`gh` push to `caesar-deployment` needs a pull first** — it moves under you.

## Constraints the user has set

- **Do not read `~/Hobby/electric-boogaloo-workspace/.env`.** It holds the Codeberg and
  Vikunja tokens. The scripts beside it (`cb-api.sh`, `vikunja.py`) are fine to read and
  are good prior art for the secret-handling pattern. Enforced by a tool classifier, not
  just convention — even listing variable *names* is blocked. The user seals those
  tokens themselves with `../caesar-deployment/scripts/seal-caterpillar-secrets.sh eb`,
  which reads `.env` in-process and never prints a value.
- Conventional Commits, **no** `Co-Authored-By` trailer, no gitmoji.
- Never use the type `any`.
- Prefer open-source, provider-agnostic tooling — this is why the project is built on
  `pi` rather than a vendor SDK. The user asked to be argued with rather than deferred
  to; pi also turned out to be technically better here.
- Pull before working in a repo.

## Immediate next action

Write the `caesar-deployment` manifests: `apps/workloads/caterpillar/` (Deployment with
`Recreate`, PVC for mirrors/worktrees, ConfigMap for `config.json`, ServiceMonitor) plus
`argocd/apps/caterpillar.yaml` at sync wave 4, following that repo's existing
conventions. The GitHub App secret is already committed there and inert; the ConfigMap
is the first place the workspace/tracker config from `src/config/types.ts` becomes real.
