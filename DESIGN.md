# Caterpillar — Design

A long-running autonomous coding agent that survives context exhaustion, pod restarts,
and machine boundaries. Runs on the k3s cluster managed by `../caesar-deployment`.

**Status:** design agreed, not yet implemented.

---

## 1. Goals

1. **Run for hours, not minutes.** A task outlives any single LLM context window.
2. **Context-aware self-handoff.** The agent detects it is filling up, writes a handoff,
   and exits; a fresh session resumes from durable state.
3. **Machine handoff.** Work that needs a GPU, special hardware, or a human present
   migrates to a runner that has those capabilities, then migrates back.
4. **Restart-resilient.** Killing the pod at any instant loses at most the current turn.
5. **Vendor-neutral.** Uses a Claude credential today; swapping to a private provider is
   configuration, not a rewrite.

---

## 2. Decisions

| Area | Decision |
|---|---|
| Agent runtime | `@earendil-works/pi-agent-core` + `pi-ai` as **libraries** (not the Claude Agent SDK) |
| Durable state | **Git**, one directory per task, in a dedicated state repo |
| Context strategy | **Hard handoff** at a token threshold — new session, not compaction |
| Mutual exclusion | **Atomic git ref CAS** on `refs/leases/<TASK>`, heartbeat + steal-on-stale |
| Multi-machine | **Capability-matched runner daemons** that poll and claim |
| K8s shape | **Deployment** running a supervisor loop, one task at a time per replica |
| Workspace | **PVC** bare mirrors + one **git worktree** per task |
| LLM access | All runners → **in-cluster proxy** that holds the credential |
| Git credentials | **GitHub App**, supervisor-minted, scoped per task; repo-scoped tokens on Codeberg |
| Autonomy | Push branches, open/update PRs. **No merging. No cluster writes.** |
| Human channel | **Discord** — questions, parks, terminal outcomes only |
| Metrics | **Prometheus/Grafana** for everything else |
| Workspaces | Per-ecosystem profiles (`caesar`, `electric-boogaloo`) — forge, tracker, creds |
| Task intake | GitHub issues / Vikunja tasks labelled `agent`, Discord command, hand-committed spec |
| Stop conditions | Max sessions per task + no-progress detector |
| Done | Machine-checkable acceptance criteria **and** PR open with CI green |

### 2.1 Why pi over the Claude Agent SDK

Chosen for vendor neutrality, but it wins on the merits for this specific system:

- `agent.shouldStopAfterTurn` is an async per-turn predicate — the handoff trigger is a
  first-class hook evaluated at a clean turn boundary, not a parse-stderr hack.
- `usage.{input,output}` and `usage.cost.total` are exposed per message, and models carry
  `contextWindow`. The handoff threshold and the cost budget read the same numbers.
- Sessions are append-only JSONL trees (`id`/`parentId`) — they commit into the task
  directory and diff sanely.
- `CredentialStore` serialises OAuth refresh inside `modify()`, so concurrent runners
  cannot double-refresh a rotated token. A real distributed-systems bug, pre-solved.
- Provider swap is `createProvider({ baseUrl, auth })` + `models.setProvider()`.

**Accepted costs.** pi has *no permission system* — it runs with the permissions of its
process. The container and the scoped credential are the security boundary, not the agent.
`pi-server` and `pi-protocol` are explicitly experimental and must not be depended on.
The npm scope already moved `@mariozechner/*` → `@earendil-works/*`; pin exact versions.

---

## 3. Components

```
┌─ k3s cluster ─────────────────────────────────────────────┐
│                                                            │
│  supervisor (Deployment, 1 replica)                        │
│    ├─ claim loop (git ref CAS)                             │
│    ├─ pi Agent instance  ← one task at a time              │
│    ├─ GitHub App token minting                             │
│    └─ /metrics                                             │
│                                                            │
│  llm-proxy ──────────────► provider (Anthropic today)      │
│    holds the only credential, enforces global spend cap    │
│                                                            │
│  discord-bridge                                            │
│    outbound: questions, parks, outcomes                    │
│    inbound:  !answer → commits answer to state repo        │
│                                                            │
│  intake                                                    │
│    GitHub issues (label: agent) → task spec                │
│    Discord /brainstorm          → plan → task specs        │
└────────────────────────────────────────────────────────────┘
             ▲                              ▲
             │ git (state repo)             │ https (llm-proxy over wireguard)
             ▼                              │
┌─ dedicated machine ────────────────────────┴──────────────┐
│  same supervisor binary                                    │
│  capabilities: [linux, gpu, usb, human-present]            │
│  holds NO LLM credential — proxied                         │
└────────────────────────────────────────────────────────────┘
```

The supervisor binary is identical everywhere; only its declared capabilities differ.
Runners **poll outward**, so a machine behind NAT needs no inbound connectivity.

---

### 3.1 Workspaces

Work is not one ecosystem. `caesar` and `electric-boogaloo` differ in forge, task tracker,
and cluster, so a **workspace profile** is a first-class config object and every task
declares which one it belongs to.

| | `caesar` | `electric-boogaloo` |
|---|---|---|
| Forge | GitHub (`sipgate`, personal) | Codeberg — `ElectricBoogaloo` org |
| Forge credential | GitHub App, minted per task | repo-scoped Forgejo token |
| Task tracker | GitHub issues | **Vikunja** — `tasks.eb.bims.sh` |
| Cluster | k3s via `caesar-deployment` | EB cluster (`cluster` repo) |
| Local prior art | — | `../electric-boogaloo-workspace` |

```jsonc
// workspaces.json — supervisor config, no secrets
{
  "electric-boogaloo": {
    "forge":   { "type": "forgejo", "host": "codeberg.org", "org": "ElectricBoogaloo" },
    "tracker": { "type": "vikunja", "base": "https://tasks.eb.bims.sh/api/v1" },
    "secretRef": "caterpillar-eb"        // SOPS secret with the tokens
  }
}
```

`spec.md` carries `workspace: electric-boogaloo`. The supervisor resolves forge and tracker
credentials from the profile; **a task in one workspace can never obtain another
workspace's credentials.** This is the same containment property as §9.1, one level up.

## 4. State model

### 4.1 Layout

```
state-repo/
  runners/
    <runner-id>.json           # capabilities, last seen
  intake/
    GH-owner-repo-12.json      # why intake REFUSED an item — see §14
  tasks/
    TASK-123/
      spec.md                  # immutable: goal, acceptance criteria, repos, requires
      state.json               # mutable control record
      journal.md               # append-only: one block per session
      handoff.md               # overwritten each handoff — the baton
      questions/
        001-question.md
        001-answer.md          # written by the Discord bridge
      sessions/
        001.jsonl.gz           # pi transcript, gzipped
      artifacts/
```

`spec.md` is written once and never edited by the agent. `journal.md` is append-only —
it is the audit trail. `handoff.md` is deliberately *overwritten*: it holds only what the
next session needs, so it cannot grow without bound.

**The journal is bounded on the way INTO a prompt, never on disk** (amended after
SMOKE-1). Append-only and unbounded-in-context are different properties, and only the
first one is wanted: the file is the audit trail and git keeps it whole, but every
session was opening by paying for all of it. SMOKE-1 finished with a 347KB journal —
620 byte-identical park entries from a retry storm around two that said anything — so
any further session on that task would have started ~90k tokens down.

`journalForPrompt` renders a view: consecutive entries with identical bodies collapse
into one that states the repeat count, then the oldest entries are dropped until it fits
~5% of the context window, and what was dropped is declared in the text. Nothing is
deleted, and the cap scales with the window rather than being a fixed number that is a
rounding error on one model and a quarter of the budget on another.

The collapse is deliberately CONSECUTIVE-only: parking, working, then parking again for
the same reason is real history, and the second park means something the first does not.

