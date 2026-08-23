# Caterpillar — Design

A long-running autonomous coding agent that survives context exhaustion, pod restarts,
and machine boundaries. Deployed to a k3s cluster from a separate manifests repo, which
this document refers to throughout as `deployment`.

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
| K8s shape | **StatefulSet** of supervisor loops, `concurrency` tasks at a time per replica — default 1 (§6.5, §10) |
| Workspace | **Per-replica PVC** bare mirrors + one **git worktree** per task, reaped when the task ends |
| LLM access | All runners → **in-cluster credential holder**; the traffic is direct (§9.6) |
| Git credentials | **GitHub App**, supervisor-minted, scoped per task; repo-scoped tokens on Codeberg |
| Commit identity | The author App's **own bot account**, configured per deployment (§9.7) |
| Autonomy | Push branches, open/update PRs. **No merging. No cluster writes.** |
| Human channel | **Discord** — questions, parks, terminal outcomes only |
| Metrics | **Prometheus/Grafana** for everything else |
| Workspaces | Per-ecosystem profiles (`primary`, `oss`) — forge, tracker, creds |
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
│  supervisor (StatefulSet, N replicas)                      │
│    ├─ claim loop (git ref CAS)   ← the only coordination   │
│    ├─ pi Agent instances ← `concurrency` each, default 1   │
│    ├─ GitHub App token minting                             │
│    ├─ own /work + /nix volume    ← no RWX in this cluster  │
│    └─ /metrics                                             │
│         │                    │                             │
│         │ credential         │ substituter                 │
│         ▼                    ▼                             │
│  credential-holder      nix-cache (pull-through)           │
│    exactly 1 replica      exactly 1 replica                │
│    owns the ONLY copy     caches cache.nixos.org so N      │
│    of a token whose       stores are not N internet        │
│    refresh rotates it     fetches of one closure           │
│                                                            │
│  …runners talk to the provider DIRECTLY. An OAuth bearer   │
│    cannot be forwarded by an x-api-key proxy (§9.6), so    │
│    only the CREDENTIAL is centralised, never the traffic.  │
│                                                            │
│  discord-bridge                                            │
│    outbound: questions, parks, outcomes                    │
│    inbound:  !answer → commits answer to state repo        │
│                                                            │
│  redis (HA, its own namespace)       ← §21                 │
│    the EPHEMERAL plane, and only it:                       │
│    chat inbox, task snapshot,                              │
│    presence, cancel signals.                               │
│    Optional, off by default. No lease                      │
│    and no state is ever in it.                             │
│                                                            │
│  intake                                                    │
│    GitHub issues (label: agent) → task spec                │
│    Discord /brainstorm          → plan → task specs        │
└────────────────────────────────────────────────────────────┘
             ▲
             │ git (state repo)
             ▼
