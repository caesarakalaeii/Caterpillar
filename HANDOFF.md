# Handoff

State as of 2026-08-13, after the intake → session loop was closed end to end. Every
link in the chain is now proven in-cluster; what is left is unbuilt, not unverified.
Overwrite this file rather than appending to
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

## Environment

**The node problem is fixed at the source; there is nothing to work around any more.**

- `node` and `npm` are on PATH (`/usr/sbin`) at **node 26.5.0**. There is **no `nix`**.
- `npm test`, `npm start` and every `verify:*` script **run on it directly** — no flag, no
  tarball, no compile step. **159 tests, 159 passing** on node 26.

Two earlier handoffs described elaborate workarounds here (compile the tests first; then,
download a node 22 tarball and put it on PATH). Both are gone, and so is their cause. The
repo used `--experimental-transform-types`, which node 26 removed, and its source used
parameter properties, which node cannot strip. Every one of the 44 was converted to a
field plus an assignment, and three things now stop it coming back (DESIGN.md §16):

- `erasableSyntaxOnly` in `tsconfig.json` turns the runtime load failure into a compile
  error.
- `tsconfig.test.json` applies the same check to **test** files, which the build excludes
  — that gap is exactly how the last two slipped through `npm run check` and then failed
  to load at runtime.
- CI runs the suite on **node 22 and 26**. The failure is asymmetric, so one version alone
  proves nothing.

`engines.node` is `>=22.18`, the first release that strips types without a flag. The
container image is unaffected: it runs compiled JS from `dist/`.

If you write `constructor(private readonly x: T) {}` out of habit, `npm run check` will
tell you immediately. `flake.nix` is still in the repo and still correct; it just has
nothing to run it here.