### 4.2 `state.json`

```jsonc
{
  "id": "TASK-123",
  "status": "ready",            // ready | running | awaiting-human | parked | done | failed
  "phase": "implementing",      // planning | implementing | verifying | review
  "requires": ["linux"],        // capability predicate for claiming
  "repos": ["all-chat"],        // token scope — supervisor refuses anything else
  "owner": { "runner": "pod-7f3a", "leaseOid": "abc123", "since": "2026-08-13T09:12:00Z" },
  "sessions": 7,
  "limits": { "maxSessions": 20 },
  "usage": { "inputTokens": 1840233, "outputTokens": 96110, "costUsd": 12.47 },
  "progress": { "lastProgressSession": 5, "noProgressStreak": 2 },
  "createdAt": "2026-08-13T08:00:00Z",
  "updatedAt": "2026-08-13T09:41:00Z"
}
```

---

## 5. Leasing

Git has no transactions, so mutual exclusion rides on atomic ref updates.

**Claim** — succeeds only if the ref does not yet exist:

```bash
git push origin <lease-commit>:refs/leases/TASK-123 \
    --force-with-lease=refs/leases/TASK-123:
```

**Heartbeat** — every 60s, CAS from our own current OID:

```bash
git push origin <new-lease-commit>:refs/leases/TASK-123 \
    --force-with-lease=refs/leases/TASK-123:<our-last-oid>
```

**Steal** — if the lease commit's timestamp is older than 5 minutes, another runner may
CAS from the stale OID to its own.

### 5.1 Fencing

The heartbeat *is* the fence. A partitioned runner whose lease was stolen discovers this
within one heartbeat, because its CAS fails against an OID it no longer owns. On failure
it must **abort immediately** — no pushes to the task branch, no state writes.

Rule: **every push verifies lease ownership first.** Mutual exclusion on claiming is not
enough; a runner that lost the network but kept working must not resurrect stale work.

> **Clock skew matters.** Steal-on-stale compares commit timestamps across machines.
> Runners must run NTP. The 5-minute threshold is deliberately far larger than plausible
> skew.

---

## 6. Session lifecycle

```
supervisor loop:
  fetch state repo
  candidates = tasks where status == ready and requires ⊆ my capabilities
  task = first candidate successfully claimed (lease CAS)

  prepare worktree from PVC mirror
  mint GitHub token scoped to task.repos

  loop:
    session = new pi Agent
      system prompt + spec.md + journal.md + handoff.md
      shouldStopAfterTurn → true when usage > contextWindow * 0.70

    run until stop
    write sessions/NNN.jsonl.gz, append journal.md, update state.json
    push state (supervisor credential)

    case exit reason:
      handoff   → write handoff.md, continue loop (fresh session, same task)
      ask_human → status=awaiting-human, release lease, exit
      done      → run acceptance criteria, verify PR + CI, then status=done
      blocked   → update requires[], status=ready, release lease  ← machine handoff
      limit     → status=parked, notify Discord
```

### 6.1 The handoff threshold vs the context window

**Corrected after implementation.** Compaction lives in pi's *coding-agent harness*,
not in `pi-agent-core`. Because we use the library directly (§2), **nothing compacts
automatically** — `compact()` is something a harness calls, and we never call it. The
base `Agent` does not even emit compaction events.

So the original risk ("pi silently summarises behind our back") cannot occur here. The
actual hazard is the opposite and simpler: if a session runs past the window, the next
provider request fails with a context-length error, losing the turn.

The threshold therefore still matters, and the invariant is unchanged — handoff must
fire before `contextWindow - reserveTokens` — but it is now enforced in code rather than
trusted:

- `ContextBudget` throws `HandoffThresholdError` at construction if the configured
  threshold does not leave `reserveTokens` of headroom. A misconfiguration fails at
  startup, not at hour six.
- `caterpillar_context_overrun_total` counts sessions ending past the safe point. **Must stay
  zero**; non-zero means the trigger fired too late.

Token accounting reuses pi's own `estimateContextTokens`, so our numbers agree with the
library's rather than drifting from a parallel implementation. Note that context size
must include `cacheRead` + `cacheWrite`, not just `input` + `output` — with prompt
caching, `input` alone badly undercounts.

### 6.2 Crash recovery

A pod killed mid-session leaves a lease that goes stale and a possibly dirty worktree.
On reclaim, the new session:

1. Commits any uncommitted worktree changes to the task branch as `wip: recovered from
   interrupted session`, rather than discarding them.
2. Appends a journal entry recording the interruption.
3. Replays context from `spec.md` + `journal.md` + `handoff.md`.

The last session's transcript may be missing or truncated — that is acceptable, because
the journal, not the transcript, is the source of truth.

---

## 7. Human interaction

The agent calls `ask_human(question, options?)`. The supervisor then:

1. Writes `questions/NNN-question.md`.
2. Sets `status = awaiting-human`, **releases the lease**, exits the session.
3. Posts to Discord with the task ID.

Nothing is running while you think. You reply:

```
!answer TASK-123 yes
!answer TASK-123 no --reason "use the existing migration path"
```

The bridge commits `questions/NNN-answer.md` and flips `status = ready`. The next poll
claims it into a fresh session that reads the answer from the task directory.

**How the bridge is built** (amended when it was): a Discord **gateway websocket, in the
supervisor process** — not the separate `discord-bridge` Deployment §10 anticipated, and
not a public interactions endpoint. §6 has runners polling outward precisely so a machine
behind NAT needs no inbound connectivity; an HTTP endpoint would have broken that for
every runner that is not this pod. A gateway connection is dialled OUT, so there is no
ingress, no TLS, and no URL to leak. Node ships a global WebSocket, so it costs no
dependency either.

The bridge does **not** touch the state repo. The poll loop owns that working copy, and
two git invocations interleaving in it is `index.lock` at best; a websocket handler
writing it concurrently would be a race with no owner. So a command is submitted to an
in-process inbox, the loop drains it *before claiming* — so a task unparked by an answer
is claimable on the same pass — and the submitter is told what actually happened. Silence
would leave a human unable to tell a typo from an offline bridge.

Answering also **resets `noProgressStreak`**. `awaiting-human` is only ever reached from a
session that produced no commit, so a task answered at the no-progress limit would park
again on the very next claim without ever running, and the answer would be silently
pointless.

Two things are required and neither is code: the **MESSAGE_CONTENT** privileged intent
(without it every message arrives with empty content and no command ever matches), and a
`channel-id`, because a bot that acts on any channel it can see is a bot anyone in the
guild can drive.

`!task` (§14 path 3) was never built, and is now superseded rather than pending: as
written it carried no acceptance criteria, and §14 refuses specs that have none.
`/brainstorm` (§14.3) is the answer — it does not skip the criteria, it produces them by
refining the idea with a human first.

Parking rather than idling matters here: an 8-hour wait costs nothing, and context is
rebuilt from the journal regardless.

### 7.1 Slash commands, buttons and modals

`!answer TASK-123 <text>` works, and it is the wrong shape for the thing it does. The task
id has to be copied out of a notification by hand, into a message where a typo is silent.
So the chat surface grew commands you pick and buttons you press. Four decisions carry it.

**Interactions arrive over the same gateway socket.** Discord delivers `INTERACTION_CREATE`
as an ordinary dispatch as long as the application has **no Interactions Endpoint URL** —
the two delivery methods are mutually exclusive, and this application has never had one.
That is not a convenience, it is the whole reason buttons are possible here at all: an
endpoint would have meant ingress, TLS and a public URL for every runner, which is exactly
what §7 refused when it chose a websocket over the `discord-bridge` Deployment §10
anticipated.

