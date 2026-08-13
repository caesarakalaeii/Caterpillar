# Handoff

State as of 2026-08-13, after intake shipped. Overwrite this file rather than appending to
it — an append-forever handoff eventually consumes the context it exists to preserve (the
same reason `handoff.md` is overwritten and `journal.md` appends, DESIGN.md §4.1).

## Orientation

**Caterpillar** is a long-running autonomous coding agent supervisor. Read
[`DESIGN.md`](DESIGN.md) first — it is the source of truth for intent, the decisions in it
were settled by interview, and several were made *against* the obvious default for stated
reasons. Do not re-litigate them; if one looks wrong, the rationale is written down next to
it. **DESIGN.md is also this project's ADR record** — there is no `docs/adr/`, and every
architectural change so far has been recorded by amending the relevant section.

`README.md` has the file-by-file layout and the six load-bearing invariants.

Repo: `~/git/Caterpillar` → `github.com/caesarakalaeii/Caterpillar` (private).
Manifests: `~/git/caesar-deployment` at `apps/workloads/caterpillar`.

> An earlier version of this file said the working copy was `~/Hobby/remote-agent`. **That
> directory does not exist on this machine** — and neither does `~/Hobby`. Earlier sessions
> ran on a NixOS box; this one is Arch with a zen kernel and no nix at all. Assume nothing
> about the host from this document; check.

## Environment — READ THIS, IT CHANGED

The previous handoff said "NixOS, there is no `node` or `npm` on PATH, everything runs
through nix". On the current machine the opposite is true and worse:

- `node` and `npm` **are** on PATH (`/usr/sbin`), at **node 26.5.0**. There is **no `nix`**.
- **`npm test` cannot run at all.** Node 26 *removed* `--experimental-transform-types`, and
  strip-only TypeScript mode cannot parse the parameter properties this codebase uses
  throughout, so not a single test file loads. The same applies to `npm start` and all five
  `verify:*` scripts, which use the same flag.
- `src/credential/service.test.ts` **spawns the credential helper with that flag**, so it
  fails for the same reason even if you work around the runner.
- `npm run check` and `npm run build` are fine — they are `tsc`.
- CI pins **node 22** and is green — **143 tests, 143 passing** at `a540f6b`. It is the
  authority on whether tests pass; a local run that cannot load half the suite is not.

`flake.nix` is still in the repo and still correct; it just has nothing to run it here.

**The fix is to install node 22.** Until someone does, run tests by compiling first — this
is what produced every test result in this session, and it reproduces CI's count exactly:

```bash
# tsconfig excludes *.test.ts, so use a copy that includes them and outputs elsewhere.
# The compiled tree lives outside the repo, so symlink node_modules or bare specifiers
# ('yaml', pi) fail to resolve and whole FILES fail before any test registers.
tsc -p <tsconfig-including-tests>   # outDir e.g. /tmp/.../dist-test
ln -sfn "$PWD/node_modules" /tmp/.../dist-test/node_modules
node --test $(find /tmp/.../dist-test -name '*.test.js')
```

`node_modules` was absent entirely at the start of this session; `npm install` fixed it and
also synced a lockfile that was missing the `caterpillar-cred` bin entry.

## Status