`node_modules` was absent entirely at the start of the previous session; `npm install`
fixed it and also synced a lockfile that was missing the `caterpillar-cred` bin entry.

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
| **Tracker intake (§14)** | **implemented, deployed, and PROVEN end to end (#11, #12)** |
| **Discord webhook, outbound (§11.2)** | **implemented and tested (#14)** — inert until a webhook is sealed |
| **§12 CI gate** | **fixed (#15)** — was unsatisfiable for every Actions/App-only repo |
| **Toolchain** | **runs natively on node 26 (#18)** — erasable-syntax-only, CI on 22 and 26 |
| **Tracker label lifecycle** | **fixed (#16)** — `needs-human` outlived its question |
| State-repo credential + bootstrap | implemented, tested |
| LLM auth: Claude subscription (OAuth) | implemented, tested |
| Container image + CI | built and pushed by CI on every push to `main` |
| Deployment | **LIVE**, and no longer idle-by-design |

Not built:

1. **The inbound Discord bridge.** `!answer` (§7) and `!task <repo> <goal>` (§14 path 3)
   do not exist. A question waits in `tasks/<id>/questions/` until a human commits the
   answer by hand — the supervisor now *tells* you it is there, but you still answer in
   git. Outbound is done (§11.2).
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

**PROVEN: intake → session → done.** This was the last unproven link and it is now closed.
A GitHub issue labelled `agent` (`caterpillar-smoke#2`) became a task within 23 seconds of
being created, was claimed, worked, verified by the supervisor's own §12 gates, and closed
— with the tracker mirroring every step:

```
intake.created → intake.pass{seen:1,created:1} → task.claimed → session.start
  → done-claimed → verification.result{passed:true} → task.done
```

Cost: **5 sessions, $0.96**, of which sessions 2–4 were wasted on a supervisor bug (below).
The work itself took one 72-second session and $0.16 — a better number to quote for a
trivial task than SMOKE-1's $3.94.

**It found two real defects**, which is the point of running it:

1. **The §12 CI gate was unsatisfiable for every Actions/App-only repo** (#15). GitHub
   answers `/commits/<sha>/status` with `state: "pending"` for a ref with NO statuses, and
   a repo whose checks come from Apps or Actions never gets one. A green PR was rejected as
   `CI has not finished: 0 check(s) still running` on every claim, forever. SMOKE-1 missed
   it by having no CI signal at all, which takes the "none" path.
2. **`needs-human` was never removed** (#16), so the task ended `done`, closed, and still
   advertising that it wanted a human.

**Also proven, unexpectedly: `ask_human`.** After three rejections the agent stopped
retrying, diagnosed the gate bug correctly on its own — including that GitHub Apps report
only through `/check-runs` — established it could not work around it (its token is
`metadata: read`, so posting a status is a 403), and asked. It explicitly declined to add a
CI workflow because the issue had not asked for one. The park cost nothing while the fix
was written.

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

**The target repo needs the three lifecycle labels** — `agent`, `agent-wip`,
`needs-human`. No adapter creates them, deliberately (see below), and `caterpillar-smoke`
had none of them. A missing one does not fail the task: `mirror()` logs
`tracker.mirror-failed` and continues. It fails the tracker VIEW silently, which is worse
to debug than a crash.

### Answering a question by hand

There is no inbound bridge, so this is the operator's job (§7). Two writes to
`caterpillar-state`, and the ORDER matters:

1. `tasks/<id>/questions/NNN-answer.md`, matching the question's number. The supervisor
   treats an unanswered question as the absence of that file.
2. `tasks/<id>/state.json` with `status: "ready"`.

Answer FIRST. The poll is 30s, and a task flipped to `ready` before its answer exists
starts a session that cannot see it.

**Reset `progress.noProgressStreak` in the same write** if it has reached
`noProgressLimit` (3). Otherwise `checkLimits` parks the task on the very next claim,
before a session runs — which is what happens after any run of sessions that produced no
commit, including one caused by a supervisor bug rather than by the agent.

Both writes go through the GitHub contents API fine; no clone is needed.

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

### Discord: safe to seal now, and still silent until you do

The trap the previous handoff described is gone. `DiscordNotifier.notify` makes a real
webhook POST (§11.2), and a failure only logs `notify.failed` — it cannot park a task that
finished. Nothing is sealed, so `index.ts` still falls back to `NullNotifier` and the
supervisor is silent.

To turn it on, three steps in `caesar-deployment`, all the operator's:

1. `scripts/seal-caterpillar-secrets.sh discord` — prompts for the URL, never echoes it,
   writes `secrets/caterpillar-discord.enc.yaml` with a `webhook-url` key.
2. Add that file to `secrets/secret-generator.yaml`.
3. Drop `optional: true` from the secret mount in `deployment.yaml`.

Then prove it from inside the pod, which is where the secret already is:

```bash
kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'DISCORD_WEBHOOK_URL=$(cat /etc/caterpillar/secrets/caterpillar-discord/webhook-url) \
   node dist/cli/verify-discord.js'
```

It posts one real message and prints the webhook id but never the token. **Not run yet —
there is no webhook.** It was exercised end to end against a local stand-in server that
answers 204 like Discord does, which proves the wiring but not the credential.

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

- **Node ERASES types, it does not transform them.** Anything emitting runtime code — a
  parameter property, an enum, a namespace — type-checks and then fails to LOAD, per FILE,
  before one test registers. Node 26 removed `--experimental-transform-types` outright, so
  the flag was a dead end in both directions. Fixed at the source (§16); the guard is
  `erasableSyntaxOnly` plus a CI matrix, because the failure exists on one node version and
  not the other.
- **A tsconfig that excludes tests type-checks NOTHING in them.** The build must exclude
  `*.test.ts`, so `npm run check` silently skipped every test file until
  `tsconfig.test.json` was added — which is how two unloadable test files passed a green
  check.
- **A codemod must be diffed, not trusted.** The script that rewrote all 44 parameter
  properties silently DELETED the `super()` call in every error subclass on its first run,
  because the rewrite skipped the span between the body brace and the insertion point. It
  also stranded a constructor's `@param` doc above a field, and choked on an apostrophe in
  a comment (`repo's`) by reading it as an unterminated string. Every one of those was
  caught by reading the diff, not by the tests.
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
- **A notification must never be able to fail a task.** `notify` was called bare inside
  `applyOutcome`, so the moment it made a real request, a webhook outage unwound into
  `workTask`'s catch and parked a task that had just been verified and pushed as `done`.
  Same rule as tracker mirroring: write git first, then tell the view, and only log if
  telling it fails. Anything added to that path later inherits the same rule.
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
- **A Discord webhook is rate limited per WEBHOOK, and `retry_after` is in SECONDS** —
  in both the header and the JSON body. Treating it as milliseconds retries instantly and
  earns a second 429. Honouring it unbounded is worse: `notify` is awaited inside the task
  loop, so a large `retry_after` stops the runner doing anything. It is capped at 10s.
- **Discord's 2000-character limit is counted in CODE POINTS, and exceeding it is a 400** —
  the message never appears. An agent-authored question is exactly the payload that blows
  it. Slicing UTF-16 instead of code points splits a surrogate pair into a lone surrogate,
  which `JSON.stringify` encodes happily and Discord then rejects — a 400 that only ever
  shows up for emoji.
- **Discord parses `@everyone` in webhook content by default.** The prose is
  agent-authored and quotes files the agent read. `allowed_mentions: {parse: []}` is not
  optional.
- **GitHub's combined status endpoint answers `pending` for a ref with NO statuses.**
  `total_count`, not `state`, says whether it is worth reading. A repo whose CI comes from
  Apps or Actions never has a commit status at all, so ORing that `state` into a pending
  check made the §12 gate unsatisfiable there — a green PR rejected on every claim,
  forever (#15). Forgejo is immune only because statuses are its ONLY signal, so it returns
  early on an empty list.
- **A rejection summary that contradicts its verdict costs a debugging round.** The gate
  said `CI has not finished: 0 check(s) still running`. Zero running checks is a finished
  CI. Name the source that is actually blocking.
- **`needs-human` must be REMOVED when the question is answered** (#16). A claim is the
  only exit from `awaiting-human`, so a claim means it was answered. The label is a filter
  a human reads; one that outlives its question fills the list with work already back in
  progress. Not cleared on `parked` — a parked task genuinely does want a human.
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
- **Mutation-test the guard, not just the code.** Every behaviour in the Discord notifier
  was checked by reverting it on a COPY of `src/` and confirming the matching test failed.
  One did not: the surrogate-pair test passed over a UTF-16 slice, because the truncation
  budget happened to land on an even offset where the naive slice is accidentally correct.
  A test that only passes when the fix is present *by coincidence* is not a regression
  test. It now starts the prose with an ASCII character to force an odd cut.
  `scripts`-free and cheap: copy `src/`, patch one line, run that file's tests.
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

1. **Seal a Discord webhook**, if the user wants notifications. Three operator steps and a
   verify command, with nothing left to implement — and the value is now demonstrated
   rather than hypothetical: `caterpillar-smoke#2` sat parked on a question that nobody was
   told about. A human found it by reading logs.
2. **The inbound bridge** (`!answer`, `!task`). This one IS the `discord-bridge` Deployment
   §10 anticipates: it needs a gateway session or a public interactions endpoint, neither of
   which the supervisor's outward-polling design provides. Design it before building it.
   Until then, answering a question is the manual two-write procedure above.
3. **Give it real work.** The pipeline is proven end to end; nothing is left to smoke-test.
   The open question is what it should do, not whether it works.
4. Minor: `caterpillar-smoke#3` (the agent's `greet.sh` PR) is **open and unmerged** — the
   task is `done`, and merging it was left to a human on purpose. Delete the repo whenever;
   it is a throwaway.
5. Minor: `SMOKE-1`'s `journal.md` is **347KB** of 620 byte-identical park entries from the
   pre-fix retry storm, all mislabelled "Session 0" (the park preceded the session
   increment). It is read for handoff continuity, so it taxes any further session on that
   task. There is no journal rotation. `SMOKE-1` is `done`, so this is latent.

**Uncommitted work: none.** `main` was `0666b60` at the start of this session — since
then #14 (Discord webhook), #15 (CI gate), #16 (`needs-human`), #17 (docs) and #18 (node
26) were squash-merged, built, and rolled by Keel. **159 tests, 159 passing, on node 26
with no flags.** The pod is healthy with 0 restarts.

Of the three, only #15 changes observable behaviour today: #14 is inert until a webhook is
sealed, and #16 only shows up on the next task that asks a question. `caesar-deployment` has no unpushed commits either (its #48
merged as `5f2a95ad`); it does carry untracked `.planning/` and `tea_debug.log`, which are
not mine and were left alone.

Unresolved by choice, not by omission: the exposed App private key (see the callout under
"Live credentials").