**A question is split, never truncated.** Discord caps a message at 2000 code points and
§11.2 fitted prose inside that by clipping it. That is right for a park reason — one cut
short still says a task parked — and wrong for the one payload a human has to act on. The
first real question to exceed the limit was 3785 code points, offered four options, and
arrived cut in the middle of option A; B, C and D were never sent, and the Answer button
sat under a question nobody could answer. Questions now span as many messages as they
need, split on line boundaries, with the button on the LAST one — on the first it would
invite an answer to the half that fitted. Six parts is the ceiling, after which the
message says how many remain and where to read them, because dropping the rest silently
is the same failure again.

**Acknowledge in 3 seconds, deliver the outcome separately.** Discord gives an interaction
three seconds to be answered and then keeps its token alive for fifteen minutes. The
supervisor settles a request when its poll loop next comes round, which may be several
hours into a session. The natural design — defer, then follow up on the interaction token —
therefore works in testing and fails the first time a session runs long. So a click is
acknowledged immediately with what is knowable at click time, and the real outcome arrives
afterwards as an ordinary channel message from the bot.

Reads never take that path at all. `/tasks`, `/task` and autocomplete are served from an
in-memory snapshot the loop refreshes once per poll, from the same sweep that decides what
to claim. Going through the inbox for a listing would mean waiting on a session to finish
before being told what it is doing.

**Buttons can only come from the bot.** Discord refuses interactive components from a
webhook the application does not own, and `webhook-url` is a webhook created in the
channel's settings. A question notification with an Answer button on it is therefore not
something the outbound half of §11.2 can send. Notifications now go out as the **bot**
wherever a bot token exists, and fall back to the webhook — with the typed `!answer`
instruction instead of a button — where it does not. The gateway's existing rule that
`author.bot` messages are ignored was written to stop the bridge answering the webhook's
own `!answer` hint; it now carries the bot's own output too, and is load-bearing twice.

**A fenced code block is atomic.** Splitting one leaves the first message with an
unterminated fence — Discord renders its whole tail as code — and the second opening a
block nothing meant to start, so every message after it is formatted wrong. A block that
does not fit in the remaining room moves whole to the next message. Only a block too big
for ANY message is split, and then each piece closes its own fence and the next reopens it
carrying the language, so the pieces are independently well-formed. A fence the agent
forgot to close is closed on the way out, because generated prose drops one occasionally
and a single missing line would otherwise format the rest as code.

**In a task's own thread there is no command language.** Every message is the answer,
verbatim — no `!answer`, no id, and a leading `!answer` is stripped rather than obeyed
because people type it out of habit. Requiring the prefix was friction in the one place
this set out to remove it (refining an idea is many short replies) and it made a plausible
first word into a task id: `!answer we want B` was read as an answer to a task called
`we`. Answering a *different* task from inside a thread is not lost — `/answer` takes an
explicit id, with autocomplete, from anywhere.

Two things follow. A question posted into a thread carries **no Answer button**: the
button spares a human retyping an id in a busy channel, and in the thread there is no id
to retype. And ordinary chat while the agent is working is answered with **silence**
rather than "not waiting on an answer", which would turn a conversation into a wall of
refusals.

**A cancelled task's thread is closed, and stops being listened to.** `/cancel` parks the
task, says so in the thread, and archives it. The binding rule is what makes that safe:
only a NON-TERMINAL task's thread is bound, so a finished conversation cannot keep
accepting messages — and since a message in a bound thread is now an answer, leaving one
bound means an abandoned thread silently swallows everything typed into it. Several tasks
can share a thread (a plan's children inherit their brainstorm's), so a parent going
`done` does not close the thread its children still talk in, and when more than one is
live the task AWAITING an answer owns it. Nothing is deleted: parking stops the work, and
the journal is the audit trail.

**The typing indicator is what says the agent is alive.** Handoffs are deliberately not
notified (§11), so between a question and its answer the channel is silent and a task
thinking for forty minutes looks exactly like one that has died. While a session runs for
a task with a thread, the bot types in it — one request every eight seconds, best-effort,
never a reason for anything to fail. Not in the main channel: the runner always has
something in flight there, and a signal that is always on carries no information.

**A click disables the buttons it was made with.** The acknowledgement rewrites the message
the button sits on, with every button on it disabled. That is what makes a second click
harmless, and it matters most for the one button that merges. A `custom_id` is capped at
100 characters and is the only thing a button carries, so it is versioned (`c1:…`) and
encoding **fails** rather than truncates: a clipped task id is still a valid-looking task
id addressing a different task. A button from an older deploy is refused rather than
guessed at — Discord keeps message history forever, and every button in it outlives the
code that rendered it.

Commands are registered **per guild**, at deploy time, by `npm run discord:register`.
Guild registration takes effect instantly where global registration is
eventually-consistent, registration is a full replace so re-running it is a no-op, and it
is not done at boot because the supervisor restarts on every deploy and would otherwise
write the identical command set once per pod per rollout.

---

## 8. Machine handoff

Capability matching, not addressing. A runner claims only tasks whose `requires` is a
subset of its own declared capabilities.

```
pod      capabilities: [linux, k8s, net]
machine  capabilities: [linux, gpu, usb, human-present]
```

When the agent hits work it cannot do locally, it calls
`handoff(requires: ["gpu"], note: "needs CUDA for the benchmark")`. The supervisor
updates `requires`, sets `status = ready`, and releases the lease. The machine runner
claims it on its next poll, appends to the *same* journal, and hands back the same way.

Both runners share one narrative. The journal is the continuity, not the process.

### 8.1 Toolchains are provisioned, not matched

**A capability is a fact about a machine that cannot be provisioned** — a GPU, a USB
device, game files already on disk, a human in the room. A toolchain is the opposite. It
does not belong in `requires`, and this section records a decision that reverses an earlier
one.

The Dockerfile used to say that language toolchains "deliberately do NOT live here — that
is what capability-matched runners are for (§8)". That was a promise §8 could not keep. The
capability enum is closed, so `requires: [lua]` was refused at intake and no runner could
have advertised it; opening the enum would not have helped either, because a task requiring
a toolchain nobody had installed by hand would sit `ready` forever, claimable by nobody and
looking from outside exactly like a stuck scheduler. Encoding a solvable problem as a claim
predicate converts it into a deadlock.

So a task's environment is BUILT, by nix, at the start of every session:

```
1. `toolchain:` in the issue's agent block     explicit, wins
2. <repo>/flake.nix   devShell
3. <repo>/shell.nix
4. nothing                                     the runner's own environment
```

Most repos need no declaration. A repo that already describes a devShell for its human
contributors gives the agent the same environment its tests were written in, which is a
better answer than anything transcribed into a tracker issue — and it is versioned with the
code, so a toolchain change arrives as a diff rather than as a red gate.

**One capability is still added: `nix`** — "this runner can build a declared environment".
One, not one per language. An *explicit* declaration implies it at intake, so a runner
without nix never claims a task it could only park. A repo's own `flake.nix` does not imply
it, because the repo is not checked out when intake runs; there, a runner without nix
inherits its own environment, which is what every runner did before this existed.

**The environment is resolved once per session and given to all four spawn sites** — the
agent's bash tool, the review council, the plan maintainer and the acceptance gate. That is
the load-bearing part, and it fixed a bug that predates nix: the agent got pi's fallback
`sh -c` with the supervisor's environment while the verifier got a LOGIN `bash -lc` that
sourced `/etc/profile` and `~/.profile`. A toolchain reachable from a shell profile was
therefore visible to the gate and invisible to the agent that had to make it pass. The gate
is only a gate if it runs what the agent ran.

Consequences worth knowing before changing any of it:

