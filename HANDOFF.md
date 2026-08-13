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
| Credential service + git helper | implemented, integration-tested through **real git** (`credential fill`) |
| Workspace mirror clone (private repos) | **fixed locally, never run in-cluster** — see "The clone fix" |
| GitHub App forge (mint, PR, checks) | implemented, verified against live GitHub |
| Forgejo/Codeberg forge | implemented, endpoints verified against live Codeberg |
| Session runner | implemented, end-to-end tested with pi's `fauxProvider` |
| Verifier + progress probe | implemented |
| Multi-repo checkout | implemented, tested |
| Vikunja tracker | implemented, unit-tested, **verified against the live instance** |
| GitHub Issues tracker | implemented, unit-tested, **verified against live GitHub** (PR #5) |
| Supervisor → tracker mirroring | implemented (claim / question / park / done) |
| State-repo credential + bootstrap | implemented, tested — App token, clone-if-missing |
| LLM auth: Claude subscription (OAuth) | implemented, tested — `llm.auth: subscription` |
| Container image + CI | **built and pushed by CI** — `ghcr.io/caesarakalaeii/caterpillar:main` |
| State repo | **created and verified** — `caesarakalaeii/caterpillar-state`, private |
| `caesar-deployment` manifests | **merged** (#45, #46, #47) |
| Deployment | **LIVE** — see below |

Not built yet, in the order I would take them:

1. **Intake ingesters.** Once the clone fix ships, this is the only thing between a live
   supervisor and an idle one — see "The supervisor is live and has nothing to do" below.
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

### What the first end-to-end run proved

A hand-written task (`SMOKE-1`, targeting the throwaway repo
`caesarakalaeii/caterpillar-smoke`) was committed to the state repo and claimed. It
found **four** defects that every unit test and every live credential check had missed,
because nothing had ever driven a private repo through the worktree path.

Three are fixed and merged in **PR #8**, live as image `e42852ee`; the fourth is fixed
locally but **not yet built, deployed, or run in-cluster** — see "The clone fix" below.

1. **The mirror clone was anonymous.** `syncMirror` cloned *before* `configure()` wrote
   `credential.helper`, so private repos died on `could not read Username`. Public repos
   hid it completely. The helper is now passed to the clone itself via `-c`.
2. **A failed clone poisoned the path permanently.** `mkdir` ran before `clone`, so a
   failure left an empty directory; every retry then took the `fetch` branch and died
   with `not a git repository` — a message describing the symptom and hiding the cause.
   Unrecoverable without deleting the path by hand, which had to be done on the live PVC.
   The check now tests for `HEAD` *inside* the mirror and self-heals a partial one.
3. **One bad task killed the supervisor.** `run()` rethrew anything but
   `LeaseLostError`, exiting the process; the durable claim meant the restart re-claimed
   the same task and died again, wedging the runner permanently. Such a task is now
   journalled, parked, and skipped. Confirmed: the pod holds `1/1 Running` with **0
   restarts** through repeated failures where it previously CrashLoopBackOff'd.

### The clone fix — diagnosed, fixed, NOT yet deployed

The fourth defect was:

```
remote: Repository not found.
fatal: repository 'https://github.com/caesarakalaeii/caterpillar-smoke.git/' not found
```

An earlier version of this document guessed that an empty helper response made git fall
back to **anonymous**. That guess was wrong, and it is worth knowing why: an anonymous
request to a private repo gets a **401** and fails with `could not read Username`, not
`Repository not found`. `Repository not found` means GitHub **accepted** a credential
and then denied access — so a credential *was* being sent, just the wrong one.

It was the supervisor's own. `index.ts` builds one `Git` for the state repo, carrying an
`http.extraHeader` App token scoped to `caterpillar-state` alone, and passed that same
object to `WorktreeManager`. `syncMirror`'s clone is the **one** call site that uses it
directly instead of going through `at()` (which drops the credential by design), so
`git clone` of a task repo authenticated as the state repo. GitHub 404s, and because a
404 is not a 401 **git never consults the credential helper at all** — the correct
task-scoped token was never even requested.

Verified against real GitHub, not reasoned about: a valid token against a repo it cannot
see reproduces the message byte-for-byte with zero helper invocations.

Fixed by `Git.withoutCredentials()`, applied inside the `WorktreeManager` constructor
rather than at the call site — the caller that got this wrong passed the obvious thing,
so the invariant is enforced where it cannot be forgotten. This was also a live
cross-host leak: on the Codeberg workspace the same bug sent a GitHub token to Codeberg.

**Three more defects were found while fixing it. All are on the same path and all would
have blocked the smoke test in turn:**

1. **The credential helper never answered anything, ever.** git appends the operation as
   the **last** argv element, so the real invocation is `--socket <path> get`. The helper
   picked the operation with `argv.find(a => !a.startsWith("--"))`, which returns the
   **socket path**, so the `=== "get"` gate never matched and it exited silently on every
   single request. Bug 1 hid it (GitHub 404'd before git ever needed a credential), and
   `service.test.ts` hid it too — the harness invoked the helper as `get --socket <path>`,
   operation first, which is not what git does. Four green tests sat on top of a helper
   that declined everything. Now parsed by `parseInvocation`, and pinned by a test that
   drives the real helper through real `git credential fill`.
2. **Verification could never run on a private repo.** `probe` and `verify` both call
   `ensureWorktree`, which unconditionally re-fetched the mirror — but they run *after*
   `credentials.clearActive()`, so the credential service correctly refuses (§9.2) and the
   fetch dies. The fetch was pure waste anyway: an existing worktree is already checked
   out and a mirror fetch does not move it. `addWorktreeAt` now short-circuits.
3. **Parking after a session failure never reached the remote.** `workTask` released the
   lease in its `finally`, and only *then* did the caller park; `park` → `push` →
   `assertHeld` CAS'd against a ref that had just been deleted and threw. That is the
   `lease for SMOKE-1 is no longer held by this runner` line. The task therefore stayed
   `ready` on the remote and was re-claimed every single poll. Parking now happens inside
   `workTask`, before the release, with the heartbeat-current lease (the claim-time oid is
   already stale by then). Reproduced in `src/supervisor/loop.test.ts` over a real git
   remote: 316 retry iterations in 30s before the fix, parked on the first try after.

All four fixes have regression tests, and **each test was confirmed to fail against the
unfixed code** — the one discipline this codebase keeps having to relearn.

**Still unproven:** none of this has run in-cluster. It needs a new image and another
`SMOKE-1` run. No agent session has ever started on the runner, so everything downstream
of the clone — session, handoff, verification, PR creation — remains untested.

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

**Vikunja is VERIFIED** as of 2026-08-13 — the first time this implementation touched
the live instance. Token authenticates, 4 projects visible, and both `agent-wip` and
`needs-human` exist (the user created them).

Run it without ever exposing the token by executing it **inside the pod**, where the
secret is already mounted:

```bash
POD=$(kubectl --context default -n caterpillar get pods -o jsonpath='{.items[0].metadata.name}')
kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'VIKUNJA_TOKEN=$(cat /etc/caterpillar/secrets/caterpillar-electric-boogaloo/vikunja-token) \
   node dist/cli/verify-vikunja.js --api-base https://tasks.eb.bims.sh/api/v1'
```

The same trick works for `verify-github-issues.js` with
`/etc/caterpillar/secrets/caterpillar-github-app/`. `dist/cli/` ships in the image, so
every verifier can be run against live credentials without decrypting anything locally.

Not yet exercised: the Vikunja **write** scopes (`-- --task <scratch id>`), which only a
real transition or a deliberate scratch item covers. The lifecycle labels must keep
existing — no adapter creates them, since the token deliberately has no `labels:create`
scope. Names are overridable via `tracker.wipLabel` / `tracker.needsHumanLabel`.

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
- **`credential.helper` set AFTER a clone is set too late.** The clone is the one git
  operation that runs before any repo config exists, so it needs the helper passed with
  `-c`. This is why nothing private could ever be cloned, and why public repos hid it.
- **`Repository not found` means a credential ARRIVED and was refused.** Anonymous
  access to a private repo gets a 401 and `could not read Username`. The two failures
  look equally like "auth is broken" and point in opposite directions: 404 means the
  WRONG token was sent, 401 means NO token was. An earlier version of this document
  asserted the opposite and sent the next session hunting for a missing installation.
- **A 404 stops git asking the credential helper.** The helper is only consulted on a
  401 challenge. So a request that carries a valid-but-unauthorised credential never
  reaches the helper at all — no amount of fixing the helper will change the outcome,
  and helper-side logging stays silent while looking healthy.
- **git appends the credential-helper operation LAST**, after the arguments baked into
  the `credential.helper` string: `caterpillar-cred --socket /path get`. "First argument
  that is not a flag" therefore selects the socket path. Confirmed against real git —
  and note `git credential fill` reproduces the exact invocation offline, which makes it
  the right way to test a helper without a network or a private repo.
- **A test harness that calls the subject differently from the real caller proves
  nothing.** `service.test.ts` invoked the helper as `get --socket <path>` — operation
  first, which git never does — and four tests passed over a helper that answered no
  request in production. Same failure mode as the credential-helper regression test
  before it; when the thing under test is a protocol, drive it with the real other side.
- **`at()` drops the credential, but only if you call it.** `WorktreeManager` was handed
  the state repo's `Git` and used it verbatim for the mirror clone. When a rule is "this
  object must not travel", enforce it at the boundary that receives the object, not by
  documenting the method that happens to launder it.
- **Anything the supervisor does AFTER `clearActive()` cannot use a task credential.**
  That is the whole point of the refusal, so post-session code (probe, verifier) must
  not need the network. Watch for helpers that fetch as a side effect of "ensure exists".
- **Release the lease last.** Anything that wants to record WHY a task failed has to
  write while the lease is still held; a `finally` that releases beats an outer `catch`
  that parks, and the resulting `LeaseLostError` reads like a concurrency problem rather
  than an ordering one. Also use the heartbeat's current lease — the claim-time oid is
  stale as soon as the first renewal lands.
- **A machine runner inherits `url.<...>.insteadOf` too.** The operator's global
  `url.ssh://git@github.com/.insteadof = https://github.com/` silently rewrites every
  HTTPS clone to SSH, which bypasses the credential helper completely and fails against
  whatever key the host has. It cost a wrong conclusion in local testing here. Not a
  problem in the container (no global config), but pass
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` when testing this path on a
  workstation, or the experiment measures the operator's config instead of the code.
- **`kubectl scale` loses to ArgoCD `selfHeal`.** Scaling the Deployment to 0 was
  reverted within seconds. To stop a supervisor that is failing on a task, change the
  TASK (set `state.json` to `parked`) rather than fighting the reconciler.
- **Run the verifiers inside the pod.** `dist/cli/` ships in the image and the secrets
  are already mounted, so `kubectl exec` + `node dist/cli/verify-*.js` checks live
  credentials without decrypting anything locally. This is how Vikunja finally got
  verified, and it is strictly safer than pulling a token onto a workstation.
- **A test that only asserts "it threw" proves nothing.** The first credential-helper
  regression test passed identically with and without the fix, because the clone failed
  either way. Assert on the invocation. The cheap discipline that catches all of these:
  after writing a regression test, **revert the fix and watch it fail**. Do it on a copy
  of `src/` rather than the working tree — a test timeout that kills the shell mid-way
  leaves the real source reverted.
- **Assert on what was PUSHED, not on the working tree.** `park` writes `state.json`
  locally and then pushes; a test reading the checkout passes whether or not the push
  landed, and the next `pull` resets it anyway. The remote is the only evidence.
- **`per_page=100` contains `page=1`** — see above; it also bit a second time when a
  digest comparison matched a substring of the previous digest. Anchor comparisons.

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

1. **Ship the clone fix and re-run the smoke test.** The four defects behind
   `Repository not found` are fixed and tested locally but **exist only on this
   workstation** — nothing is committed, no image is built, the cluster still runs
   `e42852ee`. Merge, let CI publish, bump the image, and watch `SMOKE-1`: it is still
   armed in the state repo and still retrying every poll, so it will claim itself as soon
   as the new pod is up. **No agent session has ever run in-cluster**; this remains the
   largest untested surface, and everything downstream of the clone — session, handoff,
   verification, PR creation — is unproven.
2. **Build intake** (DESIGN.md §14) — `Tracker.listAgentItems()` → `TaskSpec` in the
   state repo. Until this exists, a hand-written spec is the *only* way work arrives.
   Both trackers implement the read side; nothing calls it.
3. **Discord bridge** — questions land in `tasks/<id>/questions/` in git and nothing
   tells a human they are there. An agent that parks on a question parks silently.

To silence `SMOKE-1` meanwhile, flip its `state.json` to `"parked"`.
`caesarakalaeii/caterpillar-smoke` is a throwaway; delete it whenever.

**Uncommitted work:**

- **This repo:** the whole clone fix is uncommitted on `main` — `src/state/git.ts`,
  `src/workspace/worktree.ts`, `src/credential/protocol.ts`,
  `src/cli/credential-helper.ts`, `src/supervisor/loop.ts`, plus tests
  (`src/supervisor/loop.test.ts` is new) and this file. `npm run check` and `npm test`
  are green.
- **`../caesar-deployment`** has commit `fba9d90` on branch
  `docs/caterpillar-post-deploy` that was never pushed — the GitHub SSH key dropped out
  of the agent mid-session (`ssh -T` worked, then stopped; the key `8XOjnN…` vanished
  from `ssh-add -l`, and the on-disk `id_ed25519` does not authenticate either). Re-add
  the key and push.

**The SSH agent is still broken** as of this session: `git pull` on this repo fails with
`sign_and_send_pubkey: signing failed for ED25519 "SSH Key" from agent`. `gh` itself
authenticates fine (token, not key), so `gh` commands work while `git` over SSH does not.

Unresolved by choice, not by omission: the exposed App private key (see the callout
under "Live credentials").
