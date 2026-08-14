# Handoff

State as of **2026-08-14**, after a session that built the whole usability layer: slash
commands and buttons (§7.1), the review council (§12.1), brainstorm → plan → waves
(§14.3), the artifact channel (§17), and a runner installer for capability-matched
machines (§8).

**The shape of the risk has inverted.** Until yesterday everything built was proven and
what remained was unbuilt. Now a large amount is built, merged and deployed, and almost
none of it has been exercised against a real task. Read *What is actually proven* below
before trusting any of it, and treat this document's claims as dated rather than current.

Overwrite this file rather than appending to it — an append-forever handoff eventually
consumes the context it exists to preserve (the same reason `handoff.md` is overwritten and
`journal.md` appends, DESIGN.md §4.1).

## Orientation

**Caterpillar** is a long-running autonomous coding agent supervisor. Read
[`DESIGN.md`](DESIGN.md) first — it is the source of truth for intent, the decisions in it
were settled by interview, and several were made *against* the obvious default for stated
reasons. Do not re-litigate them; if one looks wrong, the rationale is written down next to
it. **DESIGN.md is also this project's ADR record** — there is no `docs/adr/`, and every
architectural change so far has been recorded by amending the relevant section.

`README.md` has the file-by-file layout and the six load-bearing invariants.

Repo: `github.com/caesarakalaeii/Caterpillar` (private).
Manifests: `caesar-deployment` at `apps/workloads/caterpillar`.

> **The host varies between sessions and this file has been wrong about it twice.** One
> session ran on Arch at `~/git/Caterpillar` with node on PATH and no nix; the next ran on
> NixOS at `~/Hobby/remote-agent` with nix and **no node on PATH at all**. Assume nothing —
> `pwd`, and check `command -v node nix` before writing a command that depends on either.

## Environment

**The node problem is fixed at the source; there is nothing to work around any more** —
but node is not necessarily on PATH.

- Where node IS on PATH: `npm test`, `npm start` and every `verify:*` script run directly.
  No flag, no tarball, no compile step.
- On the **NixOS** host it is not. Everything goes through the flake's dev shell:

  ```bash
  nix develop --command npm run check
  nix develop --command npm test
  nix develop --command node src/cli/verify-reviewer.ts --pem … --app-id …
  ```

  Both argument styles survive `--command`; `npm run x -- --flag` and calling the `.ts`
  directly were each checked. `sops` and `shellcheck` come from `nix shell nixpkgs#…`.