- **`print-dev-env --json` is parsed, not sourced.** Sourcing would execute repo-authored
  shell in the supervisor's own process. The cost is that `shellHook` does not run, so a
  repo that builds its PATH inside a hook needs an explicit `packages` list instead.
- **The supervisor's own variables are re-asserted after the devShell has had its say.** A
  devShell is repo-authored and must not be able to move `CRED_HELPER`, `CONFIG_PATH` or
  `HOME`. Re-assertion rather than a denylist, because a denylist is a list of the things
  somebody already thought of.
- **`--profile` registers a GC root.** Without it a collection between two sessions of one
  task deletes the environment the second session was about to use.
- **The cache is keyed on `flake.lock` as well as the expression**, and it verifies that the
  store paths it remembers still exist. `nix flake update` changes no character of the
  expression and every version it resolves to; and `/nix` lives in the image rather than on
  the PVC, so a deploy replaces the store while `env.json` on the PVC survives it. An
  unverified hit would not fail loudly — it would hand the agent a PATH of directories that
  are gone, which looks exactly like the missing toolchain this set out to fix.
- **nixpkgs is pinned** for generated environments. An unattended agent picking up a silent
  bump produces a red acceptance run with no diff to explain it.
- **A toolchain that will not build parks the task**, naming nix's own error. Falling
  through to the inherited environment would hand the agent a shell missing the exact tool
  the task is about, and it would spend a session and a few dollars discovering that.

---

## 9. Credentials & security

### 9.1 Trust levels

```
GitHub App private key (PEM)  → SOPS secret, supervisor only
       ↓ signs JWT (≤10 min)
Installation token            → minted per task, 1h TTL, supervisor only
       ↓ credential helper / typed tool
Agent (the LLM loop)          → never sees either
```

Minted per task, scoped **narrower than the App itself**:

```jsonc
POST /app/installations/{id}/access_tokens
{
  "repositories": ["all-chat"],            // only repos named in spec.md
  "permissions": { "contents": "write", "pull_requests": "write" }
}
```

No admin, no workflow. `TASK-123` cannot touch `caesar-deployment` unless its spec
says so.

> **Correction — "no merging" is not a token property.** GitHub has no separate merge
> scope: `PUT /pulls/{n}/merge` is authorised by `pull_requests: write`, the same
> permission that opens PRs. An App that can open a PR can merge it. The §2 decision
> therefore cannot be enforced by the credential, and must be enforced by the repo:
>
> - a **ruleset / branch protection** on the default branch requiring a pull request
>   and **at least one approving review**
> - the App must NOT be on any bypass list
>
> GitHub blocks a PR's author from approving it, and the App is the author of its own
> PRs — so the approval must come from you. That is what actually stops a merge.
> Caterpillar additionally never calls the merge endpoint, but that is code
> discipline, not enforcement, and code discipline is not a security boundary.

**App setup notes.** Two form fields mislead at creation time:

- **Webhook → untick "Active".** Runners poll outward (§8); there is no inbound
  endpoint, and leaving it on means a permanently failing webhook plus an ingress we
  do not want.
- **Callback URL** is a required field but inert here. It only serves the
  *user-to-server* OAuth flow; we use *server-to-server* installation tokens, so
  nothing ever redirects there. Set `https://caterpillar.caes.ar/callback` and leave
  **"Request user authorization (OAuth) during installation"** and Device Flow off —
  those are what would make it live. Point it only at a domain we control, and never
  leave it as a dangling CNAME (a subdomain someone else can claim could receive an
  OAuth code).

Run `npm run verify:github-app` after installing — it confirms the JWT signs, prints
the installation id, and proves per-task repo scoping works, without printing a token.

### 9.2 Why the agent never holds the token

Session transcripts are committed to git. A token appearing in `argv`, in `.git/config`,
or in an environment dump becomes a token **committed to git history**. So:

- **Push** goes through a git credential helper — the token is never persisted.
- **PR creation** is a supervisor-implemented `open_pr()` tool. The agent calls a typed
  function; it never gets `gh` or a token in its environment.

The 1-hour expiry is invisible because the helper mints on demand. Exporting `GH_TOKEN`
once at session start is what would break mid-session.

> **How strong is this boundary, honestly?** The trust diagram above says the agent
> "never sees" the token. That holds against *accidental* exposure, which is the
> realistic failure mode here: nothing routine puts the token where a committed
> transcript can capture it.
>
> It does **not** hold against a deliberately adversarial agent. The agent has `bash`
> in the same container as the supervisor, so it could invoke the credential helper
> itself. Process-level separation inside one container cannot prevent that.
>
> What holds unconditionally is the blast radius: 1-hour TTL, one repo, no merge, no
> admin. Treat the helper as leak *hygiene* and the token scope as the actual security
> boundary. Hardening the first property requires splitting the agent out of the
> supervisor's trust domain — see §15.

### 9.3 The state repo is not agent-writable

Task tokens are scoped only to repos named in the spec, and the state repo is never one
of them. The supervisor owns all state writes with its own credential.

**The audit trail cannot be rewritten by the thing being audited.**

### 9.4 Multiple forges (GitHub + Codeberg)

Some repos live on Codeberg (Forgejo). The credential boundary is unchanged — only the
token *source* differs, behind one interface:

```ts
interface ForgeCredentials {
  /** git credential helper response — never persisted, never in argv */
  credentials(repo: RepoRef): Promise<{ username: string; password: string }>;
  openPr(repo: RepoRef, pr: PrRequest): Promise<PrResult>;
  checkRuns(repo: RepoRef, ref: string): Promise<CheckStatus>;
}
```

Two implementations, `GitHubAppForge` and `ForgejoForge`, selected by the repo's host. The
agent's `open_pr()` tool and the credential helper are **identical either way** — the agent
never learns which forge it is on, let alone the token.

**Codeberg specifics.** Codeberg runs Forgejo `16.0.0-dev` (checked 2026-08-13), which is
past v15.0, so **repository-scoped access tokens are available**:

- Permitted scopes for repo-scoped tokens: `read:repository`, `write:repository`,
  `read:issue`, `write:issue`. Nothing else is allowed on a repo-scoped token.
- `write:repository` covers pull requests — the `repository` scope is documented as
  "repository files, pull requests, and releases". No separate PR permission needed.
- Repo-scoped tokens cannot transfer the repo, add collaborators, or change visibility,
  and can only *reduce* the owner's permissions, never elevate them.

**The gap: Forgejo tokens have no expiry.** There is no installation-token equivalent, and
`POST /users/{u}/tokens` requires basic auth — so on-demand minting would mean storing the
account password, which is strictly worse than storing a scoped token.

**And per-repo scoping does not fit the actual workflow.** `electric-boogaloo` is worked
as *one workspace repo with the others cloned inside it* — it is a single ecosystem, and
essentially no task touches only one repo. A per-repo token would have to be reassembled
for every task, for no benefit. So:

- One **owner-wide token** per Codeberg owner, `write:repository` + `write:issue`.
- Optional per-repo overrides for anything that warrants a tighter credential; they are
  checked before the owner-wide token.
- Stored SOPS-encrypted as `tokens.json`:
  ```jsonc
  { "owners": { "ElectricBoogaloo": "<token>" },
    "repos":  { "ElectricBoogaloo/sensitive": "<narrower token>" } }
  ```
- **Rotation is a scheduled chore, not a free property** — calendar or CronJob, and alert
  if a token predates the rotation window.

> **Honest consequence.** On GitHub the token's blast radius is one repo for one hour. On
> Codeberg it is **every repo of that owner, indefinitely**. The scope boundary there is
> `spec.repos` — enforced by `assertInScope` before any request — not the credential. That
> is a weaker guarantee, and it is a deliberate trade for a workflow where multi-repo tasks
> are the norm rather than the exception.

### 9.4.1 Multi-repo checkout

