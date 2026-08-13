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
- `npm test` — 89 tests, all passing at last commit
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
| `caesar-deployment` manifests | **merged** (#45, #46, #47) |
| Deployment | **LIVE** — see below |

Not built yet, in the order I would take them:

1. **Intake ingesters.** This is now the only thing between a live supervisor and an
   idle one — see "The supervisor is live and has nothing to do" below.
2. Discord bridge (inbound `!answer`, outbound webhook).

## Deployment state: LIVE

Deployed 2026-08-13 and healthy. Nothing here is theoretical any more.

| | |
|---|---|
| Namespace | `caterpillar` |
| Context | **`default`** in `~/.kube/config` |
| ArgoCD app | `caterpillar`, `Synced` / `Healthy`, sync wave 6 |
| Pod | 1 replica, `Recreate`, `/healthz` + `/metrics` on 9090 |
| PVC | `caterpillar-work`, 20Gi RWO, bound |

Verified in-cluster: the App token minted, the state repo cloned onto the PVC, the
loop polls it (`FETCH_HEAD` refreshes every few seconds), metrics serve, and the
subscription credential loads through the app's own `FileCredentialStore`
(`type: oauth`).

**`argocd/root-app.yaml` auto-syncs `argocd/apps/` from `main` with `prune` and
`selfHeal`** — so anything added there deploys immediately, and anything *removed*
there is pruned from the cluster.

**The live app-of-apps is named `root`, not `root-app`.** The manifest file is
`root-app.yaml`; the Application it creates is `root`. `kubectl -n argocd get
application root-app` returns NotFound and looks alarming for no reason.

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

All four deployment prerequisites are done: image, pull credential, state repo, sealed
EB secret, and the subscription credential seeded onto the PVC.

### The supervisor is live and has nothing to do

**Read this before assuming the system works end to end.** It runs, but no task can
reach it.

`Supervisor.claimNext()` iterates `store.listTasks()`, which reads `tasks/` in the
**state repo**. Nothing in the running binary calls `Tracker.listAgentItems()` — grep
it: the only callers are `src/cli/verify-vikunja.ts` and
`src/cli/verify-github-issues.ts`. The tracker → `TaskSpec` path (DESIGN.md §14) is
**not built**.

So the deployed supervisor polls an empty `tasks/` directory forever. Labelling an
issue `agent` does nothing today. Until intake exists, the only way to give it work is
to commit a `tasks/<id>/spec.md` into `caterpillar-state` by hand — which is also the
cheapest way to prove the whole pipeline, since it exercises leasing, sessions,
verification, and the forge without needing intake first.

That makes **intake the single highest-value thing left**, and it is pure code with no
credential work attached.

The GHCR package is private (it inherits the repo's visibility), which is handled the
way `caesar-deployment` already handles its other private images: `imagePullSecrets:
myregistrykey`. Image-pull secrets are **namespaced**, so `caterpillar` carries its own
re-sealed copy of the same credential at `secrets/myregistrykey.enc.yaml` — rotating the
GHCR token means re-sealing it in every namespace that has one (`caesar`,
`ai-editor-collector`, `plot-spot`, `sn2-randomizer`, `spotify-widget`, `caterpillar`).

### The subscription credential is the sharp edge

`llm.credentialsPath` is `/work/credentials/anthropic.json` on the PVC, and it **cannot
become a Secret**. Refreshing rotates the refresh token and pi writes the new one back
inside `CredentialStore.modify`; a read-only mount means the supervisor works until the
access token expires and then stops. `FileCredentialStore` locks around the
read-modify-write so two sessions can't race a rotation — the loser would persist a
token the provider already invalidated. 30s to acquire; a lock older than 60s is treated
as abandoned by a process that died mid-refresh.

Seed it with `npm run llm:login -- --out ./auth.json` on a machine with a browser (a pod
has nowhere to open one), then `kubectl cp` it in.

**Two things this document previously got wrong, both corrected by watching the real
deploy:**

- **The pod does NOT crash-loop without the credential.** It boots clean, serves
  `/healthz`, and idles — the credential is read lazily when a session starts, not at
  boot. Do not wait for a crash loop as a signal that anything is wrong.
- **The real trap is that `/work/credentials` does not exist on a fresh PVC**, and
  `kubectl cp` will not create a missing parent. `mkdir -p` it in the pod first, or the
  copy fails.

Refresh is **lazy, not scheduled**. Nothing runs on a timer; pi refreshes when it next
uses the provider. An expired access token on an idle supervisor is normal, not a fault.
Verified in-cluster: `modify()` acquires the lock, persists, and releases correctly on
the real PVC.

**Deleting the PVC destroys the credential**, not just the mirrors and worktrees. There
is no copy anywhere else — recovery means re-running the browser login.

## Live credentials

The GitHub App exists and is verified working:

- App slug `caterpillar-agent`, **App ID `4579022`**, **installation ID `153385932`**
- Private key is SOPS-encrypted at
  `../caesar-deployment/apps/workloads/caterpillar/secrets/caterpillar-github-app.enc.yaml`
  (committed as `aca5042`). Keys: `app-id`, `installation-id`, `private-key.pem` —
  matching what `src/secrets/load.ts` reads.

> **UNRESOLVED — the App private key is exposed.** `aca5042` committed that Secret
> **twice**. The second path had a **trailing newline in its filename**
> (`caterpillar-github-app.enc.yaml\n`), so that session's `shred` and
> `sops --encrypt` both hit the correctly-named file while the newline-named copy kept
> its cleartext `stringData` — including `private-key.pem` — and was committed
> unencrypted. An earlier version of this document claimed "the plaintext PEM was
> shredded". It was not.
>
> caesar-deployment #46 removed the file, but by the owner's explicit decision the key
> was **not rotated** and history was **not** rewritten. The blob is still reachable in
> `aca5042`, and any clone predating #46 still holds a working key for app `4579022`.
> The repo is private and nothing was ever deployed from the plaintext copy.
>
> Rotating is cheap if this is ever revisited: generate a new key at
> `github.com/settings/apps/caterpillar-agent`, delete the old one, re-seal the Secret.
> App ID and installation `153385932` do not change. Note
> `seal-caterpillar-secrets.sh` has only `eb` and `discord` modes — re-sealing the App
> secret is a manual `sops` step.
>
> `ls` renders both filenames identically. Use `ls -b` or `find` to see a stray one.
- That secret is **live** — mounted into the running pod and used for state-repo pushes
  and task-scoped forge tokens.
- Verify any time with `npm run verify:github-app -- --pem <p> --app-id <id> --repo <r>`,
  or the tracker path with `npm run verify:github-issues`.
- **The installation is account-wide** ("All repositories" — 65 repos as of this
  writing). That is why `caterpillar-state` needed no separate install. If it is ever
  narrowed to selected repos, the state-repo mint returns 422 and the pod crash-loops
  at bootstrap.

To use the key locally: `sops --decrypt` the secret to a mode-0600 file, extract
`private-key.pem` with `yq`, and `shred -u` it after. Do not decrypt to stdout — the
key lands in the terminal, and in an agent session in the transcript.

**The state repo exists**: `caesarakalaeii/caterpillar-state`, private, seeded with a
README describing the layout. Verified minting `contents: write` scoped to it alone.

Codeberg and Vikunja tokens are **sealed and deployed**, in
`caterpillar-electric-boogaloo` (`username`, `tokens.json`, `vikunja-token`).

**Vikunja is still unverified.** The token is mounted, but:

- Labels `agent-wip` and `needs-human` **must already exist** on the instance — no
  adapter creates them, because the token deliberately has no `labels:create` scope.
  Names are overridable per workspace via `tracker.wipLabel` /
  `tracker.needsHumanLabel`. If they are missing, every lifecycle transition throws
  `UnknownVikunjaLabelError` — but only once a task actually reaches the eb workspace,
  which cannot happen until intake exists.
- `VIKUNJA_TOKEN=... npm run verify:vikunja` (read-only), then `-- --task <scratch id>`
  for the write scopes. **Still never run.** The routes come from
  `../electric-boogaloo-workspace/scripts/vikunja.py`, proven against the live instance,
  but this implementation has not itself touched it.

GitHub Issues is verified live (65 repos enumerate, token mints with `issues: write` and
nothing else). Its ingest label `agent` had **zero** matching issues at last check, and
the same repo-level label rule applies: `agent-wip` / `needs-human` must exist on each
repo that carries agent work.

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

The deploy is done. Everything below is about making the live supervisor actually
receive work.

1. **Prove the pipeline with a hand-written task.** Commit a `tasks/<id>/spec.md` into
   `caterpillar-state` (front-matter + prose goal + machine-checkable `acceptance`) and
   watch the pod claim it. This exercises leasing, the session runner, the credential
   helper, verification, and PR creation in one shot, and needs no new code. Nothing has
   yet run a real agent session in-cluster — this is the biggest untested surface.
2. **Build intake** (DESIGN.md §14) — `Tracker.listAgentItems()` → `TaskSpec` in the
   state repo. Until this exists, step 1 is the *only* way work arrives. Both trackers
   already implement the read side; nothing calls it.
3. **Verify Vikunja** — one command, and it has never been run against the live
   instance.
4. **Discord bridge** — questions currently land in `tasks/<id>/questions/` in git and
   nothing tells a human they are there.

Unresolved by choice, not by omission: the exposed App private key (see the callout
under "Live credentials").

## Immediate next action

Write the `caesar-deployment` manifests: `apps/workloads/caterpillar/` (Deployment with
`Recreate`, PVC for mirrors/worktrees, ConfigMap for `config.json`, ServiceMonitor) plus
`argocd/apps/caterpillar.yaml` at sync wave 4, following that repo's existing
conventions. The GitHub App secret is already committed there and inert; the ConfigMap
is the first place the workspace/tracker config from `src/config/types.ts` becomes real.