┌─ dedicated machine ───────────────────────────────────────┐
│  same supervisor binary                                    │
│  capabilities: [linux, gpu, usb, human-present]            │
│  its own credential file and its own nix store — it has    │
│  no holder and no cache to reach, and must keep working    │
└────────────────────────────────────────────────────────────┘
```

The supervisor binary is identical everywhere; only its declared capabilities differ.
Runners **poll outward**, so a machine behind NAT needs no inbound connectivity.

Two planes, and it is worth being blunt about which is which. **Git is authoritative** for
leases, task state, the journal and the audit trail; **Redis is ephemeral** and carries only
what has to cross a process boundary now that the Discord bot is its own pod. A runner with
no Redis is a supported deployment and is what the dedicated machine above actually is —
§21 argues the split, and why the leases in §5 are not on it.

---

### 3.1 Workspaces

Work is not one ecosystem. The deployment this was built for runs two that differ in forge,
task tracker and cluster, so a **workspace profile** is a first-class config object and
every task declares which one it belongs to.

The shape, with two profiles named `primary` and `oss` for illustration — the names are
arbitrary and mean only what an operator's config says they mean:

| | `primary` | `oss` |
|---|---|---|
| Forge | GitHub | Codeberg (any Forgejo host) |
| Forge credential | GitHub App, minted per task | repo-scoped Forgejo token |
| Task tracker | GitHub issues | **Vikunja**, self-hosted |
| Cluster | k3s via a manifests repo | a second cluster |

```jsonc
// workspaces.json — supervisor config, no secrets
{
  "oss": {
    "forge":   { "type": "forgejo", "host": "codeberg.org", "org": "acme" },
    "tracker": { "type": "vikunja", "base": "https://vikunja.example.com/api/v1" },
    "secretRef": "caterpillar-oss"       // SOPS secret with the tokens
  }
}
```

`spec.md` carries `workspace: oss`. The supervisor resolves forge and tracker
credentials from the profile; **a task in one workspace can never obtain another
workspace's credentials.** This is the same containment property as §9.1, one level up.

#### A mirror refresh never touches a branch a worktree holds

One bare mirror per repo serves every task on it, and each task's worktree checks out
`agent/<task>` — a local branch in that shared mirror. `clone --mirror` configures
`+refs/*:refs/*`, so a plain `fetch --prune` tries to write every remote ref onto the
identically-named local ref. The moment a task **pushes** its branch, the remote has it, and
the fetch targets a local head that a worktree holds:

```
fatal: refusing to fetch into branch 'refs/heads/agent/<task>' checked out at ...
```

git refuses the *whole* fetch, so one task pushing broke `syncMirror` for every later task
on that repo, permanently. Worktrees persist on the PVC after a session ends, so this was
not limited to tasks running concurrently — and it surfaced as `task.parked` two seconds
after a claim, which reads as a scheduler fault rather than a git one.

`^refs/heads/agent/*` was the first answer, and it is still half of it — but only the half
about *ownership*, not the half about the refusal. The mirror exists to supply upstream
history to create worktrees from; it never needs to fetch back a branch it pushed itself,
and excluding those refs also excludes them from `--prune`, so an agent branch whose remote
counterpart a merge deleted is not pruned out from under a worktree that may still be
resumed.

What that exclusion assumed is that the agent stays on the branch we created for it.
Nothing holds it there: the session drives git through its bash tool, and the PR tool takes
whatever `head` it is handed. An agent that renamed its work reproduced the failure exactly,
under a name the pattern could not match —

```
fatal: refusing to fetch into branch 'refs/heads/ci/govulncheck-go-1.25.13'
       checked out at '/work/tasks/<other task>/<repo>'
```

— and again it was the *next* two tasks on that repo that parked, naming a branch neither
had ever touched.

Rule: **the mirror fetches `+refs/*:refs/*`, minus `^refs/heads/agent/*`, minus one
exclusion per branch a worktree currently holds.** The held set comes from `git worktree
list --porcelain`, because that and the fetch's refusal read git's own worktree list, so the
exclusion cannot disagree with the check it exists to satisfy — a naming convention the
agent never agreed to can. The cost is that a held branch stops tracking upstream until its
worktree goes away; for `agent/<task>` that is the point, and for the default branch (an
agent that ran `git checkout main`) it means later tasks fork from a mirror that is behind,
which they resolve on their own PR. A stale base beats a repo whose every later task parks.

The refspecs are passed per invocation, not written into the mirror's config — that config
is only written on first clone, so every mirror already on a PVC would keep the old one, and
the held set changes with every worktree anyway.

#### An agent push can only ever move `agent/<task>`

The same shared config cuts the other way on push. `clone --mirror` also writes
`remote.origin.mirror = true`, and a linked worktree reads the mirror's config — so the
agent's own `git push`, typed into the bash tool from its worktree, was a **mirror push**:
every ref the mirror holds, forced, onto the remote. The mirror's `main` is only as fresh
as its last fetch, so with a sibling task pushing to the same repo the agent silently
rewound shared history:

```
+ 6a889c2...b0b1f47 main -> main (forced update)
```

The destroyed commit had never been fetched into any clone on the box, so no local reflog
could restore it. Worse, the flag also blocks the careful form — `git push -u origin
<branch>` fails with `--mirror can't be combined with refspecs` — so an agent trying to be
precise is pushed back towards the bare `git push` that does the damage.

Rule: **`configure` unsets `remote.origin.mirror` and sets `remote.origin.push = HEAD`.**
Unsetting alone is not enough — a bare `git push` would then fall through to `push.default`,
which is a usage error on an unconfigured branch and on a machine runner inherits whatever
the operator's global config says. `HEAD` pins it to *the current branch, to its own name
upstream, and nothing else*: an agent cannot move a branch it is not standing on, whatever
it types. Delivery to the default branch goes through the PR path (§12), never a push.

Unlike the fetch refspec above, this **is** written into the shared config — the rule is a
property of every task on the repo, not of one invocation — and because `configure` runs on
every worktree create *and* reuse, mirrors already on a PVC are healed the next time a task
touches them.

#### A session never starts behind `origin/agent/<task>`

The exclusion above is load-bearing and it has a cost that took two tasks to find. Because
the mirror never fetches `refs/heads/agent/*`, a mirror that does not already have a task's
branch will **never learn one from the remote**. `addWorktreeLocked` used to decide a task's
start point from that local ref alone, so every route to a missing or stale one — a runner
that never worked this task, a reaped worktree, a mirror re-cloned after a failed fetch, or
the branch reset GH-95 reported — looked identical to a task nobody had ever pushed, and the
session started on the base.

That is indistinguishable, to the agent, from a fresh task. On GH-96 sessions 2 and 3 pushed
eighteen commits; session 7 started on `main`, re-implemented the entire task, and found out
only when its push was refused as non-fast-forward. Two complete independent implementations
of one task reached the remote and a human had to pick one.

Rule: **if `origin/agent/<task>` exists, the session's worktree is at its tip or the session
does not start.** Starting silently behind it is the one outcome that is not available.
Both checkout paths enforce it:

- *Creating* a worktree fetches the remote branch into `refs/remotes/origin/agent/<task>` and
  starts there, fast-forwarding the local ref. A local ref that already *contains* the remote
  tip is the start point instead — a session killed between a commit and a push leaves the
  branch exactly there, routinely, and nothing on the remote is lost by resuming on it. Only
  a true divergence gets a throw, because nothing in the runner can choose between two
  histories: forcing would discard commits that exist nowhere else, and starting on the local
  ref is the drift the rule exists to stop.
- *Reusing* one runs `merge --ff-only` onto the remote tip, and only while HEAD is actually
  on `agent/<task>`. A worktree that is ahead is left alone — those commits exist nowhere
  else — and a divergence or a dirty tree makes the merge decline, which becomes the same
  refusal. A worktree an agent moved off its own branch is left alone too: merging the task
  branch into `main` would fast-forward the default branch, which `remote.origin.push = HEAD`
  would then make the agent's next push deliver.

The fetch names origin's **URL**, not the remote `origin`. A configured `+refs/*:refs/*` is
applied opportunistically alongside an explicit refspec, so fetching by remote name also
force-updates the local `refs/heads/agent/<task>` — reviving the refusal above and clobbering
a divergent local branch before anything could look at it. `^refs/heads/agent/<task>` does
not suppress that, because a negative refspec matches the *source* side and so cancels the
mapping we asked for too. With a URL there is no configured remote to apply.

**"The remote has no such branch" and "the remote could not be asked" are different
answers.** A fetch reports both as a plain non-zero, so code that decides existence from a
fetch tolerates a network fault exactly as much as it tolerates a first session — and one
expired credential then starts a session on the base with the pushed work upstream, which is
the same defect with every local ref correct. Existence is therefore settled by `git ls-remote
--exit-code`, which exits 2 for a ref the remote does not have and 128 for a remote it could
not read.

What an unreachable remote *means* is the caller's to say, because it differs by caller:

- The **agent session runner** holds the task's credential lease, so it passes
  `mustReachRemote` and gets a throw. The task parks through `parkFailed` with git's own
  message in its journal, where a human fixes a credential — instead of a session silently
  starting from scratch.
- The **progress probe, verifier, review council and plan maintainer** all check out the same
  task *after* `clearActive()` has closed the credential service (§9.2), where a fetch on a
  private repo cannot succeed. They keep the tolerant reading: a silent remote has nothing to
  say, and the checkout proceeds on what is on disk. Being strict there would take
  verification down on every private repo.

The flag is passed explicitly rather than inferred from the environment — say, from the task's
credential socket existing — so that the strictness is something one caller asks for in code a
reader can grep for, not a property that changes underneath it.

#### Worktrees are reaped, because they are what actually grows

A mirror is fetched incrementally and its size tracks the repository's history. A worktree
is a full checkout plus everything a session puts in it — `node_modules`, a `target/`, a
`.venv`, a build output tree — once per repo the task declares, and it lives at
`<tasksDir>/<TASK-ID>/<repo>` on a **20Gi ReadWriteOnce volume, per replica**. Nothing ever
removed one. The nix store next to it had a collector on a timer (§8.1); the directory that
grows per task had nothing at all, and `removeWorktree` existed with no caller outside its
own test.

So there are two removals, with different triggers, and the split is the whole design:

- **Targeted**, the moment a task reaches a state it will not resume from *in place*. The
  supervisor calls it on `done`, on `failed`, and when it loses the lease mid-session.
  It removes every repo's worktree — including the siblings at `<root>/repos/<name>`, which
  are worktrees of their **own** mirrors — then the `<tasksDir>/<TASK-ID>` directory
  wholesale, which git would never remove because git does not know it exists.
- **A periodic sweep** from the idle branch of the poll loop, next to
  `maybeCollectGarbage` and for the identical stated reason: only when this runner has no
  task in flight, because a collection racing a session is a risk with no upside and there
  is always another idle poll. It is the backstop for the case the targeted removal cannot
  cover — a pod killed mid-session, a node evicted, a roll landing between the merge and
  the removal — where the task moves to another replica and the directory here is orphaned
  with nothing that will ever name it again.

**What is deliberately NOT reaped is the more interesting half.** A handoff, and a park
awaiting a human, both resume against this very checkout: `ensureWorktree` reuses one
precisely so session N+1 does not pay for a clone and a dependency install. Reaping there
would trade a few gigabytes for both, on every handoff, which is the opposite of the trade
this is making. `failed` *is* reaped despite being resumable, and for a reason a park does
not share: a task fails because a session raised an error the supervisor could not
attribute, and the checkout that produced it is as likely to be the cause as the cure —
`/resume` re-creates it from the mirror and the branch on the remote, which is every byte
of the work and none of the wreckage.

Two properties are load-bearing and neither is obvious:

- **The live task set is passed in, never inferred.** Deleting the worktree of a session
  that is running right now is the worst thing this code can do — uncommitted work, index
  and resolved environment go at once, mid-turn, and what the agent reports afterwards is a
  git error about a directory that vanished. The supervisor knows which tasks the state
  repo considers unfinished; the workspace layer would have to guess from mtimes and lock
  files, and a guess is not a safety property.
- **Nothing outside `tasksDir` can be removed, and the check is on the resolved path.** Task
  ids arrive from directory names on a volume and from a state repo that intake writes, and
  `join(tasksDir, "..")` is the parent of every mirror on the PVC. One `..` reaching the
  delete unchecked would take the mirrors, the nix store's GC roots and the state checkout,
  on a timer, and log that it had reclaimed a lot of disk. The containment test uses
  `relative()` rather than a prefix comparison, because `/work/tasks-old` starts with
  `/work/tasks`.

Both removals finish with `git worktree prune` on the mirrors involved. That is not
tidiness: `rm -rf` leaves the mirror's `worktrees/<name>` administrative record behind, and
an unpruned record still **holds its branch** as far as `worktree list --porcelain` is
concerned — which is exactly what the fetch refspec above is derived from. A mirror that is
never pruned therefore accumulates one permanent exclusion per finished task and slowly
stops tracking upstream at all.

Configured as `workspace.reap.intervalHours` and `workspace.reap.keepHours`, mirroring
`toolchain.gcIntervalHours` / `gcKeepDays`, and shown next to them in the web view. The
keep-age is hours where the store's is days, because a store path is shared by every task
that resolved the same environment and a worktree belongs to exactly one; the default
comfortably outlives a weekend, which is the realistic gap between a task parking for a
human on Friday and being answered.

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
      amendments/
        001.yaml               # append-only: replaces `acceptance` only — see §12.3
      state.json               # mutable control record
      journal/                 # append-only: ONE FILE per entry — the audit trail
        0007-20260813T094100123Z-pod-7f3a.md
      journal.md               # legacy single-file journal: still read, never written
      handoff.md               # overwritten each handoff — the baton
      questions/
        001-question.md
        001-answer.md          # written by the Discord bridge
      sessions/
        001.jsonl.gz           # pi transcript, gzipped
      artifacts/
```

`spec.md` is written once and never edited — not by the agent and not by a human. The
only thing that can change afterwards is the acceptance list, and it changes by *adding*
a file rather than by editing that one (§12.3). The journal is append-only —
it is the audit trail. `handoff.md` is deliberately *overwritten*: it holds only what the
next session needs, so it cannot grow without bound.

**The journal is one file per entry, not one file appended to.** Append-only is the
invariant; a single file was never part of it, and it was the one place the state repo
broke the property everything else relies on. Runners touch disjoint `tasks/<id>/` paths,
so their histories commute and rebase — but two runners recording the *same* task both
appended to the last line of `journal.md`, and no rebase can ever apply that (§4.3). A
sharded journal has no such line: they write different files and both commits apply. No
amount of better rebasing achieves this; only the format does.

The name is `<zero-padded-session>-<iso-ish-timestamp>-<runner-id>.md`. It sorts
chronologically as a plain string, which is what `readJournal` concatenates on and what
the digest reads the window in; the session orders entries the way a reader expects, the
timestamp orders two entries of one session, and the runner id separates two runners that
managed both. A name already taken is suffixed rather than overwritten — an entry is never
rewritten, which is the invariant restated at the level of files.

Existing `journal.md` files are **read and never touched**. `StateStore.readJournal`
prepends the legacy file to the shards and hands back the same markdown the single file
always did, so a task that started before the change keeps rendering, keeps feeding
digests, and keeps resuming on its full history. Rewriting those files into shards would
put the unmergeable conflict straight back, this time in the migration.

**The journal is bounded on the way INTO a prompt, never on disk** (amended after
SMOKE-1). Append-only and unbounded-in-context are different properties, and only the
first one is wanted: the journal is the audit trail and git keeps it whole — every shard
of it — but every session was opening by paying for all of it. SMOKE-1 finished with a 347KB journal —
620 byte-identical park entries from a retry storm around two that said anything — so
any further session on that task would have started ~90k tokens down.

`journalForPrompt` renders a view: consecutive entries with identical bodies collapse
into one that states the repeat count, then the oldest entries are dropped until it fits
~5% of the context window, and what was dropped is declared in the text. Nothing is
deleted, and the cap scales with the window rather than being a fixed number that is a
rounding error on one model and a quarter of the budget on another.

The collapse is deliberately CONSECUTIVE-only: parking, working, then parking again for
the same reason is real history, and the second park means something the first does not.

**An entry states what the branch did, not only what the agent said it did.** A session
that commits and then dies — context exhaustion, a kill, a crash — never calls a
control-plane verb, so its summary is the one the supervisor fills in: "session ended
without a control-plane decision". On GH-96 that sentence was the entire entry for sessions
4 through 7, over a branch already carrying eighteen commits. Session 7 read that history,
concluded the task was untouched, and re-implemented all of it.

So `recordSession` adds `**Committed:** \`agent/<task>\` is at \`<tip>\`, was \`<baseline>\``
whenever the progress probe saw the branch move. It is built from the probe and from
`progress.lastHeadOid` in `state.json`, never from the summary — which is the point, because
the case that matters is the one where the agent said nothing.

It says *committed* and not *pushed*. Nothing in the supervisor pushes a task branch; the
agent does, and by the time the probe runs `clearActive()` has closed the credential service
(§9.2), so no network check is available. The local branch is what is provable and what the
next session on this runner starts from (§3.1). Naming the oid makes "is this on the remote?"
a question the reader answers with one `git rev-parse`, rather than one the journal answers
wrongly.

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

`pr` is the primary repo's pull request and `prs` is one per repo the task opened one in
(§9.4.1). Both are written together: every reader that only wants something to link to reads
`pr`, and the completion gates read `prs`.

**It is replaced by `rename`, not by `writeFile`.** `writeFile` truncates and then writes, and
the store's mutex orders WRITES against each other while doing nothing about reads — which for
this file are constant and mostly outside it: `survey` reads every task once per poll, the web
view renders from it, and `/task` answers from a snapshot built out of it. A reader landing in
that window gets `Unexpected end of JSON input`.

That is worse in the loop than an error would be, because `survey` wraps its read in a `catch`:
the task drops silently out of that pass's snapshot **and out of its thread bindings**, so a
listing goes briefly wrong and a message typed in that task's thread finds no binding to route
to. §7.1 already has an incident about a read being fast without being right; this is the same
failure arriving through the filesystem. A rename within one directory is atomic on POSIX, so a
reader sees the whole old file or the whole new one.

### 4.3 A local commit that can never merge is set aside, not retried

`pull` keeps unpushed commits by rebasing onto the remote rather than resetting over them —
it used to reset, and that destroyed five tasks' work. But a rebase can conflict, and a
conflict here is **unresolvable rather than transient**.

Throwing made that fatal to the runner rather than to the pull. `pollOnce` logs
`poll.failed` and tries again in thirty seconds, and the retry is the identical rebase. On
a four-replica fleet two runners sat in that loop indefinitely within minutes of the fleet
existing — claiming nothing, draining no chat, answering every probe — and a restart does
not help, because the commit is on the volume.

The conflict that caused *that* incident was `journal.md`: append-only and single-file, so
two runners recording the same task collided on the same line. It was reachable whenever
one runner had its push refused (a forge outage will do it), kept the commit, and another
took the task over and pushed its own. **That conflict class no longer exists.** The
journal is one file per entry (§4.1), the two runners write different paths, and both
commits apply — which is a property of the format rather than of the recovery, and so
cannot regress by being retried differently.

The salvage stays anyway, because it is the correct backstop for every *other* conflict —
a hand-edited file, a `state.json` two runners wrote, a future format that forgets this
lesson. Unmergeable commits are moved to `refs/salvaged/<oid>` and the runner carries on.
Nothing is destroyed, the ref outlives the pod because the volume does, and the event is
logged at `error` — the runner recovers, so nothing else would raise it, and two runners
disagreeing about a task is never routine. The remote wins because it has to: it is what
every other runner already agrees on. A `state.salvaged` line today means something the
fleet has not seen before, not the journal.

---

## 5. Leasing

Git has no transactions, so mutual exclusion rides on atomic ref updates.

There is a Redis in the cluster and this does not use it. That is a decision rather than an
omission, and §21 makes the case: the fence below compares an exact OID, and a key that can
evaporate leaves nothing to compare against — a fence that fails **open**, which is the one
way for two runners to work the same branch. Ref CAS fails **closed**: a ref that vanished is
a ref whose `--force-with-lease` is rejected.

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

**A claimant is not the same thing as a replica.** Nothing above distinguishes them, and
that is the property §6.5 leans on: one replica working four tasks at once races through
exactly the same CAS as four replicas working one each, because the ref is per *task* and
the compare-and-swap is exclusive against whoever else is asking. Concurrency within a
process therefore needed no new coordination — only local bookkeeping about how many slots
that process is filling. The one thing it does need is for a process not to steal from
itself: a lease this runner holds looks stale to nobody but is `running` in local state,
which `isClaimable` accepts (§6.2), so `claimUpTo` skips tasks already in one of its own
slots before it reaches the CAS.

### 5.1 Fencing

The heartbeat *is* the fence. A partitioned runner whose lease was stolen discovers this
within one heartbeat, because its CAS fails against an OID it no longer owns. On failure
it must **abort immediately** — no pushes to the task branch, no state writes.

Rule: **every push verifies lease ownership first.** Mutual exclusion on claiming is not
enough; a runner that lost the network but kept working must not resurrect stale work.

**And every IRREVERSIBLE act, not only every push.** A push is cheap to fence because it
is cheap to lose — a rejected one costs a retry. A merge is not: it lands on the default
branch, it crosses a system boundary, and no later check can take it back. Fencing it
afterwards fences nothing. The gap that made this concrete: `convene` takes minutes (207s
observed), and in that window the lease can go stale, an operator can `/cancel`, and
another runner can park the task and push — after which the council returns `pass` and
the original runner merges the PR for a task the human already cancelled. `assertHeld`
then threw, and the throw was logged at warn and discarded, because by then there was
nothing left to protect. So `assertHeld` runs immediately *before* the merge, and the
`Merge anyway` button claims the lease before merging rather than after, refusing when
another runner holds it.

> **Clock skew matters.** Steal-on-stale compares commit timestamps across machines.
> Runners must run NTP. The 5-minute threshold is deliberately far larger than plausible
> skew.

#### The fencing token is a handle, never a value

A `Lease` is a *snapshot* of a token the heartbeat **rotates**. Because `assertHeld`
compares the OID exactly — and that exactness is the entire fence — a `Lease` held across a
renewal names a token the ref no longer has, and the next push reports a stolen lease that
nobody stole.

Rule: **anything that writes after an unbounded await carries a `LeaseHandle`, not a
`Lease`,** and resolves it immediately before the write. `startHeartbeat` returns one;
`heldLease` wraps the short claim-write-release paths that have no await worth rotating
across. No signature offers the choice, because remembering the rule at each call site is
what failed.

This was not hypothetical. The supervisor read a `Lease` out of the heartbeat *before* a
council review, and pushed with it 207 seconds and three renewals later. The
`LeaseLostError` unwound a plan that had already been reviewed and cut into five tasks; the
next poll's `pull()` (`git reset --hard`) reverted every tracked write, and the five child
task directories survived only as untracked files on the PVC — where the claim loop found
and claimed them. It was logged at `warn`.

`current()` is async so it can wait out a renewal already in flight, which closes the same
failure in its narrow form. It waits for exactly the airborne renewal, not "until none is
airborne": the caller wants to write, and a caller that never returns is worse than one
racing a rotation. The residual window between `assertHeld` and the push it guards is
seconds against a 60s interval, and losing it costs an unwound task, not a corrupted one.

---

## 6. Session lifecycle

The shape below is **one task's** lifecycle. A runner works `concurrency` of them at once,
default 1 (§6.5); at N > 1 this loop runs N times over, independently, one per slot.

```
work loop:
  fetch state repo
  candidates = tasks where status == ready and requires ⊆ my capabilities
  claim up to (concurrency - in flight) of them (lease CAS each)
  start each as its own session; keep polling

per claimed task:
  prepare worktree from PVC mirror
  mint GitHub token scoped to task.repos

  loop:
    session = new pi Agent
      system prompt + spec.md + journal/ + handoff.md
      shouldStopAfterTurn → true when usage > contextWindow * 0.70

    run until stop
    write sessions/NNN.jsonl.gz, write a journal/ entry, update state.json
    push state (supervisor credential)

    case exit reason:
      handoff   → write handoff.md, continue loop (fresh session, same task)
      ask_human → status=awaiting-human, release lease, exit
      done      → run acceptance criteria, verify PR + CI, then status=done
      blocked   → update requires[], status=ready, release lease  ← machine handoff
      limit     → status=parked, notify Discord
      provider  → status=ready, release lease, cool the RUNNER down  ← §6.3, not the task's fault
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
   This step is conditional on the catch-up above succeeding, and cannot be moved ahead of
   it: the worktree path comes from `ensureTaskCheckout`. So if the remote moved while the
   session was dead and the fast-forward touches a file the dirty tree also touches, the
   checkout refuses and the WIP stays uncommitted for a human. Nothing is lost — the changes
   are still on disk — but the recovery is not automatic in that case.
2. Appends a journal entry recording the interruption.
3. Replays context from `spec.md` + the journal + `handoff.md`.

**A reclaim requires `running` to be claimable, and for a long time it was not.** From
the end of session 1 the pushed `state.json` says `running` — `recordSession` writes the
status object it was handed — so this is the state EVERY interrupted task is in, not an
edge case. `isClaimable` accepted only `ready`, and `claimNext` filters on it *before*
calling `LeaseManager.claim`, which meant the stale-lease steal below could never run for
the tasks it exists to serve. Every route out of a session other than a clean terminal
transition stranded the task permanently: a killed pod, a lost lease, and a graceful
SIGTERM alike — and Keel rolls the pod on every push to main, so this fired on each
deploy, with no notification.

Nothing was lost when it happened (branch commits and the journal survive, and `/cancel`
then `/resume` recovers it), which is precisely why it went unnoticed: the symptom is a
task that is simply never worked again.

The predicate now admits `running` and lets the CAS adjudicate. That is the correct
division: `isClaimable` filters a snapshot read seconds earlier, and a filter over stale
data cannot establish exclusivity whatever statuses it admits — only the atomic
compare-and-swap on the lease ref can, and a successful one already means the lease was
absent or stale. Terminal and parked statuses stay excluded, because those are decisions
rather than interruptions.

The last session's transcript may be missing or truncated — that is acceptable, because
the journal, not the transcript, is the source of truth.

### 6.3 When the provider stops answering

**Added after the incident of 2026-08-15.** The account's monthly spend limit was
reached mid-session. Nine seconds later the task had run five sessions, three of them
without receiving a single token, and had parked itself citing *"3 consecutive sessions
made no measurable progress"* — a verdict about the agent, for something the agent never
saw. Every other `ready` task was queued up for the same treatment.

Three separate things were wrong, and each is now closed:

**1. pi does not throw on a provider failure.** `Agent.prompt()` catches it, appends an
assistant message with `stopReason: "error"` and an `errorMessage`, and returns
normally. The `try/catch` in `agent/session.ts` therefore saw nothing, and the session
fell through to *"ended without a control-plane decision"* — which is a **handoff**, and
a handoff means *start another session immediately*. That is the retry storm. Both
halves of the failure are read now: the throw, and `agent.state.errorMessage`.

**2. An outage is not a session exit reason the task owns.** `provider-unavailable` is
its own reason, distinct from `error`, and `llm/outage.ts` decides which one a failure
is by reading the provider's message. The line it draws:

| Reads as | Examples | Response |
|---|---|---|
| outage | 429 spend/usage limit, 429 burst, 5xx, 529 overloaded, 401/403, no response at all | release the task, back the runner off |
| the task's own error | 400 `prompt is too long`, 404 unknown model | unchanged — `failed`, and a human looks |

Sweeping the second row into a cooldown would hide a real bug behind an hour of silence
and then reproduce it exactly. That is why the classifier reads prose rather than
treating every failure as transient.

**3. The response belongs to the runner, not the task.** On an outage:

- the task goes back to **`ready`** — not `parked`, not `failed`. It did nothing wrong,
  and a park needs a human to undo, so a limit that clears by itself would otherwise
  leave a queue of tasks all needing hand-resumption.
- the **progress probe does not run** and `progress` is untouched. The no-progress
  detector (§11.1) answers *"is the agent going in circles"*. Feeding an outage into it
  is precisely how a spend limit came to park a task for making no progress.
- a session that never got a token back **is not recorded at all** — no journal entry,
  no session count, no transcript commit. It cost nothing and proves nothing, and one
  entry per attempt is the spam `agent/journal.ts` exists to bound. A session
  interrupted *mid-work* is recorded in full, minus the probe: its tokens were spent and
  its commits are on the branch.
- the state is pushed as `ready` **even when nothing else changed**. Only `ready` is
  claimable, and every task past its first session was last pushed as `running`.
- the **runner** then stops claiming until a cooldown expires: 60s, doubling, capped at
  30 minutes (`llm.cooldownSeconds` / `llm.maxCooldownSeconds`). A wait the provider
  itself asked for wins when it is longer. A rejected credential goes straight to the
  cap — no wait length fixes a 401.

The cooldown is in memory and runner-scoped. In memory because it is a claim about right
now, and a restarted pod should try again immediately — the likeliest reason anyone
restarted it is that they just fixed the provider. Runner-scoped because the account is
shared by every task, so a per-task schedule would multiply the request rate by the size
of the queue.

Chat and intake keep running throughout. Answering a question and ingesting an issue
cost no tokens, and a queue that fills while the provider is down is correct — it is only
*starting sessions* that has to stop.

**The council was a fourth way to lose.** Its reviewers abstain rather than fail, so an
outage made all three abstain — and `decide` excluded abstentions from the blocker count,
leaving zero blocking objections, which read as a **pass**. An unreachable provider was a
way to merge an unread change. A council whose every reviewer abstained is now the same
as an empty one, and a council interrupted by an outage records no verdict at all: a
verdict is a permanent document, and *"could not complete this review"* × 3 is not one
worth keeping in the file the next session reads as its instructions.

Visibility: `caterpillar_provider_outage_total{kind}`,
`caterpillar_provider_cooldown_seconds`, a `provider.unavailable` log line, and exactly
two Discord messages per incident — one when it breaks, one when it comes back.

Sessions also retry transient provider errors twice before giving up, which pi does not
do by default (`maxRetries: 0`). A single 500 used to cost a whole session.

---

### 6.4 A session can be stopped

Four things may stop a session in flight, and they arrive as one `AbortSignal` threaded
into `agent.prompt()` via pi's `abort()`:

1. **Pod shutdown.** SIGTERM aborted the loop *between* tasks only, so a graceful stop
   waited for the whole session.
2. **A lost lease.** The heartbeat's failure callback used to set a flag read at the top
   of the session loop, so a lease lost at t=60s let the session run out the rest of its
   budget — still minting a fresh token for every push, via a `CredentialService.active`
   that outlived the lease justifying it — while another runner worked the same branch.
   The callback now aborts and clears the credential at that moment.
3. **`/cancel`.** See below.
4. **The wall clock** (`limits.maxSessionSeconds`, four hours). Not a budget: pi's bash
   tool documents `timeout` as optional with **no default**, so the model decides whether
   a command may block forever — and a provider request can hang just as well as a
   command can. `npm run dev`, a test runner waiting on stdin, a
   `nix build` against a dead cache — the promise never settles. The heartbeat keeps
   renewing, `/healthz` keeps answering 200, and the typing indicator stays on: a runner
   that looks healthier the longer it is wedged.

   This used to take everything else down with it. The supervisor ran one loop, so the
   chat drain, intake, alerts and the digest stopped with the session too — see *Two
   loops* below, which is the fix and which changes what the paragraph above costs: a
   wedged session is now a wedged session rather than a wedged runner.

#### It happened, and the session ceiling was the wrong place to catch it

The paragraph above was written as a prediction. The prediction was right and the
mitigation was too weak, in two separate ways.

A review council reviewer ran `npm test` in a task worktree. One test subprocess never
exited, `tail` blocked on the pipe, and the reviewer sat in that single tool call for **two
hours and forty-two minutes** — lease renewed on schedule, `/healthz` green, CPU at 15
millicores, the last log line ninety minutes old. Exactly the runner-that-looks-healthy
above.

**The first failure: the ceiling was in the wrong place.** `maxSessionSeconds` wraps
`runner.run` in the supervisor loop and is cleared in a `finally` before the council is
convened. So the implementation session was bounded at four hours and the review *of* that
session was bounded by nothing at all. The council now carries the same deadline, and a
reviewer cut off by it is recorded as an **abstention** — the honest reading, since it did
not decide — and deliberately not as an outage, so the runner does not back off from a
provider that was answering fine.

**And a deadline passed by hand is one the next caller forgets.** `ReviewCouncil` was not
the only session the supervisor did not bound: `PlanMaintainer` and the digest summariser
called `runSession` with no signal either, and a second incident found the council itself
stopped for **7h20m** on a provider request that never returned — three reviewers waiting
under one `Promise.all`, `/healthz` green throughout. Threading the deadline into each
caller fixes the callers that exist. So `SessionOptions.timeoutSeconds` is **required**: a
caller may add a signal of its own and the two are combined, but it cannot take the ceiling
away, and a new call site cannot quietly omit it — the compiler names it instead. All five
share `limits.maxSessionSeconds`.

**The second failure: four hours is not a hang detector, it is an outage.** Even correctly
placed, a ceiling that generous means a wedged runner is out of service for half a working
day. The real fix belongs one level down, at the command:

> **`limits.commandTimeoutSeconds`, default 900** — a ceiling *and* a default for one
> command from the agent's shell, applied in `BoundedExecutionEnv`.

Three things about it are load-bearing:

- **It clamps as well as defaults.** Absent-becomes-900 fixes the common case; without the
  clamp a model that passes `timeout: 86400` for a slow build reintroduces the hang, and it
  would look like the protection was working. A clamp rather than a refusal, because the
  model is not doing anything wrong by asking — it cannot know what this runner tolerates,
  and an error it has to interpret costs a turn to learn something the harness can decide.
- **It is applied in BOTH shells.** The council builds its own `ExecutionEnv`, separate
  from the runner's, and *that* is the one that wedged. A fix in the agent's shell alone
  would have left the exact failure untouched.
- **900 matches the acceptance gate.** `verifier.ts` has always passed a 15-minute
  `timeout` to `execFile`. That asymmetry was the whole bug: the gate could not wedge and
  the agent trying to satisfy it could. They should tolerate the same command for the same
  time.

`maxSessionSeconds` stays, now genuinely as a backstop: it catches what a per-command
ceiling cannot — a model looping over a thousand commands that each return in a second.

**A note on where this did *not* get fixed.** The council's shared preamble already tells
reviewers the suite has passed and not to run it again. The reviewer ran it anyway. That is
the argument for the ceiling living in the harness rather than in a prompt: a prompt is a
request, and an unattended fleet needs a limit.

#### The other half: a ceiling on what a command RETURNS

The ceiling above bounds how long a command runs. Nothing bounded how much it hands back,
and the two failures look nothing alike. A hung command holds a slot until something kills
it. A 40,000-line `grep` **succeeds, in a second**, and spends a large share of the context
window that §6.1's handoff threshold exists to protect — after which the task hands off
early with a journal that can only say it ran out of room. One `cat` of a lockfile does the
same. For a while `cluster.maxLogLines` was the only output bound in the codebase, and it
covered three tools.

So the rule is general, and it is the same rule as the timeout: **`limits.commandOutputMaxLines`
(2,000) and `limits.commandOutputMaxBytes` (50KiB) both default AND clamp**, applied in
`BoundedExecutionEnv` — so in the agent's shell and the council's, since both go through it.
A config can only lower them. That matters more here than it looks: the agent edits config
in its own worktree, so a knob it could raise is not a bound.

Five things about it are load-bearing.

**Head AND tail, and the split is 1:3.** A test runner prints its failure summary last, so
head-only truncation loses the verdict and makes a bounded failure look like a pass. A
compiler prints the first error first, so tail-only loses what started it. Both ends are
kept, the tail gets the larger share, and the note says which — `budget.ts` is pure and
decides only this.

**Lines and bytes, whichever bites first.** A line ceiling alone lets one minified lockfile
through as three lines and half a megabyte. A byte ceiling alone lets 40,000 short lines
through. The one unavoidable case — a single line longer than the whole byte budget — cuts
the line and *says out loud that it did*, because a truncated line that looks complete is
how a model comes to believe a file ends where it does not.

**The elision is declared, never silent.** "1,284 of 40,112 lines shown", the way
`journal.ts` declares its own. Silent truncation is worse than a short answer, because the
model acts on it.

The note is charged against both halves of the ceiling — a line of the line budget and a few
hundred bytes of the byte budget — because it is text the model reads, so `maxLines` of
content plus a note is over the ceiling it declares. The line matters more than it sounds:
pi bounds its own capture at exactly 2,000 lines, tail-only, so at the shipped default a
view one line over gets cut a second time and the line that goes is the first head line.
That is the compiler's first error — the only reason the head is kept. Do not spend that
line on content; the "pi's truncation is a no-op" claim below depends on it.

**The overflow is written, not discarded.** `<tasks>/<task>/.caterpillar/output/<uuid>.log`,
named in the note, so a session that needs the middle can read it in slices. That directory
is the scratch directory the toolchain cache already uses: beside the checkout, so a spill
is never committable, and reaped with the task rather than accumulating on the work volume.
A failed spill does not fail the command — the bounded view is still correct, and the note
says plainly that the rest is gone.

Known limitation: one file per bounded command accumulates for the LIFE of the task, and
`removeTaskWorktrees` deliberately does not reap on handoff or `awaiting-human` — so a
long-lived task that greps widely every session grows the directory without a cap. Usage
accounting does see it, since it measures `paths.tasks`, so this shows up as disk pressure
rather than as a silent leak. Left alone here because capping the directory means changing
when the reaper runs, which is the supervisor's concern and not this ceiling's.

**It is applied to the STREAM, not to the return value.** This is the part that would have
been got wrong. pi's bash tool reads `env.exec`'s `onStdout`/`onStderr` callbacks and
ignores the `stdout` it returns, so bounding the return value alone leaves the model's own
view unbounded while every test passes. `BoundedExecutionEnv` therefore withholds the
caller's callbacks for the duration of the command and hands over one bounded chunk just
before `exec` resolves — and bounds the return value too, so the ceiling does not depend on
which half of `ExecutionEnv`'s contract a caller reads. Two consequences, both accepted: pi's own truncation
becomes a no-op (a constant 2,000 no config could lower, tail-only, spilled to a `tmpdir`
file outside the worktree), and progress updates arrive when a command ends rather than
while it runs, which nothing in this codebase consumes.

**And it is counted in the accounting that decides handoff.** Lines and bytes are what a
command produces; they say nothing about what they cost. 50KiB is a rounding error in a 1M
window and a large share of a 32k one. So `ContextBudget.outputCeiling()` caps the
configured number a second time, at a tenth of the handoff threshold — the same move
`journalBudgetChars` makes for journal history, and made in `limits.ts` because that is the
class that knows the window. The guarantee is that **no single tool call can cross the
handoff threshold by itself**, which is the failure the whole thing exists to prevent: a
session that hands off having run one `grep`.

`cluster.maxLogLines` is now one configured case of this rule rather than a special one —
same validation helper in `load.ts`, and its cap is `MAX_OUTPUT_LINES` itself. Two
independent 2,000s in two files is how they come to disagree, and the disagreement would be
invisible.

**What is deliberately left alone.** pi's `read` tool never goes through `exec` — it calls
`readTextLines` — and it already bounds itself at the same 2,000 lines / 50KiB, declares the
elision, and tells the model the `offset` to continue from. Head-only is the right choice
there, unlike for a command: a file is read forwards. So it is left as it is, and the
asymmetry is recorded here rather than "fixed" into a second mechanism. The knob it would
need does not exist, which is the honest limitation: an operator who lowers
`limits.commandOutputMaxLines` for a small window does not thereby lower what one `read`
costs.

There is a third shell, and it gets neither ceiling: `PlanMaintainer` (`src/plan/maintain.ts`)
builds a bare `NodeExecutionEnv`, so its `bash` tool has no output bound and — this part
predates the output ceiling — no `limits.commandTimeoutSeconds` either. Invariant 12's
"no command returns without one either" is therefore true of the agent's shell and the
council's, which is where a wide `grep` actually happens, and not of the plan maintainer's.
It is left alone here because wrapping it is a change to the maintainer's behaviour rather
than to the budget, and it belongs in the change that also gives it the timeout: one
`BoundedExecutionEnv` for both ceilings, not a second knob for one of them.

An interrupted session is `reason: "interrupted"` and **nothing is recorded** — no
session count, no journal entry, no usage. Same reasoning as an outage (§6.3) and
deliberately distinct from it: no provider misbehaved, so no cooldown starts. Charging a
task a session for a deploy would also count it against the no-progress streak, which is
how a pod restart could park a task that was doing fine.

#### Two loops: housekeeping does not wait for a session

The supervisor's `run()` was one `while`, and one iteration of it did `store.pull` →
`chat.refresh` → `applyChatRequests` → `maybeIngest` → `drainAlerts` → `maybeDigest` →
`claimNext` → `workTask`. `workTask` runs a whole session, which is hours, so every step
before it lived in that session's shadow. The consequences were not hypothetical: a
labelled GitHub issue was not ingested until the session ended (`maybeIngest` had its own
interval, but an interval is only an interval if something consults it); a `/resume` or
`/answer` sat unread in the `ChatInbox`; and the Discord holder claim — refreshed from
that same loop — could neither be renewed nor stood down from, so a mid-session replica
went on advertising itself as the holder while answering nothing (§7).

The workarounds that existed confirmed the diagnosis rather than fixing it: a
`CANCEL_POLL_MS` interval that watched for one request kind, and `yieldToBrainstorm`,
which hands the whole runner back at a session boundary.

So the timing is split in two, in `src/supervisor/loop.ts`:

- **The housekeeping loop**, on `housekeepingSeconds`: `store.pull`, `chat.refresh`,
  `applyChatRequests`, `maybeIngest`, `drainAlerts`, `maybeDigest`, and
  `toolchain.maybeCollectGarbage()` when idle. It runs whether or not a session is in
  flight.
- **The work loop**, on `pollSeconds`: `store.pull` → `coolingDown` → `claimUpTo` →
  `startSlot` per claim. `pollSeconds` is a claim *backoff* — how long a runner with a free
  slot waits before looking for work again — and nothing a human waits on depends on it.
  `housekeepingSeconds` defaults to `pollSeconds` and is clamped to it.

  It no longer blocks for the session. It used to, and that is what §6.5 changed: each
  session now runs as its own promise and the loop's job is to keep free slots filled. At
  `concurrency: 1` — the default — the observable behaviour is identical: one slot fills,
  every later pass finds it full, and the loop naps until it frees.

  The work loop pulls too, and that is not redundant with housekeeping's pull. The single
  loop did pull-then-claim in one pass, so a claim was always decided from a checkout
  refreshed moments earlier; splitting the loops broke that silently, because `pull`
  declines while the tree is dirty and the tree is dirty for the *whole* of a session. The
  first claim after every session would then be decided from a view of `tasks/` predating
  it. The lease CAS does not cover that gap — `isClaimable` is a filter over local state,
  and the CAS succeeds freely once another runner has released — so a task finished
  elsewhere hours ago looks ready and claimable, and this runner opens a session on
  already-merged work, which §6.2 names as the worst outcome the system has. Mid-session
  the call is a no-op `"skipped"`; it is only ever a real pull when the tree is clean,
  which is exactly when a claim is about to be made.

This was **not** task concurrency, and for a long time §6's one-session-at-a-time rule was
unchanged by it: there was one work loop, so there was one `workTask`. What this section
made concurrent was housekeeping against a session. Task concurrency came later and
separately — §6.5 — and it is built on the two mechanisms this section introduced rather
than alongside them: the shared-checkout mutex below is what makes N writers safe, and it
was put there for two.

Both loops contain their own failures for the reason the single loop did — a
throw out of `run()` reaches main's `finally`, which closes `/healthz` and the credential
socket and then blocks forever on `await bridge`, leaving a live process that polls nothing
and that systemd never restarts because it never exited. Splitting the loop doubled the
number of places that can happen. Both honour the same `AbortSignal`, and `run` awaits both
so a throw that did escape ends the process rather than leaving one loop turning.

**The two loops share one git checkout, and that is the hard part.** `StateStore` is a
single working copy; `commitAndPush` stages the tree and `push` rebases on conflict. Two
concurrent writers get `index.lock` at best and a commit carrying the other's half-written
state at worst — exactly the reasoning §7 already gives for why the Discord bridge does not
touch git. Two mechanisms, and both are needed:

1. **A serialising mutex** (`src/state/serial.ts`) in front of every `StateStore` method
   that runs git. A promise chain, no dependency, fair, and a throw releases it — a
   rejected tail would make one failed push wedge every later write. It is deliberately not
   re-entrant: a public method calling another public one is the bug, and an ownership
   token would hide it.
2. **`pull` declines while the tree is dirty.** Mutual exclusion says a pull does not land
   inside a `git add`; it says nothing about one landing between a session's `writeState`
   and the `commitAndPush` that would have persisted it, which is a window of *minutes*.
   `pull` does `reset --hard` and `clean -ffdq` over `tasks/`, `intake/` and `alerts/`, and
   that combination once destroyed five tasks' work outright (§4.3). So every write sets a
   dirty flag, the commit clears it, and a pull that finds it set returns `"skipped"` and
   tries again next tick. Skipping is cheap and safe in a way resetting is not: the state
   repo is authoritative but never urgent, a session commits at defined points
   (`recordSession`, `push`), and the very next housekeeping tick after one of those finds
   a clean tree. The failure modes are not symmetrical — a deferred refresh costs one
   interval and a taken one costs a task.

   One flag covered both writers, which looked too simple and was not — while there were
   two. `commitAndPush` staged `tasks`, `intake`, `digests` and `alerts` with `add -A` — the
   whole of what the supervisor writes — so whichever loop committed carried the other's
   pending files with it and the tree afterwards really was clean. What the two lost was
   attribution, not durability: a commit message occasionally undersold its contents.

   **That trade stopped being acceptable at §6.5, and the flag needed a second condition.**
   Broad staging is fine when the other writer's files are ones nobody else is about to
   commit; it is not fine when there are N sessions, because two ending in the same tick
   produce one commit carrying both tasks' files and a second commit that finds a clean tree
   and records *nothing*. So staging is now scoped to the paths one writer wrote (see §6.5),
   and `dirty` is cleared only when the write counter has not moved **and** nothing is left
   outstanding — because a commit that carried only its own files no longer proves the tree
   is clean, and clearing the flag on the counter alone would hand the next `pull` a
   `reset --hard` over a mid-session `state.json`. That is this same five-task incident,
   reintroduced by its own fix and aimed at a different victim.

   The flag is backed by a monotonic write counter. `commitAndPush` samples it before its
   first `add` and clears the flag only if it has not moved, so a write that lands *during*
   a commit — after the `add` that would have staged it — leaves the tree marked dirty
   rather than being lost to the next `pull`; and `pullNow` re-reads it after its `fetch`
   and abandons the refresh if it moved, reporting `"skipped"`. That second one is the
   original five-task incident, still reachable after the flag alone was added: it stopped
   being theoretical the moment the work loop began pulling before each claim, which put a
   pull in the same instant as a `/brainstorm` creating a task — the spec was written
   between the fetch and the clean, and the `commitAndPush` immediately after found nothing
   to commit and reported success. A task acknowledged to a human that existed nowhere.

3. **Writes take the mutex too — one write at a time.** This is the third mechanism, and it
   exists because the first two are not enough however carefully the counter is placed.
   `dirty` is a *sample*, and both destructive paths spend several subprocess spawns in the
   working tree **after the last moment they could check it**: `pullNow` between its
   post-fetch re-check and its `clean -ffdq`, and `rebaseOnto` between its `reset --hard
   HEAD` and the end of its salvage. An unlocked write landing in there is deleted having
   been visible to nothing, and no additional flag can see it — the check would have to
   happen after the damage.

   It was not found by reasoning about the window. It was found as a **flaky test**: one CI
   run in three, `an answer from the bridge unparks the task on the REMOTE`. An answer typed
   in Discord reported `applied`, wrote `questions/004-answer.md`, had it deleted by the work
   loop's pre-claim pull, and then pushed a `state.json` saying the question had been
   answered — the answer gone from the one file the next session reads it out of (§4.1),
   while every status said it had been recorded. The same red job also skipped the image
   build, so that deploy silently did not happen.

   The objection this design started with — that holding the mutex across a session's
   minutes-long write-then-commit window is a deadlock waiting to happen — is answered by
   **scope**: the lock is held for one `writeFile`, never for a write-then-commit unit. What
   a write can now do is wait out a fetch. Losing it was the alternative.

   The one real deadlock this did introduce is worth writing down, because it hung a test
   file rather than failing it. `exclusively` exists so that a write and its commit are one
   unit — so the holder of the tree writing through it deadlocks on its own hold the instant
   writes acquire. So acquisition is **scoped to the async context that holds the lock**
   (`AsyncLocalStorage`, in `StateStore.exclusive`): the holder's own write runs immediately,
   anyone else's queues. `Serial` stays re-entrant-hostile and is not weakened, because the
   re-entrancy turns on *identity* — a boolean saying "someone holds it" would wave through
   the very concurrent write the lock exists to order.

   The counter checks stay as the second line rather than the only one: `serial` is
   injectable, so something else can share the checkout, and a guard whose incident is
   written down is not one to delete because it has become hard to reach. What the mutex
   still does not make atomic is a read-then-write — a caller that reads state, decides, and
   writes it back can have a pull land in the middle. That is what `exclusively` is for.

   `StateStore.exclusively` holds the checkout across write *and* commit, for a caller that
   needs the two to be one unit. It was written with **no production path using it**, kept
   deliberately against one concrete prospect, and named that prospect in its own docstring:
   "the cost of that route is attribution (another writer's commit may carry these files)
   rather than durability. This exists for a caller that cannot accept even that cost."

   **§6.5 is that caller.** Every write-then-push unit in the supervisor now goes through it
   (`Supervisor.unit`), because with N sessions the cost is no longer attribution: the writer
   whose files were swept up commits nothing, so its state push silently does not happen.
   The boundary is one logical operation and never wider — the model call, the council review
   and the progress probe all stay outside it, since holding the state checkout across one
   would stop every other slot writing and stop housekeeping pulling for minutes.

**`/cancel` keeps its own interval, and it is not redundant.** Housekeeping drains the
inbox during a session now, which is what `CANCEL_POLL_MS` was built to work around — but
not for the one request kind it exists for. A `/cancel` naming the task *this runner is
currently running* cannot be served from housekeeping: acting on it means writing state
under a lease the session holds, and only the session can stand down from it. So
`applyChatRequests` leaves exactly those requests queued and takes everything else, and
`workTask` watches for park requests naming its own task and takes only those
(`takeWhere`). The reply says `cancelling`, not `parked`, because the session may take a
turn boundary to unwind and the human is waiting on a Discord interaction.

The watcher also wants a tighter interval than housekeeping does: it is an in-memory queue
check, where housekeeping's interval is tuned against a git fetch and a Discord round trip.

**That split depends on the queue being able to take selectively, and one cannot.**
`RedisChatQueue.takeWhere` is a stub returning empty — a selective pop from a shared list
is a Lua script, and it was never needed while the only caller was the in-session watcher
(§21). Routing the whole housekeeping drain through `takeWhere` therefore drained *nothing*
on a Redis-backed fleet for the duration of every session: `/resume`, `/answer`, `/merge`
and `/brainstorm` all unserved, silently, on exactly the multi-replica path the split was
aimed at. Worse, the in-session watcher polls that same stub, so an in-flight `/cancel` had
no path at all and deleting the pod was the only way to stop a session — which strands the
task (§6.2).

So `ChatDrainer` carries an explicit `selective` flag and the loop branches on it. Where it
is true, the behaviour above stands. Where it is false, housekeeping drains *everything*
and routes a park naming an in-flight task to that task's session directly, through the
hook its slot carries (§6.5). The hook settles `cancelling` and aborts that one session —
the same two things the watcher does, because it is the same function. A queue that cannot
take selectively must say so rather than answering "nothing matched" to every question.

The routing is a **lookup by task**, not a comparison against "the current task", and §6.5
is why. A single field naming one in-flight task would answer "not mine" for every session
but one, so a cancel for A while B was also running went to `applyPark`, failed its CAS
against A's own live lease, and replied "not-parkable: running" about the exact task the
human was watching this process work.

Stopping the session is **not** cancelling the task, and the difference is easy to miss:
an interrupted task is left `running`, which is claimable (§6.2), so an abort on its own
means the next poll re-claims it and starts over while the operator watches the thing
they cancelled carry on working. `workTask` therefore parks it under the lease it still
holds, before releasing. A cancel that raced a lost lease does not — it has no standing
to write, and `park` fences anyway.

### 6.5 N tasks at once, and why the number is the operator's

`concurrency` says how many tasks one replica works simultaneously. **It defaults to 1, and
at 1 nothing about a runner's behaviour changes** — which is deliberate rather than
cautious, because the ceiling is not a property of the box.

The bound today is the model provider. A weekly token allowance divided between four
sessions is exhausted in a quarter of the time, and every one of those sessions then meets
the same wall — which is exactly why the provider cooldown (§6.3) is runner-scoped. So the
number an operator can afford is a fact about their account, and the fleet must not guess
it. What makes it worth configuring at all is semi-local inference: with the model on
hardware the operator owns, the limit stops being an allowance and becomes how many
sessions the machine can run, and that is a number only they know.

`concurrency` is refused rather than clamped when it is not a whole number of at least 1. A
runner with 0 slots claims nothing and looks perfectly healthy doing it.

#### What it did *not* require: a new coordination mechanism

Leasing already made concurrent claims safe, and had since it was written. A claim is a
compare-and-swap on `refs/leases/<task>` (§5), exclusive against every other claimant in the
fleet, and it does not care whether the competition is another replica or another slot in
this process. **Four replicas at one slot each and one replica at four slots race through
the identical CAS.** Raising this number is local bookkeeping about how many slots one
process fills.

Three things follow from that and are worth stating, because each is a place the old code
assumed exclusivity:

- **Leases are per task, so heartbeats are per slot.** Renewal is a CAS on that task's own
  ref, so `assertHeld` fencing (§5.1) was already per lease and stays so however many slots
  are open. What the split buys is containment of the *failure*: a stalled renewal for A
  drops A — its credential revoked by task id, its session aborted, its checkout reaped —
  and leaves B running under a lease that was never in question. A shared heartbeat could
  not have that property, because it would have to read one CAS failure as evidence about
  every task at once.
- **Worktrees were already per task** (`<tasksDir>/<task>/<repo>`), so nothing there moved.
- **Mirrors were not.** See below.

#### A slot is a value, because "the current task" was three fields

`Supervisor` was written throughout as *the* current task: `sessionInFlight`,
`inFlightTask`, `cancelInFlight`. Those described the one session a runner could have, and
every terminal path assumed exclusivity over them. At N slots they stop being a description
and become a race — task B starting overwrites task A's cancel hook, task A finishing clears
a flag B relies on.

So each in-flight task owns a `TaskSlot`: its lease heartbeat, spec, abort controller, cancel
hook, and its own `cancelled` / `lost` / `outage` flags. The rule that replaces the old
assumption is that anything task-scoped lives there and anything runner-scoped stays a field.
Every field was audited against it. `cooldown` stays, because the provider is genuinely
shared. `lastIntakeAt` and `lastReapAt` stay, because they rate-limit a runner rather than a
task.

#### Containment is per slot, and that moved the boundary

The old work loop did `await workTask(...)` inside its own `try`/`catch`. That was correct
while there was one task, because unwinding the pass and unwinding the task were the same
act. They are not the same act with N: a throw reaching the loop abandons the pass that
every *other* in-flight task's cleanup and reclaim depends on.

Each session therefore runs as its own promise (`startSlot`), which **settles rather than
rejects**. `LeaseLostError` drops one task and reaps one checkout; anything else is logged
and frees one slot. The comment that used to read *"any other failure belongs to the TASK,
not the supervisor"* now has to hold per slot, and what makes it hold is that the boundary
is a function rather than a loop. On shutdown the loop awaits the collection once, so an
aborting runner does not walk away from a task mid-park.

#### An outage is runner-scoped, so it fans out

With one slot, "stop claiming" and "let go of what you hold" were the same sentence. With N
they are not, and releasing only the slot that met the wall would leave the other N-1
hammering an endpoint that has already refused one — N journal entries, N cooldown records
extending the back-off geometrically, and the stampede §6.3 exists to prevent, arriving one
task at a time.

`releaseAfterOutage` therefore signals every other slot before recording its own release:
set a flag, abort the session. It deliberately does **not** release them itself. Releasing
task B means writing B's state and pushing under B's lease, and doing that from inside A's
stack is precisely the cross-task coupling slots exist to remove — a push that failed for B
would surface as A's failure, and A's `catch` would park A. So each slot unwinds through its
own `releaseAfterOutage`, under its own lease. One incident still produces one Discord
message, because the cooldown's `first` flag is what the notification is gated on and the
fan-out arrives inside the same incident.

#### `yieldToBrainstorm` yields a slot now, not the runner

It hands the runner back at a session boundary when a `/brainstorm` is queued, because a task
that keeps handing off would otherwise own the runner indefinitely — twenty minutes and six
sessions of a thread that opened and said nothing, in the run it was written from.

It is **kept**, including at the default N=1, and the housekeeping split did not make it
redundant: housekeeping drains the request, creates the task and answers the thread, but the
brainstorm still cannot be *claimed* until a slot frees, and on a saturated runner nothing
frees one. Draining without yielding produces a task that exists and never starts.

What changed is that it must no longer fire when a slot is already free. A runner at
`concurrency: 4` with one session running has three slots the very next pass will claim the
brainstorm into, and releasing a working task to solve that costs a session boundary, a
state push and a re-claim for nothing. So the yield is gated on there being no free slot —
which at N=1 is always true, which is why a single-slot runner is unchanged.

#### One mirror, two sessions

Worktrees are per task; **mirrors are per repo**, and two tasks on the same repo fetch,
`worktree add` into, and prune one bare directory on the volume. Git does not queue for
`index.lock` — the loser exits non-zero with `Unable to create '…/index.lock': File exists`.
That surfaces as a session dying thirty seconds in, on a task with nothing wrong with it,
only when two tasks on one repo happen to start together: a flaky task failure, which is the
worst possible way to discover a race.

`WorktreeManager` therefore holds one mutex **per mirror path** and takes it around every
mirror-mutating operation — clone, fetch, `worktree add`/`remove`, prune, and the config
writes that go with them. Per mirror and not one global lock, because two tasks on different
repos have nothing to contend over and serialising them would give back the concurrency
slots were added for. Keyed by resolved path rather than by `RepoRef`, so the key is the
resource.

Two related facts, both checked rather than assumed:

- **Nothing else on that class is mutable.** `git` and `options` are set once and every path
  is derived from arguments, so two checkouts through one manager share no field. What needed
  serialising was the disk, not the object.
- **`configure()` writes the mirror's COMMON git config**, as its own comment says. Those
  writes — `user.name`, `commit.gpgsign`, `remote.origin.push`, `credential.useHttpPath` —
  are identical for every task on a repo, which is why sharing them is wanted and why two
  concurrent writers of the same values are harmless. The exception is `info/exclude`, which
  is a read-modify-write and would lose an update; it takes the workspace mirror's lock. The
  per-task `credential.helper` was already in worktree scope for a different reason (§9.2)
  and is unaffected.

#### The one thing that genuinely did not survive the change

`git add -A tasks` did not, and it took two mechanisms to replace. That is written up where
it belongs, under the shared-checkout discussion in §6.4 — the short version is that the
supervisor leaves a `state.json` uncommitted for the whole of a session, so broad staging
means the first session to finish commits every other in-flight task's state under its own
message while their own commits find a clean tree and record nothing.

#### The one thing that gets worse with N, and is left that way on purpose

`StateStore.dirty` is one flag for the whole checkout, and `pull` declines while it is set.
That same `transition("running")` write keeps it set for the length of a session, so at
`concurrency: N` the tree is clean only when every slot is momentarily between commits, and
the runner refreshes its view of `tasks/` less often than it used to.

This is a refresh **rate**, not a correctness property. Skipping is the safe direction — a
deferred refresh costs an interval and a taken one can cost a task (§6.4) — and a slot
commits several times per session, so a runner whose slots are not all permanently occupied
still pulls. It is worth stating because the same call is the work loop's pre-claim pull,
which is what stops this runner opening a session on already-merged work (§6.2).

Two fixes were tried and both rejected, which is why this is written down rather than
solved:

- **Per-path dirtiness.** `reset --hard` and `clean -ffdq` are whole-tree, so a narrower
  check would let a pull revert a directory another session is mid-write in. That is a task
  destroyed to save an interval — the wrong side of the asymmetry §6.4 is built on.
- **Pushing the `running` transition.** It clears the flag promptly and it would make the
  fleet's view of a running task honest, which is independently attractive. It also makes a
  task visible as `running` *before the session it names exists*, so a `/cancel` arriving in
  that window is answered by a park with no session to stop — and the abort never reaches a
  session, because there is not one yet. `loop.test.ts` pins exactly that, and it is pinning
  something real rather than an accident of timing.

What did come out of trying the second one is worth keeping: a session is no longer started
against a signal that has **already** aborted. A `/cancel` can land between the CAS that won
the lease and the first turn — the slot's cancel hook is installed at the CAS precisely so
that it can — and `AbortSignal` never fires a listener added after the abort, so a
`SessionRunner` that subscribes to the event waits forever for something that has already
happened. That is a slot and a lease held by a promise that will never settle, with
`/healthz` green.

#### What it is observable as

`caterpillar_tasks_in_flight` and `caterpillar_slots_free`, both labelled `runner`, and
`caterpillar_claims_rejected_full_total`. The last is the one that earns its place: a
saturated fleet and an idle one look identical from every other metric, because in both cases
nothing new starts. A rate that is persistently non-zero says raise `concurrency` or add a
replica; a rate flat at zero while tasks sit `ready` says the bottleneck is somewhere else.

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

**Options are buttons** (amended when they were built). `options` is capped at five, which is
Discord's buttons-per-row limit, and refused above it rather than truncated: an option that
cannot be rendered is a choice the human is never offered. The text is written to
`questions/NNN-options.json` beside the question and the button's `custom_id` carries only the
INDEX — a `custom_id` holds 100 characters and a tracker-derived task id has spent most of them.
Pressing one resolves the index against that file and then goes through the ordinary answer
path, so a press produces the same answer file, journal entry and `noProgressStreak` reset as a
typed `!answer`; an index the stored question does not have is refused, because a button
outlives the question it was posted under. The free-text button is always offered as well:
"none of these" is always a possible answer.

**How the bridge is built** (amended when it was): a Discord **gateway websocket, in the
supervisor process** — not the separate `discord-bridge` Deployment §10 anticipated, and
not a public interactions endpoint. §6 has runners polling outward precisely so a machine
behind NAT needs no inbound connectivity; an HTTP endpoint would have broken that for
every runner that is not this pod. A gateway connection is dialled OUT, so there is no
ingress, no TLS, and no URL to leak. Node ships a global WebSocket, so it costs no
dependency either.

The bridge does **not** touch the state repo. The supervisor's loops own that working copy,
and two git invocations interleaving in it is `index.lock` at best; a websocket handler
writing it concurrently would be a race with no owner. So a command is submitted to an
in-process inbox, the housekeeping loop drains it — on that loop's interval, whether or not
a session is in flight (§6.4) — and the submitter is told what actually happened. Silence
would leave a human unable to tell a typo from an offline bridge.

That argument is also why the two supervisor loops take a mutex rather than each opening
their own checkout: they are both loops, so neither can queue for the other the way the
bridge queues for them. See §6.4.

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
supervisor settles a request when its loop next comes round. That was once several hours
into a session; since the housekeeping split (§6.4) it is one housekeeping interval, which
removes the pathological case but not the design. The natural design — defer, then follow
up on the interaction token — works in testing and fails whenever settlement outruns
fifteen minutes, and a housekeeping pass that waits on a git fetch still can. So a click is
acknowledged immediately with what is knowable at click time, and the real outcome arrives
afterwards as an ordinary channel message from the bot.

Reads never take that path at all. `/tasks`, `/task` and task-id autocomplete are served
from an in-memory snapshot, refreshed by the same sweep that decides what to claim. Going
through the inbox for a listing would mean waiting on a session to finish before being told
what it is doing. `/brainstorm`'s `repo:` box is the one autocomplete answered from
somewhere else — the workspaces' forges (§9.1.1) — and it is bounded and failure-isolated
for the same 3-second reason.

The **housekeeping** loop refreshes it, not only the work loop (§6.4), and that is not
belt-and-braces. The sweep publishes the snapshot on its way to picking a task, so on the
work loop alone it stops the moment a session claims and does not run again until the
session ends — `/tasks` would keep answering in milliseconds from a view taken hours ago,
showing the running task as `ready` and missing every task created since. The same sweep
publishes the thread bindings, so an `!answer` typed into a thread opened during the
session would find no binding and be swallowed. That is this section's own defect arriving
through the reader rather than the writer, and it is the reason a read being fast is not
the same as a read being right.

**The snapshot is sorted, and the order is a correctness property rather than a
presentation one.** A Discord message is capped at 2000 characters, so a listing is capped
at 25 lines, so the *order* decides what a human is shown. `survey` builds its records by
walking `tasks/`, which yields them effectively alphabetically by id — and for ids like
`BS-<snowflake>` and `BS-<snowflake>-07` that means oldest brainstorm first. At 39 tasks
`/tasks` showed **23 finished tasks and elided the one that was running**: the command whose
entire job is to say what the fleet is doing showed everything except that.

`TaskSnapshot.replace` therefore sorts by `updatedAt`, newest first, tie-broken by id.
Recency and not a status ranking: a status order needs a policy about which status outranks
which, that policy is wrong for somebody, and recency reaches the same answer without one —
the task a runner is working is the task whose state is being rewritten, and finished work
sinks on its own. The tie-break matters because tasks cut from one plan are created in the
same millisecond, and a listing that shuffled them between two runs of the same command
reads as a bug.

Sorted **once, in the snapshot**, rather than in each reader, because pagination slices it:
`/tasks page:2` over a list a reader had re-ordered would repeat some tasks and skip others.
The listing also states the per-status counts over the whole set, which is the half of the
answer a capped list cannot give, and names the exact command that shows the next page —
the previous wording was `…and 14 more.`, which announces that something is missing and
offers no way to reach it.

**A holder gives the claim back on the way out.** `refs/chat/holder` is stealable on staleness —
`lease.staleAfterSeconds`, 300 — so a holder that simply dies leaves the ref behind carrying the
commit time of its last renewal, and every replica that comes up refuses to claim until that
window passes. The bot is then deaf for the remainder of it, and deaf *silently*: `acts()` is
checked at both inbound doors and a non-holder returns without logging, so a slash command in the
gap shows Discord's own "This interaction failed" and a message typed in a thread is simply gone.

Observed on the 2026-08-19 rollout — pods restarted 20:03–20:05, the ref went stale at 20:09:58,
exactly 300s after the dead holder's last renewal. Shutdown now deletes the ref if this replica
holds it, CAS'd on the oid it wrote so a replica that quietly lost the claim cannot delete its
successor's. The next replica takes it on its first housekeeping pass. It is the same move
`PresenceRegistry.depart` already makes one line later in the same `finally`, for the same
reason: leave the display before closing the connection.

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

**§7.3 keeps the first and corrects the second.** Silence was the right answer to the noise
and the wrong answer to the question, because "the session has it" and "it was discarded"
looked identical from the thread — and it was discarded. Chat while the agent works is now a
steer, acknowledged with a reaction on the human's own message, so the conversation gains no
line and loses no ambiguity. The same argument extends the id-free reading to commands:
`/resume`, `/cancel` and `/task` take their task from the thread when it is not typed.

**A cancelled task's thread is closed, and stops being listened to.** `/cancel` parks the
task, says so in the thread, and archives it. Several tasks can share a thread (a plan's
children inherit their brainstorm's), so a parent going `done` does not close the thread its
children still talk in, and when more than one is live the task AWAITING an answer owns it.
Nothing is deleted: parking stops the work, and the journal is the audit trail.

**Amended by §7.3.** The binding rule this paragraph relied on — only a NON-TERMINAL task's
thread is bound — was written because a bound thread with nothing behind it swallows what is
typed into it. That reasoning was about swallowing rather than about terminality, and it cost
more than it bought: `parked` is terminal, so the thread of a stalled task was unbound at the
exact moment its park notification asked the human to type in it. A thread is now bound unless
the only thing behind it is `done`, and nothing is swallowed because a message to a parked task
is guidance the loop acts on. `/cancel` still archives, which is a stronger statement than
unbinding and the one the human actually made.

**A REPLY names its own task; rank is only what is left when nothing else does.** The rank rule
above picks ONE owner for a shared thread, and for an ordinary message that is the best answer
available. For a Discord *reply* it is not: the payload carries
`message_reference.message_id`, and the message it names is one the bot posted about exactly
one task — so a reply to child `-03`'s question can be placed exactly, instead of being filed
against whichever sibling outranks it. Three tiers, in order, and each covers what the one
before it cannot. An **in-memory index** of message → task, populated as the bot posts and
bounded oldest-first, answers the common case at no request cost. A **REST read** of the
referenced message, parsing the leading `**<task-id>**` every task-scoped message opens with
and confirming it against the snapshot, covers what the index cannot hold: a message from
before a restart, and — in the split of §7 — a notification the *supervisor* posted, since the
process holding the index is not the process that sends them. Neither tier alone is enough,
which is why both exist: index-only loses targeting for every live thread across a rollout,
REST-only cannot place a message Discord will not show us and spends a request per reply.
When both fail, the rank rule still decides — and the reply then **says which task it was
filed against**. That note is not decoration. Answering the wrong sibling silently is the
failure this whole path removes, and where the system cannot avoid guessing, a visible
attribution is the only thing that lets a human catch it. It rides even on a steer, which is
otherwise acknowledged with a reaction alone, because a reaction cannot name a task.

**`/resume` brings back `parked` AND `failed`, but never `done`.** `failed` was left out
of the original command, and it was an oversight rather than a decision — the argument for
`/resume` existing is that the alternative is an operator editing `state.json`, which is a
race against the loop that owns the working copy, and that argument is the same word for
word for a task that failed. It stopped being theoretical when a runner brought up with no
usable provider credential marked six tasks `failed` in ninety seconds, for a reason that
was nothing to do with any of them, and stalled two more behind them — a plan's later waves
are blocked by whatever failed, so the fleet had eight tasks it could not touch and no
command that could help. `done` stays refused: it is the one terminal status where coming
back is not a recovery but a re-run of work that passed every gate and merged.

### The bot runs as its own process

**`src/bot.ts` is a second entrypoint, and the supervisor becomes a pure worker.** The
image ships both (§10); `bot.mode: "external"` plus `redis.enabled` is what selects the
split, and anything else is today's in-process behaviour unchanged.

The reason is **liveness, not duplicate claims.** The duplicate-claim problem was already
solved by the ref below: four replicas produced one acting bot, and that worked. What did
not work is that leadership was refreshed from a supervisor loop and the inbox was drained
between tasks, so a replica in the middle of a four-hour session could neither renew nor
step down, and nothing was drained for the length of the session. The bot was online and
answered nothing. A dedicated process cannot have that failure: it has no sessions to block
on, so its liveness stops depending on any runner's.

What moves with it, and what does not:

- The bot owns the gateway, the bridge, the thread index and the REST half. It **touches no
  state repo and holds no forge or LLM credential** — that separation is most of the value.
  Reads are answered from the Redis snapshot inside Discord's 3-second budget; anything
  that writes goes to the supervisor as an intent on the Redis inbox and comes back as a
  `ChatOutcome` on a reply channel.
- The supervisor keeps everything **outbound**: the notification with an Answer button, the
  typing indicator, closing a cancelled task's thread. Only *reading* the channel has to be
  exclusive, so `external` turns off the gateway and nothing else.
- **Registering the command set (§7.1) also stays with the supervisor**, which looks
  backwards until you follow the credential. Publishing is a PUT authorised by the bot
  token, but it is claimed on a git ref keyed by the commands' digest so that it happens
  once per change across the fleet — and that claim is a push to the state repo with the
  forge credential, the one thing this split defines the bot process as not holding. So the
  bot registers nothing, and the supervisor keeps registering even when it has handed the
  gateway away. Folding registration in behind the same gate as the bridge would leave the
  fleet with no command set and nothing to report it.
- The `/brainstorm repo:` **autocomplete is not completed in the split**, for the same
  reason: the catalogue is built from the configured forges (§9.1.1). An absent catalogue
  produces an empty suggestion list — the same answer a refusing forge gets, so the
  interaction never hangs — and the repo is typed by hand. Nothing is lost but the
  convenience: the supervisor parses and validates it when it drains the intent, and an
  unparseable or cross-workspace repo comes back as a `refused` outcome with a reason.
- The **thread↔task index** cannot be rebuilt from the state repo in a process that has
  none, so the supervisor publishes the bindings its survey already derives (`chat:threads`)
  and the bot consumes them on a timer. Design consequences, both load-bearing: the bot may
  start **before** any supervisor has published, and a binding is always **briefly stale**.
  Absent is therefore not empty — a failed read and a cold start both resolve to
  `undefined`, which leaves the last good mapping alone, while a published `[]` really does
  mean the last live task went terminal and clears it. A thread the **bot itself** bound is
  *pinned* and survives a mapping that has not heard of it: a brainstorm's thread exists
  well before the task the mapping is derived from does, and unbinding it in
  that window would drop the thread a human was just invited to type in. The pin ends the
  moment the mapping mentions the thread, so a terminal task still unbinds — and it also
  **expires on a timer**, because a mapping might never mention the thread at all:
  a brainstorm cancelled before the first survey that would have published it is named by
  nothing, and a permanent pin would leave that dead thread bound for the life of the
  process, swallowing everything typed into it. The expiry is a **duration, not a count of
  refreshes**, and the difference was a real bug: the window the pin must cover is set by
  the *supervisor's* `housekeepingSeconds` (default 30s, plus a pull, a drain and a survey),
  while the bot refreshes on its own unrelated 5s timer. Counting refreshes measured the
  wrong clock and spent the pin in ~15s, so a human typing in a fresh brainstorm thread was
  told the thread could not be placed — and that text is dropped, not queued. A pin covers one window; it is not a lease. A message in a
  thread the bot cannot place produces an **honest reply**, never silence: in a bound thread
  every message *is* the answer, so saying nothing is indistinguishable from the agent being
  busy.
- That honest reply needs the gateway to **deliver** the message the bridge has an answer
  for, and for one revision it did not. The filter consulted the same `ThreadIndex` the
  bridge would, so a thread the bridge would call unbound was one the gateway had already
  dropped, and the branch was reachable only from a direct call in a test. **Routing and
  delivery are therefore separate questions**: the index says which task owns a thread,
  while `ThreadRouter` says whether the bridge sees the message at all. `MESSAGE_CREATE`
  names no parent channel, so deciding "is this a thread of ours?" costs a REST lookup; the
  router memoises it per channel — **both** answers, since a negative cache is what stops an
  unrelated busy channel spending a lookup per message — and the main channel and every
  bound thread stay on the synchronous path. The supervisor's in-process index supplies no
  `deliverable`, so that path keeps today's behaviour and makes no REST call per message.
- Redis is **required** for this process, unlike everywhere else in §21. It is the only
  route to the supervisor, so a bot without it would acknowledge every command and answer
  none. It refuses to start rather than come up and fail each command individually.
- The `bot.mode` interlock is checked from **both** sides, because the two failures are
  different and only one of them was diagnosable. `external` without Redis makes the
  *supervisor* keep the gateway and warn (`bot.mode-ignored`); running the *bot* binary
  under any mode but `external` makes it warn in turn (`bot.mode-mismatch`), because the
  supervisor has then kept the gateway too and both processes act. Nothing downstream
  catches that pair: they arbitrate by different mechanisms — the supervisor by the git CAS,
  the bot by the Redis TTL lock — so each is uncontested in its own scheme and every command
  is answered twice. Both are warnings rather than refusals, so a config slip degrades
  loudly instead of taking the fleet off Discord.

**Leadership: one replica, plus a Redis lock for the rollout.** The bot Deployment runs
**one** replica and needs no leadership object at all — `acts()` already treats absent
leadership as yes. One replica is not one *process*, though: a rolling update overlaps two
pods, and both would act, which for `/brainstorm` means two threads and two tasks. So the
bot takes a **Redis key with a TTL** (`chat:holder`, `SET NX EX`, renewed on its own timer,
released on shutdown so the incoming pod need not wait out the TTL).

Keeping `ChatLeadership` and refreshing it on a timer was considered and is **unbuildable
here**: `refresh()` goes through `claimStealable`, which is `ls-remote` plus a ref push, and
that needs exactly the forge credential the split exists to take away. The docstring's old
objection to a timer — that it would renew while a session blocked the loop — *is* void for
this process, but the credential constraint decides it instead.

Redis is acceptable for this decision where it is explicitly **not** acceptable for leases
(§21): losing a task lease means two runners writing one task and a commit that can never
rebase, while losing the chat lock costs one duplicated Discord message. When Redis is
unreachable the bot **does not act**, which is the same honest reading `refresh()` takes of
an unreachable remote, and it composes with the readiness probe below.

**Health is gateway-connectedness and Redis reachability, not a bound port.** `/readyz`
reports both and fails if either is down; `/healthz` stays cheap and almost always true.
The split matters: restarting the process does not fix a Redis outage, so a liveness probe
that reacted to one would turn a dependency's bad minute into a crash loop, while a
readiness probe that ignored it would keep a pod in the Service that can answer nothing.
That is `supervisor/loop.ts`'s containment lesson — a process answering probes while doing
nothing useful is worse than one that exits — applied to the process whose entire job is to
be reachable.

**One replica of a fleet acts on Discord.** Every replica connects to the gateway — that
is what keeps the bot online across a rollout, and a connection costs nothing — but
exactly one may act on what arrives over it, decided by a compare-and-swap on
`refs/chat/holder` (`claimStealable`) refreshed from the **housekeeping** loop (§6.4). The
same mechanism as a task lease and as the digest's day ref, because the state repo is the
only thing the fleet shares and so the only place a fleet-wide decision can be made. This
is the arrangement for a fleet running the bot **in-process**, which remains the default
and the development path; a split-out bot uses the Redis lock described above instead.

It was refreshed from the single poll loop, and deliberately not from a timer of its own:
a timer would keep renewing the claim while a session blocked the loop, advertising a
holder that could not currently answer anything. That objection is void now, because the
thing on the other side of the claim moved with it — the housekeeping loop IS what drains
the inbox and applies `/resume` and `/answer`. A replica that renews here is by
construction a replica that can answer. The arrangement it replaces had the worse failure
anyway: renewing and *stepping down* are both the same call, so a replica that took the
claim and then started a four-hour session did neither for four hours — it went on
believing it was the holder while the claim went stale, online and answering nothing.

Nothing said this at first, and four replicas each handled every event. Reads mostly hid
it: Discord accepts one response per interaction token, so three replicas simply failed
and logged it. `/brainstorm` did not hide it at all — a brainstorm's id is derived from
the thread Discord has just created for it, so one command would open four threads and
mint four unrelated tasks. An `!answer` was four runners writing the same state repo,
which is how a runner ends up holding a commit that can never rebase (§4).

The claim is stealable on the same terms as a lease, and for the same reason: the ref
outlives the process that wrote it, so a claim nobody can take is one nobody can ever hold
again — the fleet would lose its bridge permanently at the first deleted pod. It is
refreshed from the loop rather than a timer of its own, so a replica whose loop is blocked
by a session stops advertising itself as the holder instead of holding a claim it cannot
currently answer on.

**`/resume` forgives the no-progress streak, and nothing else.** `checkLimits` runs
*before* a claim's first session, so any limit still met at resume time parks the task
again having run nothing — on 2026-08-16 a resume and the re-park that undid it landed in
the state repo five seconds apart, and the command had reported success. The streak is
cleared for the reason `/answer` already clears it: it is a measurement of the agent's
last few sessions, and a human reading a parked task and saying *keep going* is new
information about the next one. `sessions` and the review rounds are budgets rather than
measurements, so resuming does not forgive those — the reply names the one that still
stands and says the task will park again on the next claim, without running, until a
human raises it.

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

Commands are registered **per guild**, and the runner does it **itself, at boot, once per
change across the whole fleet, ever**. Guild registration takes effect instantly where
global registration is eventually-consistent, and it is a full REPLACE — the `COMMANDS`
array is the entire surface, so a command deleted from it disappears from the client.

It used to be a deploy-time step run by hand, for one real reason: the supervisor restarts
on every deploy and there are four of it, so a naive call in `main()` writes the identical
command set once per pod per rollout. That objection is about redundant *writes*, not about
who does it — and the cost of answering it with a human was paid in full when `/brainstorm`'s
autocompleted `repo:` box (§9.1.1) shipped as code and stayed a plain text field in Discord,
because the step was forgotten.

So the write is claimed, on `refs/commands/<digest>`, where the digest covers the commands
AND the guild. The same compare-and-swap as a task claim (§5), in the same shape the daily
digest uses (§19), with the same four properties:

- **the ref's existence IS the record** that this exact set has been published, so a restart
  registers nothing and there is no in-memory flag to lose
- **a changed set is a changed digest**, so the first boot after a deploy publishes it and
  every boot after that does not
- **a claim that errors is not a claim someone else won** — a rejected push is also what a
  dead network looks like, and reading it as a win would mark a set published that nobody
  published
- **a failed write hands the claim back**, because a claimed-but-unregistered set is
  invisible and nothing would ever revisit it

It is fire-and-forget and cannot fail a boot. A registration Discord refuses is a 403 for a
missing `applications.commands` scope, which no retry fixes and which stops nothing else: the
bridge still runs, and `!answer` and the buttons never depended on it.

`npm run discord:register` remains, and remains unconditional — it is the escape hatch for
what a digest cannot see. Commands edited or deleted **in Discord** leave the ref saying
"published" and the guild disagreeing, and it is also how a command set is iterated on
against a test guild from a workstation, with no pod and no state repo.

### 7.2 The presence says what the fleet is working on

`/tasks` and the web view both answer "what is Caterpillar doing" and both have to be
asked. The bot's Discord presence answers it without being asked, in the member list, which
is where somebody who is already in the channel is already looking. That is the whole
feature: **"Watching ALERT-6155db · implementing"**, or **"Watching for work · 4 ready"**,
or — the one that should change what you do next — **"Watching 1 waiting for you"**.

**It is rendered from the survey, not from the live session.** `obs/live.ts` knows what THIS
runner is doing and nothing about the other three, so a presence built from it would say
`idle` on three replicas out of four and race to overwrite whichever one was right. The
survey is every task's committed state, read out of the state repo, so all four replicas
render the *same* string — which is what makes it safe for all four to send it.

**Every replica publishes, unlike everything else on Discord.** §7's rule is that every
replica connects and exactly one *acts*, because four replicas acting on one `!answer` did
real damage. A presence is not an action: it is idempotent, carries no state, and four
identical payloads converge on the identical result. Restricting it to the chat holder would
be strictly worse — the status would go stale for as long as a claim handover takes, and a
bot advertising `idle` while a session runs is the exact thing this exists to prevent.

**It rides on IDENTIFY, and is re-sent on RESUMED.** Carried in the IDENTIFY rather than as
a separate opcode 3 so a reconnecting replica is never briefly online with no activity — on
a fleet that reconnects during every rollout that would be a visible flicker to no purpose.
A RESUME carries no IDENTIFY, so it gets an explicit re-send; without that, a runner comes
back from a blip still advertising what it was doing before the blip, and the runners with
the longest outage are the ones lying hardest. A READY does *not* re-send, because the
IDENTIFY beside it already did.

**Only changes are sent.** Presence updates are rate-limited per connection and the survey
runs every housekeeping tick, so an unchanged line is dropped rather than re-sent — a runner
that sent unconditionally would spend its whole idle life burning the allowance it needs at
the moment the state actually changes. The `since` timestamp is restamped only on a real
change, so Discord's elapsed timer measures how long the fleet has been in *this* state
rather than how long the pod has been up.

**Activity type 3, `Watching`.** Discord renders it as "Watching <name>", so the strings are
written to read as English after that word. Type 4 (`Custom`) would drop the verb and read
better, and is deliberately not used: its support for *bots* has changed more than once and
the failure mode is a status that silently renders as nothing at all.

Published from `survey` (`supervisor/loop.ts`) — the one place in the process that has just
read every task's state — which since §6.4's split runs on the **housekeeping** loop. That
matters more than it looks: on the old single loop the presence would have frozen for the
whole of a session, which is precisely the interval it exists to describe.

### 7.3 A session can be steered, and a parked task can be argued with

§7 gave a human one way in: the agent calls `ask_human`, the task parks, an answer is
committed, and the NEXT session reads it out of a file. That is the right shape for a
question the agent chose to ask. It is the wrong shape — and for a long time it was the
ONLY shape — for the case a human actually finds themselves in, which is watching a thread
and being able to see that the session is going the wrong way.

`BS-1539374658363854934` is what that cost. The plan was sent back **13 times** against a
cap of 3, and every mechanism that was supposed to prevent that worked exactly as designed:

- The council rejected the plan on `feasibility`, `decomposition` and `criteria`.
- The round cap parked it at 3, as §12.1 says it should.
- The park notification said: *"Say what to change — here in this thread — then `/resume`."*
- The human resumed. The same session proposed a similar plan. It was rejected again.
- Ten times.

Four separate defects, and the reason they are one section rather than four is that each one
on its own is invisible: a human who cannot type anywhere useful cannot find out that the
typing was going nowhere.

**The park was posted in the channel, and it named the thread.** Every other outcome of a
review round reached the thread through `notifyTask`; `park` was the one call site that
called a `notify(notification, threadId?)` whose thread argument was optional, and omitted
it. So rounds 1 and 2 appeared in the thread and the park that ENDED the loop appeared in
`#caterpillar` — read from the thread, the conversation simply stopped. The fix is not that
`park` now passes the id, it is that **there is no longer a way to send a task notification
without its thread**: `notifyTask(state, notification)` is the only method, it takes the
state because every caller has one, and the optional-argument version is gone.

**A parked task's thread was unbound.** `threadBindings` dropped every task `isTerminal`
called terminal, which includes `parked`, and the argument for it was sound: a bound thread
with nothing behind it swallows what is typed into it, because the loop answered
`not-waiting` and the bridge — correctly, under §7.1 — said nothing. But that argument is
about SWALLOWING, not about terminality, and the two coincided only because there was
nothing a parked task could be told. Now there is. A thread is bound unless the only thing
behind it is `done`, which is the one status `/resume` refuses and so the one where a
message genuinely has nothing to ask for. Where several tasks share a thread, `rank`
decides: the task awaiting an answer, then one that can still move on its own, then one
waiting to be resumed — so guidance meant for a running child is not filed against a parked
sibling.

**`/resume` was refused in the thread of the task it names.** The interaction gate tested
`ThreadIndex.knows`, which is a BINDING, and `/resume` addresses nothing but parked and
failed tasks — so the command was refused with *"I only act in #caterpillar and its
threads"* in a thread of `#caterpillar`. The gate now asks whether the channel is a thread
of ours, which is what §7's containment rule actually means and is a question about the
CHANNEL rather than about any task's status. It is answered from
`interaction.channel.parent_id`, which Discord sends on every interaction and which costs
nothing — no binding, no REST call, nothing that can be stale, and none of the three seconds
an interaction has. `MESSAGE_CREATE` carries no parent, which is why the message path still
needs `ThreadRouter` and this mostly does not.

While the gate was wrong, so were the ergonomics behind it: `/resume`, `/cancel` and `/task`
required a task id typed into a thread that already identifies one. Their id is now optional
and defaults to the thread's task. `/answer` deliberately does not — in a task's own thread
every message is already the answer, so the command only exists there to answer a DIFFERENT
task, and defaulting it would also force `text` ahead of it in the option order, reshaping
the one command people type from muscle memory.

**Nothing carried the text anywhere.** `applyAnswer` required `awaiting-human` with an open
question and returned `not-waiting` otherwise, and the bridge dropped that outcome without a
word. The human's sentence was read, matched, and discarded — while three separate surfaces
(`plan-stalled`, `verdict`, and `/task`) told them to type it. So there is now one entry
point and four answers, decided by what the task is doing rather than by what the bridge can
see:

| the task is | what a message in its thread does |
|---|---|
| `awaiting-human`, question open | the answer file, exactly as §7 always did |
| `running` | a **steer**, delivered to the live session |
| `ready`, `parked`, `failed` | **guidance**, journalled for the next session |
| `done` | nothing to say to it; the reply says so and names `/brainstorm` |

#### Steering, and why pi already had it

A steer is not a restart. `Agent.steer` queues a message and pi's loop drains it at the next
turn boundary — after the current assistant turn's tool calls finish — so the session keeps
its context, its worktree and its work, and the message lands within one turn. The
alternative shape, which is what `ask_human` does, costs a park, a release, a fresh claim and
a whole context rebuilt from the journal.

`steeringMode` is `all` rather than `one-at-a-time`. Refining an idea is many short replies
(§14.3), so several messages routinely arrive inside one turn; draining them one per turn
would spend a provider request on each and deliver the last several turns after it was
typed, by which point it is advice about work already done.

**What arrives is journalled, not what is consumed.** `shouldStopAfterTurn` exits pi's loop
BEFORE it polls the steering queue, so a sentence that lands in the same turn as an
`ask_human` or a handoff is queued and never seen. The journal is what the next session's
prompt is built from, so recording what arrived puts the guidance back in front of the agent.
Being wrong that way costs one repeated instruction; being wrong the other way loses a
human's correction between two sessions, which is the failure this whole section is about.

It is written in `recordSession` and it can only be written there. Writing the state repo
needs the lease, the session holds it for its whole run, and `recordSession` is the first
point after the session where the lease is still held and a journal shard is already being
written. That is also why guidance for a `running` task writes nothing at the time —
`applyPark` has the same constraint for the same reason — and why the reply for it is
`steered` rather than `guided`.

**The feed belongs to the SLOT, not the session.** `workTask` drives a task through as many
sessions as it needs, and a sentence typed during a changeover has nowhere else to wait, so
`SlotSteering` buffers with nobody subscribed and hands the backlog to the next session's
`take()`. On the slot rather than on the supervisor for `slot.cancel`'s reason one step
further: at N slots a steer has to reach ONE session, and the routing is by task id.

Crossing a process boundary is `redis/steering.ts`, which is `cancel.ts` with one difference
that matters. A cancel is idempotent — the second says nothing the first did not — so a
single key is a complete record of it. Guidance is not: *"use the existing migration path"*
and *"and skip the second wave"* are two sentences and losing either loses half of what was
said. So it is a LIST, drained by the session and by nobody else, expiring after four hours
— long enough to survive a handoff or a park-and-answer, short of a working day so nothing
typed today ambushes the session that claims the task tomorrow.

#### The acknowledgement is a reaction

§7.1 answered ordinary chat in a busy thread with SILENCE, to stop a conversation of many
short replies becoming a wall of receipts. It was right about the noise and wrong about the
silence: "the session has it" and "it was discarded" looked identical, and until this section
the second was what actually happened.

So a steer is acknowledged with 👀 on the human's OWN message — no new line in the thread,
and no ambiguity. Reactions need `ADD_REACTIONS`, which an existing installation may never
have granted, so `react` returns whether it landed and the bridge says it in words when it
did not. An acknowledgement that silently fails to happen is the exact defect being fixed.

#### Guidance resets the review rounds, and a bare resume still does not

A deliberate departure from §12.1, which says the round budget is a budget and `/resume` does
not forgive it. That rule is right for a bare resume and wrong for guidance, and the
distinction is **information**. The cap exists because the agent and the council can trade a
task forever with nothing new entering the loop; guidance is precisely something new entering
the loop, and it is the only thing that is.

Without this the fix does not work. Guidance would land, `/resume` would put the task back at
13 rounds against a cap of 3, and the next rejection would park it again immediately — so the
advice would never be tested, and the human would conclude, correctly, that nothing they
typed had any effect. The argument §7 already makes about `noProgressStreak` ("answering IS
the progress") reaches the same answer here, and `describeOutcome` states which of the two
happened rather than letting a human discover it when the task parks itself thirty seconds
later.

`sessions` is still not forgiven, and neither is `review.last` or `review.reason` — those are
the record of what the council said, and a human resuming wants to see what they are
answering.

#### A review left in the forge is guidance too

Everything above gives a human one place to talk: the task's Discord thread. The place they
actually are is the pull request. §12.1 let the review council block a change with a verdict
and left a human unable to do the same thing without switching surfaces — so a reviewer who
read the diff, found the swallowed error, and wrote it on the line it was on was **talking
into a void**. Nothing read it, and the next session opened with no idea it existed.

So unresolved review comments are a guidance source, fetched at session start and spliced
into the prompt after the handoff — last, because the prompt orders itself most-actionable
closest to the model's attention, and an objection from outside the loop is the most
actionable thing in it.

**The supervisor fetches, and it is the SESSION RUNNER that does it.** Not the loop: the
loop's forge dependency is narrowed to `RepoReach` on purpose (§9.1.1) — it answers whether a
repo can be reached and cannot mint a token — and widening it to a minting factory to read
some comments would trade that bound for a convenience. The runner already holds the task's
scoped forge and its credential lease for exactly the length of the session, so the read costs
no new credential and no new plumbing. The agent still never holds anything (§9.2): what it
gets is rendered text.

**A forge that cannot be reached does not fail the task**, per invariant 6 and exactly as
tracker mirroring behaves. The review is not the work, and a 500 from GitHub costing a task
its session would be a worse failure than a session that ran without seeing a comment. The
failure is logged per pull request, so one unreachable sibling does not discard what the
primary already answered.

**Which comments count** is decided in one pure place, `agent/review-guidance.ts`, and the
answer is narrower than "all of them" in two ways that matter:

- **A closed thread is not an instruction.** A resolved comment was accepted and an outdated
  one was written against a line that no longer exists. Quoted in full they send the agent to
  redo work that already landed, and on an old pull request they are most of what there is to
  read. So they are counted rather than quoted, and the count appears only BESIDE something
  still open — it says "part of this review is already answered", which is worth knowing next
  to the part that is not and is a sentence about finished work on its own. A pull request
  whose every thread is resolved renders no section at all.
- **The fleet's own voice is not guidance.** The agent replies to reviews and the reviewer
  identity posts approvals, both onto the pull request being graded. Read back, they are a
  loop with no human in it. On GitHub the discriminator is GraphQL's `author.__typename`,
  which reports `Bot` for any App; on Forgejo the fleet is an ordinary account, so it is the
  account the tokens were issued for.

GitHub's read is the one GraphQL call in `forge/github-app.ts`, and it has to be: thread
resolution is exposed nowhere but `pullRequest.reviewThreads`. On REST alone every comment a
human ever accepted would arrive as an open instruction forever. Forgejo needs no such thing —
Gitea's `PullReviewComment` carries `resolver`, the account that closed the thread — but it
does need two levels, because a review's own BODY is where "this is the wrong approach" gets
written and reading only per-line comments drops every objection about the change as a whole.

**A comment resets the review round count**, for §12.1's reason word for word: the cap detects
a loop with nothing new entering it, and a human objection is precisely something new. Left
unforgiven the whole feature does not work — a task already at the cap parks on the very next
rejection, so the objection is never tested and the human concludes, correctly, that
commenting had no effect.

It is forgiven **once per objection**, which is the other half. `review.commentSeen` records
the newest comment already acted on, and forgiving without it would delete the cap rather
than inform it: one comment would buy a round on every session for the rest of the task's
life. The reset is written in `recordSession` rather than in `convene` because of the
ordering — `recordSession` runs first, and a round forgiven after the council has spoken has
already been spent. `review.last` and `review.reason` are untouched, as they are for typed
guidance: a human who commented wants to see what they are answering.

#### What is deliberately absent

**No `/steer` command.** Every message in a task's thread already is one, and a command
language in the one place §7.1 removed it would be the same friction arriving under a new
name.

**No replying to a review comment, and no resolving one.** The agent answers a review in the
code, which is where an answer belongs; a thread the fleet closed itself would be a thread the
human never agreed was finished. Marking one resolved is a human's act on both forges and
stays one.

**Nothing polls the forge between sessions.** A comment left mid-session is read by the next
one, not delivered into the running one. Steering already exists for the case where somebody
wants to interrupt, it costs no forge requests, and a review comment is written to be read
against the whole change rather than mid-turn.

**Steering is not offered to the council, the plan maintainer or the digest summariser.**
They all call `runSession` and all pass nothing. They are not the agent, they run for minutes
rather than hours, and a verdict a human leaned on is not a verdict.

**No steering without a thread.** A task nobody is watching has nobody to steer it, and
`/answer <id> <text>` from the channel reaches the same code path for the case that needs it.

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

**`nix` is DERIVED at boot, not read from config** — the only capability that is. Every
other one asserts something no program can check: a GPU is wired in, a USB device is
plugged in, a human is in the room, so a person has to say so. "Can this machine build an
environment" is answered by whether nix runs, and asking is exact and free.

Deriving it closes the same hole from the other side. Capabilities otherwise come only from
the ConfigMap, so a runner whose image gains nix while its config still says
`["linux", "net"]` leaves every task declaring a toolchain `ready` forever, claimable by
nobody — §8's deadlock again, arriving through stale config instead of through the closed
enum, and just as silent. Config still wins where it can be right: a declaration is kept,
and a declaration the machine cannot honour is a warning at boot rather than a removal,
because the operator may be installing nix next and a config the runner quietly edits is
worse than one that is merely wrong.

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
  expression and every version it resolves to. The existence check matters because the cache
  entry and the store have independent lifetimes: a garbage collection can take a path, and
  a store that is not on durable storage is replaced wholesale by a deploy while `env.json`
  survives on the PVC. An unverified hit would not fail loudly — it would hand the agent a
  PATH of directories that are gone, which looks exactly like the missing toolchain this set
  out to fix.

**Where the store lives is a deployment concern, not a code one.** The supervisor is
indifferent: it asks nix, and nix reads `/nix`. Relocating the store with `NIX_STORE_DIR` is
the one thing that is not an option — store paths carry their literal `/nix/store` prefix
inside the binaries, so moving it invalidates every binary-cache substitution and forces
builds from source.

In the cluster a volume is mounted at `/nix`, seeded from the image's own closure by an
initContainer (`deployment`, `apps/workloads/caterpillar`). Without it every deploy
throws the store away, and since keel rolls the workload on every push to `main`, a task
needing a dotnet SDK would re-download over a gigabyte each time. Nothing in this repo
changes for any of it — which is the point, because a machine runner and a local
`docker run` have no such mount and must keep working.

**A fleet gets one store per replica, and there was never a choice about it.** The cluster
offers exactly one storage class, `local-path`: node-local and `ReadWriteOnce`. There is no
`ReadWriteMany` to be had at any price, so a shared `/nix` is not an option that was
weighed and rejected — it does not exist. The volumes therefore come from a StatefulSet's
`volumeClaimTemplates` rather than from a claim the manifests name, which is the entire
reason the workload is a StatefulSet and not a Deployment (§10).

Sharing the store between co-located pods via `hostPath` *would* be possible and is
deliberately not done. Nix supports concurrent processes against one store — that is what
`/nix/var/nix/db/big-lock` is for — but two containers writing one SQLite database through
separate mount namespaces is not a configuration nix tests, and the failure mode is a store
whose database has forgotten paths that are still on disk. It would also pin every replica
to one node, which is the opposite of the goal.

**So the cost of a fleet is N stores, and the fix is a shared binary cache rather than a
shared store.** The distinction matters: a replica must *materialise* every closure it
runs, so nothing can make the disk cost sublinear. What can be made sublinear is the
*fetch*. Almost nothing here is built — a devShell of dotnet, go, node and python is
substituted from `cache.nixos.org` byte for byte — so `toolchain.substituters` points every
runner at an in-cluster pull-through cache first. One replica pulls a 3.8G closure over the
internet; the rest, and the same replica after its next garbage collection, get it over the
LAN.

That shape needs **no signing key and no push path**, which is why it is a caching proxy
and not harmonia or attic. The proxy passes the upstream's own `narinfo` through untouched,
signature included, so nix verifies against the `cache.nixos.org-1` key it already trusts.
Nothing has to trust the proxy — it is a cache, not an authority. A store that served
*locally built* paths would have to sign them, and `toolchain.trustedPublicKeys` exists for
that day without being needed today.

Two properties of how it is applied are load-bearing:

- **It is set through `NIX_CONFIG`, not through flags on the resolver's own `nix` call.**
  That reaches every nix in the session — `nix-collect-garbage`, and the agent's own
  `nix build` inside its bash tool — and it survives into the resolved devShell
  environment, which a flag on one argv would not.
- **It is `extra-substituters`, appended, never `substituters`.** `cache.nixos.org` stays
  in the list, so the cache being down costs a failed request and a slower fetch rather
  than building a compiler from source. The append also matters mechanically: the image
  ships `NIX_CONFIG="experimental-features = nix-command flakes"`, and assigning over it
  turns every flake reference into an error about an experimental feature.

`extra-substituters` from an untrusted caller is silently ignored by a nix **daemon**. This
image runs single-user nix with `node` owning `/nix`, so the caller is the trusted user and
it is honoured — worth knowing before anyone introduces a daemon.

#### The store's quota is `min-free`, and the volume size is not a quota at all

The `nix` `volumeClaimTemplate` requests 15Gi and that number **enforces nothing**. Under
`local-path` a PVC is a directory on the node's own filesystem: the request decides where
the pod is scheduled and the provisioner applies no limit whatsoever. A store that grows to
60Gi does not get ENOSPC at 15 — it fills the node and takes every other pod on it down.
There is no storage class here that would behave differently, and `ephemeral-storage`
limits govern the container's writable layer and emptyDirs, not a PersistentVolume.

That is worth stating in this much detail because the manifest reads exactly like a quota,
so the failure would arrive as a surprise on a node nobody was watching.

The actual bound is nix's own automatic collector, set through the same `NIX_CONFIG`:
below `toolchain.minFreeGb` of free space on the store's filesystem, nix garbage-collects
**mid-build** until `maxFreeGb` is free again. Three properties make it the right
instrument rather than a store-size cap:

- **It measures the NODE**, which is the thing that actually breaks. Four replicas' volumes
  share one disk with everything else scheduled there, so per-store ceilings that are each
  individually fine still add up to a full node.
- **It fires while the store is GROWING**, not on a timer. `maybeCollectGarbage` runs on the
  idle branch every `gcIntervalHours`; a substitution that adds 4GB in ninety seconds
  happens entirely between two of those.
- **It costs nothing when there is room** — a `statvfs` before a build. So the age-based
  pass stays the thing that decides *what* is worth keeping, and this only decides when
  keeping it stops being affordable.

`maxFreeGb` must exceed `minFreeGb` and the loader refuses otherwise. With no gap nix has
already met its target the moment it starts collecting, so it collects on every build and
frees almost nothing — a store that thrashes its collector while still filling the disk,
which from outside reads as "the quota is on and not working". Either number could be the
typo, so neither is guessed at.

**On by default (5/20 GiB), unlike the caches**, which default to empty. An unbounded store
is how a runner takes down the machine it is on, and that is not a cluster-only hazard — a
workstation runner filling a laptop's disk is the same failure with a shorter fuse.
`minFreeGb: 0` is the documented off switch. The GC roots `print-dev-env --profile`
registers still protect a live task's environment, so an automatic collection cannot delete
the toolchain of the session that triggered it.
- **nixpkgs is pinned** for generated environments. An unattended agent picking up a silent
  bump produces a red acceptance run with no diff to explain it.
- **A toolchain that will not build parks the task**, naming nix's own error. Falling
  through to the inherited environment would hand the agent a shell missing the exact tool
  the task is about, and it would spend a session and a few dollars discovering that.

#### A declared toolchain is checked before the task exists

Parking on nix's own error is the right answer once a task exists, and it is an expensive
way to learn about a typo. `toolchain.packages` is free text: §14.1 checks that the block
is *shaped* right — `mode` is one of two words, `packages` is a non-empty list of strings —
and nothing checked that the names in it resolve. So `lua51` (the attribute is **`lua5_1`**)
passed intake, became a task, was claimed, and failed inside the session in
`nix print-dev-env`. A session spent on a missing underscore.

This is §9.1.1 with a different exit code, so it gets the same answer: ask at the door.
`workspace/toolchain-doctor.ts` evaluates `pkgs ? <attr>` against the configured pin for
each declared name and, **only when one is missing**, a prefix-filtered `attrNames` for the
near miss — one evaluation, because the candidate list is wanted only when the answer is
bad. It **evaluates and does not build**: nothing is substituted or compiled. Measured
against the shipped pin on a warm store, ~0.5s.

**The ceiling is 30s and is a bound on intake, not on nix.** Not
`toolchain.timeoutSeconds`, which is 900 because it bounds a devShell build that may
compile from source. Intake runs on the supervisor's own thread of control, once per
interval, over every labelled item — so an item whose evaluation hangs stalls every item
behind it, and at 900s one cold nixpkgs fetch would hold up a pass for fifteen minutes. A
cold fetch was measured at ~45s and therefore exceeds the ceiling: it fails open and is
checked on a later pass once the store is warm, which is the right trade, because the worst
case is an unchecked item and that is precisely the behaviour that existed before.

**It fails open, and that is the load-bearing half.** Every answer that is not "nix ran and
said no" lets the item through: no nix on the runner, an evaluation that timed out, a pin
that could not be fetched, output that would not parse. A nix evaluation that times out is
not evidence that an attribute is wrong, exactly as a 500 from GitHub is not evidence that
an App was uninstalled (§9.1.1). Getting this backwards would be worse than having no check
at all: on a runner without nix *every* declared toolchain is unevaluable, so a strict
check would refuse every item that had bothered to declare one — and suppress each refusal
durably (§14.2).

A missing attribute is reported by an evaluation that **succeeds**, which is what makes the
distinction clean: a non-zero exit from `nix eval` always means the question could not be
answered, never that the answer was no.

Two details worth keeping:

- **The near miss is ranked by a squashed comparison first**, then by bounded edit distance —
  the same idea as §9.1.1, tuned for attributes rather than slugs. `_`, `-` and `.` are
  separators nixpkgs uses inconsistently (`nodejs_22`, `lua5_1`, `gcc-unwrapped`) and nobody
  remembers which, so squashing is what finds `lua5_1` for `lua51`. Prefix matches are
  deliberately *not* ranked, which is where it parts company with `rankRepos`:
  `lua51Packages` contains the whole query and is a set of lua modules rather than the
  interpreter the author meant.
- **A name that is not a bare attribute is skipped, not refused.** The name is interpolated
  into a nix expression this process then evaluates, so only `[A-Za-z0-9_+-]+` is ever put
  there. `.` is excluded with the rest, because `pkgs ? ${a.b}` asks about a *nested*
  attribute and the answer would not mean what it is read as meaning.

  But unaskable is not invalid, and an earlier version got this wrong: it *refused* a dotted
  path on the stated reasoning that "nix would reject it too". Nix does not.
  `generatedFlake` interpolates declared names into `with pkgs; [ … ]`, where
  `python3Packages.requests` is legal and builds today — so intake was refusing toolchains
  the resolver handles. Such a name is now skipped and the rest of the list is still
  checked, which is the same fail-open rule the section above applies to a missing nix: no
  evidence, no refusal. Validating per segment with `builtins.hasAttrByPath` was considered
  and rejected — it would commit the doctor to reasoning about nested attribute sets to
  catch a typo inside a package set, rarer than the false refusal it replaced.

`mode: inherit` declares no packages and is a no-op, not a refusal — as is `mode: nix` with
no `packages`, where the repo's own nix expression decides and the repo is not checked out
at intake.

Provenance: `orca vm recipe doctor`, which validates a per-workspace environment recipe
without provisioning it.

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
  "repositories": ["all-chat"],            // repos named in spec.md, ∩ the workspace scope
  "permissions": { "contents": "write", "pull_requests": "write" }
}
```

No admin, no workflow.

> **`spec.repos` is a narrowing filter, not the boundary.** It reads like one, and it
> was treated as one for a while, and that was wrong: `spec.md` is rendered from a
> GitHub issue body, a Vikunja description, or a plan the previous session wrote. All
> three are outside the operator's control, and an outside contributor can edit their
> own issue body after a maintainer has labelled it. Checking a credential request
> against `spec.repos` — which is what `assertInScope` does on its own — compares an
> attacker-chosen value against an attacker-chosen list. It always succeeds.
>
> The real bound is the **`WorkspaceScope`** (`src/config/scope.ts`), built from the
> ConfigMap and nothing else:
>
> - `repo.host` must equal the workspace's own `forge.host`. Without this, a spec
>   naming `evil.example.com/<owner>/<repo>` gets cloned from that host with the
>   credential helper attached; the server answers `401`, git offers the credential,
>   and the helper hands over a live token. On Codeberg that token is owner-wide and
>   never expires.
> - the **state repo is excluded**, compared case-insensitively because GitHub
>   resolves `Caterpillar-State` and `caterpillar-state` to the same repository. This
>   is what makes §9.3 true in code rather than by convention.
>
> Enforced in four places, deliberately redundantly: at `renderSpec` and `materialise`
> so a human or an agent gets a refusal naming the repo, in `ForgeFactory.forTask` so
> nothing is cloned, and in `CredentialService.answer` plus `Forge.credential` because
> that is where a token actually leaves the supervisor. Only the last two are the
> boundary; the first two exist so the failure is legible.

With both layers, `TASK-123` cannot touch `deployment` unless its spec says so
**and** `deployment` is on the workspace's forge and is not the state repo.

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
the installation id, proves the installation can reach the repo you name, and proves
per-task repo scoping works, without printing a token.

### 9.1.1 A repo the credential cannot reach is refused at the door

Everything above bounds which repos a task is *allowed* to name. Nothing asked whether
the credential can *reach* the ones it named — and the answer arrived at the worst
possible moment.

```
BS-1539331435477860432 parked — session failed: git clone --mirror
  https://github.com/acme/allchat.git failed (128):
  caterpillar-cred: GitHub /app/installations/153385932/access_tokens failed with 422:
    the App is not installed on one of the requested repositories
  fatal: could not read Username for '…': terminal prompts disabled
```

The repo is called **`all-chat`**. Somebody typed `allchat` into `/brainstorm`, and every
check on the way in passed: it parses as `owner/name` (§domain), it is on the workspace's
host, it is not the state repo, so it resolved to a workspace and became a task. A runner
claimed it, spent a session, and died on the first thing a session does. The park reason
named an installation id and a git exit code; the one word that mattered — `all-chat` —
appeared nowhere.

**Why the mint cannot say it.** `POST /access_tokens` answers **422 for a repo that does
not exist and 422 for a repo the App is not installed on**, with a body of
`{"message": "Unprocessable Entity"}`, and it takes `repositories` as *names* — so it does
not even echo which one it refused. A 422 is not evidence about an installation. Reading
it as one sent the operator to the App's settings page for what was a dash.

The question is therefore asked from the other side: **`GET /installation/repositories`**
returns the list, so the difference can be computed here, and a list makes the useful
sentence possible — *"`acme/allchat` is not one of the 65 repositories this
workspace's GitHub App can see. Did you mean `acme/all-chat`?"* Near misses are
ranked by a squashed comparison first (`-`, `_`, `.` and case are what people retype
wrong: `AllChat`, `all_chat`, `allchat` are all one edit from nothing) and then by bounded
edit distance. `ForgeFactory` answers it — one per workspace, which is the unit a
credential belongs to — and Forgejo answers the same question from what it has: a token
configured for the owner, and a `GET /repos/{owner}/{name}` that is not a 404.

Asked in three places, each the first moment the answer is cheap:

- **the `/brainstorm` door** (`applyBrainstorm`) — a refusal typed back into the channel
  before a task exists. This is where the incident above was avoidable.
- **intake** (`Ingester`) — an `agent` block's `repos` list is free text too, and on that
  path nobody is watching: the refusal becomes a comment on the item, recorded and
  suppressed exactly like every other intake refusal (§14.2).
- **before every session** (`workTask`) — the net under both, and the only one that
  catches a repo that became unreachable *after* the task was created, or one that arrived
  through a plan (`materialise` resolves repos from agent free text and is synchronous, so
  it does not ask; its children are caught here). The task parks with the sentence instead
  of with a git exit code, and no session is spent.

Re-asked per session rather than cached per task, because the answer changes without the
task changing: an App uninstalled mid-task, or one installed a minute ago by the human who
read the last park reason. The listing behind it is cached for five minutes, so the steady
state costs one request per workspace per five minutes — the same budget §14.2 rations.

A **hit is served from that cache and a miss is not**: an absence is re-read from GitHub
before it becomes a refusal. A repo installed a minute ago is absent from a five-minute-old
list, and "your brand-new repo does not exist" is the one wrong answer this check exists to
stop being given. It is affordable exactly because misses are rare, and it is bounded to one
re-read per call however many repos miss.

**Every one of the three fails OPEN.** A forge that throws has told us nothing: a 500, a
DNS blip, an expired key. Refusing a `/brainstorm`, or parking a task, over that would be
strictly worse than the clone failure this exists to pre-empt — so a refusal only ever
comes from a forge that *answered*, and a listing that could not be read to completion is
an error rather than a short list (the same reasoning as the check-run cap in §12).

**And the mint still explains itself**, because the check is a usability layer and not a
boundary: a 422 now asks the installation what it *can* see and names the repos that are
missing, with the same near miss. That is the message the credential helper prints into a
failing `git clone`, so it is the last place a human is told anything at all.

**The refusal is the floor, not the fix.** The better outcome is never typing the name: the
same list answers forwards as well as backwards, so `/brainstorm`'s `repo:` option is
**autocompleted** from the repos the runner can actually reach (`RepoCatalog`, the mirror of
`RepoReach`). A name that cannot be reached is a name that is never offered.

Four things make that box behave:

- **The ranking is forgiving in exactly the way the incident was.** Prefix, then substring,
  then the *squashed* comparison — so `allchat` finds `all-chat` while it is still being
  typed — then bounded edit distance for `all-chta`. An empty query lists the catalogue
  rather than nothing: an empty suggestion box is indistinguishable from a bot that has
  stopped working.
- **`repo:` takes several repos** (§14.3), and Discord replaces the *entire* option value
  with the chosen suggestion — so each choice carries the repos already typed plus the new
  one. A choice carrying only its own repo would silently delete the others, which is the
  same "plan about half a system" the cross-workspace refusal exists to prevent. A
  completion that would exceed Discord's 100-character ceiling is dropped rather than sent,
  because that ceiling rejects the *whole* response and shows the human no suggestions at
  all.
- **One catalogue over every workspace**, because `/brainstorm` does not name one — the loop
  derives the workspace from the repo. Each workspace's contribution is bounded (1.5s) and
  failure-isolated: one forge being slow or refusing costs it its place in the list, not the
  list.
- **It never throws.** An autocomplete accepts exactly one response and no other kind, so an
  unanswered interaction is a spinner that never resolves — worse than no suggestions. A
  bridge with no catalogue at all (a standalone bot process holds no forge credential) is a
  supported shape and behaves as it did before the box was completed.

GitHub's catalogue is the installation listing already described. Forgejo's is `GET
/user/repos` narrowed to the owners a token covers, falling back to the configured per-repo
slugs when the token is repository-scoped and not permitted to list — so the box is as good
as what the credential can enumerate, and empty rather than wrong when it can enumerate
nothing.

`COMMANDS` changed, and nothing has to be remembered for the box to appear: the first runner
to boot on the new image registers the new set and the rest of the fleet does not (§7.1).

### 9.2 Why the agent never holds the token

Session transcripts are committed to git. A token appearing in `argv`, in `.git/config`,
or in an environment dump becomes a token **committed to git history**. So:

- **Push** goes through a git credential helper — the token is never persisted.
- **PR creation** is a supervisor-implemented `open_pr()` tool. The agent calls a typed
  function; it never gets `gh` or a token in its environment.

The 1-hour expiry is invisible because the helper mints on demand. Exporting `GH_TOKEN`
once at session start is what would break mid-session.

**The credential service is keyed by task.** It holds a map `TaskId → ActiveCredential`
and opens one unix socket per active task, at `<runtimeDir>/cred/<task>.sock`. A request
is answered from the entry belonging to the socket it arrived on, or refused — never from
another task's entry, and never from "whatever was set most recently".

This is a prerequisite for running more than one session per replica, not a refinement of
one. The service used to hold a single `active` slot, set when the supervisor claimed a
task and cleared when it finished. Two concurrent sessions on one runner therefore shared
it: whichever task registered last owned the answer, so task A's `git push` was handed
task B's repo credential — with nothing adversarial happening, on the ordinary path. That
crosses the §9.1 trust boundary by accident. A single global `clearActive()` had the
mirror-image failure: a task that finished, parked, or lost its lease revoked the
credential of a concurrent task that was still running, which surfaces as an
unexplainable mid-session auth failure.

Both are removed structurally rather than by discipline. `activate(task, credential)`
returns a lease whose `close()` revokes **that task only**, taken in the session runner's
`finally`, so there is no exit path that can forget it and none that can revoke a
neighbour.

**Task identity is carried by which socket git connects to**, not by a field in the
request — there is no protocol change and nothing for a caller to fill in wrongly. The
per-task socket path is written into the worktree's `credential.helper`, which forces one
non-obvious detail: `git config` inside a linked worktree writes to the repository's
**common** config, shared by the mirror and every other worktree of it. Writing a per-task
socket there would point every worktree at the last task to configure — the same
cross-task leak, relocated from the service into git's config resolution. So the helper
goes to worktree-scoped config (`git config --worktree`), which requires
`extensions.worktreeConfig` on the mirror. Enabling that extension makes the common
config's `core.bare = true` — which `clone --mirror` writes — apply to linked worktrees
too, so `core.bare` is relocated into the main worktree's own config as git's worktree
documentation prescribes; without that step every command needing a working tree fails
with `fatal: this operation must be run in a work tree`. Identity, the push rules and the
commit identity stay shared, because they are properties of the repo rather than of a task.

Socket hygiene is per task and survives a restart: `0600`, a stale path removed before
bind, the socket unlinked on revoke, and the directory swept on `start()` so a pod killed
mid-session cannot leave a bound path that makes the task it was restarted for
un-resumable.

None of this makes the socket a wall — see immediately below. It removes the case where
the wrong token is served *without anyone trying*.

> **How strong is this boundary, honestly?** The trust diagram above says the agent
> "never sees" the token. That holds against *accidental* exposure, which is the
> realistic failure mode here: nothing routine puts the token where a committed
> transcript can capture it.
>
> It does **not** hold against a deliberately adversarial agent. The agent has `bash`
> in the same container as the supervisor, so it could invoke the credential helper
> itself — and with per-task sockets, it could connect to a concurrent task's socket by
> naming its path. Per-task keying narrows an *accidental* leak; it is not an access
> control. Process-level separation inside one container cannot prevent either.
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

Two implementations, `GitHubAppForge` and `ForgejoForge`, selected by the task's
**workspace** — `spec.workspace` picks the profile, and the profile names the forge. NOT
by the repo's host, which is the reading this sentence used to invite: one task binds one
forge to one credential bundle, so a repo whose host disagrees with its workspace's
`forge.host` has no credential that could serve it and is refused rather than routed
(§9.1). The agent's `open_pr()` tool and the credential helper are **identical either
way** — the agent never learns which forge it is on, let alone the token.

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

**And per-repo scoping does not fit the actual workflow.** `oss` is worked
as *one workspace repo with the others cloned inside it* — it is a single ecosystem, and
essentially no task touches only one repo. A per-repo token would have to be reassembled
for every task, for no benefit. So:

- One **owner-wide token** per Codeberg owner, `write:repository` + `write:issue`.
- Optional per-repo overrides for anything that warrants a tighter credential; they are
  checked before the owner-wide token.
- Stored SOPS-encrypted as `tokens.json`:
  ```jsonc
  { "owners": { "Acme": "<token>" },
    "repos":  { "Acme/sensitive": "<narrower token>" } }
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

The list comes from wherever the task did. Intake reads a `repos:` list out of the `agent`
block (§14.1); `/brainstorm` takes several repos in one `repo:` option (§14.3); and a plan's
children inherit their brainstorm's list through `materialise`'s `defaultRepos`, so a
brainstorm that spanned two repos cuts tasks that span the same two. **Every repo in a
spec must belong to the same workspace** — one forge, one owner, one credential bundle
(§3.1) — and the entry points refuse a list that crosses two rather than narrowing it to
one, because a checkout spanning two workspaces is a session holding two credential
bundles, which is the blast radius §9.1 exists to bound.

`repos/` is added to the workspace's **local** exclude (`$GIT_COMMON_DIR/info/exclude`)
rather than trusting the repo's `.gitignore`, so a sibling repository can never be
committed into the workspace even in a repo that has not thought to ignore it.

> Note `--git-common-dir`, not `--git-dir`: in a linked worktree the latter returns the
> worktree-private directory, and git reads `info/exclude` only from the common one. The
> pattern therefore applies to every worktree of that mirror, which is the intent.

> Prior art: a shell predecessor solved this for a *shell* agent — it sourced `.env`
> in-process and fed the header through a process-substituted `--config` file, so the
> token never reached `argv`/`ps`. The supervisor does not need that trick, because a
> TypeScript HTTP client sets the header directly and argv is never involved. The
> *principle* is the same and already encoded in §9.2: the agent never holds the token.
> Do not ship a forge-API script into the agent's toolset — expose `open_pr()` instead.

#### The checkout was plural and the completion path was not

The checkout has been plural since this section was written, and every entry point learned to
produce a list. The *completion path* never did, in three places, and all three silently
defaulted to `spec.repos[0]`:

- **`open_pr` posted to `repos[0]` unconditionally** and took no repo argument at all.
- **The CI gate checked `repos[0]`.** A task whose sibling PR was red — or absent — passed on
  the strength of the primary.
- **The council merged `repos[0]`.** The rest stayed open with nothing saying so.

So a two-repo task could do all of its work and then only ever half-finish, and the first
failure hid the second two. `GH-acme-all-chat-543` is the record: both halves built,
committed, pushed and verified — 22 acceptance commands exiting 0 — and the second pull request
could not be opened at all. The agent called `open_pr` twice and got a 422 from the wrong
repository twice (once matching the PR it had already opened on the *primary* repo, once
refusing `base: …-extension:main` on a repo where that branch does not exist), correctly
diagnosed it as a tooling limit rather than a permissions problem, and parked on `ask_human`. A
human opened the PR by hand.

**`open_pr` is idempotent: a duplicate adopts the pull request that is already open.** GitHub
answers a second POST for the same head with a 422 (`A pull request already exists for …`) and
Forgejo with a 409, and both are statements about the world already being the way the caller
wanted. Treating that as a failure made a class of situation unrecoverable from inside a
session: a handoff whose successor re-opens from the journal, a push whose state write was lost,
or a human who opened it by hand while the task was parked — which is exactly how
`all-chat-extension#113` came to exist, and it would have left that task unable to record its own
PR ever again. In every one the branch, base and intent are identical, so the existing PR is the
one being asked for.

Narrow deliberately: only that status, only when the branch actually has an open PR against the
requested base, and matched on head+base rather than on title. A 422 about an unusable base still
throws — that is the one an agent has to read, and it is the error GitHub gave rather than a
summary of it. The title and body are **not** applied to an adopted PR: rewriting a description a
human may have edited is not this call's business.

Both forges implement it because `open_pr` is one verb with one contract. An agent that had to
know which forge it was talking to in order to know whether "already open" is a failure would be
reasoning about the thing the tool exists to hide.

**`open_pr` takes an optional `repo`, and refuses anything outside `spec.repos`.** Optional
because one repo is what a list of one looks like and the primary is the overwhelming case;
refusing rather than trusting for `materialise`'s reason one layer down (§9.1) — the argument is
agent-authored text, and a tool that opened a pull request against any repo the credential could
reach would be a session naming its own blast radius. The credential activated for the session
already covers exactly `spec.repos`, so the tool's bound and the token's bound are the same list
by construction rather than by agreement. The refusal is **prose the model can act on**, not a
throw: it names what IS allowed, which is the whole of what the raw 422 did not.

**`TaskState.prs` carries one PR per repo, and `pr` still means the primary's.** Both are
written together, and that is not redundancy — every reader that only wants something to link to
(the snapshot, the web view, the digest, the council's prompt) reads `pr`, and the gates read
`prs`. `taskPullRequests` reads a state written before `prs` existed as "just the primary one",
which is the only PR a session could open then; a rolling deploy has both shapes in the state
repo at once, so that is a live path rather than a migration nicety.

**The gate checks every repo and stops at the first red.** All of them, because the work is one
change and half of it being green is not it passing; the first failure rather than a collected
report, because a red suite in one repo is a full session's work whether or not the other is
also red. A repo with no CI keeps its existing warning, per repo.

**Merging goes in `spec.repos` order and stops at the first failure.** The order is the one the
operator typed, which this section already treats as meaningful — `repos[0]` is the working
directory — and it is the closest thing to a dependency order the supervisor has. The repos of
one change usually cannot land in either order: `all-chat#734` had to merge before
`all-chat-extension#113`, because the extension reads a field the gateway does not send yet.
Continuing past a failure would land exactly that broken intermediate.

A **partial** merge names what did land. It is the one outcome where "could not merge" on its own
is actively misleading — some of the change is on the default branch, and a human cannot decide
what to do about the rest without knowing which half. `mergeReviewed` still never fails the
task, for the reason it never did.

**The system prompt says so.** A tool that can do a thing an agent does not know about is a tool
that does not exist: the sibling-layout paragraph now says to call `open_pr` once per repo, and
that completion checks CI in every repo a PR was opened in — so a repo changed without one will
not merge.

### 9.5 Task tracker credential (Vikunja)

Everything in `oss` is tracked in Vikunja at `https://vikunja.example.com`
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

> Prior art: a python predecessor — same discipline as the shell one above: token read
> in-process from `.env`, header-only, never argv. In the cluster the `.env` becomes a
> SOPS secret; the discipline is unchanged.

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
  after start. It lives on a volume, seeded once from `npm run llm:login` on a machine
  with a browser — a pod has nowhere to open one.
- **`modify` must serialize across processes.** Two sessions refreshing at once would
  both read the same token and both write; the loser persists one the provider has
  already invalidated. `FileCredentialStore` takes a lock directory for this.

#### The credential holder — what a fleet needs instead

`FileCredentialStore`'s lock is a directory, so its blast radius is the volume it sits on.
That is exactly enough for one supervisor and exactly nothing for a fleet, because §8.1's
constraint applies here too: no `ReadWriteMany`, so N replicas means N volumes means **N
copies of the credential**.

Copies are what make this fatal rather than wasteful. The first replica to refresh rotates
the refresh token, and every other copy is instantly a token the provider has invalidated.
The fleet locks itself out about an hour after it starts — and does it *silently*, because
each replica keeps working right up until its own access token expires.

So the credential stops being a file each runner owns and becomes a service exactly one pod
owns. Runners get an `HttpCredentialStore` that **never writes and never refreshes**.

This is §2's "in-cluster proxy that holds the credential", reduced to the part that was
ever possible. The original proxy was meant to carry the model *traffic* and could not —
an OAuth bearer cannot be forwarded by something authenticating with `x-api-key`, which is
what deleted it. Carrying the *credential* was never the problem. Runners still talk to
`api.anthropic.com` themselves; only the token comes from the holder, and the spend-cap
choke point the original promised still does not exist.

Three things about it are load-bearing:

- **Nothing reimplements OAuth.** The holder calls `Models.getAuth`, which is pi's own
  public entry into `resolveStoredOAuth` — the double-checked "is it expiring / refresh
  once / persist the rotation" dance, run inside `CredentialStore.modify`. Handing it the
  same `FileCredentialStore` the single-replica deployment used means the refresh path in
  a fleet is character-for-character the refresh path that already worked.
- **The runner's `modify` deliberately does not run pi's callback.** This is the one place
  that departs from the letter of pi's `CredentialStore` contract, and it is the whole
  point. That callback invokes `anthropicOAuth.refresh`, which mints a new access token and
  invalidates the refresh token it was given. Running it on a replica would rotate the
  fleet's credential from something that cannot persist it — the holder's copy dies on the
  spot and every other replica dies at its next refresh. So the call is forwarded to the
  holder, which runs the identical refresh under its own lock against the single durable
  copy, and returns what the callback would have produced. pi's caller cannot tell.
- **`delete` throws rather than being a no-op.** Logging out is a fleet-wide act and a
  runner is not entitled to it. Nothing calls it today; it is a tripwire for the caller
  that eventually does.

The runner caches what it reads until the token is inside a ten-minute margin — larger than
pi's own five-minute staleness check, so the cache cannot hand pi something pi immediately
rejects, which would make every request take the refresh path. Rotation does not invalidate
an *access* token, so caching by `expires` is safe.

**Config precedence is the sharp edge.** A fleet's ConfigMap necessarily carries both
`credentialsPath` and `credentialsUrl`, because one object configures the runners and the
holder. `credentialsUrl` wins in a runner (`src/index.ts`), and it has to: a runner that
preferred the path would open a private copy on its own volume and start rotating a token
its peers are using — the exact failure the holder exists to prevent, arriving through a
config that looks correct.

`credentialsPath` alone remains fully supported and is right for a machine runner or a
local `docker run`, neither of which has a holder to reach.

**What the bearer token does and does not do.** It bounds reach to workloads that hold it,
rather than to anything in the cluster that can resolve the Service. It is *not* a defence
against the agent: the agent's bash tool runs inside a runner pod, which is a pod that
legitimately holds the token — and the credential was equally readable from that pod's own
volume before the holder existed. Its absence is a warning at boot, not a refusal, because
bringing a fleet up before sealing a secret should produce a working cluster and a loud log
line rather than a crash loop.
- **Rate limits are per-account** and shared with the operator's own interactive usage.
  So is the spend limit, and reaching either is a normal operating condition rather than
  an exception: the supervisor treats a refusal as a runner-wide pause, never as a fact
  about the task that happened to be running. See §6.3.

**`proxy` (retained).** All runners point at an in-cluster proxy holding the provider
credential. Its value is not "easy provider swap" (pi-ai already gives that) but:

- The off-cluster machine runner never stores a Claude credential.
- One choke point for the global spend cap and per-task cost metrics.

The modes are not exclusive at runtime: pi resolves *a stored credential owns the
provider; ambient env is consulted only when nothing is stored*, so a subscription runner
can keep an API key in its environment as an automatic fallback. The cluster deliberately
does not — there is no Anthropic key anywhere in `deployment`.

Swapping to a private provider later remains a config change.

### 9.7 Who the fleet commits as

One configured identity authors everything the runner writes — the state repo's audit
trail and the agent's work in a task worktree alike. They are the same actor, and two
identities would make the history read as though there were a second author nobody
configured.

**It is configuration, not a constant.** The address names the App installed for *this*
deployment, so there is nothing correct to hardcode, and no default is offered either: a
default is a claim about who wrote an audit trail, and after the fact a wrong claim is
indistinguishable from a right one. A runner that has not been told refuses to start.

**A forge resolves an address to an ACCOUNT.** That is the whole hazard, and it is not
theoretical — it is what this section was written after. The identity read
`caterpillar@users.noreply.github.com`, which looks like a reserved, inert address for a
project called caterpillar. It is not. It is GitHub's pre-2017 personal noreply form, and
GitHub resolves it to the account holding that login: an unrelated person, who became the
author of 129 commits across four repositories, on their contribution graph, with their
avatar, in repositories they have never seen.

So `load.ts` refuses one shape outright — a `users.noreply.github.com` address without
the numeric id prefix. `<id>+<login>@users.noreply.github.com` cannot make that mistake,
because a numeric id names exactly one account: it is either yours or it does not exist.
Only that domain is checked; a runner pushing to Codeberg has no github noreply address
to get wrong and must not be made to invent an id prefix that means nothing there.

**An identity that has changed leaves history behind it.** `identity.pastEmails` lists the
addresses this deployment used to commit as, and nothing ever commits as one — they exist so
the daily digest's authorship split (§19) recognises the fleet's own past work instead of
inventing a contributor for it. The refusal above is deliberately not applied to them: it
exists to stop an address AUTHORING anything, and a deployment that already made this
mistake must still be able to describe the history it has.

The deployed value is the author App's own bot account,
`caterpillar-agent[bot] <316492202+caterpillar-agent[bot]@users.noreply.github.com>` —
which is what GitHub already stamps on the merge commits that App makes (§12.1), so the
history is self-consistent rather than carrying two names for one actor. Note that the
bot account's id is **not** the App id in the secret: the App id names the application,
this names the account it commits as.

#### Nothing the fleet writes carries a second name

The identity above is stamped on every commit by the git layer. Everything the *agent*
writes — commit message bodies, pull request titles and descriptions, review comments,
journal entries, code comments — must carry no attribution at all.

This needed saying explicitly, in the system prompts, because the default behaviour is the
opposite. A model asked to commit reaches for a `Co-Authored-By` trailer and a "Generated
with" footer without being asked, having learned them from a corpus full of both, and it
had been doing exactly that: the fleet was signing its work with the name of the harness it
resembles.

Two reasons, and only the second is about taste:

- **It contradicts the identity.** The configured author is already on the commit. A
  different name in the message body means the history carries two authors for one actor,
  which is precisely the failure §9.7 exists to prevent, arriving through prose instead of
  through config.
- **It is an advertisement nobody is being paid for**, for a product that is an
  implementation detail. The model behind a runner is a config field (§9.6) and may be a
  different one next month; the work is Caterpillar's either way.

Enforced in three prompts rather than one, because they publish to different places:
`SYSTEM_PROMPT` (which `REMEDIATION_SYSTEM_PROMPT` inherits) covers commits and pull
requests, the review council's shared preamble covers verdicts posted verbatim to a PR, and
the digest summariser covers the daily post to Discord and the state repo. A stripping pass
over the output was considered and rejected: it would be a denylist of the phrasings
somebody already thought of, and the model has more.

#### And the agent cannot supply one of its own

Git config is advice. `WorktreeManager.configureShared` writes `user.name` and `user.email`
into every checkout on every create and reuse, and that was not enough, because an agent
that decides a git command needs an author can overrule it from the command line. One did:

```
git -c user.name=Caterpillar -c user.email=caterpillar@users.noreply.github.com \
    merge --no-edit 79715d93
```

Unprompted — no git error to react to, on a merge it was otherwise right to make, in a
worktree whose config was correct the whole time. The name came from its own system prompt
("**You are Caterpillar**") and the address was invented to match. It is the exact form
this section was written after, so GitHub resolved it to the account holding the login
`caterpillar` and a stranger became the author of a merge commit in a repository they have
never seen. `load.ts` could not catch it: the address never passed through config.

So the identity is also stamped into the ENVIRONMENT — `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, set by
`withCommitIdentity` in the toolchain resolver, so all four spawn sites (§8.1) get them
from one place. Git reads those before ANY config, `-c` included, so the command above now
produces the configured identity whatever it is handed. They join `RESERVED`, for the same
reason `HOME` is there: a repo-authored devShell exporting `GIT_AUTHOR_NAME` would
otherwise rename the fleet for every task on that repo.

The config writes stay. They are what a human reads in the checkout, and what git falls
back to in a shell the supervisor did not spawn.

**And the VALUE is refused twice, because the value is the thing that matters.** Who typed
an address is incidental; a bare `<login>@users.noreply.github.com` names a real person
whatever route it arrived by. The rule lives in `config/identity.ts` and is asked twice:
by `load.ts`, so a runner told to be a stranger does not start, and by
`withCommitIdentity`, at the last point before an identity becomes history. The second is
not the first one twice — a machine runner inherits the operator's own `GIT_AUTHOR_EMAIL`,
and the loader never sees it.

It is not a sandbox — `--author`, `--reset-author` and `unset` all still exist — and it is
not meant to be. It is the difference between a mistake a helpful model makes on its own
and one it has to decide to make. The prompt rule covers the rest, and says why rather than
only what: an email address is not a label, a forge resolves it to an account, and the last
one guessed belonged to a real person.

---

## 10. Kubernetes

Deployed via ArgoCD from `deployment`, following the existing conventions:

- `apps/workloads/caterpillar/` — manifests + `kustomization.yaml`
- `argocd/apps/caterpillar.yaml` — Application, sync wave 4
- Secrets SOPS-encrypted with age, as everywhere else in that repo

| Object | Purpose |
|---|---|
| `StatefulSet` | the supervisor fleet, N replicas, `RollingUpdate` |
| `volumeClaimTemplates` | git mirrors + worktrees, and the nix store — **one pair per replica** |
| `Deployment` | credential holder, **exactly 1** (§9.6) + its own claim + `Service` |
| `Deployment` | **the Discord bot, exactly 1** (§7) — Discord secret + Redis, no PVC, no forge/LLM credential |
| `Deployment` | nix pull-through cache, **exactly 1** (§8.1) + its own claim + `Service` |
| `Secret` (SOPS) | GitHub App PEM, Discord webhook, credential-holder token |
| `ConfigMap` | capabilities, thresholds, workspace forge host (the repo scope, §9.1) |
| `Service` | load-balanced `metrics` + `web`, and a headless one for stable per-pod DNS |
| `ServiceMonitor` | scrape supervisor `/metrics` |
| `PrometheusRule` | alerts below |

**A StatefulSet for one reason: `volumeClaimTemplates`.** Not ordering, not identity. The
cluster's only storage class is node-local and `ReadWriteOnce`, so each replica needs its
own `/nix` and `/work` (§8.1), and a Deployment can only name claims that already exist —
which is one set for every replica. The stable pod name is a genuine second prize:
`RUNNER_ID` is the pod name, so a lease in the state repo now names `caterpillar-0`, an
identity that survives a restart, rather than a ReplicaSet's random suffix that never
appears again.

`RollingUpdate` is safe here and was not before. The single-replica Deployment used
`Recreate` to avoid two pods contending for one `ReadWriteOnce` claim; with a claim per
replica there is nothing to contend for, and overlapping supervisors were always safe on
their own — leases handle it. `podManagementPolicy: Parallel`, because these pods do not
form a quorum: `OrderedReady` would let a wedged `caterpillar-0` stop `caterpillar-1` from
ever booting, which is the opposite of what a fleet is for.

### The bot is a second Deployment, and deliberately a small one

Splitting the bot out (§7) costs one manifest in `deployment` and no second image:
`dist/` is copied whole, so the entrypoint is already there.

```yaml
command: ["node", "/app/dist/bot.js"]
```

What it **has**: the `caterpillar-discord` secret, the Redis connection, and its own port
(`bot.port`, 9091) for `/healthz`, `/readyz` and `/metrics` — its own because the two
processes share a namespace and one number meaning both is an EADDRINUSE in whichever pod
loses. Probe **`/readyz`**, not `/healthz`: readiness carries gateway connectedness and
Redis reachability, liveness deliberately does not.

What it **does not have**, and this is the point rather than an economy:

- **no work PVC.** It runs no sessions and clones nothing, so it needs neither `/work` nor
  `/nix`. That is also why it can be a Deployment where the supervisors must be a
  StatefulSet — with no `volumeClaimTemplates` there is nothing to template.
- **no forge credential, no LLM credential, no ServiceAccount token.** It cannot touch a
  repo, cannot spend money, and cannot read the cluster. Everything that writes the state
  repo goes to a supervisor over the Redis inbox, so the blast radius of the process
  holding a public-facing socket is "it can post a Discord message".

**`replicas: 1`.** Not a constraint of the code — the Redis lock (§7) makes an overlap
correct — but the intended shape: one bot is all a fleet wants, and the lock is there for
the seconds of a rolling update rather than as a scaling mechanism. Supervisors scale
freely underneath it and connect to Discord not at all, which is what the split bought.

The supervisor StatefulSet's ConfigMap gains `bot.mode: "external"` alongside
`redis.enabled: true`. Both are required: `external` without Redis would leave supervisors
deaf to Discord and the bot unable to reach them, so the supervisor logs that
misconfiguration and stays in-process rather than obeying it.

**What actually bounds the replica count** — none of it is this repo:

- **Node disk.** Each replica takes its `work` + `nix` claims from `local-path` on
  whichever node it lands on. `topologySpreadConstraints` exist to stop four replicas
  piling onto one node and filling it while two others sit empty; that is a storage
  constraint wearing scheduling clothes, and it is `ScheduleAnyway` because a fleet that
  refuses to grow over an uneven spread is worse than an uneven fleet.
- **The subscription's rate limit**, which is per *account* and shared with the operator's
  own interactive usage (§6.3). This is the ceiling reached first. The fleet degrades
  rather than failing tasks — a refusal is a runner-wide pause, not a fact about the task —
  but many replicas contending for one subscription mostly produces many runners in
  cooldown.
- **Scaling down leaves claims behind.** Kubernetes never deletes a StatefulSet's volumes.
  Reclaiming that space is a deliberate `kubectl delete pvc`.

---

## 11. Observability

Discord stays a signal channel — questions, parks, terminal outcomes. Everything else
goes to Grafana.

Three channels, and they answer different questions. Keeping them apart is deliberate:

| Channel | Answers | Retention |
|---|---|---|
| Metrics | "is the fleet healthy" — rates, totals, queue depth | Prometheus |
| **Logs** | "what is this runner doing, and why did that task park" | Loki |
| Journal (`journal/`) | "what did the AGENT do and decide" — handoff continuity | git, forever |

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
| `caterpillar_provider_outage_total{kind}` | counter | sessions the provider refused — §6.3 |
| `caterpillar_provider_cooldown_seconds{runner}` | gauge | >0 means idle **on purpose** — §6.3 |
| `caterpillar_alerts_received_total{alertname,outcome}` | counter | Alertmanager deliveries — §20 |
| `caterpillar_worktrees_reaped_total{kind}` | counter | `targeted` vs `swept` — §3.1 |
| `caterpillar_worktree_bytes_reaped_total{kind}` | counter | approximate bytes returned to the PVC |
| `caterpillar_work_fs_bytes{runner,kind}` | gauge | `total`/`free` of the work volume, from `statfs` |
| `caterpillar_work_bytes{runner,category}` | gauge | `mirrors`/`tasks`/`nix`/`other`, apparent size |
| `caterpillar_work_entry_bytes{runner,category,name}` | gauge | the largest few tasks and mirrors, capped |
| `caterpillar_work_partial{runner}` | gauge | 1 when the walk hit its deadline |
| `caterpillar_work_measured_timestamp_seconds{runner}` | gauge | how stale the four above are |
| `caterpillar_digest_authored_lines_total{runner,repo,author}` | counter | `fleet` vs `human` lines in a digest window — §19 |
| `caterpillar_digest_authored_commits_total{runner,repo,author}` | counter | the same split at commit level |
| `caterpillar_digest_authorship_unreadable_total{runner,repo}` | counter | windows where a repo's history could not be read |

`kind` on the reaping pair is the label that earns them their place. A healthy runner reaps
almost everything `targeted`, so a `swept` series that keeps climbing says the supervisor's
terminal paths are not reaching the removal — pods being killed mid-session, or a branch
nobody wired up — and the volume is only staying under its limit because a timer is
cleaning up after a bug. The bytes counter is what answers "is reaping worth anything" at
all, and divided by the first it says what one task actually costs on disk.

The `work_*` family answers the one question the supervisor could not previously answer
about itself: where the disk went. It is produced by a directory walk
(`workspace/usage.ts`) that is READ-ONLY, runs only from the **work** loop's idle branch,
and is rate-limited to `usage.intervalHours` — one `stat` per file over a tree carrying a
`node_modules` per task is not something to do on the thread that claims work. It stayed on
the work loop when the nix store collection moved to housekeeping (§6.4), and the asymmetry
is deliberate: this walk spends its time inside *this* process, and housekeeping is what a
human waiting on `/resume` is waiting for. An idle work loop has nothing better to do. It is
bounded by `usage.deadlineSeconds` and reports what it has with `caterpillar_work_partial`
set rather than blocking the loop or throwing the pass away.

`category` is disjoint and sums to what THIS runner can account for, which is not the same
as what the volume holds — another process on the same disk makes `work_fs_bytes` the only
honest arbiter. `name` is capped at the top N by size with the remainder in a single
`other` series, because a task id is an unbounded label value in a registry with no expiry
and the alternative is one series per task the runner has ever worked, forever.

`outcome` is one of `created`, `duplicate`, `refused-no-policy`, `refused-max-open`,
`malformed`, `unauthorized`, and it is deliberately not collapsed into ok/error. The failure
the alert path is most likely to have is an alert nobody notices has been declined four
hundred times, and `outcome="refused-no-policy"` is the series that says so without anyone
reading a log line. `alertname` is empty for a delivery that failed authentication or never
parsed: there is no alertname to attribute it to, and taking one from such a body would let
a stranger choose a label value.

**Alerts**

- `caterpillar_context_overrun_total > 0` — handoff threshold fired too late
- `caterpillar_no_progress_streak >= 3` — task is thrashing
- `caterpillar_lease_age_seconds > 600` with no heartbeat — dead runner
- `caterpillar_provider_cooldown_seconds > 0` for 15m — the provider is refusing and
  nothing is being worked on. Without this a runner sitting out a spend limit looks
  exactly like an idle one.
- task in `awaiting-human` > 24h — you forgot
- `caterpillar_cost_usd_total` over per-task budget
- `caterpillar_work_fs_bytes{kind="free"}` under a floor — the volume is filling. Alert on
  this rather than on the category sum: the sum is what the supervisor can attribute, and a
  disk filled by something else would leave it flat while writes start failing.

The first four of those are the natural first entries in `alerts/policy.yaml` (§20), because
each of them is about the fleet's own code and each has a repo whose tests would demonstrate
a fix: a context overrun is a handoff-threshold defect, a no-progress streak is usually a
task the supervisor keeps re-claiming for a reason a session can find, and a lease age with
no heartbeat is a supervisor that stopped. The provider-cooldown alert is the interesting
one to leave OUT — nothing in this repo can fix an account that is out of budget, so it
would produce a task whose honest outcome is always `ask_human`. `awaiting-human > 24h` is
about a human rather than about the code and belongs to nobody but the operator.

### 11.1 No-progress detector

A session made progress if it produced **any** of: a commit on the task branch, a newly
passing acceptance command, or a journal entry marking a completed step. Three consecutive
sessions with none → park and notify.

This is the limit that catches the failure the others miss: an agent burning tokens for
hours while going in circles.

**It judges the AGENT, so only the agent's sessions reach it.** A session the provider
refused does not run the probe and does not touch the streak (§6.3). The detector was
the thing that finally stopped the spend-limit retry storm on 2026-08-15, by parking the
task — which is the right mechanism reaching the wrong conclusion about the wrong actor,
and exactly the kind of evidence that makes a park unreadable.

**A session that ended in `ask_human` is neutral: neither progress nor a stall.** It is
the one exit reason that is, and the reason is the charter above — the question is whether
the *agent* is going in circles, and an agent that established it needs a decision only a
human can make is not. §7 says it plainly: "Nothing is running while you think."

§7 half-conceded this already, by clearing the streak when an **answer** arrives, on the
grounds that `awaiting-human` is only ever reached from a session that produced no commit.
That fixes the park and not the reading. Between the question and the answer — which is
hours, because the whole point is that a human is asleep or busy — the task carries a
streak it did not earn, and `caterpillar_no_progress_streak` reports it. That is how
`BS-1540279100223127564-01` fired `CaterpillarTaskThrashing` on 2026-08-21: session 3 was
a completion claim the verifier rejected and scored a stall honestly (streak 1); session 4
read the rejection, worked out that its acceptance list runs the whole frontend's lint
while the task owns only a slice of the reported errors, and asked. Streak 2, alert firing,
and nothing running on the task for the next four hours. A task waiting **too long** on a
human is a real problem and §11 already gives it its own alert (`awaiting-human > 24h`),
which is about a human rather than about the code.

Neutral rather than forgiving, deliberately. Clearing the streak here would hand an agent
a way to reset the detector on demand — stall, ask anything, get answered, stall again —
so a streak earned by other sessions survives an `ask_human` untouched. Evidence still
wins over the exit reason: a session that commits real work and *then* discovers it needs
a decision moved the task forward, and is scored as progress. `handoff` is deliberately
not exempt: it is how most sessions end and says nothing about what was achieved, so
exempting it would blind the detector to the exact failure it exists for.

**The gauge is a claim about right now, and nothing expires it.** `recordSession` was the
only writer of `caterpillar_no_progress_streak{task=...}`, while three other sites forgive
the streak in state (an answer, guidance, a resume) and a parked or finished task stops
having sessions at all. So the series reported a number the state no longer held for as
long as the pod lived — `BS-1540252370968117339-04` reached streak 2 and then merged its
PR, and went on reporting 2. Since this is an **alerting** rule, a stale sample is not
cosmetic: it pages somebody about work that is over. Every forgiveness now publishes, and
`transition` **removes** the series when a task reaches a terminal status — the state keeps
the streak, because it is the record of why the task parked, but the gauge stops claiming
there is a session to measure. Removed rather than zeroed: 0 is a real reading, meaning a
task that is making progress.

**And removing it in `transition` alone was not enough, because the gauge is per-process
and tasks are not.** `transition` runs in whichever process performed the terminal
transition; the sample lives in that process's registry. A task migrates between replicas
across sessions — 19 tasks in the state repo carry journal shards written by two to four
different runners — so the pod that published the streak is routinely not the pod that
finishes the task. Pod A hands off at streak 2, pod B takes the task `done` and removes the
series from its own registry where nothing ever set it, and pod A goes on reporting 2 until
somebody restarts it. The rule does not aggregate over `pod`, so one orphan is enough to
keep `CaterpillarTaskThrashing` firing about merged work. `survey` therefore drops the
series for every task it reads as terminal: it is the one pass that reads every task's
committed state on every poll in **every** replica, which is the same property that makes
the fleet presence it publishes fleet-wide. `transition`'s removal is kept as the fast path
for the common case, where the pod that finishes a task is the pod that was running it.

This is what fired on `BS-1540288291008684052-02` on 2026-08-21, and the task itself was
fine: session 1 committed all three commits, sessions 2 and 3 committed nothing because
there was nothing left to commit, and session 3's completion claim passed the gate and the
council and merged. The streak of 2 was truthful, the task never parked, and §11.1 scored
all three sessions correctly. The alert nevertheless fired for 36 hours, on pods whose
image predated the `transition` fix, because CI was billing-blocked and the image carrying
that fix was never built. That is the other lesson, and it is not a code one: a fix to an
in-memory gauge changes nothing until a new image is built AND rolled out, so an alert on a
stale gauge keeps creating remediation tasks in the meantime. Check the running image's
digest against the commit you believe fixes it before reading the metric as a live defect.

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
because the probe runs after the session's credential lease is closed, and the credential
service then refuses to answer for that task by design (§9.2) — anything touching the
network fails.

**The detector measures sessions; it cannot tell you whether the session should have
run.** `BS-…-07` parked on 2026-08-18 with a streak of 3, and the probe was right about
every one of those sessions — none committed anything. The defects were upstream, and
both produced a session that could only fail:

- **A pending CI run was reported as a failed gate.** `verifier.ts` returned
  `passed: false` for a check that had not finished, which is indistinguishable from red
  CI at the call site. The supervisor journalled a REJECTED completion claim, sent the
  task back to `ready`, and started a fresh session — against a branch nobody was going
  to change, whose acceptance commands had already passed. Three of those in a row parked
  finished work behind an open PR. A pending run now carries `pending: true`, the gate
  waits it out in the same session slot (`limits.ciSettleSeconds`, default 20 minutes,
  polling every `limits.ciPollSeconds`) the way `ProviderCooldown` waits out a provider,
  and past that budget the task is *released without a session* rather than rejected. The
  wait is bounded on purpose: a check that never settles is a real problem an agent
  should be told about, not a reason to pin the runner forever.

  This is not one task's bad luck. On 2026-08-21 the fleet logs show the same pending
  rejection **seven** times between 07:41 and 13:58, across two repos and four runners,
  every one of them on work whose acceptance commands had already passed:
  `BS-…052-01/02/03/04`, `BS-…609-01/02`, and the branch carrying this very fix. In each
  case the next session was started 2–4 seconds after the rejection, ran for 2–15
  minutes, committed nothing because there was nothing to commit, and was honestly scored
  no-progress. `BS-…052-04` went round twice and reached streak 2 — one cycle short of a
  park — before the same commit passed at 08:42 with 7 checks green. The gap between the
  pending verdict and the green one was 3–7 minutes in every case, which is why a bounded
  in-slot wait resolves it and a fresh session cannot: the session is not the thing that
  was missing, time was.

  Why that window is minutes rather than seconds, for anyone later tuning
  `limits.ciSettleSeconds`: `.github/workflows/build-and-push.yml` triggers on `push` to
  `'**'`, and its `build` job is skipped only for `pull_request` events. A push to an
  agent branch therefore runs the two `check` matrix legs *and* a buildx image build and
  registry push, and the image build dominates the wall time. The budget has to cover the
  slowest check on the branch, not the length of the test suite.

  **Known residual, deliberately left:** the release carries no not-before, and
  `isClaimable` accepts `ready` immediately, so an idle runner re-claims the task on the
  very next poll. CI that stays pending *longer than the whole settle budget* therefore
  still spends a session per claim cycle, and three such cycles still park the task —
  `BS-…-07`'s exact shape, roughly twenty minutes slower each time round. The observed
  gaps were 3–7 minutes against a 20-minute budget, so this is not the case that fired;
  fixing it properly means giving a released task an earliest-claim time, which is a
  change to the claim/release cycle rather than to this gate, and it is not made here.
  Anyone who sees a task park with green CI and an `awaiting CI` commit in its history
  should start with that.
- **`NODE_ENV=production` leaked into the task's environment.** The supervisor's own
  image sets it (correctly — that image installed with `--omit=dev`), but it is
  process-wide and every agent session and acceptance command is a child of the
  supervisor. npm honours it by skipping devDependencies, so a task whose acceptance list
  begins `npm ci` installs no `typescript` and the next command dies with
  `tsc: command not found`, exit 127. Nothing in the repo is wrong when that happens and
  no agent can fix it from inside the worktree: the acceptance list is unsatisfiable
  inside the container. `ToolchainResolver` now strips exactly that value on the way in —
  a repo that genuinely wants a production install still says so in its own acceptance
  command.

**A caution about the second one, because the record nearly recorded it wrongly.** It is
tempting to read `BS-…-07`'s exit-127 as proof of the `NODE_ENV` defect. It is not.
That task's acceptance list is `npm run check` and `npm test` with **no `npm ci` at all**,
so the gate never ran an install and never had devDependencies stripped from under it; it
type-checked against whatever `node_modules` the previous session happened to leave in the
worktree. `GH-…-60` ran the same three commands on the same repo in the same image at
11:45 the same morning and passed, because its list *does* begin `npm ci --ignore-scripts`.
The two facts only fit together one way: **an acceptance list that omits its install step
is not reproducible.** It grades the worktree's leftover state, so it passes or fails on
what the last session did rather than on what was committed, and it is the omission —
not the ambient variable — that stranded `BS-…-07`. The `NODE_ENV` strip is still right,
and is kept, but it is a fix for the *next* repo rather than an account of this one.

**A third one, found while verifying the fixes for the first two, and it is a lesson about
evidence rather than about code.** The branch carrying them had `check (26)` go red, so the
completion claim was rejected and another session started — on a branch whose acceptance
commands passed. Three sessions went looking for a defect in node 26. There was none.

The red was a **flaky test added by the first fix**, and the matrix leg was a coin toss:
the same test took `check (22)` red on the next commit, with a green run in between. It
asserted on a state that is transient by design — a task released back to `ready` is
re-claimed on the very next iteration, so the window is one `claimNext` wide and an
observer polling every 100ms steps straight over it. It now waits for the *commit* the
release pushes instead: history only grows, so the assertion can be late without being
wrong.

Two rules come out of it, and the second is the expensive one:

- **A red check on one matrix leg that reproduces on neither locally is evidence of a
  race, not of a version.** Nothing version-specific can produce a green run on the same
  leg two commits later. Reading it as "node 26 is broken" cost a session that could not
  execute the failing leg at all and therefore could not have concluded anything.
- **Assert on what is durable, not on what is momentary.** A test that watches for a
  transient state is a test that fails on whichever machine is busiest, and it will be
  read as a defect in the code under review — which is precisely the "session with
  nothing to do" this whole section is about, manufactured by the fix for it.

**A fourth, and it is the one that made the third expensive: the gate said a job was red
and never said why.** `summarise` in `github-app.ts` read three fields of a check-run —
`status`, `conclusion`, `name` — so a rejection was `CI is red — failing: check (26)` and
nothing more. That is the whole of what the next session gets to act on, and it cannot get
more on its own: the agent holds no forge credential (§9.2), the image has no `gh` or
`curl`, the unauthenticated API 404s on a private repo, and the App has no `actions: read`
by deliberate choice. So the only moves left are to re-prove the tree green or to change
code blind, and both produce a session with no commit — the detector then scores that
honestly, and the opacity has manufactured the streak.

It is recorded three times over. `ALERT-6155db6ffb83deff` spent session 2 proving one tree
green five ways against a leg the machine cannot execute ("Node 26 is not available on this
machine") and session 7 concluding "the red is unexplained from here";
`BS-1539163866305658891-07` records "four sessions were burned on blind changes to a
GitGuardian issue that turned out to be dashboard triage". The rule above — a red leg that
reproduces nowhere is a race, not a version — is the correct reading, and none of those
sessions could reach it, because the message they were handed contained no information to
read either way.

GitHub was returning the answer all along, in the same response the names come from:
`output.title`/`output.summary` and `html_url` per check-run, under the `checks: read`
permission the App already holds. Those are now declared and used — title before summary
(for an Actions job the title is the one-line verdict; the summary can run to pages), first
line only, name alone where a run offers neither. The job log itself is still out of reach
and stays that way: fetching it needs `actions: read`, and "no admin, no workflows" is a
stated property of this App rather than an oversight. A link a human can follow is the
honest substitute, and quoting it in an `ask_human` is the right move for a red leg the
container cannot run.

The same change deduplicates by job name. `push: ['**']` and `pull_request` both trigger
the workflow, so every job has two check-runs at one sha: `ALERT-76f2ff229fea37b1`'s own
rejection read `failing: check (22), check (26), check (26), check (22)` — four entries for
two broken jobs, which invites the reader to hunt for a difference between them. There is
none; they are the same two jobs reported twice.

**A fifth, found while trying to explain the fourth's own red CI: the acceptance command
could not fail.** `npm test` ran `node --test --test-force-exit`, and force-exit tears the
process down as soon as the root test settles, discarding the results of tests still
reporting from other files. The numbering closes over the gap and `fail` stays 0, so this
suite reported 1425, 1428, 1440 or its true 1441 tests run to run — always losing the tail
of `src/cluster/preflight.test.ts` from the *middle* of the stream — and exited 0 every
time. A test that never ran was indistinguishable from a test that passed.

The journal had already noticed the symptom twice and filed it as cosmetic: "`npm test`
registers 1421 or 1431 tests run to run … harmless to the gate". It was not harmless and it
was not the reporter. `npm test` is an acceptance command (§12), so it is one of the three
things that decide whether a task is done; a gate that cannot fail certifies nothing, and a
session whose work is waved through by it is a session whose defect surfaces later, to
someone with less context.

Force-exit is gone. It was added as a hang backstop — a hung test once held CI open for
twenty minutes — so removing it required the hang to still be caught. Force-exit turned out
to be the weaker of the two, not the stronger: with stdout piped it reported a deliberately
hanging file as a **pass with exit 0**, on every version tried. The suite is now
deterministic, at unchanged speed. `--test-concurrency=1` also stabilised it, and was
rejected — 47% more wall time to narrow a race rather than remove it.

**Two things about `node --test` differ by node version, and the CI matrix spans two
versions deliberately (§12), so getting this right on the machine to hand is not getting it
right.** Both were found only by running the suite under node 24 as a proxy for the node 26
leg — the leg that had rejected two consecutive completion claims on this very task with a
verdict no one could reproduce.

- **The summary format.** node 22 emits TAP when stdout is a pipe; node 24+ emits `spec`,
  which marks summary lines with `ℹ` rather than `#`. A verdict matching only `#` sees no
  summary at all and rejects a green tree. The reporter is now pinned with
  `--test-reporter=tap`, and the parser accepts either prefix — belt and braces, because a
  parser that silently matches nothing is precisely how the defect above worked.
- **Whether the runner exits after reporting a timeout.** node 22 reaps the hung file's
  process and exits 1. node 24 reports the timeout and then waits forever, so a wrapper
  that waits on the runner inherits the hang — the twenty-minute stall again, on the newer
  leg only. `npm test` therefore keeps a deadline of its own (twenty minutes, against a
  150-second suite) and SIGKILLs the runner past it. It waits on the child's `exit` rather
  than `close`, since a killed runner can leave a grandchild holding the pipe open and
  `close` would wait on that instead.

Belt and braces, in `src/testing/run-report.ts`: the run is judged against a known test
count, so a result lost for some other reason — a file that fails to load registers nothing
at all — cannot read as a pass either. The floor is a hand-maintained constant rather than
a high-water mark on disk, because a self-updating floor ratchets down the first time a run
truncates, which is exactly the failure it is there to catch. Note that a timed-out test
reports `cancelled`, not `fail`, so a check that only reads `fail` would miss the hang.

**A sixth, and it rejected three consecutive completion claims on the branch carrying the
five above: a test's own teardown lost a race with a subprocess it had leaked.** The
verdict was `failing: check (22), check (26), check (26), check (22)`, both legs, twice
over, on a tree that ran green locally on every version available. The actual failure:

    not ok - src/supervisor/loop.test.ts
    failureType: 'hookFailed'
    error: "ENOTEMPTY: directory not empty, rmdir '.../caterpillar-loop-XXXX/state/.git/objects'"

`rm -rf` walks a tree and then rmdir's each directory it believes it emptied. A process
still creating files between those two steps makes the rmdir fail, and `force: true` does
not cover it — that suppresses `ENOENT`, the opposite race. The leaked writer is a git
child: `Supervisor.run` awaits both its loops, but `housekeepingLoop` checks the abort
signal only *between* passes, so an abort landing inside `housekeepOnce` leaves that pass's
`store.pull` still writing after the test's `await running` has resolved. `loop.test.ts`
drives a real supervisor over a real git remote across 69 tests, so it is the file where
this is reachable, and one file failing in a hook fails that whole leg.

This is the third rule above collecting its own interest — a red on one leg reproducing
nowhere is a race, not a version — with the twist that it fires on *both* legs, because a
coin toss lands on each half the time. It is `src/testing/tempdir.ts` now: a removal that
retries a bounded number of times, used by that teardown, rethrowing if the tree really
cannot go. Test teardown only, and documented as such; production code removes trees it
owns exclusively, where a retry would hide a real concurrent writer rather than tolerate an
expected one.

Two further notes for whoever meets this next:

- **The rejection message came from `main`, not from the branch under test.** The verifier
  runs the deployed supervisor, so the fourth fix above — which makes a red verdict name a
  reason and a URL — cannot improve the verdicts of the very branch that introduces it.
  Three sessions read a bare, doubled job list as evidence about their own code; it was
  `main`'s `summarise` all along, and the doubling is the pre-dedup format. **A verdict
  describes the branch with the code that produced the verdict, which during a change to
  the gate is not the branch being graded.**
- **A flake needs a reproduction before a fix.** This one showed at roughly 1 full run in
  3 on node 24, 0 in 5 runs of the file alone, and never on node 22 — so "it passed
  locally" was true and worthless. What settled it was running the suite repeatedly on the
  other matrix version, then reducing the race to a 40-iteration probe that reproduced the
  identical error 15 times by removing a tree under an un-awaited `git fetch`.

**What the sixth fix did NOT settle, recorded so the next session starts here rather than
where session 1 did.** The claim after it was rejected with the same verdict again, and the
tree is green: all three acceptance commands exit 0 from a clean clone under node 22.23.2
and 24.19.0, `# tests 1449 # pass 1449 # fail 0 # cancelled 0`, with a stable count across
repeated runs. The following differences between this container and a GitHub runner were
each tested and are **not** the cause — do not spend a session re-testing them:

- **git identity.** The runner container exports `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and has
  no global gitconfig; an Actions runner has neither. The suite is green with all four
  stripped, because the tests set their own.
- **npm and the registry.** `npm ci --ignore-scripts` exits 0 on a cold cache. `.npmrc`'s
  `min-release-age=2` cannot bite it: the setting works by pinning `before` to two days
  ago, `npm ci` resolves from the lockfile's integrity hashes without consulting a
  packument, and the youngest pinned dependency (`typescript@5.9.3`) was published in
  2025 regardless — `time.modified` on that packument is recent, which is the package's
  last change and not that version's release.
- **Timeouts.** The slowest single test is 16s against a 180s per-test limit, and the
  whole suite is ~150s against the wrapper's 20-minute deadline.
- **The count floor.** Exactly 1449 on every run on both versions. The only conditionally
  registered block is `redis/contract.test.ts`'s live-server `describe`, and a skipped
  test still counts toward `# tests`.
- **Checkout shape.** Green on a branch checkout, a detached HEAD, and a `--depth 1`
  shallow clone with one commit of history — which is what `actions/checkout` produces.
- **Load and memory.** Green under 8-way CPU oversubscription on 4 CPUs, in a container
  capped at 4 GiB; an Actions runner has 4 CPUs and 16 GB.

So the red is still unexplained from here, and the two facts that bound any future guess
are that **both** legs fail — which excludes anything true only of node 26, since node 22
is green locally — and that the verdict arrives about 3m20s after the push, four times
running, while the `check` job's `npm test` step alone takes ~150s. Four *completed,
failed* check-runs that fast means the jobs died early rather than running the suite to a
red result, and `awaitChecks` never got to use its 20-minute budget because `summarise`
returned `failure` on the first poll rather than `pending`. The next useful move is not
another local run: it is reading the job log, which needs someone who can open the URL.

**A seventh, and it is the case where ONE leg red really was about the version — but about
its npm, not its node.** `BS-1540375555520598126-05` had a completion claim rejected with
`failing: check (26)` alone, on a tree whose four acceptance commands all passed locally.
The rule above says a single red leg reproducing nowhere is a race; the exception is that
`setup-node` installs the npm bundled with the node, so the two matrix legs differ in npm
as well. Node 22 carries npm 10, node 26 carries npm 12, and npm 12 hard-fails `npm ci` on
the lockfile root entry drift that npm 10 and 11 only silently rewrite — the same drift
#123 had just reconciled on `main`. So the leg died in the install step, before `npm test`
ran at all, which is consistent with the fast verdict the fourth note describes. Merging
`main` was the fix. **What to check first on a one-leg red, before reaching for the race
explanation: whether the two legs differ in a tool the node version drags along.** Note
that the theory could not be executed here — no npm 12 exists on any container in reach,
and npm 10 and 11 both accept the old lockfile — so it stays a strong inference rather than
a reproduction, and the confirmation available was a whole-suite run on node 22 and node 24
against the merged tree.

The rule all of them share: **when a task parks for no progress, suspect the sessions
before the detector** — and check what the acceptance list actually runs before believing
a story about why it failed. Widening the streak limit here would have hidden every one of
these and parked the work later instead of sooner. The fourth adds a corollary about the
evidence rather than the limit: **a gate that rejects work must say what it saw.** A
verdict the next session cannot act on spends a session to rediscover it, and three of
those park the task. The fifth adds its converse: **a gate that accepts work must have been
able to reject it.** A green that cannot go red is not evidence, and a number in a summary
that nobody has checked against a known total is not either — twice it was seen varying and
twice it was called harmless.

**The `ask_human` exemption above is not an exception to that rule, and it matters that it
is not.** The rule forbids making the detector less sensitive to hide a defect upstream of
it; the exemption says a particular kind of session was never evidence of circling in the
first place, which is a statement about what the metric *means*. The test is whether the
change loses information: raising the limit to 4 would have let every defect in this
section through, whereas nothing that an `ask_human` session could tell you about a
thrashing agent is lost — the task is parked on a human either way, and §11's
`awaiting-human > 24h` is the alert that says so. The upstream defect in
`BS-1540279100223127564-01`'s case is still real and still unfixed by any of this: **an
acceptance list that grades the whole repository cannot be satisfied by a task that owns
part of it**, and a wave of sibling tasks cut from one plan will each be handed the same
repo-wide `lint` gate. That belongs to §14's plan materialisation, not here, and the
symptom to look for is a task whose acceptance output names files it never touched.

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
2. **PR open and CI green — in every repo the task opened one in.** Every, not the primary's:
   a task may span several repos (§9.4.1), the work is one change, and half of it being green
   is not it passing. This checked `repos[0]` alone until §9.4.1's completion-path pass.

Only then `status = done` — except by a human's explicit decision, see *A human can write
`done` past both gates* below — Discord gets the terminal message, and the supervisor closes
the tracker item (§9.5). The agent participates in none of these three steps — it can only
*claim* completion, which triggers verification.

> **A branch that is gone reads as no CI signal, and on a task with a pull request that
> means the work landed.** Merging through the GitHub UI deletes the head branch by default,
> and the checks endpoint then answers `422 No commit found for SHA: <ref>`. That was read as
> a transport failure and thrown, which failed the whole *session* rather than the one
> question being asked — so the task could not reach a verdict at all, in any session, ever.
> `BS-1540288291008684052-04` landed as `caesarakalaeii/all-chat#748` and was still parked
> nine sessions later with every acceptance criterion passing on the default branch.
>
> A ref that does not exist reports nothing, and `conclusion: "none"` is already the word for
> that. Narrowly: only 404 and 422, and only when *both* check endpoints say they cannot find
> the ref. A 500 genuinely is a broken API and must keep throwing, because gate 2 passes on
> `none` — reading an outage as "nothing ran" would pass a task whose CI was never consulted.
>
> Gate 2 then distinguishes the two `none`s, because they are different events with the same
> verdict. The gate's loop runs once per pull request the task *has*, so `refAbsent` inside it
> means the work reached a pull request and the branch it came from was deleted afterwards.
> Nothing in the fleet deletes a task branch — so a human did, and a human does that when the
> change has landed. It passes, and it says so in those words. The standing "completion rests
> on acceptance criteria alone where CI is absent" warning is *not* used here: that sentence
> is true of a repo which configured no CI and false of a merged pull request whose CI ran, and
> it would send a reader looking for a workflow that was never missing.

> **A missing interpreter makes this gate unsatisfiable, not failed.** Acceptance commands
> run in the runner's container, so a toolchain absent from it fails every task that needs
> one no matter what the agent does. Observed: a repo whose tests run through `tools/test.py`
> exited **127** with `env: 'python3': No such file or directory`. That reads as a badly
> written acceptance command rather than a missing interpreter, and nothing the agent can do
> inside a session fixes it.
>
> **The toolchain belongs to the target repo, as a nix flake** — not to the base image and
> not to a capability. A repo declaring its own `dotnet`, `lua` or `python3` means every
> runner has exactly what that repo needs, the base image stays small, and no runner pays for
> another repo's dependencies. It also avoids inventing capability tokens per language:
> `requires` stays about *machine* properties (`gpu`, `usb`, `human-present`) rather than
> becoming a package list, which is what `KNOWN_CAPABILITIES` would otherwise drift into.
>
> **Consequence: a runner must be able to evaluate a flake.** The supervisor image is Alpine
> and ships no `nix`, so flake-provided acceptance commands cannot run there until it does.
> That is the prerequisite for this approach, and it is not yet met.

**A gate can leave evidence, and the exit code still decides.** "A shell command that exits
0" is the right primitive and it cannot express what a change *renders*. A task that alters
a page, a component or a layout can pass every gate — acceptance green, CI green, council
satisfied reading the diff — and be visibly wrong, because nothing in the pipeline ever
looked at it. That is also the honest answer to "why can't you write an end-to-end test for
this": until now, because a gate could not produce or return an image.

So gate 1 creates an empty directory, names it in **`CATERPILLAR_EVIDENCE_DIR`**, runs the
commands, and publishes whatever they left there as §17 artifacts — **whether the gate
passed or failed.** A repo whose `flake.nix` provides Playwright writes
`acceptance: ["npx playwright test"]` and the fleet gates on rendered output, with no new
subsystem in the supervisor.

Five properties, and each is a decision rather than an accident:

- **Failure is when the image matters most.** Publishing only on success would discard the
  evidence in the one case that needs explaining. The failure text names what it collected.
- **It is never the pass condition.** Nothing in the collection path returns a verdict. An
  image is evidence for a human and for the council; the command's exit code is the whole
  gate. A green gate that wrote a 4 MB screenshot has passed; a red one that wrote a tidy
  small one has not.
- **The directory is emptied first, and lives outside the checkout.** The per-task scratch
  survives between sessions by design (§6.2), so a screenshot from three sessions ago would
  otherwise be published as evidence about a diff it predates — worse than none, because it
  looks current. And a file inside the worktree is a file in `git status`: the next session
  to run `git add -A` would commit a screenshot into the pull request.
- **Over the cap is refused, and legibly.** See §17 — the bytes do not land, but the size
  and the limit are reported, because "too big to commit" and "the gate wrote nothing" must
  not read the same way in a journal.
- **The browser environment is decided once, in `workspace/toolchain.ts`.** A browser needs
  a writable cache directory and it needs a sandbox decision, and neither is something a
  task should discover for itself. `XDG_CACHE_HOME` points at `<paths.tasks>/.cache`,
  created before the first task command runs, shared across tasks and reserved against a
  devShell the same way `HOME` is: that is the variable Playwright resolves its browser
  registry from on Linux when `PLAYWRIGHT_BROWSERS_PATH` is unset, and npm, pip and nix
  honour it too. Shared rather than per-task because a browser bundle is a few hundred
  megabytes and the per-task directory is reaped when the task finishes, so a per-task cache
  would never amortise one download. An operator's own value wins; the container sets none.

  **No privileges are asked for and no sandbox is disabled.** Worth stating because the
  obvious next step — `--privileged`, or `CAP_SYS_ADMIN` in the pod's securityContext — is a
  large permission for a small reason. `playwright-core` launches the `chromium` channel
  with `--no-sandbox` on Linux of its own accord, so the browser a flake provides runs as
  is. A repo that genuinely wants the real sandbox needs a runner configured for it, and
  that is a machine property — which makes it `requires` (§8), not something the resolver
  can grant.

**A human can write `done` past both gates, and the record has to say so.** A task can be
*obsolete* rather than finished — superseded, descoped, or answering a question nobody is
asking any more — and until `/done` there was no way to say that. `/merge` is the closest
thing and it is not this: it merges the PR under the reviewer identity, so it refuses with
no PR and with no reviewer identity configured, and it is an override of the *council*
rather than of the gates. Obsolete work has nothing to merge and often nothing on a branch.

So `/done task:<id> reason:<text>` writes `status = done` and merges nothing. `reason` is
required on both the command and the button's modal, because a forced completion with no
stated cause is unauditable — and the journal entry names who forced it, quotes the reason,
and says the gates were **BYPASSED**. It must never read as a task that was verified; that
is the whole point of the entry, and `loop.test.ts` asserts the words `passed` and
`verified` appear nowhere in it.

It is refused on `running`. The session holds the lease, so the write would either lose its
compare-and-swap or land under an agent still working — `/cancel` stops one at a turn
boundary and the force is available a poll later. `parked`, `failed` and `awaiting-human`
are the statuses it is for.

The tracker is mirrored through the **`parked`** transition, not `completed`. `completed`
carries a `prUrl` this command may not have, and it is the transition that *means* the gates
passed — it comments "acceptance criteria and CI verified" and closes the item. `parked`
releases the item and puts the reason on it, which leaves the issue open and honest. Closing
it needs a transition of its own (§9.5) and the reason above is why it cannot be this one.

### 12.1 The review council

A third gate, after those two and never instead of them. Both of the first pair measure
*outcomes* — commands exit 0, CI is green — and neither of them reads the change. A change
can satisfy both and still be wrong in ways only reading catches: the test that was
weakened to pass, the error path that swallows, the half of the goal that was quietly not
implemented.

**Four read-only reviewers, four different lenses** — correctness; design, simplicity and
the record; test-first discipline; acceptance fit — run concurrently in the task's existing
worktree, joined by a fifth, `sabotage`, when there is source to break. Different rather
than redundant: three runs of one prompt catch variance, but only a different lens catches a
failure mode the first one is blind to. The four read-only lenses share the worktree safely
because their tool surface is `read`, `bash` and `submit_verdict`: no `write`, no `edit`,
and none of the implementation agent's control verbs. `sabotage` is the one reviewer that
can write, and it writes only in a copy of its own — see below. No reviewer of either kind
can open a PR, claim completion, ask a human, or hand off.

**The fifth reviewer breaks the code on purpose.** Reasoning about test quality does not
settle it: a reviewer reading a diff can say the coverage looks thin, and that is an opinion
about a test suite rather than a fact about one. So this lens inverts a condition, empties a
function body or drops a guard, runs the task's acceptance commands, and reports what got
through. Either a sabotage of behaviour this diff introduced passed unnoticed — a test that
does not test, worth a round trip — or it did not, which is a pass worth stating plainly.

It is convened only when the diff touched source (`prLenses` in `review/lenses.ts`, off
`review/tdd.ts`'s `touchesSource`): a documentation or configuration change has nothing to
break, and a reviewer that can only abstain still costs a concurrent session and a copy of
the checkout. It works in a **private copy** of the checkout, a sibling directory under
`<taskDir>/.caterpillar/sabotage` — beside rather than inside, so the copy never appears in
the original's `git status`, and made a checkout by rewriting git's pointer files rather
than by `git worktree add`, so the shared mirror is only ever read. The other four
reviewers' worktree, the branch and the pull request are therefore untouched by anything it
does, and the copy is removed whichever way the round ends, including a throw out of the
concurrent stage. Three bounds hold it: a total **command cap** (`limits.sabotageMaxCommands`,
default 40 — this is the one lens whose loop is naturally unbounded, and exhausting the
budget fails the command with an instruction to submit what it has rather than throwing away
the verdict it had formed), the same **per-command timeout** every other shell here gets,
and a **disk floor** (`limits.sabotageMinFreeGb`, default 5) below which the copy is refused.
A refusal drops the lens from the round and records an abstention carrying the reason; it
never fails the council, and it never falls back to the shared worktree.

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

**Operator guidance resets the count; a bare `/resume` still does not (§7.3).** The cap
detects a loop with nothing new entering it, and guidance is the one thing that is new. Left
unforgiven it made the park unrecoverable rather than terminal: a resume bought exactly one
more round, so `BS-1539374658363854934` reached 13 rounds against a cap of 3 by being resumed
ten times with nothing to say. `sessions` is still never forgiven, for this paragraph's
original reason — that one is a budget, and raising it is a decision.

**An unresolved review comment on the pull request resets it too (§7.3)**, and for this
paragraph's argument rather than a new one: what the cap is measuring is the absence of new
information, not the surface the information arrived on. It is forgiven once per objection,
against the `review.commentSeen` watermark — forgiven per session instead, a single comment
would delete the cap rather than inform it.

**A task spanning several repos merges all of its pull requests, in `spec.repos` order, and
stops at the first failure** (§9.4.1). The order is the closest thing to a dependency order the
supervisor has, and the repos of one change usually cannot land in either one.

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

**The reviewers are shown the gate's evidence, read-only.** An artifact the gate produced
(§12) is staged into `<taskDir>/evidence-in/` before the round starts and the paths are
named in every lens's prompt — which is the whole difference between an artifact being
*stored* and it being *evidence*: a reviewer told "there are screenshots" and not where has
been told nothing it can act on. No new tool; `read` handles text and `bash` handles the
rest.

Three things about it, for the same reasons the gate side has them. It is the task's **own**
artifacts, not its blockers' — along a `blockedBy` edge an artifact is input to the next
task's work (§17), here it is evidence about the change under review. The files are written
**read-only** (`0o444`): four reviewers hold no writable tool but `sabotage` holds `write`
and `edit`, and all five run concurrently, so a reviewer that edited the screenshot it was
shown would change what the others are looking at mid-round. And it is staged **beside** the
checkout, never inside it, so evidence never shows up as an uncommitted change in the shared
worktree or in the sabotage copy of it. A round with nothing to show gets no directory and no
section — "Evidence: none" would be carried by every task that renders nothing, and it reads
as a finding about the change rather than a fact about the pipeline. Staging that fails is
logged and the round proceeds on the diff alone, which is what every round did before this
existed.

Verdicts are written to `tasks/<id>/reviews/NNN-verdict.md`, numbered by session and never
overwritten, and appended to the journal — the journal is what the next session actually
reads, so a rejection has to arrive there as instructions rather than as a score.

### 12.2 The standards, and why both sides are given the same words

Everything above grades a change. `agent/standards.ts` is what it is graded *against*, and
the reason it is a module rather than four paragraphs in a prompt is that **the agent that
writes the code and the council that reads it are handed the same constants**. Written
twice they drift, and a drifted standard produces the most demoralising round trip this
system has: a task sent back over a rule its session was never told, with no way for the
next session to see what it missed.

The content is Google's engineering practices, distilled into instructions to an agent
rather than advice to a team — the code review standard, what to look for in a change, and
the change author's guide to writing a description:

| Constant | Given to the author | Graded by |
|---|---|---|
| `CODE_HEALTH_STANDARD` | every implementation and remediation session | the `design` lens |
| `TEST_FIRST_STANDARD` | the same | the `tests` lens |
| `WRITING_STANDARD` | the same | the `design` lens |
| `REVIEW_STANDARD` | **nobody** — see below | every PR lens |
| a repo's `.caterpillar/standards.md` section | every implementation and remediation session on that repo | the lens its heading names — see *A repository's own standards* |

`REVIEW_STANDARD` is the one asymmetry and it is deliberate. Its central sentence is
Google's — *approve once the change definitely improves the overall health of the codebase,
even if it is not perfect* — which is permission to let something merge. That is what stops
a multi-lens council being a bottleneck. Handed to the author it reads as permission to ship
whatever survives a lenient reading, which is the opposite of its purpose, so the bundle
the author gets (`AUTHOR_STANDARDS`) excludes it and a test asserts that it does.

**Test-first is not optional, and the commit order is the only thing that can prove it.** A
change written test-first and one with the tests bolted on at the end produce *identical
trees*. No reviewer reading `git diff` can tell them apart, so a lens asked to grade the
discipline would be grading the agent's claim about itself. What distinguishes them is the
order of the commits — which is why the author's prompt asks for the failing test as its own
commit as a mechanical requirement rather than as a virtue, and why the supervisor reads it
back:

- `WorktreeManager.commitsSince` logs the branch **oldest first** (`--reverse` is
  load-bearing; git's default would invert every verdict while still reading as plausible),
  with the files each commit touched.
- `review/tdd.ts` classifies each path as test, source, or neither — polyglot, because the
  fleet is pointed at whatever repo an operator owns and a classifier that only knows
  `*.test.ts` reports every Go change as untested. It flags source commits with no test in
  them and none before them.
- The result goes into the prompt **every** lens receives, as a *Test-first evidence*
  section. Only `tests` is asked to reach a verdict on it; a correctness reviewer is simply
  better informed knowing the fix landed three commits before anything exercised it.

That module decides nothing, and must not. It reports order; a docs-only change and a spike
that was covered before it landed both have legitimate shapes, and only a reader can tell
which is which. The narrow carve-out — documentation, comments, formatting and pure
configuration have no behaviour to test — is stated to the author and to the lens in the
same words, because a rule that produces absurd work is one the next session learns to
ignore in the cases that matter.

Its cost is a fourth concurrent reviewer on every round of every task, roughly a third more
review spend. That buys the one defect class both earlier gates are blind to *by
construction*: a test weakened until the suite goes green passes acceptance and passes CI,
because the suite is green precisely because the test stopped asking.

#### A repository's own standards

Everything above is the fleet's, and identical in every repository it is pointed at. A repo
with house rules of its own had nowhere to put them **that the council would also read**:
put them in `AGENTS.md` and the implementation agent reads them while the reviewers do not,
which is precisely the asymmetry the paragraphs above exist to forbid.

So: an optional `.caterpillar/standards.md` per repo, read from the task's checkout by
`readRepoStandards`, spliced into the author's system prompt (`systemPromptFor`) **and**
into the reviewer prompts (`repoLenses`) from the *same parse* and through the same
renderer. One file read from the repo, and deliberately nothing else — no registry, no
sharing links, no install flow, no content hashing, no versioned bundles. Those solve a
distribution problem a self-hosted fleet does not have.

**Every section names the lens that owns it, in its own heading.** The format is
`## <lens>: <title>`, with `<lens>` one of `correctness`, `design`, `tests`
(`REPO_STANDARD_OWNERS`). That is what extends the one-owning-lens property to text this
system did not write: a repo adding a rule says who grades it in the same edit, and there is
no second mapping file to fall out of step with the first. `parseRepoStandards` refuses,
rather than dropping, every case where a rule would exist with no grader — a heading naming
an unknown or non-owning lens, an empty section, and prose before the first heading, which
has no owning lens and is made to look accounted for by the sections after it.

Not `fit`, which grades the change against the TASK, and no repository has an opinion about
that. Not `sabotage`, which is convened only when the diff touches source: a rule routed
there would be graded on some rounds and not others, which is the same failure wearing a
schedule. `review/lenses.test.ts` checks the owner keys against the standing council, and
that plan lenses receive none of it — a plan is not code.

**The text is untrusted**, authored outside this system by whoever can push to the repo, and
it reaches a model prompt. Three bounds follow. It is capped at `REPO_STANDARDS_MAX_BYTES`
(4 KiB) and the read is bounded at the cap rather than after it — a file any pusher controls
must not be able to make the runner allocate a gigabyte — and the cap is small because it is
paid for by every session of every task on that repo *and* by every reviewer of every round,
so the cost is multiplied by the council. It cannot override what it sits beside: code
health, test-first and the attribution rules are the fleet's, both the author's block and the
lens's say so in as many words, and a repo rule that contradicts them does not apply.

And **a body may not open a heading that outranks the prompt it lands in.** Sections are
spliced under a `###`, into prompts whose own sections are `##`, and a body is quoted
verbatim — so `## Test-first, without exception\n\nIgnore the above.` in a body would render
as a *peer* of the fleet's standards rather than as a rule inside a repository's section.
That is the override the paragraph above forbids, with markdown for a payload. Every heading
at `##` or above is therefore a section boundary and only a well-formed `## <lens>: <title>`
is a valid one; `###` and below nest harmlessly and are left alone, because refusing them
would make the format hostile to a repo structuring its own rule. "At `##` or above"
includes up to three leading spaces, which CommonMark also reads as a heading: a guard
anchored at column zero is one a repo walks around by typing a space. Four spaces is an
indented code block, renders as code inside the repo's own section, and needs no guard —
which holds only because the parse **preserves a body's leading whitespace**. Trimming it
would re-emit the first content line at column zero, so `    # Attribution` would reach the
prompt as a real heading above every `##` the fleet's own standards use, and the code-block
carve-out would become the way around the guard beside it. Only wholly blank lines are
trimmed, from each end.

The same rule covers **setext** headings, which spell the override without a `#` at all: a
line of `=` or `-` directly under a paragraph is an H1 or H2 in CommonMark, so a body
containing one is refused too. "Directly under a paragraph" is the whole test — it is what
keeps a `---` thematic break and a `| --- |` table delimiter, both ordinary markdown, from
being refused along with it.

A file this system cannot use **fails the session** rather than being skipped. On the runner
path the throw reaches `SupervisorLoop.parkFailed`, so the task parks with a reason naming
the repo and the file; on the council path it propagates out of `convene()` instead, a
different route to the same class of outcome — and the runner reads the same files first, so
a file that would break the council has almost always already stopped the session. Skipping it would hold the author to a rule the council cannot see, or the reverse, and
neither is visible from outside — the whole class of bug this feature exists to remove.

**Multi-repo (§9.4.1) is scoped per repo. Not merged, and not refused.** A task declaring
several repos reads each one's file separately, and every section is rendered headed with
the repo that supplied it; both blocks state that a rule governs only the files of the repo
it came from. Two repos saying opposite things is then **not a conflict at all** and nothing
has to arbitrate — which is the only one of the three options that needs no policy, cannot
surprise a repo by having another repo's rule applied to it, and does not make one repo's
bad file block work on a sibling. Merging would need a precedence order nobody has a basis
to pick; refusing would let any repo in a workspace veto every multi-repo task touching it.

Read per session and per round rather than cached, because the file is on the branch the
task is working: a session that adds a rule is held to it, and so is the council reviewing
that very change.

### 12.3 An acceptance criterion is amended, never rewritten

`spec.md` is immutable and stays immutable: rewriting the spec of a running task changes
its completion gate mid-flight, and the file is also the record of what the task was
actually asked to do. But a declared criterion can turn out to be **unsatisfiable**, and
when it does, the gate is wrong and no amount of work inside a session fixes it. Three
real ones in one morning: a repo-wide `npm run lint` demanded of a 42-line feature branch;
a `git ls-files 'src/app/overlays/[id]/...'` glob where `[id]` is a wildmatch character
class, so it could never match the literal directory it mandated; and a repo-wide
`prettier --check`. Two of those tasks had already been rejected twice on the same
impossible line.

The only lever available was to hand-edit the immutable file in the state repo. That is
the thing immutability exists to stop, so the supported lever is an **amendment**:

```
tasks/<id>/amendments/001.yaml
```

```yaml
acceptance:
  - npm test -- src/widget
why: the repo-wide lint predates this branch and fails on files it does not touch
author: operator
at: 2026-08-19T09:14:02.113Z
```

Five decisions, each of which is the interesting part:

- **`readSpec` returns the EFFECTIVE spec** — the base document with the newest
  amendment's acceptance list applied. There is deliberately no opt-in
  `readEffectiveSpec`, because an opt-in method is a rule every future call site has to
  remember, and the site that forgets is the one where the verifier runs a criterion a
  human already amended away. That is precisely the failure this mechanism exists to
  prevent, so the seam is the one that cannot be forgotten. `readBaseSpec` is there for a
  reader that genuinely wants the document as filed, and says so.
- **The highest number wins entirely.** Not merged across amendments, not applied in
  sequence. Merging would resurrect a criterion an earlier amendment deliberately removed,
  and the author of amendment 3 has no way to know it was doing that.
- **A whole-list replacement, not a positional patch.** "Replace entry 2" is unreadable
  six months later without the original file open beside it. The full list *is* the gate,
  written out, in the record that changed it.
- **Append-only, so the file list is the audit trail.** Nothing rewrites or deletes an
  earlier amendment; `writeAmendment` allocates the next number from the highest one on
  disk. `why` is required for the same reason: an amendment nobody explained is a
  hand-edited `spec.md` with extra steps.
- **Only `acceptance`.** A file naming `repos`, `workspace`, `requires`, `toolchain`,
  `kind` or the prose goal is refused by name, loudly, rather than partly applied.
  `repos` is the forge token's scope, which makes it a §9.1 blast-radius decision and not
  a chat command; the rest decide where and how the task runs; and a wrong prose goal
  deserves a fresh task with clean history rather than an overlay that makes the filed
  document a lie. An amendment also cannot empty the list, for the reason gate 1 exists
  at all: a task with nothing the supervisor can run could never be closed.

### 12.3 A merge queue is enqueued, and a conflict is said out loud early

Two holes on the merge path, both of which turned an ordinary situation into a
terminal-looking failure at the very end of a task.

**A merge queue is a gate the repo's owners chose.** On a base branch protected by one, a
direct `PUT /pulls/{n}/merge` either fails or *bypasses the queue* — and bypassing is the
worse outcome, because it defeats the protection rather than reporting it. So the council
asks (`Forge.mergeQueue`) and enqueues instead (`Forge.enqueue`) where there is a queue.

The question is asked about the **pull request**, not about a branch name. Nothing in
`state.json` records what a pull request targets — only its number and url — so a caller
taking a base branch would have to guess it from the repository default, which is wrong for
any task based on anything else. GitHub's `pullRequest.mergeQueue` answers directly, and it
is asked rather than `branchProtectionRule.requiresMergeQueue` because a queue can be
required by a **repository ruleset** as well as by a classic protection rule and only the
former sees both.

**"In queue" is its own state.** Not success, not failure. This is §11.1's lesson about CI
`pending` pointed at the other end of the path: an unfinished answer returned as a failed
gate cost three whole sessions. A queued pull request has not landed and the queue's own
checks can still reject it, so a human told "merged" stops watching something that is not
finished. `mergeNote` in `forge/mergeability.ts` always names a queued pull request as
queued, and the `merged` chat outcome carries that note rather than gaining a fourth kind —
the request succeeded either way, and every caller that branches on it behaves identically.

**A forge that cannot answer must not block the merge.** `mergeQueue` returns
`"required" | "absent" | "unknown"`, and `landingFor` merges on `unknown`. That is not
optimism: the merge itself is the authority, since GitHub refuses a direct merge into a
queue-protected base with a 405. Guessing wrong costs a reported failure; refusing on an
unanswered question costs every repo whose forge cannot answer, which is all of Forgejo.
Forgejo has no merge queue at all, so it answers `"absent"` — a fact about the forge, not a
failure to look — and its `enqueue` throws, because reaching it means the state machine
broke and a silent no-op would report a queued merge on a forge with no queue to hold it.

**A queued merge is not a completed one, so it stops the sequence.** §12.1's ordering rule —
merge in `spec.repos` order, stop at the first failure — now stops on a queued pull request
too (`stopsTheSequence`). A queue runs the change's checks against a speculative base and
can still reject it, so landing the sibling now risks exactly the half-landed state the
ordering rule exists to prevent. The remaining pull requests are left open and the note
names them.

**A conflict is ordinary drift, and it is reported twice.** A task that ran for several
sessions can end on a branch its base has moved past. That used to surface as a merge
failure after every gate had passed, which reads as terminal and is nothing of the kind. So:

  - **At session start**, `agent/runner.ts` computes a conflict summary — which files, how
    many hunks — and puts it in the prompt, so the agent rebases as ordinary work. It
    refreshes the mirror first, and that is load-bearing: `addWorktreeLocked` deliberately
    does not fetch for a worktree that already exists, so without the refresh every session
    after the first would compare against the commit it forked from and report "merges
    cleanly" for every drift there is. It is safe there and nowhere else on that path,
    because it runs inside `credentials.activate` — the verifier and the progress probe run
    after `clearActive()` and cannot authorise a fetch (§9.2).
  - **At the completion gate**, `supervisor/verifier.ts` rejects the claim with the same file
    list. Rejecting costs a session and gets the rebase done; passing costs the same session
    plus a failed merge at the point where nothing is left to fix it.

The summary is computed with `git merge-tree --write-tree`, which touches neither the index
nor the working tree — safe to run in a worktree the agent is about to work in — and writes
a real tree carrying the conflict markers. That tree is where the hunk counts come from:
`--name-only` names the files and counts nothing, and "three files conflict" is a very
different instruction to hand a session than "three files conflict, one line each".

All three outcomes are distinct, and the third is why: **clean**, **conflicted**, and
**unknown** — a base git could not resolve, which happens whenever a worktree's mirror has
been re-pointed. Folding `unknown` into `clean` would tell a session its branch was fine
because nobody could check. It never fails anything; the primary repo only, because every
extra repo costs a `merge-tree` and a `git show` per conflicting file before the first
token.

The state machine and the summary shape are pure, in `forge/mergeability.ts`: no forge
calls, no git calls, no clock, so every decision above is testable without a network.

---

## 13. Agent tools

| Tool | Provider | Notes |
|---|---|---|
| `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | pi built-ins | |
| `open_pr`, `ask_human`, `handoff`, `done` | supervisor | control-plane verbs, typed. `open_pr` takes an optional `repo`, one of the task's own (§9.4.1) |
| web search / fetch | supervisor | fewer human round-trips on unfamiliar libs |
| Grafana / Jira / Atlassian | MCP | verify impact, pull requirements |
| `cluster_logs`, `cluster_events`, `cluster_describe` | supervisor | read-only cluster evidence — no writes of any kind |

The control-plane verbs being *tools* rather than parsed prose is load-bearing: every
state transition is typed and auditable.

The three `cluster_*` reads bind **only for `kind: remediation`** (§20), and only on a
runner where an operator has set `cluster.enabled`. An `implement` or `brainstorm` task
never receives them, even on a runner where the reader is configured — the binding is by
task kind, in `agent/tools.ts:toolsForKind`, and that is the security boundary of the whole
feature rather than an implementation detail of it.

They are tools instead of `kubectl` in the agent's shell for the reason §9.2 gives for every
other credential: the ServiceAccount token stays with the supervisor. Were it the pod's
ambient credential, every task that ever ran on the runner would inherit cluster read access
and the bound would be whatever the model chose to type. Instead each call is checked against
a namespace allowlist that is supervisor configuration, `cluster_describe` can read eleven
kinds and no others, and a Secret comes back as key names and byte lengths — the values never
leave the supervisor, because Kubernetes RBAC cannot express "keys but not values" and
`cluster/redact.ts` is therefore the entire boundary.

---

## 14. Task intake

Six paths, all converging on a `spec.md`:

1. **GitHub issue** labelled `agent` → ingester renders a spec. (`primary`)
2. **Vikunja task** labelled `agent` → ingester renders a spec. (`oss`)
3. **Discord** `/brainstorm` → refine into a plan → child tasks (§14.3). Fastest, works
   from a phone, and the only path that produces acceptance criteria by asking for them.
4. **Hand-committed** `tasks/TASK-x/spec.md` (most control over acceptance criteria).
5. **A firing Alertmanager alert** → `POST /alerts` on the supervisor's own webhook port →
   policy lookup → a `kind: remediation` spec (§20). The only path with no human in it at
   all, which is why it is also the only one that must be opted into twice: the receiver is
   off by default and refuses to start without its bearer token, and an alert becomes a task
   only if an operator has already written an entry for its `alertname` in the state repo's
   `alerts/policy.yaml`. The entry supplies the workspace, the repos and the acceptance
   commands verbatim — this path synthesises none of them. An unlisted alert is refused
   once, durably, rather than per delivery.
6. **A clock** — a `schedules/<id>.yaml` in the state repo, fired on the housekeeping loop
   when its cron expression comes due in its named IANA zone (§22). The second path with no
   human in it at the moment it fires, and the only one that can decline to spend a session
   at all: a schedule may declare a **precheck**, a bounded command whose non-zero exit
   records a skipped occurrence instead of creating a task. Like path 5 it synthesises
   nothing — the workspace, the repos, the prompt and the acceptance commands are the
   operator's — and it is off until `schedule.enabled` says otherwise.

Path 5 answers Alertmanager in milliseconds and enqueues in memory; the spec is written on
the supervisor's own thread of control on the next poll, because the loop owns the state repo
working copy. Everything after the spec is identical to every other path: it is claimed,
sessioned, gated by §12 and ends in a pull request.

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
/brainstorm topic:… repo:owner/a, owner/b
   → thread opens, brainstorm task created
   → agent reads the repos, asks one question at a time via ask_human
   → submit_plan
   → review council (plan lenses)
        ↘ changes → back to the same session
        ↘ pass    → child tasks, tagged wave + blockedBy
```

A human watching that thread can talk into it at any point, and what a message does depends on
what the brainstorm is doing: it answers an open `ask_human`, steers the session that is
proposing, or — once the round cap has parked it — becomes guidance that resets the count and
offers a Resume button. See §7.3, which exists because none of that was true and the
notification asking for it said otherwise.

**A brainstorm is a task kind, not a special case.** `kind: brainstorm` in the spec. It
gets the same lease, the same journal, the same park-and-resume cycle. Two things differ:
its tools are `read`, `bash`, `ask_human`, `handoff` and `submit_plan` — no `write`, no
`edit`, no `open_pr`, no `done` — and it is the **only** kind permitted to declare no
acceptance criteria, because its gate is the council's verdict on its plan rather than
§12's commands. That exception is narrow and deliberate; everything else still refuses.

**A brainstorm may span several repos, within one workspace.** The `repo:` option takes a
list — `owner/a, owner/b`, separated by commas or spaces, because Discord's single-line
option box invites both. Everything downstream was already plural: `spec.repos` is a list,
`WorktreeManager.checkout` lays the siblings out under `repos/<name>` (§9.4.1), and
`materialise` hands `defaultRepos: spec.repos` to every child, so the plan a two-repo
brainstorm produces cuts two-repo tasks. The entry point was the only thing that could not
say it, which meant a change spanning a client and its server had to be refined blind on
one side of it.

The option keeps its singular NAME deliberately: renaming it re-registers the command and
breaks the muscle memory of everyone using it, to no benefit — one repo is what a list of
one looks like. Repeats collapse, and order survives, because `repos[0]` becomes the
agent's working directory (§9.4.1) and so the first one typed wins.

**Crossing workspaces is refused, not narrowed.** Every entry is resolved with
`resolveWorkspace`, and if two land in different profiles the whole command is refused with
a message naming which repos went where. This is a containment boundary (§3.1/§9.1) rather
than a convenience check: a workspace is one forge, one owner, one credential bundle, and
one session holding two is exactly the blast-radius expansion the workspace model exists to
prevent. Silently dropping the repos from the second workspace would be worse than
refusing — it produces a plan about half a system and does not say which half is missing.
A repo no workspace owns is refused on the same terms rather than guessed at. The refusal
comes back as a `refused` `ChatOutcome` and is posted into the thread, so the human reads
why instead of watching a thread that never becomes a task.

**Its id is its Discord thread id** (`BS-<threadId>`). Unique without coordination,
collision-free across runners, and its own reverse index: a message in a thread resolves
to a task without a lookup table. The same discipline `taskIdFor` applies to a tracker
ref — derived from something external and immutable, never from a title.

**Refinement is one question at a time.** `ask_human` already parks the task and releases
the lease, so a question costs nothing while a human thinks. That makes the expensive
thing not the round trip but the batch: six questions at once get one answer covering two.

**A brainstorm does not queue behind batch work.** Someone typed it and is watching the
thread; an implementation task is throughput and nobody is watching any single session of
it. Three things follow, and all three were bugs before they were rules:

*Claiming puts a brainstorm first.* Ordering was `(wave, id)`, and a brainstorm's id is
its Discord thread id — a snowflake, so the newest brainstorm always sorted **last**,
behind every task already in the repo including the children of previous brainstorms. It
could therefore only start when the queue was empty, which for a runner working a
multi-session task means never. Observed: a brainstorm created at 19:35 was still
unclaimed twenty minutes later while the runner re-claimed an older task six sessions
running. Priority is a tie-break ahead of the existing order, never a replacement for it
— waves still order among themselves and the id is still the final key, so two runners
sorting the same queue reach the same answer.

*A session in flight yields a slot at its boundary.* `workTask` drives one task through as
many sessions as it needs, so a task that keeps handing off holds its slot indefinitely.
Since the housekeeping split (§6.4) the chat drain is no longer blocked with it, so the
brainstorm request is drained, answered and turned into a task on schedule — but the slot it
needs is still occupied, and a claim is what only the work loop can make. So the runner
checks the inbox at each session boundary and, if a brainstorm is waiting **and no slot is
free**, puts the task back to `ready` and gives its slot up. Housekeeping fixed the latency
of *acknowledging*; this fixes the latency of *starting*, and neither substitutes for the
other.

The free-slot condition arrived with §6.5 and is what keeps this proportionate. It used to
hand back the whole runner, which cost nothing when a runner was one slot; at
`concurrency: 4` with one session running there are three slots the very next pass will
claim the brainstorm into, and releasing a working task to solve that would cost a session
boundary, a state push and a re-claim for nothing. At the default N=1 there is never a free
slot while a session runs, so the behaviour is exactly what it was.

The check reads the queue without taking from it — the request is left for
`applyChatRequests` on the housekeeping loop, which is what actually creates the task now.
Deliberately not an interrupt: `/cancel` aborts a session because stopping it *is* the
intent, whereas here the session is doing legitimate work and an interrupted session
records nothing at all (§6.4). Waiting for the boundary costs the human the tail of one
session and costs the task nothing. It is `ready` rather than `running` because
re-claiming a `running` task is the crash-recovery path (§6.2) and writes a journal entry
about a runner that died — true after a killed pod, a lie once per brainstorm.

*The thread talks before the write lands.* The bridge opens the thread, binds it, and
greets the human immediately, then queues the creation. All of that is free: the task's
id **is** the thread id, so nothing about the greeting or the binding needs the state repo
written first. Binding early is safe because ordering makes it safe — the creation is
queued ahead of anything typed afterwards and `drain` preserves that order, so by the time
an answer is applied its task exists. A refusal takes the binding back, because a bound
thread with no task behind it swallows what is typed into it in silence.

None of this made the runner concurrent, and for a long time it did not need to: what these
three fixed was which task a one-slot runner picks up next and how soon it is free to pick.
Concurrency came separately, in §6.5, and it does not replace any of them — the claim
ordering still decides which of several claimable tasks fills a slot first, and the yield
still applies when every slot is full. It only makes "every slot is full" a question with
more than one answer.

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
task at a time (§6). Actual parallelism comes from scaling the StatefulSet, which git-ref
leasing already makes safe (§5). A wave of four on a single replica is four sequential
tasks in a defined order — worth having, and genuinely parallel once the fleet is wider
than one.

**A plan is a prediction, so it is re-checked.** When a task from a plan reaches `done`, a
short maintenance pass reads what it actually did and may move the edges between its
remaining siblings. It can do nothing else: creating a task means writing a goal and
acceptance criteria no human saw, which is a brainstorm's job with a council in front of
it. When the finished work implies genuinely new work it says so in a note and a human
runs `/brainstorm`. Every guard is in the supervisor, not the prompt — siblings of the same
plan only, never a task that has already started, and a revision that would introduce a
cycle is discarded whole rather than partially.

### 14.1 The `agent` block

**Who wrote it is checked before what it says.** On GitHub the item's author must hold
`OWNER`, `MEMBER` or `COLLABORATOR` — push access, in other words. `CONTRIBUTOR` is
deliberately not enough: GitHub grants it for one merged commit, which on a public repo
is close to "anyone who has ever been helpful once".

The label cannot carry this on its own, and the reason is a sequencing property rather
than a trust one. A maintainer applies `agent` to an item; the AUTHOR keeps the right to
edit the body afterwards, forever. Intake re-reads the body on every pass, so the text
that gets executed is not the text anyone approved. Since `acceptance` runs as shell in
the supervisor's own process, before the CI gate, the gap between "labelled" and
"executed" is a gap between two different documents.

The refusal for an untrusted author deliberately does **not** quote the template back.
Everywhere else a refusal explains exactly what to write, which is right when the reader
is allowed to write it; here it would be a set of instructions for making the body
executable, handed to the one person who must not have them. The comment says a
maintainer should open their own item instead.

Vikunja has no equivalent check and needs none: writing to a project requires an account
someone provisioned, and the agent's token only sees projects that account was granted.
There is no arm's-length contributor. `VikunjaTracker` says so at the line that sets
`authorTrusted`, so a future public instance has one place to change.

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

**The interval bounds one runner; a claim bounds the fleet.** ~13/min is comfortable and
N × 13/min is not — ten replicas exhaust the hourly allowance and, because the limit is per
*installation* rather than per endpoint, take every forge call down with them. So the
interval becomes a bucket and the bucket becomes a claim: `refs/intake/<bucket>`, won by
the same compare-and-swap that claims a task (§5). The winner ingests, the losers skip the
pass outright and are not delayed by it.

Nothing releases the ref — its existence *is* the record that the bucket has been served,
which is what makes it idempotent across a restart. A runner that dies mid-pass costs one
skipped interval, and intake is best-effort by design.

Bucketing on wall-clock rather than on each runner's own last-intake time is what lets
replicas agree without talking: two pods that booted forty seconds apart compute the same
bucket. The agreement is approximate at a boundary and that is accepted rather than fixed —
runners firing either side of one land in adjacent buckets and both win, so a fleet can
ingest *twice* in an interval, but only twice however many replicas there are, because
everyone before the boundary shares a ref and everyone after shares the other. Two passes
the budget absorbs. A tighter scheme would need the runners to agree on a clock, which is a
distributed clock to be wrong about in exchange for one saved request per five minutes.

A claim that *errors* is not a claim someone else won, and is treated as a win: a
state-repo blip must not stop intake fleet-wide and silently. A duplicated pass is
idempotent (`hasTask`); a skipped one is work nobody sees.

**What gets refused.** Four questions are asked of an item, each one the first moment the
answer is cheap, and all four refuse through the one path above — recorded, suppressed,
commented once, visible on `/intake` (§14.5):

- the body does not parse into a spec, or names no `acceptance` (§14.1);
- its author does not have write access, so the body is not run as shell (§9.1);
- it names a repo the workspace's credential cannot reach (§9.1.1);
- its `toolchain.packages` names an attribute that does not exist in the pinned nixpkgs
  (§8.1).

The last two are *usability* checks and not security boundaries — `assertWorkspaceScope` is
that — and both fail open: a forge that cannot be asked and a nix that cannot evaluate are
the absence of evidence, and a refusal needs evidence. A repo or an attribute that is
genuinely wrong is refused on the next pass instead.

Ordering inside a single ingest is load-bearing: `state.json` is written first and
`spec.md` last, because `spec.md` is the existence marker. A crash between the two leaves
a task the claim loop skips and the next pass recreates cleanly; the reverse order would
wedge the item as permanently existing and never claimable.

### 14.5 A refusal that nobody can see is a refusal that did not happen

Everything above is durable and none of it was *visible*. A refused item was a warn line in
one pod's stdout, a JSON file in the state repo, and a comment on a tracker item nobody is
watching — so a fleet whose only labelled issue was refused looked exactly like a fleet
nobody had given work to. That is how this was reported: "I have never seen an agent pick up
an issue", about a fleet that had worked an issue across five sessions and opened a PR.

Three things changed, and each of them is the smallest one that answers the question.

**The refusal record grew the fields a page needs.** `{digest, reason, at}` could not be
rendered as anything but text: `GH-acme-all-chat-724` does not say where the owner
ends and the repo begins, so nothing could link to the item being refused. `url`, `title`
and `workspace` are now written too, and all three are **optional** on read. That is not
tidiness: the digest is the suppression key, a record whose *shape* changed must not read as
a record whose *item* changed, or the first poll after a deploy re-comments on every open
refusal — the exact spam §14.2 exists to prevent. `listIntakeRejections()` is the mirror of
the `listAlertRefusals()` the alert path already had.

**The pass is remembered, in memory, for one runner.** `IntakePass {seen, created, rejected,
failed}` was returned, logged once, and discarded; `seen` is the field that separates
"nobody labelled anything" from "the tracker returned three items and none became tasks".
It is now held by `IntakeStatus` alongside the timestamp and the `refs/intake/<bucket>` this
runner contended for, and rendered as one line on the fleet page. **Not in git**, for the
reason §18 gives for not writing a runner registry: a record committed every interval is a
commit per runner per interval forever, and a pass that mattered is already durable as a
task or as a refusal record. A runner that *lost* the claim records that fact rather than a
pass of zero — on a fleet of four, three do so every interval, and zeroes would report a
working intake as a broken one.

**Intake got a metric.** It had none, which made it the only path Grafana could not answer a
question about. `caterpillar_intake_total{workspace,outcome}` counts decisions with
`outcome ∈ created|rejected|skipped` — the three answers `ingestItem` already returns,
uncollapsed, because `skipped` is the normal case and `rejected` is the one that needs a
human. `caterpillar_intake_items{workspace}` is a **gauge** of `seen`: counters only grow,
so a tracker that has gone quiet looks identical to one nobody is polling, while a gauge
goes back to zero when the last labelled item becomes a task. Only the runner that won the
interval publishes it, so aggregate it with `max` and not `sum`.

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

**A second producer: the acceptance gate.** `publish_artifact` is not the only way in.
Anything a §12 gate leaves in `CATERPILLAR_EVIDENCE_DIR` is committed here too, and it lands
in the same directory under the same caps — one place a reader looks, one set of limits, one
route serving it. The two differ only in audience: an agent's artifact is *input* for the
tasks that declare this one as a blocker, and a gate's is *evidence* about this task's own
change, read by a human on the web view and by the review council (§12.1).

**Over the cap, a gate is refused in words rather than truncated.** A screenshot is not
small, so this is the common case rather than the corner one, and it is where the caps stop
being theoretical. The bytes do not land: every runner clones this repo and git keeps
whatever reaches it forever, so a 4 MB PNG per failed session is paid for by every machine
in the fleet in perpetuity. Truncating was rejected — half a PNG is not a smaller PNG, and a
truncated trace is not a shorter trace, so the reader would be handed something that looks
like evidence and is not. Instead the verdict's detail names the file, its size and the
limit, so the journal distinguishes "too big to commit" from "the gate wrote nothing", and
says what a repo can do about it: a lower resolution, a JPEG rather than a PNG, one
screenshot rather than Playwright's whole output tree. An agent that hits the cap through
`publish_artifact` is told to summarise; a gate that hits it is told to render less. The
same refusal, aimed at what the caller can actually change.

**On the web view an artifact is a download, never a document** — `application/octet-stream`
as an attachment, with the link carrying `download` to agree with the header. That rule
predates images and does not bend for them: these are agent-authored bytes on the origin
that serves every transcript (§18, invariant 8). A screenshot is not exempt for being
something a browser could render; being renderable is the hazard.

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

---

## 18. The web view

Discord is a signal channel and Grafana is an aggregate. Neither answers the question an
operator actually asks first — *what is this thing doing right now, and why* — because
answering it means reading a task's spec, its journal, the questions it asked, and the
messages of the session currently in flight, all at once. Every one of those already
exists; none of them was reachable without `kubectl exec` and a `git log`.

So: a read-only web view, one page per thing, behind the cluster's existing SSO.

### It ran inside the supervisor, and at four replicas that was reversed

**The original decision, kept because the reasoning still applies to the runners' own
port.** The obvious shape was a second Deployment that clones the state repo, and it was
rejected: such a process needs its own copy of the state-repo credential and its own clone
to keep fresh — a second thing that can fall behind and a second place a token lives — and
it still could not show the two things the view exists for, **the log this process is
writing** and **the session it is running**, because both are in this process's memory and
neither is in git until later. A transcript is written when a session ENDS, and pushed after
that. So the view ran in the supervisor, next to the outbound notifier and the gateway
websocket (§11.2, §7), with the consequence stated rather than hidden: *fleet-wide task data
comes from git and is complete; logs and in-flight messages are this runner's only.*

**That was right for one replica and became a broken page at four.** `caterpillar-ingress`
points at a Service that balances across every pod, so the sentence above stopped describing
a documented limitation and started describing a lie: the live panel showed whichever pod
answered *this* request and a refresh showed a different one; `/logs` showed one ring of a
thousand lines out of four thousand and said "this runner only" as though the reader had
chosen which; three runners in four were invisible unless they happened to hold a running
task, because membership was derived from task ownership. The only hint any of it was
happening was the runner id in the rail.

**Both objections dissolve when the second process aggregates instead of cloning.**

> *"needs its own copy of the state-repo credential and its own clone"* — not if it never
> reads git. Every runner already serves `/api/fleet`, `/api/tasks/<id>`, `/api/logs` and
> the raw transcript route out of the checkout it maintains anyway. The viewer proxies
> those. It holds **no state-repo credential, no forge token, no provider credential, no PVC
> and no ServiceAccount token** — strictly less privilege than the process serving that page
> before it existed.
>
> *"could not show the log this process is writing and the session it is running"* — not if
> it asks each process for them. That is one HTTP GET per replica per refresh, and it turns
> the weakness into the feature: **N live sessions and a merged log, instead of one at
> random.**

So `src/view/` is a second entrypoint on the same image (`caterpillar-view`, a different
`command` — `dist/` already ships whole) running as a **Deployment**, not a StatefulSet:
there are no volumes and nothing to keep. The runners keep serving `web` in-cluster,
because those endpoints *are* the viewer's data source; what moves is the Ingress.

This section is the record of a decision that was correct and was then reversed, kept in
full so the next person to consider folding the view back into the supervisor finds the
argument rather than repeating it. The condition that flipped it was `replicas: 4`; at
`replicas: 1` the two shapes are equivalent and the in-process one is cheaper.

### How the viewer aggregates

**Discovery is DNS, not Kubernetes.** `caterpillar-headless` already exists with a named
`web` port, so `_web._tcp.caterpillar-headless.<ns>.svc.cluster.local` enumerates exactly
the ready pods, by stable name, and shrinks and grows with `kubectl scale`. No API access,
no RBAC, no mounted token, and no replica count in a ConfigMap to fall out of step with the
StatefulSet. `VIEW_RUNNERS=name=url,…` is the escape hatch for running it outside a cluster,
which is what keeps the one thing worth testing by hand testable by hand.

**Task data from any one runner; per-process data from all of them.** The state repo is
identical everywhere, so a task list, a task's documents and a stored transcript come from
the first healthy responder — asking four for the same bytes is four times the work for one
answer. `live` and `logs` are unioned across every replica, each entry tagged with the
runner it came from.

**`FleetView.live` is a list.** `live?: LiveSummary` → `live: readonly (LiveSummary &
{runner})[]`. A breaking change to `/api/fleet`, made while that route had no consumer
outside this repo. A single runner answering for itself reports a list of at most one.

**Failure is rendered, not swallowed.** A runner that times out or refuses appears next to
its name as unreachable. A dashboard that silently drops a replica is worse than one that
has none, because a missing runner reads as an idle runner — and "three of the four are
idle" is a sentence an operator acts on. The per-runner timeout is a few seconds and the
fan-out is parallel, so one wedged pod costs the page that timeout, not four of them.

**Idle runners stop being invisible** without the registry §18 rejected twice below: the
viewer asks each pod what it is doing instead of inferring it from lease mirrors in git.
The objection to the registry was to a heartbeat file committed every poll, and it stands —
asking over HTTP costs one GET per refresh and nothing durable.

**The seatbelt is kept, not punched through.** The runners' `web.requireForwardedUser` is a
fail-closed check on the Ingress losing its forward-auth annotations, so the viewer
**forwards the `Remote-User` header it received** on every fan-out request rather than the
runners relaxing the check. A runner's port stays useless to anything in the cluster that
cannot present an identity Authelia vouched for, and the viewer authenticates nobody: it
repeats what the proxy in front of *it* asserted.

Everything in the read-only argument below survives verbatim in the new process — non-`GET`
refused before routing, the same CSP, `html.ts` escaping by default, artifacts as
`application/octet-stream` attachments, `isTaskId`/`isArtifactName` on every path segment —
and its tests assert each of them again rather than trusting the shared module.

### Its own port

`web.port`, default 8080, never the metrics port. One Service port is scraped by the
ServiceMonitor and one is published by the Ingress, so "what is exposed" is answerable by
reading a Service rather than by reading the router. The web view is the only thing behind
the Ingress; `/metrics` is not on it.

### Read-only, and provably so

The guarantee rests on three independent things, because one mechanism is one edit away
from being wrong:

1. anything that is not `GET` or `HEAD` is refused with 405 **before routing**, so there
   is no handler a write could reach even if one were added by accident;
2. every handler goes through `web/view.ts`, which reads and does nothing else — no
   commit, no push, no ref update, no forge call. The property is checkable by reading one
   file;
3. the process holds no forge token while serving. The credential service answers only
   for a task with a live lease, and only on that task's own socket (§9.2), so even a bug
   here has nothing to spend.

### Everything on these pages is untrusted input

This is the part that decides the implementation. A goal, a journal entry, a question, the
text of a bash result — all of it is written by a model, and quotes whatever that model
read in a repository. It is the §11.2 rule about Discord mentions, one layer down.

- **Escaping is the default and `raw` is the exception.** `web/html.ts` is a tagged
  template that escapes every interpolation; there is no sanitiser and there should never
  be one, because sanitising is a guessing game and escaping is not.
- **CSP `default-src 'none'`,** with no `unsafe-inline`. That is why the stylesheet and
  the script are routes rather than inline blocks.
- **An artifact is served as `application/octet-stream`, as an attachment.** Agent-authored
  bytes rendered as a document on the origin that serves every transcript would be script.
- **A URL reaching an `href` is scheme-checked** (`safeUrl`): `javascript:` and `data:` are
  script on this origin, and a PR url arrives from a forge.
- **Task ids and artifact names are validated with the same guards the chat commands use.**
  Writing this view is what found that `isTaskId` accepted `..` — a directory name that
  resolves to the state repo root, reachable from a slash command since the day it shipped.

### Authentication is the Ingress's job, and `requireForwardedUser` is the seatbelt

Authelia forward-auth at the Ingress, exactly as `plot-spot.caes.ar` does it. The app
implements no login and stores no session.

`web.requireForwardedUser` makes the supervisor refuse any request that did not arrive with
the proxy's identity header. **This is not a second authentication system** — anything
already inside the cluster can set a header. It is a fail-closed check on the one realistic
failure: an Ingress whose forward-auth annotations are typo'd or dropped, which otherwise
publishes the whole state repo to the internet and looks exactly like a working deployment.
`/healthz` is answered before the check, because the kubelet does not come through the
Ingress and a probe that gets 401 restarts a healthy pod forever.

`web.enabled` defaults to **false**. A runner on a workstation must not begin serving every
transcript the fleet has produced because it was upgraded; in the cluster it is turned on in
the same ConfigMap as the Ingress that authenticates it.

### The two in-memory sources

**`obs/ring.ts`** holds the last N log lines. It is wired as `JsonLogger`'s `write` SINK
rather than as a second `Logger`, which is the whole trick: the sink runs only for records
that already survived the configured level, so the ring and the container's stdout cannot
disagree, and the threshold is not implemented twice. It carries nothing stdout does not,
so §11's "never log a credential" rule covers both.

**`obs/live.ts`** holds the session in flight. pi already keeps these messages in
`agent.state.messages` for the length of the session, so this keeps references to objects
that are alive anyway; clearing at session end is what stops it becoming a second,
unbounded copy of every transcript. The tap is `SessionOptions.onMessage`, called from the
`message_end` subscription that was already there for usage accounting — and wrapped in a
`try`, because an observer that throws would tear down pi's event dispatch mid-session,
which is a live view costing the task it was watching.

### `/intake`, the page for the paths that produce nothing

Every other page here answers a question about a task that exists. `/intake` answers the one
asked when none does: *I labelled an issue / an alert fired, and nothing happened.* It is fed
entirely by records that already existed and that nothing rendered.

- **Refused tracker items** (`intake/<task-id>.json`, §14.5) — with a link back to the item,
  which is what the record's new `url` field is for.
- **The alert ledger** (`alerts/refusals/`). The directory is misnamed: `queue.ts` writes a
  record on the success path too (`reason: "created"`, with `task`), so it is a complete list
  of every alert this fleet has decided anything about, refusals and tasks alike.
- **Which alerts are opted in** (`alerts/policy.yaml`, §20). An operator learns here that an
  alert fired and was refused because it was never listed. A **missing** file is rendered as
  that sentence with the runbook next to it rather than as an empty table — "nobody listed
  it" is the refusal least likely to be guessed, and an empty table reads as "nothing has
  happened". A file that does not *parse* is rendered as its `PolicyParseError` for the same
  reason: the poll loop catches that error into a log nobody is reading.
- **Whether the receiver is listening.** `remediation.enabled` and the `cluster` bounds are
  now on `/runner` and on this page. A disabled receiver is the single most likely reason a
  firing alert produced nothing, and it was invisible.

The page is a new front door to agent-authored bytes and inherits every rule above verbatim:
an alertname is whatever a Prometheus rule's template produced and a refusal reason quotes a
tracker item anyone with an account can edit. Its tests assert the escaping again rather than
trusting `html.ts` to have been reached.

### A task says where it came from

`TaskSpec.tracker` has been on every ingested task since intake shipped and no page rendered
it. There are four ways a task can exist — a labelled tracker item, a brainstorm's plan, a
firing alert, a hand-committed spec — and the fleet page could not distinguish work a human
asked for from work the fleet proposed to itself.

The source is decided from the spec, not from the id: `kind` is authoritative for a
brainstorm and a remediation task, and `spec.tracker` identifies an ingested one because
`kind: implement` is also what a hand-committed spec defaults to. The **link** is recovered
from the goal's prose (`Tracker item: …`, `- Rule: …`), because a `TrackerRef` carries no
URL and a `FiringAlert`'s `generatorURL` is written into the goal and nowhere else; for
`github-issues` the ref alone is enough to rebuild it as a fallback. Vikunja's is not — its
web address depends on the instance's frontend — and a guessed link that 404s is worse than
the plain text it falls back to. An alert task's **alertname** comes from the ledger, since
`ALERT-<fingerprint>` is a hash and cannot carry one.

### There is no runner registry

`runners/<runner-id>.json` has been in the §4.1 layout since the beginning and is still not
written. It was reconsidered here and rejected again: a heartbeat file committed to the
state repo every poll is a commit per runner per interval, forever, in a repo every runner
clones and pulls constantly — the same objection §17 makes to large artifacts.

Who is running what is derived from task ownership instead, which costs nothing and is
already true. On a runner's own page that still carries a price: an **idle** runner other
than this one is invisible, because it owns nothing and nothing names it.

**The viewer pays no such price and still writes nothing.** It asks each pod directly — the
headless Service names them all, ready or idle — so "which runners exist" is answered by
DNS and one HTTP GET per refresh rather than by a file in git. That is what makes the
registry unnecessary rather than overdue: the objection was never to knowing, it was to a
commit per runner per interval, forever.

§21 adds a presence heartbeat in Redis, and it does not change any of the above. It is a
DISPLAY: advisory, expiring, and explicitly forbidden as an input to routing or claiming.
The sentence this section is titled with still holds in the sense it was written in — there
is no registry anything DEPENDS on. An idle runner now appears on a page; nothing decides
anything because of it.

`state.owner` is a mirror of the lease and is never cleared (`transition` in
`supervisor/loop.ts` stamps it and nothing unstamps it), so on a task that is not `running`
it names the runner that worked it LAST. The view says "last run by" there rather than
"held by", and counts only running tasks when it reports who is busy — otherwise a runner
that finished a task in March is reported as holding it in August.

### Rendered on the server

No build step, no framework, no dependency: the stylesheet and the script are strings in
`web/assets.ts` that `tsc` emits, because the image copies `dist/` and nothing else and a
`.css` file on disk would work in development and 404 in the cluster. The live pages
re-fetch themselves and swap `<main>`; the server already knows how to draw every one of
these, and a second renderer in the browser is a second thing to keep in step with the
first.

Spec and journal prose is shown as the markdown SOURCE it is. A markdown renderer is either
a dependency or a hand-rolled parser, and both are a new place for agent-authored text to
become markup.

---

## 19. The daily digest

Every channel the supervisor already has answers a question about *now*. Discord signals
one event at a time, the web view shows the fleet as it stands this second, and Grafana
draws rates. None of them answers **"what did this thing do today"** — which is the
question an operator actually has at the end of a day, and the one an autonomous fleet
makes hardest to answer, because most of the work happened while nobody was watching.

So: one document a day, published at a configured local hour, into all three places it
could sensibly go — the Discord channel, the state repo, and the web view.

### It is measured from git, not remembered

The digest is collected by diffing the state repo between two commits: the one at the
window's start and the one at its end. Nothing new is recorded as the day happens, and
there is no event log to keep in step with reality.

The alternative — reading the current `state.json` of every task — cannot answer the
question at all. A snapshot has no memory: a task that ran four sessions today and one
that has not moved since Tuesday are identical in it, and every number it carries is a
LIFETIME total. A digest built that way reports a long-running task's whole history as
though the fleet had spent it this afternoon, and does so again tomorrow with bigger
numbers.

Two commits also make a **catch-up digest correct**. "The end of the day" is a commit, not
`HEAD`, so a digest published the next morning describes the day it names rather than
folding that morning's work into it.

The journal is exploited rather than parsed: it is one append-only file per entry (§4.1),
so the day's entries are exactly the shard files that appeared between the two commits —
a `--diff-filter=A` question. No session headings are matched, and nothing breaks when
their format changes. A task whose history predates the sharding still has a single
`journal.md`, and for that file the day's entries are the suffix the earlier copy does not
have; both paths run, so a window straddling the change reports both halves.

### A day ends when the operator's day ends

The window is **local**, in a named IANA zone. In Berlin the last two hours of every summer
day belong to tomorrow in UTC, so a digest keyed on the UTC date reports two hours of work
under the wrong heading for half the year, silently. A fixed offset is refused for the same
reason inverted: `+02:00` is correct for five months and an hour wrong for seven.

The window runs **between publications**, not from local midnight: the digest for the 16th
covers 18:00 on the 15th to 18:00 on the 16th. Midnight-to-publication is the obvious
alternative and it loses an evening a day — work done after the cutoff falls into a window
that has already been published and is reported by nothing. Consecutive windows meet
exactly, so every hour is reported once.

### One runner publishes, and the ref is how that is settled

Every runner reaches 18:00 at the same instant and all of them can read the whole state
repo, so this is a race by construction. It is settled with the mechanism §5 already
proved: `refs/digests/<date>` is created by a compare-and-swap against an empty expected
value, which exactly one push in the fleet can win. Nothing renews it and nothing steals
it — unlike a task lease, a published day does not become unpublished.

The ordering inside is **claim, then publish, and release the claim if publishing failed**,
because the two failures are not symmetric. Publishing twice is embarrassing and visible.
A day that is MARKED published and never was is silent: the ref says done, no message
arrives, and nobody finds out until they go looking for a digest that never existed.

A failed CAS cannot distinguish a lost race from a dead network — both are a rejected
push — so the ref's existence is checked afterwards. Getting that backwards would write
off a day nobody published.

At most one digest is published per poll, oldest first. Catch-up reaches back exactly one
day: a pod rolled through the cutoff (Keel rolls this pod on every push to main) still owes
yesterday, but a runner returning after a week must not post seven digests into a channel.

### The prose is the only part that is written rather than measured

The counts, the transitions, the costs, the diffstats and the commit subjects are all
facts. One paragraph is not: a model is given those facts, the agents' own journal entries
for the window, and the paths each task touched, and asked to say what changed.

It has **no tools**. It cannot read a file, run a command or reach a repo — it describes
the evidence it was handed, so the worst it can do is describe it badly. It runs
unattended, once a day, and its output goes to a channel where nobody will diff it against
the repo.

It also cannot fail the digest. A provider outage, a refusal, a model that says nothing —
each becomes a line in the document saying why there is no paragraph. Saying so out loud
matters: a digest that silently lost its prose looks exactly like one whose summariser was
never configured. A quiet day skips the model entirely; the document already says nothing
moved, and paying to have that restated is a cost that is invisible per day and obvious per
month.

`digest.summarise` turns it off separately from `digest.enabled`, so a runner minding its
spend keeps the report and drops the paragraph.

### The diffs come from mirrors, and their absence is declared

Everything else in a digest is in the state repo, which every runner has. The code is not:
a task branch lives in the bare mirror of the runner that WORKED it. So the publishing
runner can see some tasks' diffs and not others.

That asymmetry is stated rather than hidden. A repo with no local mirror produces a line
saying the diff cannot be read from here — never `0 files changed`, which is a false
statement about a merged pull request rather than a smaller one. Nothing is fetched to
close the gap: the digest reads what is already on disk, needs no credential, and cannot
be the reason a repo gets cloned.

### It says how much of the change is the fleet's, and which way that is going

The rest of the digest answers "what moved today". After a month of running, the question an
owner actually has is a different one: **what share of this repository's change is coming
from the fleet, and is that share trending?** Nothing else the supervisor publishes can
answer it, and everything needed to is already here — the digest measures changes from git
and costs nothing to do so.

So one more section, computed by a pure `digest/attribution.ts`: commits and lines, split
into fleet and human, per repo, for this window and the one before it.

**Authorship is decided by the ADDRESS.** Never by the display name. §9.7 exists because a
forge resolves an address to an account; a display name is decoration, two people can share
one, and a name match would credit one of them with the fleet's work. The address comes from
config for the same reason §9.7 gives: it names the App installed for *this* deployment, so
there is nothing correct to hardcode.

**Which means the identity can change inside a window.** A deployment that reinstalls its
App has commits under the retired address and the current one in the same day, and reading
the retired half as a person's work invents a contributor and halves the reported share on
exactly the day someone is most likely to look. `identity.pastEmails` is that list. It is
read-only — nothing commits as one — which is why `identityFault` is not applied to it: a
deployment that already made §9.7's mistake must still be able to describe the history it
has.

**A share is reported against the previous window, or not at all.** A single day's share
says almost nothing — one human commit in a quiet day reads as 50% — and a direction says a
lot. The baseline is `previousWindow`, recomputed from the calendar date rather than by
subtracting the window's own length: consecutive windows meet exactly but are not equal in
length, and 18:00 to 18:00 across a spring-forward is 23 hours. A window with no measured
predecessor says so rather than reporting "flat", which would be a claim about a yesterday
nobody measured.

**And it inherits the mirror rule rather than reintroducing the bug.** This is the section
where a silent zero would be most credible, because a percentage always looks like a
measurement. A repo whose history this runner cannot read — a task branch lives in the
mirror of the runner that worked it — is NAMED, exactly as its diff already is. So is a
window in which nothing was committed, which is a different fact from one the fleet wrote
none of. A share whose denominator is zero is absent, never printed as 0%.

Two figures rather than one, because they disagree in ways that matter: a fleet that
rewrites a file moves many lines in one commit, a person fixing a typo moves one line in
one commit, and a report showing only lines would describe a reformatting run as having
written the repository. Merges are excluded from both — a merge introduces no line, its
commits are already counted, and on GitHub every merge is made by the author App (§12.1),
so counting them would raise the fleet's share every time a *human's* branch landed.

The prose is not the only output. `caterpillar_digest_authored_lines_total` and
`caterpillar_digest_authored_commits_total` carry the same split by repo and author, and
`caterpillar_digest_authorship_unreadable_total` carries the declared gap — so the trend is
graphable over a fortnight without anyone parsing a paragraph, and a repo with no mirror on
the publishing runner is distinguishable on a graph from one the fleet stopped working on.

### Three destinations, one document

The same markdown goes to Discord, to `digests/<date>.md` in the state repo, and to the web
view. A digest that said different things in different places would be one nobody could
quote.

Git is written **before** Discord, and a Discord failure never undoes it — the same rule as
every other notification (§11.2), and stronger here: a throw would release a claim whose
digest is already committed, and the retry would publish the day twice.

Discord's 2000-code-point limit is handled by SPLITTING, like a question and unlike
everything else (§11.2). A truncated park reason still says a task parked; a digest cut at
the limit is silent about every task after the cut, and the reader cannot tell that
anything was. Past four messages it stops and names the file instead.

### Off by default

`digest.enabled` defaults to false, like `web.enabled` and for a related reason: publishing
writes to the shared state repo and posts to the shared channel. A runner someone started
on a workstation must not begin doing either because it was upgraded. The claim protocol
makes a second publisher harmless, not welcome.

### It cannot be the thing that fails

Two rules, both learned from the paths around it.

**One malformed task costs that task.** A `state.json` that parses and is not shaped like
one — a hand edit, a half-finished migration — is skipped and NAMED in the document, rather
than thrown over. The collector is deterministic, so a digest that throws is a digest that
fails identically on every retry: the day would never be published at all, and the release
path would hand the claim back forever. The same reasoning covers an unparseable `spec.md`
(it costs a title) and a timestamp that will not parse (it is printed verbatim — `Intl`
answers an invalid date with a `RangeError`).

**A shutdown hands the day back.** Writing the paragraph is the one call in a digest that
waits on a network, so the pod's abort signal reaches it. Aborted, the day is released
rather than half-published: the next boot publishes it whole, prose included. The
alternative is the silent failure again — a claimed day, torn down mid-publish, that
nothing ever revisits.

## 20. Alert-driven remediation

A fifth intake path (§14): **a firing Alertmanager alert becomes a task**, whose goal is
"diagnose and fix this", and which then runs like every other task and ends in a pull
request.

The gap it closes is narrow and real. Every other intake path starts with a human deciding
something is worth doing. Monitoring already knows something is wrong — it knows before
anyone is awake, it knows precisely which rule fired and with which labels, and today that
knowledge reaches a Discord channel and stops. An operator reads it hours later, forms the
same diagnosis the evidence already implied, and files an issue that becomes a task. The
alert is a task intake source that was being routed to a human for transcription.

```
Alertmanager  →  POST /alerts  →  policy lookup  →  spec.md (kind: remediation)
                                       │                        │
                                  no entry?                  normal claim,
                                  refusal record             normal session,
                                                             §12 gate, PR, merge
                                                                        │
                                                             re-verify: did the
                                                             alert actually clear?
```

### It never writes to the cluster

**A remediation session cannot change the cluster. Not a restart, not a scale, not an
edit, not a silence.** This is the load-bearing constraint of the whole design and every
other decision below follows from it.

The reason is not caution about capability, it is what the two options actually are. An
agent that may restart a Deployment will restart the Deployment, because that is what
makes an alert stop, and it will do it before it understands why the alert fired. What
that produces is a fleet that erases its own evidence: the crash loop is gone, the pod is
new, the logs are rotated, and the cause is now unknowable. It also produces a system
whose blast radius is "whatever the model thought would help" against a live cluster, with
no review step anywhere in it — the exact inverse of the arrangement §9.3 and §12 build for
code, where nothing the agent does reaches production without a human approving a diff.

So the cluster is **evidence**, not a workspace. Reads are supervisor-mediated: the session
asks for a described observation and the supervisor performs it, against a namespace
allowlist that is **supervisor configuration**, not something the alert path can widen for
itself. The output of a remediation task is the same artifact as every other task's — a
pull request against a repo — and the same two gates decide whether it is any good.

A corollary that has to be said out loud in the system prompt, because the model will not
assume it: **a fix that is not code is a legitimate outcome.** Plenty of alerts are
capacity, configuration, a dependency that is down, or a threshold that was always wrong.
A session that finds one of those should write up the diagnosis and `ask_human` (or
`handoff`), and it is told explicitly not to invent a code change in order to have
something to open a pull request with. A plausible patch attached to a real incident is
worse than no patch, because it looks like the incident was handled.

The same prompt says the alert is the *symptom*. Widening a threshold, deleting an
assertion, or making a check no longer run all make the alert stop without making anything
better, and the review council (§12.1) reads for exactly that.

### `kind: remediation`

A third task kind (§4.1), alongside `implement` and `brainstorm`. It is a **writing** kind:
it gets `write` and `edit`, the full control verbs including `open_pr` and `done`, and §12
applies to it **unchanged**.

It is a separate kind only because its ORIGIN changes what the session must be told. The
`brainstorm` exemption from acceptance criteria is deliberately **not** widened to it: a
brainstorm's gate is the council's verdict on a plan, and it has nothing to run, whereas a
remediation task ends in a pull request and therefore needs commands the supervisor can
run. A remediation spec with no acceptance criteria is refused by `readSpec` for the same
reason an ordinary one is — it could be created and never closed.

Concretely, the kind selects a system prompt and nothing else about the session's shape.

### `alerts/policy.yaml`

An alert becomes a task **only if an operator said in advance what that alert means and how
a fix for it is verified**. That statement is a file in the **state repo**:

```yaml
version: 1
alerts:
  - alertname: CaterpillarNoProgress        # required, exact match on the alert label
    workspace: primary                       # required, a known workspace
    repos:                                  # required, >= 1, host/owner/name
      - github.com/acme/caterpillar
    acceptance:                             # required, >= 1 command (§12)
      - npm run check
      - npm test
    requires: []                            # optional, from KNOWN_CAPABILITIES
    goalPrefix: |                           # optional prose prepended to the goal
      This alert usually means a session wedged on a provider cooldown.
    runbook: https://runbooks.example/…      # optional URL surfaced in the goal
    maxOpenTasks: 1                          # optional, default 1
    settleSeconds: 600                      # optional, default 600, max 21600
```

**In the state repo, not this repo and not a ConfigMap.** Adding an alert must be a commit
to the thing the supervisor already polls — reviewable, revertable, and live on the next
cycle — rather than a redeploy. It is operator-authored and the supervisor never writes it;
there is no `writeAlertPolicy`, which is what keeps "which alerts may create tasks" outside
the fleet's own reach.

**There is deliberately no `namespaces` field.** Which namespaces a session may read is a
bound the operator sets on the whole process, in supervisor configuration. A per-alert
allowlist would let an entry in a file the alert path consults widen its own access, which
is not a bound at all. A field here that nothing reads would be worse than no field.

Parsing is **strict**, and the reason is one specific typo. `acceptence:` silently ignored
produces an entry with no acceptance commands — indistinguishable from omitting the
completion gate, and the symptom is a queue of tasks nothing can ever mark done rather than
a message anyone would read. So unknown keys, unknown top-level keys, an unknown
capability, a duplicate `alertname`, an empty `acceptance`, a malformed repo ref and a
`version` other than 1 are all **parse errors**, each naming the offending entry and field.
Failures are a typed `PolicyParseError`, never a bare `Error`: the supervisor loop has to
tell "the operator wrote this wrong", which deserves one clear message and no retry, from an
IO failure a later poll might survive.

A **missing** `alerts/policy.yaml` is an **empty policy**, not an error. The loop reads it
every cycle, and most state repos have never heard of alerts — a throw there would turn
"this cluster has not opted in" into a supervisor logging a failure every thirty seconds. A
file that exists and does not parse still throws, because that one is a mistake to fix.

### Task identity, and not opening the same task twice

Task ids on this path are **`ALERT-<fingerprint>`**, from Alertmanager's own fingerprint.
Deterministic and derived from the fingerprint alone, which is what makes the path
idempotent: Alertmanager re-sends a firing alert for as long as it fires, and an id that
varied would create a fresh task every few minutes.

The fingerprint becomes a directory name under `tasks/` and arrives in an HTTP body from
outside the process, so it is **checked, not trusted** — constrained to lowercase hex,
which is what Alertmanager renders anyway. That keeps every id this path produces inside
the existing `isTaskId` guard rather than relaxing that guard, for every other intake path,
to accommodate this one.

`maxOpenTasks` (default 1) stops an alert that keeps firing while a fix is in review from
opening a second task saying the same thing. "Open" is `!isTerminal(status)` — the one
notion of task status the supervisor already has, deliberately not a second one. A
**`parked`** remediation task therefore counts as closed: it is waiting on a human, and a
fresh firing is exactly the nudge that should be allowed to open a new task rather than be
suppressed by one nobody is working on.

Counting is a join from `alerts/refusals/` to `tasks/`, because a fingerprint is a hash and
does not carry its alertname — so the **alertname is recorded** in each record rather than
parsed back out of an id. A record naming a task that no longer exists contributes nothing,
so deleting a task by hand frees its slot instead of wedging the alert forever.

### `alerts/refusals/<fingerprint>.json`

Every decision the receiver makes about an alert is written down, durably and pushed, not
kept in memory. This is the intake-rejection record (§14) again, and for a reason recorded
there verbatim: **Keel rolls the pod on every push to main**, so an in-memory set of
already-handled alerts is emptied on every deploy — and since Alertmanager re-sends a
firing alert every few minutes, every deploy would re-notify for every alert the supervisor
had already declined. The record makes the fleet quieter than the alert instead of noisier.

Two consequences for `StateStore`, and they are separate rules that were found separately:

- `alerts` is in `commitAndPush`'s staging list. Without it a refusal is written locally
  and never pushed, which is exactly the spam the record exists to prevent.
- `alerts` is in the reset path's `git clean` list. Without it a refusal whose commit never
  landed silences the alert on this runner while existing nowhere in git: no other runner
  agrees, and no operator can see why the notification stopped. `policy.yaml` is tracked,
  so the sweep cannot touch it.

### Proving it works before an incident does

Four of the five things this feature needs live in a **separate deployment repo** — an RBAC
grant, a Service port, an Alertmanager route and a ConfigMap block — and the fifth is a file
in the state repo. When one of them is wrong, the symptom is a confusing tool error inside an
agent session, hours later, during the incident the alert was about.

So it gets a preflight, the seventh in the family (`verify:github-app` and friends):
`npm run verify:cluster-read`, run from inside the pod. Seven checks with a remedy on each
failure — config, the projected token and CA, `GET /version` over TLS verified against that
CA, the allowlisted namespaces, RBAC through `SelfSubjectAccessReview`, Loki, and the
redaction promise against a real Secret rendered through `cluster/redact.ts` itself.

Two of those deserve naming here because they are checks a preflight written from the happy
path would not contain:

- The RBAC check asserts the **negative**. `create`, `update`, `patch` and `delete` on `pods`
  and `deployments` must come back DENIED, and an allowed write verb fails the run. The
  entire safety argument above is that the token cannot write; a preflight confirming only
  the reads it wants would pass against a `cluster-admin` binding and thereby certify the
  opposite of the property being relied on.
- The redaction check runs the real `redactObject`/`renderObject` over a real Secret and
  asserts each decoded and each base64 value is absent from the output. A reimplementation
  of the redaction inside the checker would only prove the checker agrees with itself.

The checks are pure functions over an injected HTTP function in `cluster/preflight.ts`, for
the reason `redact.ts` records for itself: the states worth asserting — a 403, an allowed
write verb, a leaked value — are ones a healthy cluster will not produce on demand, and a
check that needs a cluster to test is a check nobody tests.

`docs/remediation-runbook.md` is the operator's end-to-end guide: the order of operations
across the two repos, how to test the webhook by hand, how to write a policy entry, and the
three levers for turning it off in a hurry.

### Did the fix work? The re-verification

Until this existed the path had no closing edge. A remediation task diagnosed a firing
alert, opened a pull request, the council read it, and it merged — and **whether the alert
actually cleared was never checked**. A patch that ended the incident and a patch that
changed nothing produced the same record: `done`, one merged PR, and silence.

The dedup makes that worse rather than better. The task id is `ALERT-<fingerprint>`, which
correctly makes an alert firing for an hour one task rather than twenty — so a re-fire
after a merged-but-ineffective fix is deduped against the very task that failed to fix it,
and may never become work again at all. The loop could close on a patch that did nothing,
and the only signal was a human noticing the alert was still there.

So a merged remediation fix is **held for a bounded settle window** and then re-checked.

```
PR merges  →  verify block written on alerts/refusals/<fp>.json
              task → ready, and the claim filter skips it
                      │
              housekeeping pass, once the window has run out
                      │
        ┌─────────────┼──────────────────┐
     cleared      still firing     cannot be checked
     → done       → parked         → parked
                  + record reset   + record reset
```

**The evidence is what Alertmanager delivered, not a question anyone asks it.** A firing
alert is re-delivered on `repeat_interval` for as long as it fires, and a webhook receiver
with `send_resolved` — its default — gets one delivery when it stops. The receiver used to
DROP the resolved ones; it now records them, so `alerts/refusals/<fingerprint>.json` is the
ledger of what the monitoring has said about that fingerprint and the decision is a pure
function over it (`remediation/verify.ts`). Adding an Alertmanager API client instead would
have meant a URL, a credential and a failure mode to answer a question the existing stream
already answers. Nothing here reads the cluster, and invariant 13 is untouched: the session
gets no new capability, and the observation is one the supervisor performs.

**Silence is never a clear.** It is the one inference this refuses to make, and the reason
is that "nothing delivered since the merge" is also what a stopped Alertmanager, an edited
route, a rotated webhook token and a receiver nobody enabled look like. Every one of those
is indistinguishable from a fix that worked. So a window that runs out with no delivery
either way is **`unverifiable`** — recorded, notified, and never counted as a success.
Absence of evidence is not evidence.

**The window is bounded configuration**, per alertname, in the same policy entry as
everything else an operator says in advance: `settleSeconds`, defaulting to ten minutes and
refused above six hours. Per-alert because the right number is a property of the alert — a
crash loop stops within a scrape of the fix landing, and an alert on a disk a nightly job
cleans up does not. A fleet-wide window would have to be the slowest of them, holding every
fast task open for hours. It is refused rather than clamped above the ceiling: an operator
who wrote a day meant it, and being quietly given six hours reads as the file being ignored.
The window a task is held for is the one read back off the RECORD, not the policy as it
stands at the verdict — the entry can change while a fix is in review, and the number the
journal already quoted is the one the task is entitled to.

**A failed re-verification resets the fingerprint's record.** That deletion is the
load-bearing write of the whole feature, not a tidy-up: without it, `ALERT-<fingerprint>`
dedup means the fix that did not work goes on suppressing its own alert forever, which is a
worse outcome than never having re-verified. A CLEARED verdict deletes only the `verify`
block and keeps the record, because the record is what `countOpenAlertTasks` joins to
`tasks/` — removing it while the task is still being written as done would free the
alertname's slot, and a firing in that window would open a second task for an incident that
had just been fixed.

**A failure parks, and parks with the evidence.** Not `failed`: the change merged and
passed every gate, so `failed` would be a lie about the change. What is true is that the
incident is not over and a human has to decide what next — so the verdict goes in the
journal along with the reset, and the next session starts from "the previous fix did not
work" rather than from scratch. And it is said out loud either way, in Discord and in the
digest (§19): `ALERT-6155db — fix merged, alert cleared after 4m` or `fix merged, alert
still firing`. A silent success and a silent failure must not look the same; that they did
is the defect this closes.

Two mechanisms are worth naming because a reader would reach for something else:

- **The hold is `ready` plus a filter in the claim path, not a seventh `TaskStatus`.** A new
  status would touch the web view, the slash commands, the digest ordering, the snapshot
  ranking, the worktree live set and `isTerminal`, none of which has anything to say about
  an alert. `ready` is also honest for a settling task: nothing is wrong with it and the
  work is not finished. The filter is where the one distinguishing fact lives, and it is
  free for every other task — the question is answered from the task id alone unless it
  starts with `ALERT-`.
- **The verdict, the journal, the transition and the push are one unit.** A commit made
  inside a unit stages only the paths that unit wrote (`stageCommitPush`), so recording the
  verdict outside it left the deleted record uncommitted until some later unrelated bare
  commit happened to stage it. The reset has to land with the park that motivates it, or git
  carries a park whose reason had no effect.

The re-check runs on the **housekeeping** pass, after the alert drain so evidence that
arrived in the same pass is read by the verdict it decides. It claims the task's lease
before acting, because two replicas must not settle one verdict, and it re-reaches the
verdict under that lease rather than trusting the one computed without it.

**A fix that was only enqueued is not re-verified, and the journal says so.** On a
queue-protected base the council enqueues rather than merges (§12.3), and a queued pull
request is not on the default branch — the queue runs the change's own checks against a
speculative base and can still reject it. There is therefore no merge instant to time a
window from: one started now would run out while the fix was still on its way and park a
change that works. So the hold is skipped and the skip is written into the journal, naming
the queue. That is the same rule as `unverifiable`, applied one step earlier: what is not
known is said rather than guessed at, in either direction.

### What is deliberately absent

**No Alertmanager silence, ever** — not even a temporary one. A supervisor that can silence
an alert can hide its own failure to fix it, and the alert an operator most needs to see is
the one about the supervisor.

**No auto-merge.** The pull request is reviewed like any other. An alert firing at 03:00 is
not a reason to lower the bar; it is a reason to have the diagnosis written down by 08:00.

---

## 21. The ephemeral plane, and why the leases are not on it

There is now an HA Redis in the cluster. That is a genuinely useful
thing to have, and the reason it exists here at all is one specific need: the Discord bot
is becoming its own process, and a bot in a different pod from the supervisor cannot reach
into the supervisor's heap. `ChatInbox` and `TaskSnapshot` were in-process objects because
the bridge and the loop were in one process. They no longer are.

So Redis carries what has to cross a process boundary, and only that:

| | lives in Redis | lives in git |
|---|---|---|
| chat inbox — an intent, and the outcome that answers it | ✔ | |
| task snapshot — the `TaskSummary[]` an autocomplete reads | ✔ | |
| presence — which runners are alive, for display | ✔ | |
| cancel signals — reaching a session already running | ✔ | |
| steering — a human's guidance, reaching that same session (§7.3) | ✔ | |
| **leases** | | ✔ |
| **task state** — `state.json`, phase, sessions, usage | | ✔ |
| **journal, transcripts, artifacts, audit** | | ✔ |

The line is not "small things in Redis, big things in git". It is: **anything whose loss is
a degraded display stays in Redis; anything whose loss is a lost task stays in git.**

### Why the leases are not moving

A Redis lock with a TTL is the textbook answer, and it is a worse answer than the one
already here — not marginally, and not for a reason about Redis's own durability.

A task in this system survives a pod restart, an exhausted context window, and a move to a
different machine, and it survives all three for one reason: **nothing about it is in
RAM.** The claim is a ref, the state is a file, the history is a commit. A runner that dies
mid-session leaves a lease commit with a timestamp, and the next runner reads that
timestamp and decides. Nobody has to be told anything. Nothing has to be handed over.

`LeaseManager` claims by compare-and-swap on a ref, and `assertHeld` fences by comparing an
**exact OID** before every irreversible act (§5.1). That comparison is the whole mechanism,
and it needs two things: a value that is durable, and a value that is *the same one* the
lease was granted with. A Redis key gives neither on the axis that matters. If the key
evaporates — an eviction under `maxmemory`, a failover that loses the last second of
writes, an operator's `FLUSHALL`, a network partition healed the wrong way — there is
nothing left to compare against, and a fence that cannot fail is not a fence. Worse, it
fails *open*: two runners each holding a key that no longer exists both conclude they are
fine, and they work the same branch.

The git version cannot fail that way. A ref that vanished is a ref whose CAS fails, because
`--force-with-lease` against an OID that is not there is a rejection, not a permission. And
a ref cannot half-exist: the failure mode of the authoritative plane is *refusal*, which
costs a poll interval, rather than *ambiguity*, which costs a task.

There is also a plainer argument. The state repo is the only thing every runner already
shares — a machine behind NAT on someone's desk has it, and does not have the cluster's
Redis. Moving the claim to Redis would make the fleet's central coordination unavailable to
exactly the runner the capability system exists to include.

### It has to be optional, and the tests are how that stays true

`redis.enabled` defaults to false and every consumer has an in-memory implementation
selected when it is. That is not politeness toward small deployments; it is three separate
requirements that happen to have one answer:

- A single-replica runner has no process boundary to cross, so Redis would buy it nothing
  and cost it a dependency.
- The whole test suite has to run on a laptop with nothing listening on 6379. The contract
  in `src/redis/contract.test.ts` is written once and executed against both implementations,
  so "they behave the same" is checked rather than asserted; the third run, against a real
  server, registers only when `REDIS_TEST_URL` names one.
- **A Redis outage must degrade the fleet to the single-replica arrangement, not take it
  down.** This is the one that decides the code. Every operation is bounded by a timeout and
  passes through `RedisGuard`, which turns a failure into the in-memory answer and a
  throttled warn line. Nothing in `src/redis/` may throw into either supervisor loop (§6.4),
  for the reason their try/catch exists (§6, `supervisor/loop.ts`): a live process that answers
  `/healthz` and does no work is worse than a crash, because nothing restarts it.

The reading of a failure is `ChatLeadership.refresh`'s (§7), one layer down. "I could not
reach Redis" is read as "there is no cancel pending", "no runner is present", "the snapshot
is what I last saw" — never as an exception for somebody else to handle, and never as the
affirmative answer. A cancel signal that defaulted to *true* on a network blip would abort a
session every time a socket hiccuped.

### Presence is advisory, and §18 still means what it said

§18 says "There is no runner registry", and that stays true in the sense it was written in:
there is no registry anything **depends** on. Presence exists so the web view and the bot
can show which runners are alive, and it is in the same category as the log ring — useful,
disposable, safe to be wrong. Nothing may route, claim, steal, or decide a lease is dead
from it. A runner missing from the display is a runner whose last heartbeat did not land,
which happens for reasons that have nothing to do with whether it is working: a paused pod,
a slow node, a clock. Those answers come from the lease refs and only from there.

### Steering rides the same crossing, and is a list rather than a key

§7.3's guidance has the same problem a cancel has and one extra property. The problem: the
submitter is the bot and the reader is a session in the supervisor, and with a separate bot
those are different pods. The extra property: guidance is not idempotent. A second cancel says
nothing the first did not, so one key with a timestamp records it completely; *"use the
existing migration path"* and *"and skip the second wave"* are two sentences, and a key would
keep whichever arrived last. So `steer:<task>` is a LIST — pushed with a TTL that is refreshed
on every push, so the clock measures silence rather than age and an active conversation is
never cut off mid-way.

Drained by the SESSION and by nobody else, which is what makes it correct rather than merely
delivered: a steer that is read is gone, so a task that hands off five times is not told the
same thing five times, and a steer that is never read expires after four hours rather than
ambushing whoever claims the task tomorrow. The channel is only a wake-up — it carries the
string `steer` and not the text — so a publish delivered twice costs a wasted drain instead of
a duplicated sentence in the agent's context.

Its loss is a degraded conversation and never a lost task, which is the line this section
draws: the durable record of guidance is the journal in git, written by the session that
consumed it or by the housekeeping pass that recorded it for a task nothing is running.

**`crossesProcesses` is declared, for `ChatDrainer.selective`'s reason.** The in-memory inbox
accepts every push, so without the flag `applyGuidance` would report "sent to the session" for a
task running on a machine this heap cannot reach — and two runners sharing a state repo with no
Redis is a supported arrangement, not a hypothetical one. A structure that answers "recorded" to
a question it cannot serve is indistinguishable from one that served it, and the caller is the
only place that can decide what to say about the difference. With it false, the human is told the
runner could not be reached; the local slot path is unaffected, because that is the case the
in-memory inbox actually covers.

### Cancels get a channel because the loop is blocked

`/cancel` already worked in one process, through a two-second interval that filters the
in-process queue while a session runs (§6.4) — and it worked *because* the submitter and the
session were the same process. With a separate bot they are not. So a cancel is published on
a channel and written to a key with a TTL: the channel is the fast path, and the key is what
makes it correct, because Redis pub/sub is fire-and-forget and a session that subscribes a
millisecond late would otherwise run to completion with a human waiting on it. The session
checks the key once on subscribing and at turn boundaries thereafter. The in-process path is
untouched and still runs; the two abort the same controller.

### What is deliberately absent

**No lease in Redis, no state in Redis, no journal in Redis.** Not as a first phase, not
behind a flag. The argument above is not about the current Redis being insufficiently
reliable — a more reliable one would not change it.

**No Redis-backed queue for anything a human is not waiting on.** The alert queue (§20) and
the intake pass stay in-process for the reason they were put there: they write the state
repo, and the loop owns the state repo working copy.

**No `takeWhere` over Redis.** Selectively removing one entry from a shared list is a Lua
script racing every other drainer, so `RedisChatQueue.takeWhere` and `some` return empty.

That absence is only safe because it is **declared**, and it was not declared once. A queue
that answers "nothing matched" to every question is indistinguishable from an empty one,
and the housekeeping split briefly routed its entire drain through `takeWhere` while a
session was in flight — so a Redis-backed runner served no chat request at all for the
duration of every session, and an in-flight `/cancel` had no path whatsoever, because the
in-session watcher polls the same stub and nothing in the process calls
`CancelSignals.request`. `ChatDrainer.selective` exists so that a caller must decide what
to do about it rather than silently receiving nothing; `applyChatRequests` reads it and
drains everything, routing an in-flight cancel to the session in process (§6.4). If a real
selective pop is ever written, that flag flips and the branch disappears — but the flag
must never be flipped without it.

---

## 22. Scheduled work

A sixth intake path (§14): **a clock becomes a task**. "Every weekday at 09:00, audit the
dependency updates in these repos" was not expressible anywhere in the system, and that is
the shape of a large amount of real unattended work — dependency audits, code-quality
sweeps, stale-branch cleanup, documentation drift. Every other path starts with somebody
deciding something is worth doing now: a labelled item, a `/brainstorm`, a hand-committed
spec, a firing alert. None of them is a calendar.

```
schedules/deps-audit.yaml  →  next occurrence  →  claim  →  precheck  →  spec.md
       (state repo)          (pure, clock in)     (ref)     (exit 0?)   (kind: implement)
                                                              │
                                                            non-0 → skipped occurrence,
                                                                    no session spent
```

Everything after the spec is identical to every other path: it is claimed, sessioned, gated
by §12 and ends in a pull request.

### It runs on the housekeeping loop and nowhere else

No listener, no port, no second Deployment, no `CronJob`. The supervisor already has a loop
that runs every `housekeepingSeconds` whether or not a session is in flight (§6.4), and
"has an occurrence come due" is a question about a checkout this runner already has plus one
`ls-remote`. A Kubernetes `CronJob` would have been a second scheduler with its own
credential, its own image tag and no access to the leases; it would also be unable to fire
for a runner on somebody's desk behind NAT, which the capability system exists to include.

Housekeeping rather than the work loop, for `maybeDigest`'s reason: an occurrence that comes
due while a session is running must still become a task, and the work loop is blocked for as
long as the session takes.

### `schedules/<id>.yaml`, one file per schedule

```yaml
version: 1
trigger:
  cron: "0 9 * * 1-5"           # required, five fields
  timezone: Europe/Berlin       # required, a NAMED IANA zone
workspace: primary              # required, a known workspace
repos:                          # required, >= 1, host/owner/name
  - github.com/acme/widget
prompt: |                       # required — the goal handed to each session
  Audit dependency updates across these repos…
acceptance:                     # REQUIRED, >= 1 command (§12)
  - npm test
requires: []                    # optional, from KNOWN_CAPABILITIES
precheck:                       # optional — the gate below
  command: "npm outdated --json | grep -q ."
  timeoutSeconds: 120
enabled: true                   # optional, default true
maxOpenTasks: 1                 # optional, default 1
```

**In the state repo, not this repo and not a ConfigMap**, for the reason §20 gives about
`alerts/policy.yaml`: adding scheduled work must be a commit to the thing the supervisor
already polls — reviewable, revertable, live on the next cycle — rather than a redeploy. The
supervisor never writes one; there is no `writeSchedule`, which is what keeps "what work
happens unattended" outside the fleet's own reach.

**One file per schedule, unlike the alert policy's single list.** Two reasons, and both are
about what an operator does with these: a schedule is edited on its own and a diff naming the
file says which one changed, and a malformed schedule then costs itself alone. A single
document would make one bad cron expression refuse every schedule in the fleet.

**`acceptance` is required, so a schedule that cannot express machine-checkable completion
may not exist** (§12). This is not a formality: an unattended task with no completion gate is
one that accumulates sessions and can never be closed, and nobody is watching it happen.

**`enabled: false` is a state a schedule may be in.** The alternative is deleting the file,
which loses the prompt and the acceptance commands somebody wrote and makes turning the
schedule back on a rewrite rather than an edit.

### The cron dialect is the small one

Five fields — minute, hour, day-of-month, month, day-of-week — with `*`, lists, ranges,
steps and three-letter names. No `@daily`, no seconds field, no `L`, no `#`, no `?`. Each of
those is a thing an operator would have to learn is supported here and not in the crontab
they know, and none of them expresses work this fleet does.

Two properties of the dialect are load-bearing and both are tested:

- **`day-of-month` and `day-of-week` are a UNION when both are restricted.** `0 9 1 * 1` is
  "the first of the month OR every Monday", which is what every cron implementation does and
  what an author expects. Read as a conjunction it fires roughly a tenth as often, which is
  the kind of wrong nobody notices for a month.
- **An expression that can never fire is refused.** `0 9 31 2 *` matches no day of any year.
  A schedule that silently never runs is indistinguishable from a fleet that is not
  scheduling at all, so it is refused when the file is committed.

### A named zone, and the occurrence maths is pure

`schedule/occurrence.ts` takes `now` as a parameter and does no IO, exactly like
`digest/day.ts` — which is what makes a DST boundary a test rather than a thing to wait a
year for. This subsystem has two of them: a schedule can name an hour the clocks skip and
an hour they repeat.

A **named IANA zone, never a fixed offset**, for §19's reason inverted: `+02:00` is correct
for five months of the year and an hour wrong for the other seven, and the wrongness is
silent — the audit simply starts at 08:00 or 10:00. `isTimeZone` refuses an offset even
though `Intl` accepts one.

The search runs forward over WALL-CLOCK minutes and converts each candidate to an instant,
rather than stepping in UTC, because the zone is the authority on what the clocks read. A
wall-clock minute a spring-forward deleted resolves past the gap and fires once; a minute an
autumn fall-back repeats yields one instant and fires once.

**Catch-up is bounded twice.** `CATCH_UP_OCCURRENCES` is 1 and `MAX_LATENESS_MS` is six
hours. The count alone is not a bound: "the previous occurrence" of an hourly schedule is an
hour old and worth running, while the previous occurrence of a weekly one can be six days
old, and firing a Monday audit on Saturday evening produces a task nobody asked for against
a repo that has moved on. Keel rolls this pod on every push to main, so missing ONE
occurrence is routine; missing five means nobody was home, and waking up to fire seven
dependency audits at once turns an outage into a mess somebody has to clean up.

### Exactly one runner fires each occurrence

`refs/schedules/<id>/<occurrence>` is created by a compare-and-swap against an empty expected
value, which exactly one push in the fleet can win — the mechanism §5 proved and §19 reused,
for the same reason: every runner reaches 09:00 at the same instant and all of them can read
the whole state repo. Nothing renews it and nothing steals it; an occurrence that has been
served does not become unserved.

The occurrence's name is the instant **in UTC** (`2026-08-17T0700Z`), not in the schedule's
own zone. UTC is what makes two runners agree without talking, and it means an operator who
edits the timezone does not make an occurrence that already fired look unfired.

The ordering is **claim, then create, and release the claim if creating failed**, because the
two failures are not symmetric. Firing twice is visible: two tasks, two branches, and a human
who can see both. Firing never is silent: the ref says the occurrence is settled, no task
exists, and nobody finds out until they wonder why the Monday audit stopped happening.

**A failed CAS is never read as "someone else did it" without checking the ref.** A rejected
push is also what a dead network looks like, and getting this backwards writes off an
occurrence nobody fired.

Inside the claim the order is `state.json`, then `spec.md`, then the ledger entry — and that
last position is forced rather than chosen. A write that throws hands the claim back, and a
`fired` record already on disk would stop this runner (and only this runner, since the record
is unpushed) from ever retrying: the record means "settled, no retry needed", which is
precisely what a released claim is not.

That leaves one residual, stated rather than papered over: a process killed BETWEEN the two
task writes holds the claim, has written no record, and leaves a task directory the claim loop
skips because it has no `spec.md`. The occurrence does not fire, and nothing retries it — the
next occurrence does. It is the narrowest window in the path (two local file writes with no
network between them) and closing it would need the record and the task to be one atomic
write, which git does not offer inside a working tree.

Two cheaper, local answers come first, in this order: the occurrence ledger and
`hasTask`. Both are files in a checkout this runner already has, so an occurrence that has
already been settled costs no network at all — which matters because the question is asked
on every housekeeping pass for as long as the occurrence is inside the catch-up window.

### The precheck: a command instead of a session

A bounded command, run in the task's toolchain environment **before a session is started**.
Exit 0 and the occurrence becomes a task; anything else records a **skipped** occurrence and
spends no session.

This is the cheap answer to the residual §11.1 admits. Work whose only blocker is external
state — no dependency updates this week, no stale branches, no drifted docs — currently costs
a whole session to discover there was nothing to do, and §11.1 then scores that session
honestly as no progress. Three of those park the task.

It runs in the environment the **session** would have had: the first repo's worktree and the
toolchain the resolver produces for the same spec (§8.1). A precheck answering from a shell
without the package manager is not a fact about the repository.

Four rules, each of which was a decision rather than an accident:

- **A timeout is a "no".** The command runs on the housekeeping loop, which the chat drain,
  intake, the digest and the survey share, so the bound is enforced rather than trusted —
  and a check that cannot answer within its own budget has not established that there is
  work. Firing on a timeout would make the slowest possible precheck the one that always
  passes. `timeoutSeconds` is capped at 600: an operator who wrote an hour meant a session.
- **A skipped occurrence KEEPS its claim.** The decision has been made; releasing it would
  have the next pass re-run the command, every pass, until the hour elapsed.
- **A precheck that could not be RUN releases the claim and records nothing.** "The worktree
  is not on this volume" or "the flake would not build" is not evidence about the work, and
  the runner that can answer may not be this one. Same for a schedule that declares a
  precheck on a runner with no way to run one.
- **Its output is recorded in the ledger.** A skip with no detail is indistinguishable from a
  schedule nobody is polling.

The precheck worktree is keyed on the SCHEDULE and not the occurrence
(`SCHED-<id>-precheck`), so a daily schedule does not clone a fresh tree every morning for a
check that is meant to be cheap. It is swept like any other orphaned worktree (§3.1).

### `schedules/occurrences/<schedule>-<occurrence>.json`

The ledger. Written for a **fired** occurrence as well as a skipped or refused one, and that
is what makes the skipped ones legible: "the precheck said no" and "nothing is polling this
schedule" both produce zero tasks, and only the record separates them.

Durable and pushed rather than in memory, for §14.2's reason verbatim: Keel rolls the pod on
every push to main, so an in-memory note of "already handled 09:00" is emptied by a deploy.
Two consequences for `StateStore`, the same pair §20 records for `alerts/`:

- `schedules` is in `commitAndPush`'s staging list. Without it the fleet's account of what
  fired is written locally and lost on the next deploy.
- `schedules` is in the reset path's `git clean` list. Without it a record whose commit never
  landed says "settled" on one runner and nowhere else, so the ledger a human reads disagrees
  with the ledger that stopped the work. The operator's `schedules/*.yaml` are tracked, so
  the sweep cannot touch them.

`maxOpenTasks` (default 1) is `alerts/policy.yaml`'s field for its reason: a weekly audit
whose last task is still in review must not open a second one saying the same thing. "Open"
is `!isTerminal(status)` — the supervisor's one notion of task status — so a **parked** task
counts as closed, because it is waiting on a human and the next occurrence is the nudge that
should be allowed to open fresh work. It is counted from the task tree rather than from the
ledger, since `SCHED-<schedule>-<occurrence>` carries the schedule's name, so a task deleted
by hand frees its slot.

### `kind` is `implement`, deliberately

There is no fourth task kind. A scheduled task writes code, opens a pull request and is
gated by §12 exactly as a tracker-sourced one is, and nothing about its origin changes what
the session must be told. `remediation` is a separate kind only because its brief is about a
cluster it may read and must never write (§20); a schedule has no such brief.

What the goal DOES carry, beyond the operator's prompt, is one paragraph saying that nobody
is waiting and there may be nothing to do — because the failure mode of unattended work is a
plausible pull request opened to have something to show for the session, and the review
council reads for exactly that (§12.1).

### Validated when committed, not when it fires

A malformed schedule is refused on the **intake pass** and shown on `/intake`. The firing
pass can only skip what it cannot parse, at 09:00, with nobody watching; the intake pass runs
on a timer whose whole output is a report, and the moment a schedule becomes malformed is the
commit that made it so — which is when somebody is looking.

Nothing durable is written for a refusal and nothing is commented on: there is no tracker
item and no author to tell. `IntakePass` carries `schedules` and `schedulesInvalid`, the
supervisor logs `intake.schedule-invalid` once per bad file per pass naming the field, and
the `/intake` page renders the message above the table of schedules that did parse — for
`policyPanel`'s reason, since an empty table reads as "nothing has come due".

### Off by default

`schedule.enabled` defaults to false, like `digest.enabled` and `web.enabled`, and for the
digest's reason: firing an occurrence writes tasks into the shared state repo, and a runner
someone started on a workstation must not begin doing that because it was upgraded. The claim
protocol makes a second firing runner harmless, not welcome. The `/intake` page says so out
loud, because an empty occurrence ledger on a runner that fires nothing is otherwise
indistinguishable from a scheduler that has broken.

`caterpillar_schedule_occurrences_total{schedule,outcome}` counts what was settled.
`outcome="skipped"` is the series it exists for: a schedule whose precheck never passes
creates no tasks, and neither does one nobody is polling.

### What is deliberately absent

**No `@reboot`, and no "run it now" button.** An occurrence is a point on a calendar that
every runner can compute; a manual trigger is a task, and the four other intake paths already
create those.

**No per-occurrence overrides.** A schedule that needs a different prompt on Fridays is two
schedules, which the per-file layout makes cheap.

**No catch-up beyond one occurrence, ever, and no configuration to widen it.** The bound is
the design (see above), and an operator who wants a week of missed audits wants one audit
that covers the week.