Because tasks span the ecosystem, `spec.repos[0]` is the **workspace repo** and becomes
the agent's working directory; the rest are checked out beneath it as `repos/<name>`,
each its own worktree on `agent/<task>`.

`repos/` is added to the workspace's **local** exclude (`$GIT_COMMON_DIR/info/exclude`)
rather than trusting the repo's `.gitignore`, so a sibling repository can never be
committed into the workspace even in a repo that has not thought to ignore it.

> Note `--git-common-dir`, not `--git-dir`: in a linked worktree the latter returns the
> worktree-private directory, and git reads `info/exclude` only from the common one. The
> pattern therefore applies to every worktree of that mirror, which is the intent.

> Prior art: `../electric-boogaloo-workspace/scripts/cb-api.sh` solves this for a *shell*
> agent — it sources `.env` in-process and feeds the header through a process-substituted
> `--config` file so the token never reaches `argv`/`ps`. The supervisor does not need that
> trick, because a TypeScript HTTP client sets the header directly and argv is never
> involved. The *principle* is the same and already encoded in §9.2: the agent never holds
> the token. Do not ship `cb-api.sh` into the agent's toolset — expose `open_pr()` instead.

### 9.5 Task tracker credential (Vikunja)

Everything in `electric-boogaloo` is tracked in Vikunja at `https://tasks.eb.bims.sh`
(cluster ns `vikunja`, Authelia-OIDC for humans). Agents authenticate with a personal
**API token**, `Authorization: Bearer`.

Vikunja tokens are **scoped per route**, ticked at creation in Settings → API Tokens. That
maps directly onto the least-privilege posture used everywhere else, so create a *dedicated
agent token* rather than reusing a human one:

| Scope | Grant | Why |
|---|---|---|
| `projects: read` | ✅ | discover work |
| `tasks: read` | ✅ | read the work item |
| `tasks: update` | ✅ | progress percent, description |
| `comments: create` | ✅ | post progress + PR links |
| `labels: read`, `tasksLabels: create` | ✅ | mark `agent-wip` etc. |
| `tasks: delete` | ❌ | never destroy work items |
| anything admin | ❌ | |

**Known API-token traps** (encode these, they cost hours otherwise):

- Some routes are session/JWT-only and unreachable by *any* API token — notably
  `GET /user` and `GET /tasks/all`. Verify auth against `/projects` instead, and aggregate
  tasks per project rather than globally.
- A `401 invalid token` on an otherwise-valid call almost always means **the token lacks
  that route's scope**, not that the token is bad. Re-grant in the UI; do not debug the
  token. The supervisor should surface this distinctly so the agent never "fixes" a scope
  problem by retrying.
- Descriptions and comments are **HTML fragments**, not markdown — the editor is TipTap.
  A `**bold**` progress note renders as literal asterisks, so supervisor prose is escaped
  and wrapped in `<p>` on the way out, and stripped back to text on the way in (an
  intake spec built from tag soup is noise for the agent).
- Label *removal* has to go through the bulk endpoint: the per-label `DELETE` needs
  `tasksLabels: delete`, which is deliberately not granted — the agent's credential must
  not be able to strip a label a human applied.

**The agent does not get to close tasks.** The supervisor owns tracker state transitions:

```
claim         → comment "picked up by <runner>", label agent-wip, UNLABEL needs-human
handoff       → (silent — no comment, or the task becomes a wall of noise)
ask_human     → comment with the question, label needs-human (agent-wip stays — the
                task is still owned, just blocked)
done          → only after §12 gates pass: comment with PR link, unlabel agent-wip
                and needs-human, mark done
parked        → comment with the reason, remove agent-wip
```

`needs-human` is cleared on claim and on done (**amended** after the first
intake-sourced task finished `done`, closed, and still wearing it). A claim is the only
exit from `awaiting-human`, so reaching one means the question was answered; the label
is how a human *filters* for items wanting them, and one that outlives its question
fills that list with work already back in progress. It is deliberately NOT cleared on
`parked`: a parked task genuinely does want a human.

The agent gets one narrow tool, `task_note(text)`, which appends a comment. It **cannot**
mark a task done — for the same reason it cannot self-declare success in §12: done is
determined by acceptance criteria and CI, verified independently. Granting the agent
`tasks: update` on the `done` field would route around that gate.

> Prior art: `../electric-boogaloo-workspace/scripts/vikunja.py` — same discipline as
> `cb-api.sh`, token read in-process from `.env`, header-only, never argv. In the cluster
> the `.env` becomes a SOPS secret; the discipline is unchanged.

### 9.6 LLM credential

Two modes, selected by `llm.auth`. **Amended after implementation** — the original text
assumed the proxy was the only path.

**`subscription` (what the cluster runs).** pi-ai's Anthropic provider ships an OAuth
mode — `"Anthropic (Claude Pro/Max)"`, `isSubscription: true` — with the PKCE flow and
token refresh built in. The runner uses a Claude subscription rather than metered API
billing. Consequences, all load-bearing:

- **There is no proxy in this path.** An OAuth bearer credential cannot be forwarded by
  something that authenticates with `x-api-key`, so the runner talks to
  `api.anthropic.com` directly and the spend-cap choke point below does not exist. On a
  subscription the cap *is* the subscription.
- **The credential must live on writable, durable storage.** Refreshing **rotates the
  refresh token**, and pi performs that inside `CredentialStore.modify`. A mounted
  Kubernetes Secret is read-only, so putting it there locks the runner out about an hour
  after start. It lives on the PVC, seeded once from `npm run llm:login` on a machine
  with a browser — a pod has nowhere to open one.
- **`modify` must serialize across processes.** Two sessions refreshing at once would
  both read the same token and both write; the loser persists one the provider has
  already invalidated. `FileCredentialStore` takes a lock directory for this.
- **Rate limits are per-account** and shared with the operator's own interactive usage.

**`proxy` (retained).** All runners point at an in-cluster proxy holding the provider
credential. Its value is not "easy provider swap" (pi-ai already gives that) but:

- The off-cluster machine runner never stores a Claude credential.
- One choke point for the global spend cap and per-task cost metrics.

The modes are not exclusive at runtime: pi resolves *a stored credential owns the
provider; ambient env is consulted only when nothing is stored*, so a subscription runner
can keep an API key in its environment as an automatic fallback. The cluster deliberately
does not — there is no Anthropic key anywhere in `caesar-deployment`.

Swapping to a private provider later remains a config change.

---

## 10. Kubernetes

Deployed via ArgoCD from `caesar-deployment`, following the existing conventions:

- `apps/workloads/caterpillar/` — manifests + `kustomization.yaml`
- `argocd/apps/caterpillar.yaml` — Application, sync wave 4
- Secrets SOPS-encrypted with age, as everywhere else in that repo

| Object | Purpose |
|---|---|
| `Deployment` | supervisor, 1 replica, `Recreate` strategy |
| `PVC` | git mirrors + worktrees |
| `Secret` (SOPS) | GitHub App PEM, Discord webhook, proxy token |
| `ConfigMap` | capabilities, thresholds, repo allowlist |
| `Deployment` | llm-proxy |
| `Deployment` | discord-bridge |
| `ServiceMonitor` | scrape supervisor `/metrics` |
| `PrometheusRule` | alerts below |

`Recreate` rather than `RollingUpdate`: two supervisors briefly overlapping is safe
(leases handle it) but pointless, and it avoids PVC `ReadWriteOnce` contention.

---

## 11. Observability

Discord stays a signal channel — questions, parks, terminal outcomes. Everything else
goes to Grafana.

Three channels, and they answer different questions. Keeping them apart is deliberate:

| Channel | Answers | Retention |
|---|---|---|
| Metrics | "is the fleet healthy" — rates, totals, queue depth | Prometheus |
| **Logs** | "what is this runner doing, and why did that task park" | Loki |
| Journal (`journal.md`) | "what did the AGENT do and decide" — handoff continuity | git, forever |

**Logs** (amended after the first in-cluster run)

Originally there were only metrics and the journal. Both are aggregates, and the first
task to run in-cluster completed with `kubectl logs` empty end to end — the only writes
to the process streams were on error paths a healthy run never reaches. A successful run
and a wedged one were indistinguishable from outside.

One JSON object per line on **stdout**, which is what the cluster already ingests from
container output. No agent, no sidecar, no format to teach it.

- `ts`, `level`, `event` on every record; `event` is a dotted name (`task.claimed`,
  `session.end`, `progress.probe`) so a query can select a lifecycle stage without
  matching prose.
- Level from `log.level` in config, default `info`. `poll.idle` is `debug` precisely
  because at the default poll interval it is the noisiest line the supervisor could emit.
- **Never a credential.** Nothing redacts, so the rule lives at the call sites: log
  identifiers and outcomes, never a token or a header. `GitError` is safe by
  construction — §9.2 keeps tokens out of argv, so its message cannot carry one.
- **Never agent prose.** A question's text is agent-authored and can quote anything it
  read, so `task.awaiting-human` logs the question's index and leaves the text in git.

Logs are for the operator and are disposable; the journal is for the next session and is
not. That is why a park writes both — a `warn` record so a human sees it now, and a
journal entry so the next session sees it at all.

**Metrics**

| Metric | Type | Notes |
|---|---|---|
| `caterpillar_task_status{task,status}` | gauge | queue depth by state |
| `caterpillar_sessions_total{task}` | counter | handoff frequency |
| `caterpillar_tokens_total{task,kind}` | counter | from pi `usage` |
| `caterpillar_cost_usd_total{task}` | counter | from pi `usage.cost` |
| `caterpillar_handoffs_total{task,reason}` | counter | handoff/park/blocked/limit |
| `caterpillar_lease_age_seconds{task}` | gauge | detects wedged runners |
| `caterpillar_no_progress_streak{task}` | gauge | thrash detector |
| `caterpillar_context_overrun_total` | counter | **should always be 0** — see §6.1 |

**Alerts**

- `caterpillar_context_overrun_total > 0` — handoff threshold fired too late
- `caterpillar_no_progress_streak >= 3` — task is thrashing
- `caterpillar_lease_age_seconds > 600` with no heartbeat — dead runner
- task in `awaiting-human` > 24h — you forgot
- `caterpillar_cost_usd_total` over per-task budget

### 11.1 No-progress detector

A session made progress if it produced **any** of: a commit on the task branch, a newly
passing acceptance command, or a journal entry marking a completed step. Three consecutive
sessions with none → park and notify.

This is the limit that catches the failure the others miss: an agent burning tokens for
hours while going in circles.

**A commit is proven per-session, against a baseline.** The baseline is the branch head
recorded at the end of the previous session, and on a FIRST session — where no such head
exists — the point the task branch forked from. Both halves are load-bearing:

- Without the fork-point fallback the commit that *starts* the work can never be proven.
  The first in-cluster task finished with a two-session no-progress streak while its PR
  sat open, and one more session would have parked it citing "no commit" with a commit on
  the branch.
- Comparing against the fork point *forever* would be worse: every session after the
  first commit would look productive, and an agent that commits once and then spins would
  never trip the detector at all.