| Area | State |
|---|---|
| Leasing (git-ref CAS, heartbeat fence) | implemented, tested |
| Context budget + handoff trigger | implemented, tested |
| Credential service + git helper | implemented, integration-tested through **real git** |
| Workspace mirror clone (private repos) | **fixed, deployed, and exercised in-cluster** |
| GitHub App forge (mint, PR, checks) | implemented, verified against live GitHub |
| Forgejo/Codeberg forge | implemented, endpoints verified against live Codeberg |
| Session runner | implemented, **ran a real task to a merged PR in-cluster** |
| Verifier + progress probe | implemented; probe's first-session bug fixed (#10) |
| Multi-repo checkout | implemented, tested |
| Vikunja tracker | implemented, verified against the live instance |
| GitHub Issues tracker | implemented, verified against live GitHub |
| Supervisor → tracker mirroring | implemented (claim / question / park / done) |
| **Structured logging (§11)** | **implemented and deployed (#10)** — JSON lines on stdout |
| **Tracker intake (§14)** | **implemented and deployed (#11, #12)** — running on a 300s timer |
| State-repo credential + bootstrap | implemented, tested |
| LLM auth: Claude subscription (OAuth) | implemented, tested |
| Container image + CI | built and pushed by CI on every push to `main` |
| Deployment | **LIVE**, and no longer idle-by-design |

Not built:

1. **Discord.** Outbound `DiscordNotifier.notify` is **wired but throws** — see the trap
   below. Inbound `!answer` and `!task` intake (§14 path 3) do not exist.
2. Nothing else from DESIGN.md is missing.

## What is actually proven, and what is not

**Proven end to end in-cluster.** A hand-written spec (`SMOKE-1`) went from the state repo
through a private-repo mirror clone, an agent session, a context handoff, a second session,
a completion claim, the supervisor's **own** §12 verification, and `done` — producing
[`caterpillar-smoke#1`](https://github.com/caesarakalaeii/caterpillar-smoke/pull/1), since
merged. Cost: 2 sessions, 3.75M input tokens, **$3.94**. That is the number to quote when
someone asks what a trivial task costs.

**Proven in-cluster for intake.** It runs, reaches both trackers, and finds nothing:

```json
{"seen":0,"created":0,"rejected":0,"failed":0,"level":"info","event":"intake.pass"}
```

Two consecutive passes were **329s** apart, confirming the interval gate (300s + up to one
30s poll of granularity). `failed: 0` with both trackers configured is what proves it
actually talked to GitHub and Vikunja rather than iterating an empty map.

**NOT proven: intake → session.** No tracker item has ever become a task. Both trackers had
**0 `agent`-labelled items** at last check, which is why deploying intake was safe and also
why the path is unexercised. Closing that loop costs money and opens a PR, so it is a
deliberate decision, not an oversight.

## Giving it work

Two paths (§14):

1. **Label a tracker item `agent`** and put an `agent` block in the body. Within ~5 minutes
   intake renders a spec and the supervisor claims it.
2. **Commit `tasks/<id>/spec.md`** into `caterpillar-state` by hand — most control over
   acceptance criteria, and the fastest way to test the pipeline without a tracker.

````
```agent
repos:
  - owner/name          # optional on GitHub — defaults to the issue's own repo
requires:               # optional; defaults to none, so any runner may claim
  - linux
acceptance:             # REQUIRED — at least one command that must exit 0
  - "npm test"
```
````

An item without acceptance criteria is **refused** and commented on **once**, because a task
with no machine-checkable criteria can never satisfy §12. Refusals are recorded at
`intake/<task-id>.json` in the state repo, keyed by a digest of the item's title and body;
editing the item re-opens it. **In Vikunja the `agent` marker must be the first line INSIDE
a code block** — TipTap cannot put text on the fence line.

To silence intake entirely, remove the `agent` label. To stop a task, set its `state.json`
to `parked` — do **not** `kubectl scale`, ArgoCD `selfHeal` reverts it within seconds.

## Deployment state: LIVE

| | |
|---|---|
| Namespace | `caterpillar` |
| Context | **`default`** in `~/.kube/config` |
| ArgoCD app | `caterpillar`, `Synced` / `Healthy`, sync wave 6 |
| Pod | 1 replica, `Recreate`, `/healthz` + `/metrics` on 9090 |
| PVC | `caterpillar-work`, 20Gi RWO, bound |
| Image | `ghcr.io/caesarakalaeii/caterpillar:main`, rolled by Keel (`policy: force`, `trigger: poll`) |

Deploy = merge to `main`. CI builds and pushes, Keel notices within ~45–90s and rolls the
Deployment. Watch it with `gh run watch` then poll the pod's `imageID`.

**`CONFIG_PATH` is `/etc/caterpillar/config/config.json`**, not `/etc/caterpillar/config.json`
— the ConfigMap mounts a directory. Read it with
`kubectl exec <pod> -- cat /etc/caterpillar/config/config.json`.

`log.level` and `intake.intervalSeconds` are **absent** from the deployed ConfigMap, so both
run on their code defaults (`info`, `300`). Neither needed a `caesar-deployment` change.
Raising the level to `debug` requires editing that ConfigMap, which is a deploy.

**`argocd/root-app.yaml` auto-syncs `argocd/apps/` from `main` with `prune` and `selfHeal`**
— adding a file there is a deploy, not a proposal; removing one prunes it from the cluster.
**The live app-of-apps is named `root`, not `root-app`** — `kubectl -n argocd get application
root-app` returns NotFound and looks alarming for no reason.

The GHCR package is private (it inherits the repo's visibility), handled with
`imagePullSecrets: myregistrykey`. Image-pull secrets are **namespaced**, so rotating the
GHCR token means re-sealing it in every namespace that has one (`caesar`,
`ai-editor-collector`, `plot-spot`, `sn2-randomizer`, `spotify-widget`, `caterpillar`).

Decisions the user made by interview (do not re-litigate):

- **Claude Pro/Max subscription, not a metered API key.** pi-ai's Anthropic provider ships
  an OAuth mode with PKCE and refresh built in. There is **no Anthropic API key anywhere**.
- **LiteLLM was removed** as a consequence: an OAuth bearer credential cannot be forwarded
  by a proxy that authenticates with `x-api-key`. DESIGN.md §9.6 covers both modes.
- **State repo on GitHub, authenticated with the existing App**, not a deploy key.
- **Both workspaces from the start**, reusing the existing Codeberg and Vikunja tokens.

### The subscription credential is the sharp edge

`llm.credentialsPath` is `/work/credentials/anthropic.json` on the PVC and **cannot become a
Secret**. Refreshing rotates the refresh token and pi writes the new one back inside
`CredentialStore.modify`; a read-only mount means the supervisor works until the access
token expires and then stops. `FileCredentialStore` locks around the read-modify-write so
two sessions cannot race a rotation. 30s to acquire; a lock older than 60s is treated as
abandoned.

Seed it with `npm run llm:login -- --out ./auth.json` on a machine with a browser, then
`kubectl cp` it in. **`/work/credentials` does not exist on a fresh PVC** and `kubectl cp`
will not create a missing parent — `mkdir -p` it in the pod first.

- **The pod does NOT crash-loop without the credential.** It boots, serves `/healthz`, and
  idles; the credential is read lazily when a session starts. Do not wait for a crash loop
  as a signal that something is wrong.
- Refresh is **lazy, not scheduled**. An expired access token on an idle supervisor is
  normal.
- **Deleting the PVC destroys the credential**, not just mirrors and worktrees. Recovery
  means re-running the browser login.

### The Discord trap

`src/notify/discord.ts` is fully wired into `index.ts` and `loop.ts`, but
`DiscordNotifier.notify` ends in `throw new Error("not implemented")`. It is harmless *only*
because the mounted `caterpillar-discord` secret directory is **empty**, so `index.ts` falls
back to `NullNotifier`. **Sealing a `webhook-url` into it arms the throw on the first
question, park, or completion.** Implement it or leave the secret empty.

## Live credentials

- App slug `caterpillar-agent`, **App ID `4579022`**, **installation ID `153385932`**
- Private key SOPS-encrypted at
  `../caesar-deployment/apps/workloads/caterpillar/secrets/caterpillar-github-app.enc.yaml`.
  Keys: `app-id`, `installation-id`, `private-key.pem`.
- **The installation is account-wide** ("All repositories" — 66 repos as of this writing).
  That is why `caterpillar-state` needed no separate install. Narrowing it to selected repos
  makes the state-repo mint return 422 and the pod crash-loop at bootstrap.

> **UNRESOLVED — the App private key is exposed.** `aca5042` in `caesar-deployment`
> committed that Secret **twice**. The second path had a **trailing newline in its filename**,
> so that session's `shred` and `sops --encrypt` both hit the correctly-named file while the
> newline-named copy kept its cleartext `stringData` — including `private-key.pem` — and was
> committed unencrypted.
>
> caesar-deployment #46 removed the file, but **by the owner's explicit decision the key was
> not rotated and history was not rewritten**. The blob is still reachable in `aca5042`, and
> any clone predating #46 still holds a working key for app `4579022`. The repo is private
> and nothing was ever deployed from the plaintext copy.
>
> Rotating is cheap if revisited: generate a new key at
> `github.com/settings/apps/caterpillar-agent`, delete the old one, re-seal the Secret. App
> ID and installation do not change. `seal-caterpillar-secrets.sh` has only `eb` and
> `discord` modes — re-sealing the App secret is a manual `sops` step.
>
> `ls` renders both filenames identically. Use `ls -b` or `find` to see a stray one.

Codeberg and Vikunja tokens are sealed and deployed in `caterpillar-electric-boogaloo`
(`username`, `tokens.json`, `vikunja-token`).

### Run the verifiers inside the pod

`dist/cli/` ships in the image and the secrets are already mounted, so live credentials can
be checked without decrypting anything locally. This is strictly safer than pulling a token
onto a workstation, and it is how both trackers were verified. **The flags are required and
the error message only names the first missing one:**

```bash
POD=$(kubectl --context default -n caterpillar get pods -o jsonpath='{.items[0].metadata.name}')

kubectl --context default -n caterpillar exec "$POD" -- sh -c '
S=/etc/caterpillar/secrets/caterpillar-github-app
node dist/cli/verify-github-issues.js --pem $S/private-key.pem \
  --app-id "$(cat $S/app-id)" --installation "$(cat $S/installation-id)" \
  --owner caesarakalaeii'

kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'VIKUNJA_TOKEN=$(cat /etc/caterpillar/secrets/caterpillar-electric-boogaloo/vikunja-token) \
   node dist/cli/verify-vikunja.js --api-base https://tasks.eb.bims.sh/api/v1'
```

Last run: GitHub **66 repos visible, 0 items labelled `agent`**; Vikunja **4 projects, 0
items labelled `agent`**, with `agent-wip` and `needs-human` both present. Write scopes on
both are still unexercised — that needs `--issue`/`--task` against a scratch item. The
lifecycle labels must keep existing on every repo carrying agent work; no adapter creates
them, deliberately (see below).

## Things learned the hard way

Each of these cost real debugging. They are encoded in code or tests now; do not "simplify"
them away.

**Environment and tooling**

- **Node 26 removed `--experimental-transform-types`.** See Environment above. A test that
  spawns a subprocess with the flag fails too.
- **`git add -A <path>` fails the WHOLE command on a pathspec that matches nothing.** A
  freshly bootstrapped state repo has no `tasks/` directory, so `commitAndPush` threw before
  recording anything. Each path is now staged only when it exists.
- **The `yaml` package is YAML 1.2**: `no`, `yes`, `on`, `off` stay **strings**; only
  `true`/`false` are booleans. An earlier comment in `store.ts` claiming otherwise was
  wrong. The realistic coercion hazard is an unquoted command containing `: `, which becomes
  a **mapping** — `- npm test: unit` parses to `{"npm test": "unit"}`.
- **A machine runner inherits the operator's global git config** — identity,
  `commit.gpgsign`, `url.<...>.insteadOf`. Commit signing is forced off in two places and
  both are needed. **Tests must be hermetic**: pass
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, or the experiment measures the
  workstation. This bit again this session — probe tests passed locally and failed CI with
  `Author identity unknown`, because a runner has no global identity at all.
- **`gh` push to `caesar-deployment` needs a pull first** — it moves under you.
- **SOPS in `caesar-deployment` encrypts by PATH** (`path_regex: .*\.enc\.yaml$`), so
  encrypting a `/tmp` file fails with "no matching creation rules found". Write plaintext to
  its final `*.enc.yaml` path (umask 077) and `sops --encrypt --in-place` there.
- **Don't hand-edit an encrypted file's plaintext fields.** The SOPS MAC covers unencrypted
  values too. Re-target with decrypt → edit → encrypt.
- **The caesar cluster is the `default` context**, not anything in `~/.kube/caesar-clusters`.
- **`kubectl scale` loses to ArgoCD `selfHeal`.** Change the TASK, not the replica count.

**Credentials and git**

- **`credential.helper` set AFTER a clone is set too late.** The clone runs before any repo
  config exists, so the helper must be passed with `-c`.
- **`Repository not found` means a credential ARRIVED and was refused.** Anonymous access to
  a private repo gets a **401** and `could not read Username`. 404 means the WRONG token was
  sent; 401 means NO token was. The two look equally like "auth is broken" and point in
  opposite directions.
- **A 404 stops git asking the credential helper.** The helper is only consulted on a 401,
  so a valid-but-unauthorised credential never reaches it — helper-side logging stays silent
  while looking healthy.
- **git appends the credential-helper operation LAST**: `caterpillar-cred --socket <path> get`.
  "First argument that is not a flag" therefore selects the *socket path*. `git credential
  fill` reproduces the real invocation offline and is the right way to test a helper.
- **`at()` drops the credential, but only if you call it.** `WorktreeManager` was handed the
  state repo's `Git` and used it verbatim. Enforce "this object must not travel" at the
  boundary that RECEIVES it, not by documenting the method that launders it.
- **Anything the supervisor does AFTER `clearActive()` cannot use a task credential.** So
  post-session code (probe, verifier) must not need the network. Watch for helpers that
  fetch as a side effect of "ensure exists".
- **Never set `remote.origin.url` from a worktree** — worktrees share the mirror's config.
- **`--git-common-dir`, not `--git-dir`**, for `info/exclude` and shared refs in a linked
  worktree. The first attempt silently did nothing.
- **"No merging" is not expressible as a GitHub permission.** `pull_requests: write`
  authorises merge; branch protection requiring an approving review is what enforces it.
- **The agent/supervisor credential boundary is leak hygiene, not a wall.** They share a
  container. The real boundary is token scope.

**Supervisor behaviour**

- **Release the lease LAST.** Anything recording *why* a task failed must write while the
  lease is held. Use the heartbeat's current lease — the claim-time oid is stale as soon as
  the first renewal lands.
- **A first-session commit needs a baseline that exists.** The probe compared against the
  previous session's head, so the commit that STARTS the work could never count: SMOKE-1
  finished with `noProgressStreak: 2` and a merged PR. The fallback is the branch's fork
  point, resolved locally. Do **not** use the fork point as the baseline always — then every
  session after the first commit looks productive and thrashing never parks.
- **pi does not auto-compact.** The hazard is a provider context-length error, not silent
  summarisation.
- **Context size must include `cacheRead` + `cacheWrite`.** `input + output` badly
  undercounts a cached context, so a 70% threshold would fire far too late.
- **An OAuth refresh ROTATES the refresh token**, inside `CredentialStore.modify`. That one
  fact decides where the credential can live: writable durable storage only.
- **Intake must not ride the poll interval.** A GitHub pass costs 1 request + 1 per repo
  (~66 here). At a 30s poll that is ~132/min against an installation budget of ~83/min,
  exhausting it within minutes and taking the forge calls down too. Stamp the clock BEFORE
  the pass, or a failing tracker is retried every poll.
- **Intake's id must derive from the tracker ref alone**, never the title — humans edit
  titles, and a changed id means a duplicate task every pass. It also becomes a directory
  name, so reduce it to one safe path segment or an item can write outside `tasks/`.
- **`listAgentItems()` filters on the ingest label alone**, so a refused item comes back
  every pass. Suppress repeat comments with a **durable** record: Keel rolls the pod on every
  push to `main`, so an in-memory set re-comments on every deploy.
- **Write `state.json` before `spec.md`.** The spec is the existence marker, so a crash
  between them leaves a task the claim loop skips and the next pass recreates. The reverse
  order wedges the item as permanently existing and never claimable.

**Trackers and forges**

- **Forgejo has no Checks API** (`/check-runs` → 404). Commit statuses are the only CI
  signal, and its `error`/`warning` states have no GitHub equivalent.
- **Forgejo returns `statuses: null`, not `[]`.** Vikunja does the same with `labels`.
- **Vikunja: `GET /user` and `GET /tasks/all` are unreachable by any API token**, and a 401
  means a missing route scope, not a bad token. Probe `/projects`.
- **Vikunja descriptions and comments are HTML** (TipTap), not markdown. Prose is escaped
  going out and stripped back to text coming in — and **`<pre><code>` has no literal fences**,
  so `stripHtml` re-inserts them or intake's fenced `agent` block is unparseable while
  looking correct in the UI.
- **Vikunja label removal goes through `POST /tasks/{id}/labels/bulk`**, re-sending the
  surviving set. The per-label `DELETE` needs `tasksLabels: delete`, which the agent token
  must not have.
- **GitHub's issues route returns pull requests too.** The `pull_request` key is the only
  reliable discriminator, or intake hands the agent its own open PRs as fresh work.
- **`POST /issues/{n}/labels` silently CREATES an unknown label** with a random colour.
  Vikunja is protected by a withheld `labels:create` scope; GitHub has no equivalent, so
  `github-issues.ts` checks the repo's labels first and refuses. Do not simplify that away.
- **GitHub distinguishes 401 from 403; Vikunja cannot.** Only 403 becomes `TrackerScopeError`.
- **The GitHub search API is deliberately unused for intake** — eventually consistent (a
  freshly labelled issue can be invisible for ~a minute, exactly intake's window),
  separately rate limited, and on a deprecation path. Enumerate the installation instead.

**Testing discipline**

- **A test that only asserts "it threw" proves nothing.** Assert on the invocation. After
  writing a regression test, **revert the fix and watch it fail** — on a copy of `src/`, not
  the working tree, or a timeout that kills the shell leaves the real source reverted. A
  cleaner way: run the suite against a `git worktree` of `HEAD` to get a baseline, which is
  how this session proved 5 apparent failures were pre-existing.
- **A test harness that calls the subject differently from the real caller proves nothing.**
  `service.test.ts` invoked the helper as `get --socket <path>` — operation first, which git
  never does — and four tests passed over a helper that answered no request in production.
  When the thing under test is a protocol, drive it with the real other side.
- **Assert on what was PUSHED, not on the working tree.** A test reading the checkout passes
  whether or not the push landed. This found the `git add -A tasks` defect above.
- **`per_page=100` contains the substring `page=1`.** A stub matching `path.includes("page=1")`
  answers every page with a full one and paginates forever. Anchor on `&page=N`. Same class
  of bug bit a digest comparison matching a substring — anchor comparisons.
- **Run intake tests TWICE.** Both of its failure modes (duplicate tasks, comment spam) are
  invisible in a single pass.

## Constraints the user has set

- **Do not read the user's `.env` holding the Codeberg and Vikunja tokens.** The old path
  (`~/Hobby/electric-boogaloo-workspace/.env`) does not exist on this machine, but the
  constraint stands wherever it now lives. Enforced by a tool classifier, not just
  convention — even listing variable *names* is blocked. The user seals those tokens
  themselves with `../caesar-deployment/scripts/seal-caterpillar-secrets.sh eb`, which reads
  the file in-process and never prints a value.
- Conventional Commits, **no** `Co-Authored-By` trailer, no gitmoji. The repo's history has
  **no trailers at all** — match it.
- Never use the type `any`.
- Prefer open-source, provider-agnostic tooling — this is why the project is built on `pi`
  rather than a vendor SDK. The user asked to be argued with rather than deferred to.
- Pull before working in a repo, and branch before committing — every change so far went
  through a PR (#1–#12), squash-merged.
- Architectural changes are recorded in **DESIGN.md**, which serves as the ADR record.

## Immediate next action

1. **Close the intake → session loop.** Label a scratch issue on
   `caesarakalaeii/caterpillar-smoke` (a throwaway; delete it whenever) with `agent` and an
   `agent` block, then watch `intake.pass` report `created: 1` and the session start. This is
   the last unproven link in the chain and it costs a few dollars. **Ask first** — it spends
   the user's subscription and opens a PR.
2. **Implement `DiscordNotifier.notify`**, or leave the secret empty. Today an agent that
   parks on a question parks silently, and sealing a webhook makes it throw instead.
3. **Install node 22** so `npm test` and the `verify:*` scripts work locally again.
4. Minor: `SMOKE-1`'s `journal.md` is **347KB** of 620 byte-identical park entries from the
   pre-fix retry storm, all mislabelled "Session 0" (the park preceded the session
   increment). It is read for handoff continuity, so it taxes any further session on that
   task. There is no journal rotation. `SMOKE-1` is `done`, so this is latent.

**Uncommitted work: none.** `main` is `a540f6b`, everything is merged and deployed, and the
pod is healthy with 0 restarts. `caesar-deployment` has no unpushed commits either (its #48
merged as `5f2a95ad`); it does carry untracked `.planning/` and `tea_debug.log`, which are
not mine and were left alone.

Unresolved by choice, not by omission: the exposed App private key (see the callout under
"Live credentials").
