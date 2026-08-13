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
- `npm test` — 73 tests, all passing at last commit
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
| GitHub Issues tracker | implemented, unit-tested, **verified against live GitHub** (PR #5) |
| Supervisor → tracker mirroring | implemented (claim / question / park / done) |
| State-repo credential + bootstrap | implemented, tested — App token, clone-if-missing |
| LLM auth: Claude subscription (OAuth) | implemented, tested — `llm.auth: subscription` |
| Container image + CI | **built and pushed by CI** — `ghcr.io/caesarakalaeii/caterpillar:main` |
| State repo | **created and verified** — `caesarakalaeii/caterpillar-state`, private |
| `caesar-deployment` manifests | **pushed**, caesar-deployment PR #45 — Application withheld |

Not built yet, in the order I would take them:

1. **Finish the deploy**: two prerequisites remain of the four in
   `../caesar-deployment/apps/workloads/caterpillar/README.md` — the sealed EB secret
   and the subscription credential. Both need a human. Then land
   `argocd/apps/caterpillar.yaml` LAST (see the warning below).
2. Discord bridge (inbound `!answer`), intake ingesters.

## Deployment state (nothing is live)

The Caterpillar side is merged to `main` and CI publishes the image. The manifests are
now pushed as caesar-deployment **PR #45**, deliberately without the Application.

**`argocd/root-app.yaml` auto-syncs `argocd/apps/` from `main` with `prune` and
`selfHeal`.** Pushing `argocd/apps/caterpillar.yaml` therefore *deploys immediately*.
Land the workload directory first, complete the four prerequisites, and add the
Application only when you want it live.

Decisions the user made by interview (do not re-litigate):

- **Claude Pro/Max subscription, not a metered API key.** pi-ai's Anthropic provider
  ships an OAuth mode (`isSubscription: true`) with PKCE and refresh built in — I
  initially and wrongly claimed this needed hand-built client impersonation. It does
  not. There is **no Anthropic API key anywhere** in either repo.
- **LiteLLM was removed** as a consequence: an OAuth bearer credential cannot be
  forwarded by a proxy that authenticates with `x-api-key`. DESIGN.md §9.6 is amended
  to describe both modes; `proxy` is retained in code and config.
- **State repo on GitHub, authenticated with the existing App**, rather than a deploy
  key — no new secret. The feared cost (an extra installation step) turned out not to
  exist: installation `153385932` is account-wide, so the repo was covered on creation.
- **Both workspaces from the start**, reusing the existing Codeberg and Vikunja tokens
  from the electric-boogaloo `.env`.

Still missing before it can sync: the **sealed EB secret** and the **subscription
credential** copied onto the PVC. Both need a human. The image, its pull credential, and
the state repo are done.

The GHCR package is private (it inherits the repo's visibility), which is handled the
way `caesar-deployment` already handles its other private images: `imagePullSecrets:
myregistrykey`. Image-pull secrets are **namespaced**, so `caterpillar` carries its own
re-sealed copy of the same credential at `secrets/myregistrykey.enc.yaml` — rotating the
GHCR token means re-sealing it in every namespace that has one (`caesar`,
`ai-editor-collector`, `plot-spot`, `sn2-randomizer`, `spotify-widget`, `caterpillar`).

### The subscription credential is the sharp edge

`llm.credentialsPath` points at a file on the PVC, and it **cannot become a Secret**.
Refreshing rotates the refresh token and pi writes it back inside
`CredentialStore.modify`; a read-only mount means the supervisor works for about an hour
and then stops. `FileCredentialStore` takes a lock directory so two sessions can't race
a rotation — the loser would persist a token the provider already invalidated.

Seed it with `npm run llm:login -- --out ./auth.json` on a machine with a browser (a pod
has nowhere to open one), then `kubectl cp` it in. The pod crash-loops until it's there;
that's expected, copy the file in and delete the pod.

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
- **The installation is account-wide** ("All repositories" — 65 repos as of this
  writing). That is why `caterpillar-state` needed no separate install. If it is ever
  narrowed to selected repos, the state-repo mint returns 422 and the pod crash-loops
  at bootstrap.

To use the key locally: `sops --decrypt` the secret to a mode-0600 file, extract
`private-key.pem` with `yq`, and `shred -u` it after. Do not decrypt to stdout — the
key lands in the terminal, and in an agent session in the transcript.

**The state repo exists**: `caesarakalaeii/caterpillar-state`, private, seeded with a
README describing the layout. Verified minting `contents: write` scoped to it alone.

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
- **pi-ai supports Claude subscriptions natively.** `anthropicProvider()` carries an
  `oauth` auth mode next to `apiKey` — PKCE flow, device code, and token refresh, all
  in the library. Do not reach for the API key path by reflex; check the provider first.
- **An OAuth refresh ROTATES the refresh token**, and pi does it inside
  `CredentialStore.modify`. That single fact decides where the credential can live: not
  a Secret, not an env var — writable durable storage only.
- **`gh` push to `caesar-deployment` needs a pull first** — it moves under you.
- **`argocd/root-app.yaml` auto-syncs `argocd/apps/`** with `prune` + `selfHeal`. Adding
  a file there is a deploy, not a proposal.
- **SOPS in `caesar-deployment` encrypts by PATH.** `.sops.yaml` keys its creation rules
  off `path_regex: .*\.enc\.yaml$`, so encrypting a `/tmp` file fails with "no matching
  creation rules found". Write the plaintext to its final `*.enc.yaml` path (umask 077)
  and `sops --encrypt --in-place` there.
- **Don't hand-edit an encrypted file's plaintext fields.** The SOPS MAC covers
  unencrypted values too, so changing `metadata.namespace` by hand breaks decryption.
  Re-target a secret with decrypt → edit → encrypt.
- **Check the whole repo before claiming a convention doesn't exist.** I grepped one
  workload, concluded nothing used `imagePullSecrets`, and wrote it into two documents.
  Six workloads use it.
- **GitHub's issues route returns pull requests too.** Every PR is an issue in the data
  model, so unfiltered intake would hand the agent its own open PRs as fresh work. The
  `pull_request` key is the only reliable discriminator.
- **`POST /issues/{n}/labels` silently CREATES an unknown label**, with a random colour.
  Vikunja is protected from this by a withheld `labels:create` scope; GitHub has no
  equivalent to withhold, so `github-issues.ts` checks the repo's labels first and
  refuses. Do not "simplify" that lookup away.
- **GitHub distinguishes 401 from 403; Vikunja cannot.** 403 is a valid credential
  without the permission, 401 is a bad credential. Only 403 becomes `TrackerScopeError`.
- **The GitHub search API is deliberately unused for intake.** It is eventually
  consistent — a freshly labelled issue can be invisible for about a minute, which is
  exactly the window intake runs in — separately rate limited, and its legacy
  issue-search behaviour is on a deprecation path. Enumerate the installation instead.
- **`per_page=100` contains the substring `page=1`.** A test stub matching pages with
  `path.includes("page=1")` answers every page with a full one and paginates forever.
  This cost a hung suite; the Vikunja tests only escape it because `per_page=50` does
  not contain `page=1`. Anchor on `&page=N`.
- **The caesar cluster is the `default` context in `~/.kube/config`**, not anything in
  `~/.kube/caesar-clusters` — the `k3d-caesar-cluster` context there points at a host
  that refuses connections. Check `kubectl --context default get ns` for `argocd`.

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

Both open PRs need review and merge: Caterpillar **#5** (GitHub Issues tracker) and
caesar-deployment **#45** (workload manifests).

Then the two prerequisites that can only be done by a human, in this order:

1. **Seal the EB secret** — `../caesar-deployment/scripts/seal-caterpillar-secrets.sh eb`.
   Reads the workspace `.env` in-process and never prints a value. Until this exists,
   `kustomize build apps/workloads/caterpillar` fails on the missing file, which is
   expected and harmless while no Application references the directory.
2. **Seed the subscription credential** — `npm run llm:login -- --out ./auth.json` on a
   machine with a browser, then `kubectl cp` it onto the PVC and `shred -u` the local
   copy. This one needs the pod to already exist, so it comes after the first sync.

Vikunja is still unprovisioned (token + the two labels) and blocks only the
electric-boogaloo workspace's mirroring, not the deploy.

Land `argocd/apps/caterpillar.yaml` LAST — that file is the deploy.

## Immediate next action

Write the `caesar-deployment` manifests: `apps/workloads/caterpillar/` (Deployment with
`Recreate`, PVC for mirrors/worktrees, ConfigMap for `config.json`, ServiceMonitor) plus
`argocd/apps/caterpillar.yaml` at sync wave 4, following that repo's existing
conventions. The GitHub App secret is already committed there and inert; the ConfigMap
is the first place the workspace/tracker config from `src/config/types.ts` becomes real.
