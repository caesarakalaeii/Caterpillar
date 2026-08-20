# Lessons

Each of these cost real debugging on a live deployment. They are encoded in code or tests
now — the entries exist so that a future reader knows the encoding is deliberate and does
not "simplify" it away.

Deployment-specific state (credential ids, cluster inventory, what is currently running)
deliberately does NOT live here; it belongs with whoever operates a deployment. This file
is only the part that survives being handed to a stranger.

## Leases, state and the claim loop

- **A fencing token is not a value you may carry.** One was captured before a multi-minute
  await and compared afterwards, by which point the lease it fenced had already been stolen
  and renewed. The generalisation: anything compared for exact equality against remote state
  must be re-read at the moment of use, not passed down a call chain that awaits.
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

## Environment and tooling

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
- **SOPS in a deployment repo typically encrypts by PATH** (`path_regex: .*\.enc\.yaml$`), so
  encrypting a `/tmp` file fails. Write plaintext to its final `*.enc.yaml` path (umask 077)
  and `sops --encrypt --in-place` there. Don't hand-edit an encrypted file's plaintext
  fields — the MAC covers them.
- **`kubectl scale` loses to ArgoCD `selfHeal`** — change the TASK, not the replica count.

## Credentials and git

- **`credential.helper` set AFTER a clone is set too late** — pass it with `-c`.
- **Every mirror command that talks to a remote needs `-c`, not just the clone.** Once the
  helper became per-task it lives in each worktree's `config.worktree`, and a mirror is not
  a worktree — so `syncMirror`'s **fetch** had nothing to read and went out anonymous. The
  clone still authenticated, which is exactly what hid it: a repo's FIRST task built the
  mirror and succeeded, and every task afterwards failed the refresh with `could not read
  Username`. It presents as "the second task on a repo is broken". No test caught it because
  a `file://` origin needs no credential to fetch from — assert on the *invocation*, not on
  whether it threw.
- **`Repository not found` means a credential ARRIVED and was refused.** 404 = the WRONG
  token was sent; 401 = NO token was. They look equally like "auth is broken" and point in
  opposite directions. **A 404 stops git asking the credential helper**, so a
  valid-but-unauthorised credential never reaches it.
- **git appends the credential-helper operation LAST**: `caterpillar-cred --socket <path>
  get`. "First argument that is not a flag" therefore selects the *socket path*. `git
  credential fill` reproduces the real invocation offline.
- **`at()` drops the credential, but only if you call it.** Enforce "this object must not
  travel" at the boundary that RECEIVES it.
- **Anything the supervisor does AFTER the session's credential lease closes cannot use a
  task credential**, so post-session code (probe, verifier) must not need the network.
- **The credential service is keyed by TASK, one socket each** (§9.2). A single `active`
  slot served whichever task registered last, so two concurrent sessions crossed
  credentials by accident; a single global clear let a finishing task revoke a running
  one. Set and clear are now one lease taken in the session runner's `finally`.
- **Never set `remote.origin.url` from a worktree** — worktrees share the mirror's config.
  Use **`--git-common-dir`, not `--git-dir`**, for `info/exclude` and shared refs.
- **`git config` in a worktree writes the mirror's COMMON config**, so anything per-task
  written that way is per-*mirror* in practice — which is how a per-task socket path would
  have silently re-created the leak it was fixing. `git config --worktree` is the only
  per-worktree writable scope, it needs `extensions.worktreeConfig`, and enabling that on
  a bare mirror makes the common `core.bare = true` apply to every linked worktree unless
  you relocate it into the main worktree's own config — otherwise every checkout answers
  `fatal: this operation must be run in a work tree`. Do the relocation IN THE MIRROR:
  `--worktree` writes wherever it is invoked, so doing it from a task checkout marks that
  checkout bare and un-bares the mirror.
- **A worktree of a `--mirror` clone inherits `remote.origin.mirror`**, so a bare `git push`
  there force-pushes *every* ref. Sharing the mirror's config cuts both ways: it is the
  delivery mechanism for the credential helper AND for a footgun. Pin
  `remote.origin.push = HEAD`.
- **A force-pushed-away commit is usually still on the forge.** GitHub answers
  `gh api repos/<o>/<r>/commits/<sha>` for unreferenced objects; check there before trusting
  a local reflog that never saw the commit.
- **"No merging" is not expressible as a GitHub permission.** `pull_requests: write`
  authorises merge; branch protection requiring an approving review is what enforces it.

## Multi-repo tasks

- **`spec.repos` is plural everywhere, including the finish.** `open_pr` takes an optional
  `repo` — one of the task's own — and completion checks CI in every repo a PR was opened in,
  then merges them in `spec.repos` order. It did none of that until `GH-acme-all-chat-543`
  hit it: the extension half was built, pushed and verified and the PR could not be opened at
  all (two 422s from the wrong repository), so the session parked and a human opened
  `all-chat-extension#113` by hand.
- **A repo you changed and did not open a PR for will not merge.** The gate reads
  `state.prs`, not the branches on the remote.
- **Merging stops at the first failure and says what landed.** The repos of one change usually
  cannot land in either order, so a partial merge is a real state a human has to be told about.

## Supervisor behaviour

- **Release the lease LAST.** Anything recording *why* a task failed must write while the
  lease is held, using the heartbeat's current lease.
- **`checkLimits` runs BEFORE a claim's first session.** So any limit still met when a
  task returns to `ready` parks it again having run nothing, and any command that puts a
  task back must clear whatever limit parked it or say plainly that it did not. `/resume`,
  `/answer` and operator guidance all clear `noProgressStreak`; guidance additionally clears
  `review.rounds`, because a resume that did not buys exactly one more council round and parks
  again (§7.3, and how `BS-1539374658363854934` reached 13 rounds against a cap of 3). Nothing
  clears `sessions`, and the reply says so.
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

## Trackers and forges

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

## Testing discipline

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