- **293 tests, 293 passing** as of 2026-08-14.

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
| **Discord webhook, outbound (§11.2)** | **LIVE** — sealed, deployed, and verified against the real channel |
| **§12 CI gate** | **fixed (#15)** — was unsatisfiable for every Actions/App-only repo |
| **Toolchain** | **runs natively on node 26 (#18)** — erasable-syntax-only, CI on 22 and 26 |
| **Journal → prompt** | **bounded (#19)** — repeats collapsed, oldest elided, file untouched |
| **Discord bridge, inbound (§7)** | **LIVE** — `gateway.ready`, watching one channel |
| **Tracker label lifecycle** | **fixed (#16)** — `needs-human` outlived its question |
| State-repo credential + bootstrap | implemented, tested |
| LLM auth: Claude subscription (OAuth) | implemented, tested |
| Container image + CI | built and pushed by CI on every push to `main` |
| Deployment | **LIVE**, and no longer idle-by-design |

Built 2026-08-14, merged and deployed, **none of it exercised by a real task**:

| Area | State |
|---|---|
| **Slash commands, buttons, modals (§7.1)** | **LIVE** — 5 commands registered in the guild; `/tasks` used successfully |
| **Review council (§12.1)** | deployed, `configured=true`; **has never reviewed a diff** |
| **Reviewer identity** | `caterpillar-reviewer` app 4593009, sealed and live; **has never approved or merged** |
| **Brainstorm → plan → waves (§14.3)** | deployed; one brainstorm reached `ask_human` and is parked. **No plan has ever been submitted, reviewed or materialised** |
| **Thread chat + typing indicator** | deployed (#27, #28); untested against a live thread |
| **Question splitting, fence-safe (§7.1)** | deployed (#26, #29); the 3785-point case is unit-tested, not seen live |
| **Artifact channel, small path (§17)** | merged (#31); **never used** |
| **Runner installer (§8)** | merged (#30); **no second runner exists** |

Not built, deliberately:

1. **§17.1, large artifacts.** The pointer format is decided and written down; the MinIO
   store is not deployed. Nothing needs it yet — small derived outputs are what actually
   crosses machines, and inputs do not cross at all.
2. **Forgejo reviewer identity.** `ForgejoForge.approve/merge` exist and are correct, but
   `loadReviewerFactory` returns undefined for non-GitHub forges, so `electric-boogaloo`
   logs `configured=false` and its tasks end `done` with the PR open. That is a missing
   second Codeberg account, not missing code.
3. **`!task <repo> <goal>`** (§14 path 3) is superseded, not pending. `/brainstorm` is the
   answer: it produces the acceptance criteria `!task` had nowhere to put.

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

### What 2026-08-14 did NOT prove

Everything in the second status table above is **merged, deployed and unexercised**. The
gap matters because these features sit on the *outcome* path: they only run when a task
completes or a human interacts, and no task has completed since they landed.

Specifically **never observed once, in any form**:

- a council reviewing a real diff, and therefore whether the three lenses block anything.
  `caterpillar_council_total{decision="changes"}` staying at 0 across a few tasks would
  mean they are too permissive to be the last gate before `main` — tighten
  `src/review/lenses.ts` before leaving it unattended.
- an autonomous merge. **This is the one that cannot be proven any other way**: whether
  GitHub counts `caterpillar-reviewer`'s approving review towards the required approval on
  a protected branch. `verify:reviewer` proves everything up to that line and says so. A
  failure shows as `pr.merge-failed` in the logs, the task still reaches `done`, and the PR
  is simply left open — so the failure mode is safe, just silent-ish.
- `submit_plan`, plan-council review, and materialisation into wave-tagged children. The
  wave arithmetic and every refusal are unit-tested; the *agent* half never ran.
- artifact publish/stage, which additionally needs a second runner to be meaningful.
- the typing indicator, thread archiving, and how a split code block actually renders.

The cheapest way to close most of this at once is to answer the parked brainstorm (below):
it exercises thread chat → plan council → materialisation, and each child that completes
then exercises the PR council and the merge.

## Giving it work

Three paths (§14):

1. **Label a tracker item `agent`** and put an `agent` block in the body. Within ~5 minutes
   intake renders a spec and the supervisor claims it.
2. **`/brainstorm topic:… repo:owner/name`** in Discord (§14.3) — opens a thread, refines
   the idea one question at a time, and ends in a plan the council reviews and then cuts
   into wave-tagged tasks. This is the path that produces acceptance criteria rather than
   demanding them up front. **Never run end to end; see the status table.**
3. **Commit `tasks/<id>/spec.md`** into `caterpillar-state` by hand — most control over
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

### Answering a question

**From Discord**, three ways now, all converging on one handler:

- **In a task's own thread: just type the answer.** No `!answer`, no id — the thread IS the
  task (§7.1). A leading `!answer` is stripped if typed from habit. Chatting while the agent
  works gets no reply on purpose; the typing indicator is what says it is busy.
- **The Answer button** on a question notification opens a modal. It is deliberately absent
  inside threads, where there is no id to retype.
- **`/answer <task> <text>`**, or the older `!answer <task-id> <text>` in the watched
  channel. The bot replies with what happened — applied, unknown task, or not waiting —
  because silence leaves you unable to tell a typo from an offline bridge.

`/cancel <task>` parks a task and closes its thread. Nothing deletes a task; to reclaim
disk, `git rm -r tasks/<id>` in the state repo by hand once no lease is held.

**By hand** — the fallback, and what the bridge now does for you. Two writes to
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

### Discord: every half is LIVE

`caterpillar-discord` is sealed, listed in `secret-generator.yaml`, synced by ArgoCD, and
**verified against the real channel** — webhook id `1537550223604195470`, a
`**VERIFY** parked` message posted from inside the pod on 2026-08-13. Questions, parks and
terminal outcomes now reach a human.

`optional: true` stays on the mount, against the seal script's old advice: `index.ts`
degrades to `NullNotifier` and a disabled bridge when a key is absent, so a withdrawn
secret should cost notifications rather than crash-loop a working supervisor.

**`!answer` is live too.** `bot-token` and `channel-id` are sealed (deployment #51, #52),
the bot is connected — `gateway.ready` on channel `1537550186388258866` — and the
MESSAGE_CONTENT privileged intent is enabled, which is provable from that log line alone:
without it Discord closes the socket with 4014 and the connection never reaches ready.

**The bot shares the channel with the webhook and ignores its own side of it.** Verified
live, WITH A CONTROL: a webhook-posted question notification ending in a literal
`!answer VERIFY <your answer>` produced no `bridge.answer`, while a human
`!answer NO-SUCH-TASK hello` typed into the same channel produced one and drew the reply
"No task **NO-SUCH-TASK** in the state repo". Without that control the test proves
nothing — see the trap below. Three independent guards: the parser ignores anything not
starting with `!`, and the gateway drops `author.bot` and `webhook_id` messages.

The full inbound path is therefore proven end to end — Discord → gateway → parser →
inbox → poll loop → reply — on `caesarlp`'s message at 2026-08-14T07:00:40Z.

To rotate or re-seal: `scripts/seal-caterpillar-secrets.sh discord`, **leaving any prompt
blank keeps the sealed value** (#50). Then push and **delete the pod** — every key is
read once at boot and there is no reloader annotation. `kubectl scale` loses to ArgoCD
selfHeal; deleting the pod does not.

`bridge.disabled` in the boot logs means it is off; `gateway.ready` means it is on.

**Slash commands are LIVE.** All five (`/answer`, `/tasks`, `/task`, `/brainstorm`,
`/cancel`) are registered in guild `877203185700339742` and confirmed from Discord's own
`GET /applications/…/commands`. `application-id` (`1537706675988070420`) and `guild-id` are
sealed alongside the bot token, which was rotated on 2026-08-14 and re-sealed.

The bot's effective permissions in `#caterpillar` were computed from the API — base roles,
then `@everyone`, role and member overwrites — rather than trusted from the invite URL:
View Channel, Send Messages, Read Message History, **Create Public Threads** and **Send
Messages in Threads** are all present, so `/brainstorm` can open a thread.

Re-run this once per command-set change:

```bash
kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'SECRETS_DIR=/etc/caterpillar/secrets node dist/cli/register-commands.js'
```

Guild-scoped, so `/answer` appears in the client immediately. Registration is a full
replace, so running it twice is a no-op. **The bot must have been invited with
`applications.commands`** — the live invite used `scope=bot` alone, which joins the guild
and registers nothing. Re-invite with
`https://discord.com/oauth2/authorize?client_id=<app-id>&scope=bot+applications.commands&permissions=68608`;
the guild membership it already has is kept and no restart is needed. The failure mode if
this is skipped is a **403 on registration that reads exactly like a bad bot token**.

**`/brainstorm` opens threads**, so the bot needs two permissions the current invite does
not grant: **Create Public Threads** (`1 << 35`) and **Send Messages in Threads**
(`1 << 38`). Combined with the `68608` it already has that is `permissions=309237713920`. Re-invite
with the same `client_id` — the guild membership is kept and no restart is needed. Without
them `/brainstorm` fails at `createThread` with a 403 and nothing is created.

**The review council needs a SECOND GitHub App** before it can merge anything (§12.1).
Not sealed yet, and everything works without it — the council still reviews, and a passing
task ends `done` with its PR open for you to merge, exactly as today.

To enable auto-merge: create a second App (`caterpillar-reviewer`), install it on the same
repositories, and seal `app-id`, `installation-id` and `private-key.pem` into a secret named
`<secretRef>-reviewer` — so `caterpillar-caesar-reviewer` alongside `caterpillar-caesar`.
All three keys or none; a half-configured reviewer fails at the moment of merging, which is
after every gate has passed. Verify it first:

```bash
npm run verify:reviewer -- --pem <reviewer-key.pem> --app-id <id> \
  --repo caesarakalaeii/Caterpillar --author-app-id <the existing app id>
```

**It must be a different App from the one that opens PRs.** GitHub refuses to let a pull
request's author approve it — that refusal is the whole reason branch protection is a real
gate (§9.1) — so a reviewer sharing the App id can never merge anything. The verifier
asserts this when given `--author-app-id`.

**The reviewer App is now sealed and live** (`configured=true`); what follows describes how
it was set up. Untested until the first live council merge: whether GitHub counts this
App's approving review towards the required approval on `main`. If it does not, the App is on a bypass list
or the ruleset requires a code owner it is not. Nothing short of a real PR proves it.

**Notifications now come from the bot, not the webhook**, wherever `bot-token` and
`channel-id` are both sealed — which they are. That is not cosmetic: Discord refuses
interactive components from a webhook the application does not own, so an Answer button
can only be sent by the bot (§7.1). The visible change in the channel is the author of
every notification. The webhook stays sealed and stays the fallback; `verify:discord`
still exercises it.

The webhook can be re-checked from inside the pod at any time, which is where the secret
already is:

```bash
kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'DISCORD_WEBHOOK_URL=$(cat /etc/caterpillar/secrets/caterpillar-discord/webhook-url) \
   node dist/cli/verify-discord.js'
```

It posts one real message and prints the webhook id but never the token. **Not run yet —
there is no webhook.** It was exercised end to end against a local stand-in server that
answers 204 like Discord does, which proves the wiring but not the credential.

## Live credentials

**Two GitHub Apps now. The separation is the security boundary** — GitHub refuses to let a
pull request's author approve it, which is the only thing making branch protection a real
gate (§9.1). A "reviewer" sharing the author's app id could never merge anything, and
`seal_reviewer` refuses that id rather than let it be discovered at the first merge.

| Role | Slug | App ID | Installation | Secret |
|---|---|---|---|---|
| author — mints task tokens, pushes, opens PRs | `caterpillar-agent` | **4579022** | 153385932 | `caterpillar-github-app` |
| reviewer — approves and merges (§12.1) | `caterpillar-reviewer` | **4593009** | 153679546 | `caterpillar-github-app-reviewer` |

The reviewer's token was verified live from the sealed copy: `/app` resolves, a token mints
`201` scoped to `caesarakalaeii/Caterpillar` with exactly `contents:write`,
`pull_requests:write`, `metadata:read`. It is **not** on any bypass list, deliberately — it
has to satisfy the rule, not skip it.

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
- **`gateway.ready` does NOT mean the bot is in your server.** A bot belonging to zero
  guilds connects, identifies, and sits there receiving nothing — indistinguishable from
  a working bridge in a quiet channel. It cost a false "verified live" claim here: the
  ignore test looked like a pass when the bot simply could not see the message. Check
  `/users/@me/guilds` (empty means not invited) and `/channels/{id}` (403 `Missing
  Access` means invited but not permitted), and give any "it correctly ignored X" test a
  POSITIVE CONTROL that must produce a visible effect.
- **Inviting needs `scope=bot`.** A link built with only `applications.commands` adds
  slash commands and joins nothing. The bot user's id IS the application id, so the URL
  is `https://discord.com/oauth2/authorize?client_id=<app-id>&scope=bot&permissions=68608`
  — view channel, send messages, read history. A private channel additionally needs a
  channel-level permission overwrite; role defaults do not reach it.
- **Guild membership arrives over the LIVE socket.** Inviting the bot while the
  supervisor is running needs no restart; only the three secret keys are boot-time.
- **A sealed Secret can be perfectly valid and still refuse to apply.** A Discord channel
  id is a 19-digit number; unquoted, YAML types it as an int, sops preserves the type
  through encryption, and `stringData` takes strings only — the apply dies with `cannot
  convert int64 to string` and ArgoCD sits `OutOfSync` with the PREVIOUS Secret still
  mounted. Nothing about the file looks wrong: it decrypts cleanly and carries every key.
  The seal script now single-quotes every value (#52). Check `kubectl -n argocd get
  application caterpillar -o jsonpath='{.status.operationState.message}'` when a secret
  change appears to do nothing.
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

### Learned on 2026-08-14

Every one of these was found by USING the thing, not by reading it. They share a shape:
the system reported success while doing nothing, or the wrong thing.

- **`tsconfig.test.json` type-checked ZERO test files.** `exclude` is inherited from the
  base config and `include` does not override it, so the config added specifically to stop
  untested syntax reaching runtime agreed with everything. Fixed by `"exclude": []`; it
  caught a stale import within seconds. If a test config ever passes suspiciously fast, run
  `tsc -p … --listFiles | grep -c test.ts`.
- **A truncated question is an unanswerable one.** §11.2's `fit` clipped prose to 2000 code
  points. Right for a park reason; wrong for the one payload a human must act on. A
  3785-point question offering four options arrived cut mid-option-A, with B, C and D never
  sent, and an Answer button under it. Questions now SPLIT (#26).
- **A split code block breaks every message after it.** An unterminated fence makes Discord
  render the whole tail as code. Blocks are atomic now and only split when too big for one
  message, closing and reopening the fence (#29). The invariant to test is per-message
  fence balance — a test asserting "the text survived" passes against the bug, because the
  text does survive.
- **`!answer we want B` answered a task called `we`.** Two causes at once: `we` matches the
  task-id charset, and the thread index was cold because Keel had just rolled the pod. Both
  fixed (#27) — a thread has no command language now, and the index hydrates before the
  gateway connects. **Keel rolls this pod on every push to `main`**, so "just after a
  restart" is a routine window, not a rare one.
- **A button in a thread was dead.** The interaction guard compared `channel_id` against the
  configured channel alone, so every button posted into a brainstorm thread answered "I only
  act in #caterpillar" (#27).
- **Silence is right for chat and wrong for a closed conversation.** Once every thread
  message became an answer, a cancelled task's thread swallowed everything typed into it.
  Binding is now status-aware: only a non-terminal task's thread is listened to (#28).
- **`seal-caterpillar-secrets.sh` corrupted values on every re-seal.** `yaml_scalar` wraps a
  value in single quotes; `existing_key` read them back *with* the quotes and re-wrapped, so
  each blank-prompt re-seal doubled them and three round trips left a channel id wrapped in
  fifteen quote characters. Fixed in caesar-deployment #53/#54 — and verified with the OLD
  function as a positive control, which is how the growth was measured rather than guessed.
- **`kubectl kustomize --enable-alpha-plugins` silently renders NO Secrets** when the
  `ksops` binary is absent. It exits 0. I read that as "ksops resolved" and said so in a PR
  before checking. Install `nixpkgs#kustomize-sops`, symlink it into
  `$XDG_CONFIG_HOME/kustomize/plugin/viaduct.ai/v1/ksops/`, then `kustomize build
  --enable-alpha-plugins --enable-exec`.
- **ksops fails the whole app's sync if a listed file does not exist**, so a sealed secret
  and its `secret-generator.yaml` line must land in the SAME commit.
- **Notifications changed author.** With a bot token present the notifier prefers the bot
  over the webhook, because Discord refuses components from a webhook an application does
  not own. Expected, but it reads as a regression in the channel if nobody says so.
- **A bot token reset invalidates REST immediately and the gateway lazily.** After a
  rotation the socket stayed on its old session while every bot REST call answered 401 — so
  inbound looked healthy while notifications failed silently. `gateway.ready` proves the
  token was valid at connect time and nothing since.
- **A bot's application id is the first segment of its token**, base64-decoded. That works
  on a revoked token, which is how the app id was recovered without opening the portal.

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

**1. Answer the parked brainstorm.** `BS-1537785980415778816` is `awaiting-human` with a
3785-code-point question offering four options (A–D) about the SN2 resource track. Its full
text is in `tasks/BS-1537785980415778816/questions/001-question.md` in the state repo.

This is the highest-value single action available, because it is the only cheap way to
exercise the whole 2026-08-14 build at once: thread chat → `submit_plan` → plan council →
materialisation into wave-tagged children, and then each child exercises the PR council and
the autonomous merge.

Answer it **in its Discord thread as plain text** — no `!answer`, no id. That path is new
(#27) and itself unproven against a live thread.

**2. Watch the first council run.** Two numbers decide whether any of this is trustworthy:

```bash
kubectl --context default -n caterpillar logs -f deploy/caterpillar \
  | grep -E "council|pr\.merg|plan\.|verdict"
```

- `caterpillar_council_total{decision="changes"}` — if it never leaves 0, the lenses are
  too permissive to be the last gate before `main`.
- the first `pr.merged` vs `pr.merge-failed` — the only test of whether GitHub counts the
  reviewer App's approval against branch protection.

**3. Install a second runner** if the SN2 work needs the game files
(`scripts/install-runner.sh --capabilities linux,usb,human-present --from-cluster`). It
generates the config from the deployed ConfigMap and refuses to invent one; you copy the
secret directories and run `npm run llm:login` yourself. Until a runner advertising
`human-present` exists, a task requiring it sits `ready` forever and looks like a stuck
scheduler.

**4. Minor, unchanged:** `caterpillar-smoke#3` is open and unmerged (deliberate; the repo is
a throwaway). `SMOKE-1`'s `journal.md` is still 347 KB of pre-fix park entries — left alone
on purpose, it is the audit trail, and since #19 it reaches a prompt as a single collapsed
line.

**Uncommitted work: none.** `main` is `5819b42`. This session merged #22, #24, #26, #27,
#28, #29, #30, #31 in Caterpillar and #53/#54/#55 plus the two secret commits in
`caesar-deployment`. **293 tests, 293 passing.** The pod is healthy, `reviewer.identity
workspace=caesar configured=true`, `gateway.ready`, 0 errors since boot.

`caesar-deployment` carries untracked `scripts/rotate-allchat-secrets.go`, which is not
mine and was left alone.

Unresolved by choice, not by omission: the exposed App private key for **4579022** (see the
callout under "Live credentials"). Note it now has a sibling — the reviewer key for
**4593009** was sealed cleanly by `seal_reviewer` and has never existed in plaintext in any
repo. If the author key is ever rotated, that is the pattern to follow.
