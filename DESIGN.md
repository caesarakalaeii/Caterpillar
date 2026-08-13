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
│    Discord !task                → task spec                │
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

Parking rather than idling matters here: an 8-hour wait costs nothing, and context is
rebuilt from the journal regardless.

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
its own copy of the webhook secret to add nothing. A bridge is required only for the
INBOUND half (`!answer`, `!task` — §7, §14 path 3), which needs a gateway session or a
public interactions endpoint. When that is built it is a Deployment; the outbound path
stays where it is.

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
3. **Discord** `!task <repo> <goal>` → spec (fastest, works from a phone).
4. **Hand-committed** `tasks/TASK-x/spec.md` (most control over acceptance criteria).

Tracker-sourced specs keep a back-reference (`tracker: {type, id}`) so the supervisor can
mirror lifecycle transitions back per §9.5. The state repo remains the source of truth —
the tracker is a *view*, never authoritative. If they disagree, git wins.

A spec without machine-checkable acceptance criteria should be rejected at intake — it
cannot satisfy §12, so it can never be marked done.

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