The fork point is resolved locally (`merge-base` against the mirror's default branch),
because the probe runs after `clearActive()` where the credential service refuses to
answer by design (§9.2) and anything touching the network fails.

### 11.2 The Discord webhook

**Amended when the notifier stopped being a stub.** §10 lists a `discord-bridge`
Deployment. The OUTBOUND half does not need one and no longer has one: posting a message
is one HTTPS request the supervisor can make itself, and a separate process would need
its own copy of the webhook secret to add nothing. The INBOUND half (§7) needed a gateway session or a
public interactions endpoint — this section predicted it would therefore become that
Deployment. **It did not.** A gateway websocket is dialled outward, so it runs in the
supervisor process next to the outbound half, with no ingress and no second copy of the
secret. See §7.

Four rules, each one a way a notification is silently *lost* rather than loudly broken:

- **Mentions are suppressed explicitly** (`allowed_mentions: {parse: []}`). Discord parses
  them by default and the prose is agent-authored — it quotes files the agent read, so an
  `@everyone` in a repo pages the whole server the first time the agent asks a question.
- **Prose is truncated inside the frame, not at the end of the message.** Over 2000 code
  points Discord answers 400 and the message never appears, which turns a long question
  into no question at all. Clipping the assembled string instead would take the reply
  instruction with it — the one part telling a human what to do next. The full text is in
  git either way (§7).
- **429 and 5xx are retried, bounded, with the wait capped.** A webhook is rate limited
  per webhook, so two tasks finishing together is enough to hit one, and dropping a park
  defeats the channel. But `notify` is awaited inside the task loop: an obediently
  honoured `retry_after: 3600` would stop the runner working on anything. Past the cap,
  losing a signal message is the cheaper failure. A 404 — a webhook deleted in the UI —
  is permanent and is not retried at all.
- **Delivery never fails a task.** Same rule as tracker mirroring (§9.5), for the same
  reason: git is authoritative and Discord is a view. A throw here unwound into the
  supervisor's session-error path and parked a task that had just been verified and pushed
  as `done` — the notification rewriting the state it exists to announce. It logs
  `notify.failed` and continues.

The webhook URL's last path segment is the credential, so it is never included in a
thrown error: the supervisor logs those verbatim.

---

## 12. Definition of done

Two independent gates, both required:

1. **Acceptance criteria** declared in `spec.md` as commands that must exit 0. The
   **supervisor** runs them, not the agent — the agent cannot grade its own homework.
   ```yaml
   acceptance:
     - npm run check
     - npm test
   ```
2. **PR open and CI green.**

Only then `status = done`, Discord gets the terminal message, and the supervisor closes the
tracker item (§9.5). The agent participates in none of these three steps — it can only
*claim* completion, which triggers verification.

### 12.1 The review council

A third gate, after those two and never instead of them. Both of the first pair measure
*outcomes* — commands exit 0, CI is green — and neither of them reads the change. A change
can satisfy both and still be wrong in ways only reading catches: the test that was
weakened to pass, the error path that swallows, the half of the goal that was quietly not
implemented.

**Three reviewers, three different lenses** — correctness, design and simplicity,
acceptance fit — run concurrently in the task's existing worktree. Different rather than
redundant: three runs of one prompt catch variance, but only a different lens catches a
failure mode the first one is blind to. Their tool surface is `read`, `bash` and
`submit_verdict`: no `write`, no `edit`, and none of the implementation agent's control
verbs. A reviewer cannot open a PR, claim completion, ask a human, or hand off.

**Any blocking objection sends the work back.** Not a majority. Two reviewers who did not
look at the thing a third found are not evidence against it. The cost of that rule is paid
on the other side: a blocking objection is expensive — it costs the task a whole session —
so the lenses are told at length when *not* to raise one, and a preference is recorded as
a non-blocking comment that merges anyway.

**An abstention is never an approval.** A reviewer whose session errors or runs out of
context has agreed to nothing, and a council where every reviewer abstained requests
changes rather than passing. This is the one failure mode that would otherwise merge a
change nobody read.

**The round cap is what terminates it.** A rejected change goes back to the *same*
implementation agent, which fixes it and claims done again, which convenes the council
again. Without a ceiling the two can trade a task until the session limit, which from
outside is indistinguishable from a task that is working. At `limits.maxReviewRounds`
(default 3) the task parks and Discord says so.

**Merging needs a second identity.** §9.1 established that "no merging" cannot be a token
property, and that what actually stops an unreviewed merge is branch protection requiring
an approving review the App cannot give its own PR. That constraint is unchanged — so the
council does not merge as the App that opened the PR. A **separate GitHub App**, in its own
secret (`<secretRef>-reviewer`), installed on the same repositories, posts the approving
review and then merges. GitHub counts an installation token's review towards a required
approval, which is exactly why the identity has to be a different one.

Without that second App the council still runs and still records verdicts, and a passing
task is `done` with its PR open for a human to merge — the behaviour that existed before.
That degradation is deliberate, and it is also why the `Merge anyway` button on a stalled
review only appears when a reviewer identity exists: from the authoring App the merge would
be refused by branch protection every time, and a button that always fails is worse than no
button.

Verdicts are written to `tasks/<id>/reviews/NNN-verdict.md`, numbered by session and never
overwritten, and appended to the journal — the journal is what the next session actually
reads, so a rejection has to arrive there as instructions rather than as a score.

---

## 13. Agent tools

| Tool | Provider | Notes |
|---|---|---|
| `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | pi built-ins | |
| `open_pr`, `ask_human`, `handoff`, `done` | supervisor | control-plane verbs, typed |
| web search / fetch | supervisor | fewer human round-trips on unfamiliar libs |
| Grafana / Jira / Atlassian | MCP | verify impact, pull requirements |
| `kubectl` (read-only) | supervisor | logs, pods, events — no writes |

The control-plane verbs being *tools* rather than parsed prose is load-bearing: every
state transition is typed and auditable.

---

## 14. Task intake

Four paths, all converging on a `spec.md`:

1. **GitHub issue** labelled `agent` → ingester renders a spec. (`caesar`)
2. **Vikunja task** labelled `agent` → ingester renders a spec. (`electric-boogaloo`)
3. **Discord** `/brainstorm` → refine into a plan → child tasks (§14.3). Fastest, works
   from a phone, and the only path that produces acceptance criteria by asking for them.
4. **Hand-committed** `tasks/TASK-x/spec.md` (most control over acceptance criteria).

Tracker-sourced specs keep a back-reference (`tracker: {type, id}`) so the supervisor can
mirror lifecycle transitions back per §9.5. The state repo remains the source of truth —
the tracker is a *view*, never authoritative. If they disagree, git wins.

A spec without machine-checkable acceptance criteria should be rejected at intake — it
cannot satisfy §12, so it can never be marked done.

### 14.3 Brainstorms, plans and waves

Path 3 — `!task <repo> <goal>` — was never built, for a reason §7 records: as written it
carries no acceptance criteria, and §14 refuses specs that have none. `/brainstorm` is the
answer to that. It does not skip the criteria; it produces them, by refining the idea with
a human first.

```
/brainstorm topic:… repo:…
   → thread opens, brainstorm task created
   → agent reads the repo, asks one question at a time via ask_human
   → submit_plan
   → review council (plan lenses)
        ↘ changes → back to the same session
        ↘ pass    → child tasks, tagged wave + blockedBy
```

**A brainstorm is a task kind, not a special case.** `kind: brainstorm` in the spec. It
gets the same lease, the same journal, the same park-and-resume cycle. Two things differ:
its tools are `read`, `bash`, `ask_human`, `handoff` and `submit_plan` — no `write`, no
`edit`, no `open_pr`, no `done` — and it is the **only** kind permitted to declare no
acceptance criteria, because its gate is the council's verdict on its plan rather than
§12's commands. That exception is narrow and deliberate; everything else still refuses.

**Its id is its Discord thread id** (`BS-<threadId>`). Unique without coordination,
collision-free across runners, and its own reverse index: a message in a thread resolves
to a task without a lookup table. The same discipline `taskIdFor` applies to a tracker
ref — derived from something external and immutable, never from a title.

**Refinement is one question at a time.** `ask_human` already parks the task and releases
the lease, so a question costs nothing while a human thinks. That makes the expensive
thing not the round trip but the batch: six questions at once get one answer covering two.

**The agent proposes the decomposition, the supervisor performs it.** `submit_plan` carries
local ids; real `TaskId`s are assigned by the supervisor, for the same reason it assigns
everything else — a task id is a directory in the state repo, and the thing being audited
does not name the audit trail. Validation happens there too: a cycle, a missing acceptance
criterion, an unknown capability and an unresolvable dependency are all *rejected plans*
returned to the agent, not crashes.

**`blockedBy` is the authority; `wave` is derived from it** by longest-path layering. A
task blocked by something in wave 0 and something in wave 2 is in wave 3 — the shortest
path would put it in 1, alongside a dependency that has not run. Claiming filters on
`blockedBy` directly (`isClaimable`) and orders by `(wave, id)`; the wave is a scheduling
hint and a readable label, never the constraint itself.

**Waves describe what MAY run concurrently, not what does.** One runner still works one
task at a time (§6). Actual parallelism comes from scaling the Deployment, which git-ref
leasing already makes safe (§5). A wave of four on a single replica is four sequential
tasks in a defined order — worth having, but not parallel until there are replicas.

**A plan is a prediction, so it is re-checked.** When a task from a plan reaches `done`, a
short maintenance pass reads what it actually did and may move the edges between its
remaining siblings. It can do nothing else: creating a task means writing a goal and
acceptance criteria no human saw, which is a brainstorm's job with a council in front of
it. When the finished work implies genuinely new work it says so in a note and a human
runs `/brainstorm`. Every guard is in the supervisor, not the prompt — siblings of the same
plan only, never a task that has already started, and a revision that would introduce a
cycle is discarded whole rather than partially.

### 14.1 The `agent` block

What a human writes in the tracker item:

````
```agent
repos:
  - owner/name          # optional on GitHub — defaults to the issue's own repo
requires:               # optional, defaults to none, so any runner may claim
  - linux
acceptance:             # REQUIRED, at least one command that must exit 0
  - "npm test"
```
````

A fenced block rather than YAML front matter, because the body is not ours: GitHub renders
a leading `---` as a horizontal rule, and a Vikunja description arrives as HTML stripped
back to text (§9.5), where front matter does not survive as front matter.

The `agent` marker is accepted on the fence line **or** as the first line inside the
block, and every fenced block in the body is scanned rather than just the first — issue
bodies routinely open with a stack trace or a repro snippet. Both concessions are for
Vikunja: TipTap's code block carries a *language attribute*, not arbitrary fence text, so
```` ```agent ```` is simply not expressible there, and its `<pre><code>` markup has no
literal fences at all — `stripHtml` re-inserts them, or every item written with the
editor's code-block button would look right in the UI and be unparseable here.

The block is **removed** from the goal handed to the agent. Left in, it reads as a
checklist the agent may edit or reinterpret, and the acceptance commands are not its to
change (§12).

Parsing is strict in the same way `spec.md` parsing is: a non-string entry in `acceptance`
or `repos` is a refusal, never a silent filter. Intake must agree with `readSpec` — writing
a spec the store then refuses would create a task nothing can claim and nothing can
explain, which is worse than never creating it. An unknown `requires` capability is also a
refusal, because `requires` is the claim predicate (§8) and a typo makes the task
unclaimable by every runner while looking like a stuck scheduler.

### 14.2 Idempotency and refusals

Intake runs on a timer inside the supervisor loop, so both of its failure modes are
silent and unbounded.

**Duplicates.** The task id is derived from the tracker ref alone — `GH-<owner>-<repo>-<n>`,
`VK-<project>-<task>` — never from the title, which humans edit. An item whose task
already exists is skipped. Without this a fresh duplicate task appears every pass.

**Comment spam.** `listAgentItems()` filters on the ingest label alone, so a refused item
comes back every pass. A refusal is therefore recorded at `intake/<task-id>.json` with a
digest of the item's title and body, and the item is commented on only when that digest
changes. The record is durable and pushed rather than in-memory, because Keel rolls the
pod on every push to `main` and an in-memory set would re-comment on every deploy. Editing
the item re-opens it; a successful ingest clears the record.

**Interval.** Intake does *not* run on the poll interval. A GitHub pass costs one request
to enumerate the installation plus one per repo, and the live installation is account-wide
at 65 repos — ~66 requests a pass. At a 30s poll that is ~132 requests a minute against an
installation limit of 5000/hour (~83/min), which exhausts the budget within minutes and
takes the forge calls down with it. Default `intake.intervalSeconds` is 300, so the same
pass costs ~13/min. The clock is stamped *before* the pass, so a failing tracker waits out
the interval instead of being retried on every poll.

Ordering inside a single ingest is load-bearing: `state.json` is written first and
`spec.md` last, because `spec.md` is the existence marker. A crash between the two leaves
a task the claim loop skips and the next pass recreates cleanly; the reverse order would
wedge the item as permanently existing and never claimable.

---

## 15. Risks and open questions

**Transcript bloat.** A multi-hour task × 20 sessions of JSONL is megabytes of git
history. Mitigated by gzipping; if it still hurts, move `sessions/` to an orphan branch
or prune on `done`. **Revisit after the first real task.**

**pi API churn.** Packages are young, the npm scope already moved once, and the protocol
carries no compatibility guarantees. Pin exact versions; treat upgrades as code changes.

**No agent-level permissions.** A wrong `bash` call inside the container is unconstrained.
The container, the scoped token, and the absence of cluster write credentials are the
only boundaries. Do not mount a kubeconfig with write access.

**Git as a queue** is right at this scale (a handful of concurrent tasks). At hundreds it
would not be. The lease abstraction is deliberately narrow so it could move to Postgres
without touching the agent.

**Codeberg tokens do not expire.** The GitHub side gets 1-hour blast radius for free; the
Codeberg side does not, so a leaked repo-scoped token is valid until noticed and revoked.
Rotation must be scheduled and alerted on, and this asymmetry should be remembered when
reasoning about incident response. Codeberg also runs a rolling `-dev` build, so token
behaviour can shift between deploys — re-verify §9.4 if something starts failing.

**Vikunja tokens also have no expiry or per-project scoping** — scopes are per *route*,
not per project, so an agent token reaches every project the owning account can see. Same
mitigation as Codeberg: dedicated token, minimum scopes, scheduled rotation. If EB work
ever needs harder isolation, a dedicated Vikunja bot account limited to the EB projects is
the lever — the equivalent of the GitHub App's per-repo scoping.

**Clock skew** in steal-on-stale — see §5.1.

**Proxy is a single point of failure.** If it is down, every runner stalls. Acceptable
initially; it fails closed, which is the safe direction.

**Unresolved:** whether a task may spawn subtasks, and if so whether they get their own
lease and directory. Deferred until a real task needs it.

---

## 16. Toolchain constraints

**The source is erasable-syntax-only.** Added after the fact, when the workstation moved
to node 26.

Node runs this TypeScript by *erasing* types, never transforming them. Anything that
type-checks but emits runtime code — a parameter property, an `enum`, a namespace — loads
fine nowhere: it fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, per FILE, before a single
test in that file registers. So `constructor(private readonly x: T) {}` is out; declare
the field and assign it.

The alternative was `--experimental-transform-types`, which is what this repo used until
node 26 **removed** it. That flag was a dead end in both directions: the codebase could
not run on a current node, and pinning to node 22 to keep the flag meant a workstation
with a newer node could not run the tests at all — which is exactly what happened, and it
cost a session's worth of workarounds before anyone fixed the cause.

Three things hold the line, and all three are needed:

- `erasableSyntaxOnly` in `tsconfig.json` — turns the runtime failure into a compile
  error.
- `tsconfig.test.json` — the build excludes `*.test.ts`, so without this nothing type
  checks the tests, and a parameter property in a test file passes `npm run check` and
  then takes that file's whole suite down at runtime. That is not hypothetical; it is how
  the last two occurrences were found.
- A CI matrix over node 22 and 26 — the floor and what workstations actually have. The
  failure mode is asymmetric: a flag that exists on one version and not the other fails
  loudly on exactly one of them.

`engines.node` is `>=22.18` because 22.18 is the first release that strips types without
a flag. The container image is unaffected either way: it runs compiled JavaScript from
`dist/`, and never strips anything.

---

## 17. Artifacts

`artifacts/` has been in the §4.1 layout since the beginning and never had a meaning. It
gets one here, because capability matching created the need: once a task can run on the
machine with the game files (§8), its *conclusions* have to reach the tasks that follow it
on a different machine.

The first thing this design does is refuse most of the problem.

**Inputs never move.** A game install, a USB device, a display, a human — these are the
reason §8 exists. A task that needs them declares `requires`, and the agent runs where they
already are. Nothing is transferred, nothing is copied, and the question of how to move
forty gigabytes of extracted assets never arises because the answer is "don't".

**Only derived outputs travel**, and the useful ones are small: a manifest of which
sublevels contain what, a probe result, a verdict, a golden file, a log tail. Those go in
the state repo, in the directory §4.1 already reserved for them:

```
tasks/<TASK-ID>/artifacts/<name>
```

Written by a supervisor-mediated `publish_artifact`, because the agent cannot write the
state repo (§9.3) — the same reason `open_pr` is a tool. Capped at **1 MiB per artifact and
10 per task**, and the cap is the design rather than a safety net: every runner clones this
repo and pulls it on every poll, git history keeps whatever lands there forever, and §15
already worries about transcript bloat for exactly this reason. An agent that hits the cap
is told to summarise, which is almost always what was wanted.

**Artifacts flow along `blockedBy` edges.** A task's declared blockers are precisely its
upstream, so before a session starts the supervisor stages their artifacts where the agent
can read them, and says so in the prompt. No new tool to read one — `read` and `bash`
already work on a file. This reuses the dependency graph a plan already carries (§14.3),
which means the plan agent controls artifact flow by declaring dependencies, and there is
no second, parallel notion of "which task feeds which".

### 17.1 Large artifacts — designed, not built

A pak, an extracted asset tree, a `.usmap`: megabytes to gigabytes, and derived from a
commercial game, so **not redistributable**. That rules out a public release asset and
rules out anything the bytes of which end up in git.

The seam is a **pointer**. `publish_artifact` on something over the cap writes
`artifacts/<name>.json` instead of the bytes:

```json
{ "store": "minio", "bucket": "caterpillar", "key": "TASK-123/probe.pak",
  "sha256": "…", "bytes": 41234567, "at": "2026-08-14T12:00:00Z" }
```

Git keeps the pointer, so git stays authoritative about what exists and which task produced
it; the store keeps only bytes, and can be replaced without touching a task. Staging
verifies the `sha256` before handing a file to an agent — a store is a cache, and a cache
that can lie about its contents is worse than no cache.

The store would be **MinIO, the `pgsty/minio` community fork** — MinIO's own repository went
read-only and the console was stripped from the OSS line in May 2025; the fork keeps AGPL-3.0
with CVE backports. Private bucket, no public ingress: the dedicated machine already reaches
the cluster over wireguard for the LLM proxy (§3), and an artifact store belongs on that same
path rather than on the internet. One new secret (`caterpillar-artifacts`), and the agent
never holds it — uploads and downloads are supervisor-mediated exactly like the small path.

None of §17.1 is implemented. It is written down because the pointer format is the part that
has to be decided before anything depends on it, and because the honest answer to "where do
the game dumps go" is currently "nowhere, and they should not need to".
