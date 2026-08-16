# Handoff

State as of **2026-08-14**, after a session that ran the plan pipeline end to end for the
first time, found three defects in it, fixed two (#33), and then proved the whole chain —
including the autonomous merge — on a live task.

**The risk has inverted again, in the good direction.** The previous handoff's headline was
"a large amount is built and almost none of it has been exercised". That is no longer true:
the council reviews real diffs, `submit_plan` → plan council → materialisation into
wave-tagged children has run, and **a task went from `ready` to a merged PR on a protected
branch without a human touching it**. What is left is mostly a toolchain gap owned elsewhere.

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

`README.md` has the file-by-file layout and the load-bearing invariants.

Repo: `github.com/caesarakalaeii/Caterpillar` (private).
Manifests: `caesar-deployment` at `apps/workloads/caterpillar`.

> **The host varies between sessions and this file has been wrong about it twice.** This
> session ran on **NixOS** at `~/Hobby/remote-agent` with nix and **no node on PATH**.
> Assume nothing — `pwd`, and check `command -v node nix` before writing a command that
> depends on either.

## Environment

- On the **NixOS** host everything goes through the flake's dev shell:

  ```bash
  nix develop --command npm run check
  nix develop --command npm test
  ```

  Both argument styles survive `--command`. `sops` and `shellcheck` come from
  `nix shell nixpkgs#…`.
- Where node IS on PATH, `npm test` / `npm start` / `verify:*` run directly.
- **299 tests, 299 passing** as of 2026-08-14. CI runs them on **node 22 and 26**.

The node/type-stripping problem is fixed at the source; there is nothing to work around.
`erasableSyntaxOnly` in `tsconfig.json` turns the old runtime load failure into a compile
error, `tsconfig.test.json` applies the same check to test files, and the CI matrix covers
both versions because the failure is asymmetric (DESIGN.md §16). If you write
`constructor(private readonly x: T) {}` out of habit, `npm run check` tells you immediately.

> **The SSH agent died mid-session.** `git push` started failing with
> `sign_and_send_pubkey: signing failed … communication with agent failed`. The global git
> config has `url.ssh://git@github.com/.insteadof https://github.com/`, so switching to an
> HTTPS URL is silently rewritten back to SSH. The working bypass:
>
> ```bash
> GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
>   git -c credential.helper='!gh auth git-credential' push \
>   https://github.com/caesarakalaeii/Caterpillar.git <branch>
> ```
>
> `gh` API calls (`gh pr merge`, `gh api`) are unaffected — they never touch SSH.

## Status

| Area | State |
|---|---|
| Leasing (git-ref CAS, heartbeat fence) | implemented, tested; **stale-token bug fixed (#33)** |
| Context budget + handoff trigger | implemented, tested |
| Credential service + git helper | implemented, integration-tested through **real git** |
| Workspace mirror clone (private repos) | fixed, deployed, exercised in-cluster |
| **Mirror refresh vs worktrees** | **fixed (#33)** — verified in-cluster on a poisoned mirror |
| **Agent push was a mirror push** | **fixed** — `main` can no longer be moved by a task (§B2) |
| GitHub App forge (mint, PR, checks) | implemented, verified against live GitHub |
| Forgejo/Codeberg forge | implemented, endpoints verified against live Codeberg |
| Session runner | implemented, **many real tasks to merged PRs** |
| Verifier + progress probe | implemented, exercised |
| Multi-repo checkout | implemented, tested |
| Vikunja tracker | implemented, verified against the live instance |
| GitHub Issues tracker | implemented, verified against live GitHub |
| Supervisor → tracker mirroring | implemented (claim / question / park / done) |
| Structured logging (§11) | implemented and deployed — JSON lines on stdout |
| Tracker intake (§14) | implemented, deployed, **proven end to end** |
| Discord webhook + bot, both directions (§7, §11.2) | **LIVE** and verified against the real channel |
| Slash commands, buttons, modals (§7.1) | **LIVE** — 5 commands registered in the guild |
| **Review council (§12.1)** | **PROVEN on real diffs** — both plans and PRs |
| **Reviewer identity / autonomous merge** | **PROVEN** — approved and merged a protected branch |
| **Brainstorm → plan → waves (§14.3)** | **PROVEN** — a plan was cut into 5 wave-tagged children |
| Thread chat + typing indicator | deployed; thread answering exercised (3 answers) |
| Artifact channel, small path (§17) | merged; **never used** |
| Runner installer (§8) | merged; **no second runner exists yet** |
| Container image + CI | built and pushed by CI on every push to `main` |
| Deployment | **LIVE** |

Not built, deliberately:

1. **§17.1, large artifacts.** The pointer format is decided and written down; the MinIO
   store is not deployed. Nothing needs it yet.
2. **Forgejo reviewer identity.** `ForgejoForge.approve/merge` exist and are correct, but
   `loadReviewerFactory` returns undefined for non-GitHub forges, so `electric-boogaloo`
   logs `configured=false` and its tasks end `done` with the PR open. That is a missing
   second Codeberg account, not missing code.
3. **`!task <repo> <goal>`** is superseded by `/brainstorm`, not pending.

## What is actually proven

**PROVEN 2026-08-14: the entire chain, autonomously, on a protected branch.** `SMOKE-3` went
from a hand-committed spec to a merged PR with no human involvement:

```
task.claimed → session.start → session.end{done-claimed}
  → progress.probe{committed:true} → verification.result{passed:true}
  → council.start{lenses:correctness,design,fit} → council.verdict{decision:pass,abstentions:0}
  → pr.merged{pr:4} → task.done{merged:true}
```

Cost: **1 session, $0.68** ($0.31 agent + $0.37 council). Claim to merged: **under 3
minutes**. That is the number to quote for a small task now — `SMOKE-1`'s $3.94 and the
earlier $0.96 both predate the council.

**The autonomous merge is the one that could not be proven any other way.**
[`caterpillar-smoke#4`](https://github.com/caesarakalaeii/caterpillar-smoke/pull/4) was
authored by `app/caterpillar-agent`, **approved by `caterpillar-reviewer`**, and merged while
`main` required one approving review. So GitHub **does** count the reviewer App's approval
towards branch protection.

> **Residual caveat, stated honestly.** Protection was created with `enforce_admins: false`,
> and no negative control was run — nothing confirmed that a merge *without* an approval
> would be refused. What is proven is that the App's review is accepted and counted by a
> distinct identity from the author. Branch protection requiring 1 approval is still enabled
> on `caterpillar-smoke`, deliberately, so the next smoke task remains a real test.

**PROVEN: the council is not too permissive.** The previous handoff's worry was that
`decision="changes"` might stay at 0 forever. It does not. The plan council returned
**non-blocking `changes` on two of three lenses** with specific, repo-verified findings: a
cross-task filename collision that would have made the operator park a raw TSV under a build
product's name, an acceptance list where "an agent that shipped only the baker would pass all
eight criteria", and a wrong test-precedent reference. Read
`tasks/BS-1537785980415778816/reviews/004-verdict.md` in the state repo — it is the best
evidence in the system that the lenses do real work.

**PROVEN: brainstorm → plan → waves.** `BS-1537785980415778816` took three human answers in
its Discord thread, proposed a 5-task plan, passed the council, and materialised into
`-01`…`-05` with correct longest-path wave layering (`-05` is wave 1, blocked by `-01` and
`-03`). Cost **$6.06** over 4 sessions.

## The three defects this session found

All three were found by *using* the pipeline. Each reported success while doing nothing or
the wrong thing.

### A. The fencing token was captured before a multi-minute await — FIXED (#33)

`assertHeld` compares the lease oid **exactly** — that exactness is the whole fence — and the
heartbeat **rotates** it. Every method below `workTask` was handed a `Lease` *value* read out
of the heartbeat, so any write following a long await CAS'd against a stale token.

It destroyed the first real plan. `applyPlan` wrote the verdict, five children and the
parent's transition to `done`, then failed at `push`: the review had taken **207s** and three
60s heartbeats had moved the token. `LeaseLostError` unwound the task, the `finally` released
the lease, and the next poll's `pull()` (`git reset --hard`) reverted every tracked write
while leaving the five **untracked** child directories on the PVC. `convene` had the same
shape, so no PR council could ever commit a verdict — which is exactly why the previous
handoff could say a council reviewing a real diff had never been observed. **It was logged at
`warn`.**

Fixed by making the hazard unrepresentable: methods that write take a `LeaseHandle` and
resolve it immediately before the write (DESIGN.md §5.1). `heldLease` wraps the short
claim-write-release paths so no signature offers the stale choice.

### B. One task pushing broke the mirror for every later task on that repo — FIXED (#33)

`clone --mirror` configures `+refs/*:refs/*`, so `fetch --prune` writes every remote ref onto
the identically-named local ref. Once a task pushes `agent/<task>`, the fetch targets a local
head a worktree has checked out and git refuses the **whole** fetch. Worktrees outlive their
session on the PVC, so this was not limited to concurrent tasks — the second task on a repo
parked two seconds after being claimed, reading as a scheduler fault.

Fixed with a negative refspec, `^refs/heads/agent/*`, passed per invocation because
`configure` only runs on first clone and every mirror already on a PVC keeps the old refspec.

### B2. The same shared config made every agent push a force-push of `main` — FIXED

The push-side twin of B, and the one that did real damage. `clone --mirror` also sets
`remote.origin.mirror = true`; a worktree reads the mirror's config, so the agent's plain
`git push` mirror-pushed **every** ref, forced. The mirror's `main` is as stale as its last
fetch, so on `caesarakalaeii/sub2_random` a task rewound shared `main` over `6a889c2` — a
commit a sibling task had pushed and no clone on the box had ever fetched:

```
+ 6a889c2...b0b1f47 main -> main (forced update)
```

The flag also made `git push -u origin <branch>` fail outright
(`--mirror can't be combined with refspecs`), which is what drove agents to the bare `git
push` in the first place.

Fixed in `configure`: unset `remote.origin.mirror`, set `remote.origin.push = HEAD`. Written
into the shared config *deliberately* — unlike B's refspec — because `configure` runs on every
worktree create and reuse, so PVC mirrors already carrying the flag are healed on next touch.
Regression test drives a real `git push` from a worktree against a stale mirror and asserts
`main` did not move.

**Recovery note:** the destroyed commit was recoverable server-side. `b0b1f47` was `6a889c2`'s
*parent*, so restoring was a plain fast-forward — GitHub keeps unreferenced commits reachable
via the API (`gh api repos/<o>/<r>/commits/<sha>`) long after a forced update. Check there
before concluding a commit is gone; the local reflog will not show it.

### C. The acceptance toolchain is missing from the runner — NOT fixed here, owned elsewhere

A toolchain absent from the container makes §12's first gate **unsatisfiable** rather than
failed. Observed: `tools/test.py` exited **127** with
`env: 'python3': No such file or directory`. That reads as a badly written acceptance command
rather than a missing interpreter, and nothing the agent can do inside a session fixes it.

**Being solved by a different runner, as nix flakes in the target repo** — so every runner
gets exactly that repo's dependencies, the base image stays small, and `requires` stays about
*machine* properties rather than drifting into a package list. DESIGN.md §12 records this.

> **The prerequisite is not met.** The supervisor image is `node:22-alpine` and ships **no
> `nix`** (checked: `nix` and `nix-shell` both absent). Flake-provided acceptance commands
> cannot run there until it does. A first attempt at this PR added `python3 curl jq` to the
> image; that commit was **dropped on purpose** to stay out of the other runner's way, so the
> Dockerfile is untouched.

## The parked SN2 plan

Five children of `BS-1537785980415778816` are committed and **parked** in the state repo, and
the parent is set `done`. Do not unpark them until the flake toolchain lands — every one
calls `tools/test.py`, and four need `dotnet` or `lua`:

| Task | Wave | Needs | Status |
|---|---|---|---|
| `-01` pakgen `--dump-level-actors` + runbook | 0 | `dotnet` | parked |
| `-02` `gen-pak.sh --resources-level` stage | 0 | `lua` | parked |
| `-03` web Resources tab | 0 | `lua` + node | parked |
| `-04` ADR-0058 + probe recipe + kill criteria | 0 | `lua` | parked |
| `-05` resource layer on the world map | 1 (needs `-01`, `-03`) | node only | parked |

All five declare `requires: []`, and `KNOWN_CAPABILITIES` in `src/plan/materialize.ts` has no
token for a language toolchain — so capability matching would not route them anyway. With
flakes it does not need to.

Spend on this plan so far: **$10.28** (parent $6.06, `-03` $4.22 across two sessions). Three
sessions on `-01`/`-02`/`-03` ran against orphaned tasks and were discarded — that spend is
not recorded anywhere because the pushes that would have recorded it were the ones failing.

To unpark: set each `state.json` to `status: "ready"` and reset `progress.noProgressStreak`
to 0 in the same write. `-05` stays blocked until `-01` and `-03` are `done`, which is
correct.

## Giving it work

Three paths (§14):

1. **Label a tracker item `agent`** with an `agent` block in the body. Within ~5 minutes
   intake renders a spec and the supervisor claims it.
2. **`/brainstorm topic:… repo:owner/name`** in Discord (§14.3) — opens a thread, refines the
   idea one question at a time, and ends in a plan the council reviews and cuts into
   wave-tagged tasks. **Proven end to end.** This is the path that produces acceptance
   criteria rather than demanding them up front.
3. **Commit `tasks/<id>/spec.md`** into `caterpillar-state` by hand — most control, fastest
   way to test the pipeline. `SMOKE-3` used this; the seeding script is worth copying.

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
`intake/<task-id>.json`, keyed by a digest of title and body; editing the item re-opens it.
**In Vikunja the `agent` marker must be the first line INSIDE a code block** — TipTap cannot
put text on the fence line.

**Write acceptance criteria the container can actually run.** This is now the most likely way
to waste money: the gate is unsatisfiable, not failing, and the agent cannot tell you.
`bash`, `coreutils`, `git` and `node` are present; `python3`, `curl`, `jq`, compilers and
language runtimes are **not**.

To silence intake entirely, remove the `agent` label. To stop a task, set its `state.json` to
`parked` — do **not** `kubectl scale`, ArgoCD `selfHeal` reverts it within seconds.

**The target repo needs the three lifecycle labels** — `agent`, `agent-wip`, `needs-human`.
No adapter creates them, deliberately. A missing one does not fail the task: `mirror()` logs
`tracker.mirror-failed` and continues. It fails the tracker VIEW silently, which is worse to
debug than a crash.

### Answering a question

- **In a task's own thread: just type the answer.** No `!answer`, no id — the thread IS the
  task (§7.1). Proven: three answers drove `BS-1537785980415778816` through to a plan.
- **The Answer button** on a question notification opens a modal, deliberately absent inside
  threads where there is no id to retype.
- **`/answer <task> <text>`**, or `!answer <task-id> <text>` in the watched channel.

`/cancel <task>` parks a task and closes its thread. Nothing deletes a task; to reclaim disk,
`git rm -r tasks/<id>` in the state repo by hand once no lease is held.

**By hand** — two writes to `caterpillar-state`, and the ORDER matters:

1. `tasks/<id>/questions/NNN-answer.md`, matching the question's number.
2. `tasks/<id>/state.json` with `status: "ready"`.

Answer FIRST. The poll is 30s, and a task flipped to `ready` before its answer exists starts
a session that cannot see it. **Reset `progress.noProgressStreak` in the same write** if it
reached `noProgressLimit` (3), or `checkLimits` parks the task on the very next claim.

Both writes go through the GitHub contents API fine; no clone is needed. For anything
touching several files at once, the git **trees** API makes it one atomic commit — see the
scripts this session used, which is strictly better than a commit per file.

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
Deployment. Watch it with `gh run watch`, then poll the pod name — it changes, so comparing
`imageID` against the old pod is unnecessary.

**`CONFIG_PATH` is `/etc/caterpillar/config/config.json`** — the ConfigMap mounts a
directory. `log.level` and `intake.intervalSeconds` are **absent** from the deployed
ConfigMap, so both run on code defaults (`info`, `300`). Lease settings are
`heartbeatSeconds: 60`, `staleAfterSeconds: 300`.

**`argocd/root-app.yaml` auto-syncs `argocd/apps/` from `main` with `prune` and `selfHeal`**
— adding a file there is a deploy, not a proposal. **The live app-of-apps is named `root`,
not `root-app`.**

The GHCR package is private, handled with `imagePullSecrets: myregistrykey`. Image-pull
secrets are **namespaced**, so rotating the GHCR token means re-sealing it in every namespace
that has one (`caesar`, `ai-editor-collector`, `plot-spot`, `sn2-randomizer`,
`spotify-widget`, `caterpillar`).

Decisions the user made by interview (do not re-litigate):

- **Claude Pro/Max subscription, not a metered API key.** There is **no Anthropic API key
  anywhere**. LiteLLM was removed as a consequence: an OAuth bearer cannot be forwarded by a
  proxy that authenticates with `x-api-key`. DESIGN.md §9.6 covers both modes.
- **State repo on GitHub, authenticated with the existing App**, not a deploy key.
- **Both workspaces from the start**, reusing the existing Codeberg and Vikunja tokens.

### The subscription credential is the sharp edge

`llm.credentialsPath` is `/work/credentials/anthropic.json` on the PVC and **cannot become a
Secret**. Refreshing rotates the refresh token and pi writes the new one back inside
`CredentialStore.modify`; a read-only mount means the supervisor works until the access token
expires and then stops. `FileCredentialStore` locks around the read-modify-write; 30s to
acquire, a lock older than 60s is treated as abandoned.

Seed it with `npm run llm:login -- --out ./auth.json` on a machine with a browser, then
`kubectl cp` it in. **`/work/credentials` does not exist on a fresh PVC** and `kubectl cp`
will not create a missing parent — `mkdir -p` it in the pod first.

- **The pod does NOT crash-loop without the credential.** It boots, serves `/healthz`, and
  idles; the credential is read lazily when a session starts.
- Refresh is **lazy, not scheduled**. An expired access token on an idle supervisor is normal.
- **Deleting the PVC destroys the credential**, not just mirrors and worktrees.

### Discord: every half is LIVE

Webhook, bot token, channel id, application id and guild id are all sealed in
`caterpillar-discord`, synced by ArgoCD, and verified against the real channel. All five
slash commands (`/answer`, `/tasks`, `/task`, `/brainstorm`, `/cancel`) are registered in
guild `877203185700339742`. `gateway.ready` on channel `1537550186388258866` proves the
MESSAGE_CONTENT intent is enabled — without it Discord closes the socket with 4014.

`optional: true` stays on the mount: `index.ts` degrades to `NullNotifier` and a disabled
bridge when a key is absent, so a withdrawn secret costs notifications rather than
crash-looping a working supervisor. `bridge.disabled` in the boot logs means off;
`gateway.ready` means on.

**Notifications come from the bot, not the webhook**, wherever `bot-token` and `channel-id`
are both sealed. Discord refuses interactive components from a webhook the application does
not own, so an Answer button can only be sent by the bot (§7.1). The webhook stays sealed as
the fallback.

Re-run after any command-set change:

```bash
kubectl --context default -n caterpillar exec "$POD" -- sh -c \
  'SECRETS_DIR=/etc/caterpillar/secrets node dist/cli/register-commands.js'
```

Guild-scoped, so commands appear immediately; registration is a full replace, so running it
twice is a no-op. **The bot must have been invited with `applications.commands`** — a
`scope=bot`-only invite joins the guild and registers nothing, and the failure mode is a
**403 that reads exactly like a bad bot token**. `/brainstorm` additionally needs Create
Public Threads and Send Messages in Threads; the full invite is
`permissions=309237713920`.

To rotate or re-seal: `scripts/seal-caterpillar-secrets.sh discord`, **leaving any prompt
blank keeps the sealed value**. Then push and **delete the pod** — every key is read once at
boot and there is no reloader annotation.

## Live credentials

**Two GitHub Apps. The separation is the security boundary** — GitHub refuses to let a pull
request's author approve it, which is the only thing making branch protection a real gate
(§9.1). `seal_reviewer` refuses the author's app id rather than let it be discovered at the
first merge.

| Role | Slug | App ID | Installation | Secret |
|---|---|---|---|---|
| author — mints task tokens, pushes, opens PRs | `caterpillar-agent` | **4579022** | 153385932 | `caterpillar-github-app` |
| reviewer — approves and merges (§12.1) | `caterpillar-reviewer` | **4593009** | 153679546 | `caterpillar-github-app-reviewer` |

The reviewer holds exactly `contents:write`, `pull_requests:write`, `metadata:read` and is
**not** on any bypass list, deliberately — it has to satisfy the rule, not skip it. Both
installations are account-wide ("All repositories"); narrowing to selected repos makes the
state-repo mint return 422 and the pod crash-loop at bootstrap.

Private keys are SOPS-encrypted at
`../caesar-deployment/apps/workloads/caterpillar/secrets/`. Keys: `app-id`,
`installation-id`, `private-key.pem`.

> **UNRESOLVED — the author App private key is exposed.** `aca5042` in `caesar-deployment`
> committed that Secret **twice**. The second path had a **trailing newline in its
> filename**, so that session's `shred` and `sops --encrypt` both hit the correctly-named
> file while the newline-named copy kept its cleartext `stringData` — including
> `private-key.pem` — and was committed unencrypted.
>
> caesar-deployment #46 removed the file, but **by the owner's explicit decision the key was
> not rotated and history was not rewritten**. The blob is still reachable in `aca5042`, and
> any clone predating #46 still holds a working key for app `4579022`. The repo is private
> and nothing was ever deployed from the plaintext copy.
>
> Rotating is cheap if revisited: generate a new key at
> `github.com/settings/apps/caterpillar-agent`, delete the old one, re-seal. App ID and
> installation do not change. `seal-caterpillar-secrets.sh` has only `eb` and `discord`
> modes — re-sealing the App secret is a manual `sops` step.
>
> `ls` renders both filenames identically. Use `ls -b` or `find` to see a stray one.
>
> The reviewer key for **4593009** was sealed cleanly and has never existed in plaintext in
> any repo. If the author key is ever rotated, that is the pattern to follow.

Codeberg and Vikunja tokens are sealed in `caterpillar-electric-boogaloo` (`username`,
`tokens.json`, `vikunja-token`).

### Run the verifiers inside the pod

`dist/cli/` ships in the image and the secrets are already mounted, so live credentials can
be checked without decrypting anything locally — strictly safer than pulling a token onto a
workstation. **The flags are required and the error message only names the first missing
one:**

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

Write scopes on both trackers are still unexercised — that needs `--issue`/`--task` against a
scratch item.

## Things learned the hard way

Each cost real debugging. They are encoded in code or tests now; do not "simplify" them away.

### Learned this session

- **A fencing token is not a value you may carry.** See defect A. The generalisation:
  anything compared for exact equality against remote state must be re-read at the moment of
  use, not passed down a call chain that awaits.
- **Every existing test disabled the clock it needed.** `loop.test.ts` set
  `heartbeatSeconds: 3600` — *"long enough never to fire"* — in every case. A suite that
  suppresses the timer cannot catch a timer bug, and the comment explaining why sounded
  reasonable. When a test disables a mechanism for convenience, something else must exercise it.
- **`git reset --hard` reverts tracked files and LEAVES untracked ones.** That asymmetry is
  what turned a failed push into five orphaned task directories: the parent's `state.json`
  and `journal.md` snapped back to HEAD while the new child directories survived. The claim
  loop enumerates the **local filesystem**, so it claimed tasks that existed on no remote and
  no other runner could see.
- **`git add -A tasks` will sweep another task's orphans into your push.** This accidentally
  rescued the five children at 13:12:39 on an unrelated fast push — which also masked the
  bug, because the state repo eventually looked correct.
- **A `warn` for a lost lease hides a data-losing failure.** The single line distinguishing a
  working pipeline from one discarding council verdicts was `lease.lost` at warn level. Match
  log level to consequence, not to how routine the condition sounds.
- **An unsatisfiable gate is not a failing gate.** Exit 127 from a missing interpreter looks
  like a bad acceptance command, retries identically forever, and no session can fix it from
  the inside. Distinguish "the command is wrong" from "the command cannot run here".
- **Verify a mutation actually applied before trusting the mutation test.** Each of the three
  fixes here was reverted on a copy of `src/` and the matching test confirmed failing, with
  the codemod asserting `s != before` — otherwise a no-op patch reads as "the test passes
  either way".
- **`kubectl kustomize --enable-alpha-plugins` silently renders NO Secrets** when `ksops` is
  absent, and exits 0. Install `nixpkgs#kustomize-sops`, symlink it into
  `$XDG_CONFIG_HOME/kustomize/plugin/viaduct.ai/v1/ksops/`, then `kustomize build
  --enable-alpha-plugins --enable-exec`. ksops also fails the whole app's sync if a listed
  file does not exist, so a sealed secret and its `secret-generator.yaml` line must land in
  the SAME commit.

### Environment and tooling

- **Node ERASES types, it does not transform them.** Anything emitting runtime code — a
  parameter property, an enum, a namespace — type-checks and then fails to LOAD, per FILE,
  before one test registers. Guarded by `erasableSyntaxOnly` plus a CI matrix.
- **A tsconfig that excludes tests type-checks NOTHING in them.** `tsconfig.test.json`
  initially agreed with everything because `exclude` is inherited and `include` does not
  override it; fixed with `"exclude": []`. If a test config passes suspiciously fast, run
  `tsc -p … --listFiles | grep -c test.ts`.
- **A codemod must be diffed, not trusted.** The script that rewrote 44 parameter properties
  silently DELETED the `super()` call in every error subclass on its first run. Reading the
  diff caught it; the tests did not.
- **`git add -A <path>` fails the WHOLE command on a pathspec that matches nothing.** Each
  path is staged only when it exists.
- **The `yaml` package is YAML 1.2**: `no`, `yes`, `on`, `off` stay **strings**. The realistic
  hazard is an unquoted command containing `: `, which becomes a **mapping** — `- npm test:
  unit` parses to `{"npm test": "unit"}`.
- **A machine runner inherits the operator's global git config** — identity,
  `commit.gpgsign`, `url.<...>.insteadOf`. **Tests must be hermetic**: pass
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, or the experiment measures the
  workstation.
- **`gateway.ready` does NOT mean the bot is in your server.** A bot belonging to zero guilds
  connects, identifies, and receives nothing — indistinguishable from a quiet channel. Check
  `/users/@me/guilds` and `/channels/{id}`, and give any "it correctly ignored X" test a
  POSITIVE CONTROL.
- **A sealed Secret can be valid and still refuse to apply.** An unquoted 19-digit Discord
  channel id types as an int, and `stringData` takes strings only — the apply dies with
  `cannot convert int64 to string` while ArgoCD sits `OutOfSync` with the PREVIOUS Secret
  mounted. Check `kubectl -n argocd get application caterpillar -o
  jsonpath='{.status.operationState.message}'` when a secret change appears to do nothing.
- **SOPS in `caesar-deployment` encrypts by PATH** (`path_regex: .*\.enc\.yaml$`), so
  encrypting a `/tmp` file fails. Write plaintext to its final `*.enc.yaml` path (umask 077)
  and `sops --encrypt --in-place` there. Don't hand-edit an encrypted file's plaintext
  fields — the MAC covers them.
- **The caesar cluster is the `default` context.** **`kubectl scale` loses to ArgoCD
  `selfHeal`** — change the TASK, not the replica count.

### Credentials and git

- **`credential.helper` set AFTER a clone is set too late** — pass it with `-c`.
- **`Repository not found` means a credential ARRIVED and was refused.** 404 = the WRONG
  token was sent; 401 = NO token was. They look equally like "auth is broken" and point in
  opposite directions. **A 404 stops git asking the credential helper**, so a
  valid-but-unauthorised credential never reaches it.
- **git appends the credential-helper operation LAST**: `caterpillar-cred --socket <path>
  get`. "First argument that is not a flag" therefore selects the *socket path*. `git
  credential fill` reproduces the real invocation offline.
- **`at()` drops the credential, but only if you call it.** Enforce "this object must not
  travel" at the boundary that RECEIVES it.
- **Anything the supervisor does AFTER `clearActive()` cannot use a task credential**, so
  post-session code (probe, verifier) must not need the network.
- **Never set `remote.origin.url` from a worktree** — worktrees share the mirror's config.
  Use **`--git-common-dir`, not `--git-dir`**, for `info/exclude` and shared refs.
- **A worktree of a `--mirror` clone inherits `remote.origin.mirror`**, so a bare `git push`
  there force-pushes *every* ref. Sharing the mirror's config cuts both ways: it is the
  delivery mechanism for the credential helper AND for a footgun. Pin
  `remote.origin.push = HEAD` (§B2).
- **A force-pushed-away commit is usually still on the forge.** GitHub answers
  `gh api repos/<o>/<r>/commits/<sha>` for unreferenced objects; check there before trusting
  a local reflog that never saw the commit.
- **"No merging" is not expressible as a GitHub permission.** `pull_requests: write`
  authorises merge; branch protection requiring an approving review is what enforces it.

### Supervisor behaviour

- **Release the lease LAST.** Anything recording *why* a task failed must write while the
  lease is held, using the heartbeat's current lease.
- **A first-session commit needs a baseline that exists.** The fallback is the branch's fork
  point, resolved locally — but do **not** use the fork point always, or every session after
  the first commit looks productive and thrashing never parks.
- **pi does not auto-compact.** The hazard is a provider context-length error.
- **pi does not THROW on a provider failure either.** `Agent.prompt()` catches it, appends
  an assistant message with `stopReason: "error"` + `errorMessage`, and returns normally.
  A `try/catch` around it sees nothing. Read `agent.state.errorMessage` as well, or a 429
  reads as "the model stopped talking" — which is a handoff, which means *start another
  session now*. That is how the 2026-08-15 spend limit produced five sessions in nine
  seconds and a task parked for "no progress" (DESIGN.md §6.3).
- **An outage is the RUNNER's problem, never the task's.** Release the task as `ready`,
  do not run the progress probe, do not record a session that got no tokens back — and
  back the runner off, or the next task in the queue meets the same wall immediately.
  `llm/outage.ts` is deliberately narrow: a 400 `prompt is too long` is still the task's
  own failure and must keep failing loudly.
- **Context size must include `cacheRead` + `cacheWrite`.**
- **An OAuth refresh ROTATES the refresh token**, inside `CredentialStore.modify`.
- **Intake must not ride the poll interval.** A GitHub pass costs 1 request + 1 per repo
  (~66 here); at a 30s poll that exhausts the installation budget within minutes. Stamp the
  clock BEFORE the pass.
- **Intake's id must derive from the tracker ref alone**, never the title. It also becomes a
  directory name, so reduce it to one safe path segment.
- **`listAgentItems()` filters on the ingest label alone**, so a refused item returns every
  pass. Suppress repeat comments with a **durable** record — Keel rolls the pod on every push
  to `main`, so an in-memory set re-comments on every deploy.
- **A notification must never be able to fail a task.** Write git first, then tell the view,
  and only log if telling it fails.
- **Write `state.json` before `spec.md`.** The spec is the existence marker.

### Trackers and forges

- **Forgejo has no Checks API** (`/check-runs` → 404); commit statuses are the only CI signal.
  **Forgejo returns `statuses: null`, not `[]`.** Vikunja does the same with `labels`.
- **GitHub's combined status endpoint answers `pending` for a ref with NO statuses.**
  `total_count`, not `state`, says whether it is worth reading — a repo whose CI comes from
  Apps or Actions never has a commit status, which once made the §12 gate unsatisfiable.
- **Vikunja: `GET /user` and `GET /tasks/all` are unreachable by any API token**; a 401 means
  a missing route scope, not a bad token. Probe `/projects`. Descriptions and comments are
  HTML (TipTap) — and **`<pre><code>` has no literal fences**, so `stripHtml` must re-insert
  them. Label removal goes through `POST /tasks/{id}/labels/bulk`.
- **GitHub's issues route returns pull requests too.** The `pull_request` key is the only
  reliable discriminator, or intake hands the agent its own open PRs as fresh work.
- **`POST /issues/{n}/labels` silently CREATES an unknown label.** `github-issues.ts` checks
  the repo's labels first and refuses. Do not simplify that away.
- **GitHub distinguishes 401 from 403; Vikunja cannot.** Only 403 becomes `TrackerScopeError`.
- **A Discord webhook is rate limited per WEBHOOK, and `retry_after` is in SECONDS.**
  Honouring it unbounded stops the runner, so it is capped at 10s.
- **Discord's 2000-character limit is counted in CODE POINTS.** Slicing UTF-16 splits a
  surrogate pair, which Discord rejects — a 400 that only shows up for emoji. Questions
  **split** rather than truncate, and a code block is atomic: an unterminated fence renders
  the whole tail as code. The invariant to test is per-message fence balance.
- **Discord parses `@everyone` in webhook content by default.** `allowed_mentions: {parse: []}`
  is not optional.
- **`needs-human` must be REMOVED when the question is answered.** A claim is the only exit
  from `awaiting-human`, so a claim means it was answered. Not cleared on `parked`.
- **The GitHub search API is deliberately unused for intake** — eventually consistent,
  separately rate limited, and on a deprecation path.

### Testing discipline

- **A test that only asserts "it threw" proves nothing.** Assert on the invocation. After
  writing a regression test, **revert the fix and watch it fail** — on a copy of `src/`, not
  the working tree.
- **A test harness that calls the subject differently from the real caller proves nothing.**
  When the thing under test is a protocol, drive it with the real other side.
- **Assert on what was PUSHED, not on the working tree.** A test reading the checkout passes
  whether or not the push landed — and `reset --hard` will hide the difference next poll.
- **`per_page=100` contains the substring `page=1`.** Anchor on `&page=N`.
- **Mutation-test the guard, not just the code.** A test that only passes when the fix is
  present *by coincidence* is not a regression test — one surrogate-pair test passed over a
  UTF-16 slice because the budget landed on an even offset.
- **Run intake tests TWICE.** Both failure modes (duplicate tasks, comment spam) are invisible
  in a single pass.

## Constraints the user has set

- **Do not read the user's `.env` holding the Codeberg and Vikunja tokens.** Enforced by a
  tool classifier — even listing variable *names* is blocked. The user seals those tokens
  themselves with `../caesar-deployment/scripts/seal-caterpillar-secrets.sh eb`.
- Conventional Commits, **no** `Co-Authored-By` trailer, no gitmoji. The repo's history has
  **no trailers at all** — match it. PR bodies *do* carry the Claude Code footer.
- Never use the type `any`.
- Prefer open-source, provider-agnostic tooling — this is why the project is built on `pi`.
  The user asked to be argued with rather than deferred to.
- Pull before working in a repo, and branch before committing — every change goes through a
  PR, squash-merged.
- Architectural changes are recorded in **DESIGN.md**, which serves as the ADR record.

## Immediate next action

**1. Wait for the flake toolchain, then unpark the five SN2 children.** They are the only
queued work and they cannot pass until `tools/test.py`, `dotnet` and `lua` are reachable. The
open question is **how** a flake reaches the acceptance gate, because the image has no `nix`:
either add nix to the image, or run those tasks on a machine runner that has it
(`scripts/install-runner.sh`). That decision is not made yet and it is the single thing
blocking the plan.

**2. Consider folding the council's non-blocking findings into the specs before unparking.**
`reviews/004-verdict.md` names a real cross-task filename collision (`resource_points.tsv`
vs `resource_actors.tsv` — the operator would park the raw dump under a build product's
name) and two acceptance lists an agent could satisfy without doing the visible work. Editing
five `spec.md` files by hand is cheaper than a wasted session, and cheaper than re-running the
brainstorm.

**3. Nothing is broken and nothing is running.** The pod is healthy on the post-#33 image,
`reviewer.identity configured=true`, `gateway.ready`, all tasks terminal or parked. Stale
lease refs `refs/leases/BS-1537785980415778816-01` and `-02` are left over from dead pods;
they are harmless (a parked task is never claimed, and a stale lease is stolen on age) and
can be deleted with `git push --delete` if the clutter bothers you.

**4. Second brainstorm still open.** `BS-1537800044915331092` (repo `all-chat`) is
`awaiting-human` with one unanswered question and a live Discord thread. Answer it in the
thread as plain text, or `/cancel` it.

**Uncommitted work: none.** `main` is `fdb0347`. This session merged **#33** (two fixes plus
the DESIGN.md record) and made three hand-authored commits to `caterpillar-state`
(`5dde792a` settle-and-park, `3ff4b2a5` SMOKE-3). **299 tests, 299 passing.**
`caterpillar-smoke` now has branch protection requiring one approving review — left enabled
deliberately so the next smoke task remains a real test of the merge path.
