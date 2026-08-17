# Alert-driven remediation — the operator's runbook

A firing Alertmanager alert becomes a `kind: remediation` task, which diagnoses itself with
three read-only cluster tools and ends in a pull request. DESIGN.md §20 says why it is built
that way; this file says how to turn it on, how to test each half by hand, and — the section
you are probably here for — [how to turn it off in a hurry](#turning-it-off-in-a-hurry).

Nothing here is specific to one cluster except the names: namespace `caterpillar`, the
StatefulSet `caterpillar`, Loki in `monitoring`, manifests in `caesar-deployment`.

---

## Turning it off in a hurry

Three levers, in increasing severity. Reach for the first one that is big enough.

| Lever | Stops | Blast radius | How long |
|---|---|---|---|
| Delete the entry from `alerts/policy.yaml` | **one alert** creating tasks | none — no deploy, no restart | next poll cycle (~30s) |
| `remediation.enabled: false` in the ConfigMap | **the webhook**, all alerts | one pod roll | a rollout |
| Remove the Alertmanager route | **delivery**, nothing arrives | Alertmanager reload | a reload |

**One alert is misbehaving.** Commit a deletion of its entry in the state repo:

```bash
$EDITOR alerts/policy.yaml        # remove the entry whose `alertname:` matches
git commit -am "ops: stop CaterpillarNoProgress creating tasks"
git push
```

The supervisor reads the policy every cycle. The next firing is refused for having no policy
entry, exactly as if it had never been listed, and one refusal record is written. Tasks
already created keep running — deleting the entry stops new ones, it does not recall work in
flight. Cancel those by hand (`kubectl exec` into the runner is not needed; edit
`tasks/<id>/state.json` in the state repo to a terminal status, or delete the task
directory).

**All of it, now.** In `caesar-deployment`, set `remediation.enabled: false` in the
supervisor ConfigMap and let Argo sync; or, faster than a git round trip:

```bash
kubectl -n caterpillar edit configmap caterpillar     # "remediation": { "enabled": false }
kubectl -n caterpillar rollout restart statefulset/caterpillar
```

The receiver never starts, the port answers nothing, and every delivery gets a connection
refused. Alertmanager will log delivery failures — that is the intended noise.

**Nothing should even be delivered.** Remove the `caterpillar-remediation` receiver's route
from the Alertmanager config and reload. Use this when you do not trust the supervisor's own
code, since it is the only lever that does not depend on the supervisor behaving.

A fourth, blunter option exists and is worth knowing: delete the `webhook-token` key from
the `caterpillar-remediation` secret and roll. The receiver **refuses to start without it**
and says so in its logs — an unauthenticated webhook that can create tasks is a remote code
execution path, so failing closed is the only default that is not a mistake waiting for a
misconfigured NetworkPolicy.

---

## What remediation cannot do

Write these down once, because they are the three questions everybody asks.

**It cannot write to the cluster.** Not a restart, not a scale, not an edit, not an
Alertmanager silence. The ServiceAccount holds read verbs only, and `npm run
verify:cluster-read` **asserts the negative** — if `create`, `update`, `patch` or `delete`
on `pods` or `deployments` comes back allowed, the preflight fails loudly rather than
passing. This is the load-bearing constraint of the whole design (§20): an agent that may
restart a Deployment will restart it before it understands why the alert fired, and what
that produces is a fleet that erases its own evidence.

**It cannot merge its own pull request.** A remediation task ends in a PR reviewed like any
other, by the §12 acceptance gate and the §12.1 council. An alert firing at 03:00 is not a
reason to lower the bar; it is a reason to have the diagnosis written down by 08:00.

**It cannot read a Secret's values.** `cluster_describe` on a `Secret` returns key **names**
and **byte lengths** and nothing else. Kubernetes RBAC cannot express "read the keys but not
the values", so the supervisor's token genuinely can read them and `src/cluster/redact.ts`
is the entire boundary — which is why check 7 of the preflight reads a real Secret through
that exact code path and asserts every value is absent from the output in both plaintext and
base64. ConfigMaps *are* returned in full, deliberately: most misconfigurations live there.

Two more worth stating: it cannot read a namespace outside `cluster.namespaces` (the
allowlist is supervisor configuration; there is no per-alert `namespaces` field, because a
bound an alert payload could widen for itself is not a bound), and it cannot create a task
for an alert nobody listed in `alerts/policy.yaml`.

---

## Order of operations

Do these in order. Each step is verifiable before the next, and doing them out of order
produces failures that look like the previous step's.

### 1. RBAC and the Service port (`caesar-deployment`)

The supervisor's ServiceAccount needs read verbs on the kinds `cluster_describe` reads plus
`events`, in each allowlisted namespace. `npm run verify:cluster-read` prints the exact list;
the grant looks like this:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: caterpillar-cluster-reader
  namespace: caterpillar          # one per allowlisted namespace
rules:
  - apiGroups: [""]
    resources: [pods, pods/log, events, configmaps, secrets, services, persistentvolumeclaims]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list]
```

No write verbs, and no `*`. RBAC is additive with no deny rules, so a broad binding
elsewhere (`edit`, `admin`, `cluster-admin`) silently grants writes that this Role does not —
which is the case check 5 of the preflight exists to catch.

`get namespaces` is deliberately **not** granted: no tool reads a namespace object. The
preflight reports that as a skip, not a failure.

In the same pass, add the webhook port to the Service:

```yaml
  - name: remediation
    port: 8081
    targetPort: 8081
```

### 2. ConfigMap keys

```json
"cluster": {
  "enabled": true,
  "namespaces": ["caterpillar", "monitoring"],
  "lokiUrl": "http://loki.monitoring.svc.cluster.local:3100",
  "maxLogLines": 2000
},
"remediation": { "enabled": true, "port": 8081 }
```

`namespaces` is the whole bound. **Empty denies everything** — `enabled: true` with the list
forgotten gives a runner that refuses every read while looking healthy, which is why the
preflight treats an empty list as a failure rather than a warning.

`lokiUrl` is the one people get wrong. There is **no Loki gateway in this cluster**
(`gateway.enabled: false`, SingleBinary), so the address is the Loki Service itself. A URL
naming a gateway host — `loki-gateway`, `loki-nginx` — will simply not resolve.

### 3. `alerts/policy.yaml` in the **state repo**

Not this repo and not a ConfigMap. Adding an alert must be a commit to the thing the
supervisor already polls: reviewable, revertable, live on the next cycle, no redeploy. See
[writing a policy entry](#writing-an-alertspolicyyaml-entry) below.

### 4. The `webhook-token` secret

```bash
head -c 32 /dev/urandom | base64        # keep this; Alertmanager needs the same string
```

Store it as key `webhook-token` in the SOPS-encrypted `caterpillar-remediation` secret and
mount it where `secretsDir` points. The receiver refuses to start without it.

### 5. The Alertmanager route

```yaml
receivers:
  - name: caterpillar-remediation
    webhook_configs:
      - url: http://caterpillar.caterpillar.svc.cluster.local:8081/alerts
        send_resolved: false          # resolved alerts are skipped anyway; do not send them
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/caterpillar-remediation/webhook-token

route:
  routes:
    - receiver: caterpillar-remediation
      continue: true                  # keep delivering to Discord/email as well
      matchers:
        - alertname =~ "Caterpillar.*"
```

`continue: true` matters: without it the alert stops at this receiver and your humans stop
hearing about it. Remediation is an *additional* consumer of the alert, never a replacement
for the one that wakes somebody up.

### 6. Run the preflight

```bash
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read -- --namespace monitoring
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read -- --json
```

Seven checks, each with a remedy on failure: config, token and CA, the API server over
verified TLS, the allowlisted namespaces, RBAC in both directions, Loki, and the redaction
promise against a real Secret. It exits 0 only if nothing failed. Run it **from inside a
pod** — the token and the cluster CA come from the projected ServiceAccount volume, and there
is no mode that skips TLS verification.

Outside the cluster it fails with one line telling you so, which is the right answer rather
than a stack trace.

### 7. Fire a test alert

See below. Do the `curl` first: it separates "the webhook works" from "Alertmanager reaches
the webhook", and those have completely different remedies.

---

## Testing the webhook by hand

Reach the port without an Ingress:

```bash
kubectl -n caterpillar port-forward statefulset/caterpillar 8081:8081
```

A liveness check that needs no token — `/healthz` answers **before** the auth gate, because
the kubelet probes the pod directly and a probe that got 401 would restart a healthy
container forever:

```bash
curl -s -i localhost:8081/healthz          # 200 ok
```

Now a minimal Alertmanager v4 body. The `fingerprint` must be lowercase hex: it becomes a
directory name and part of the task id `ALERT-<fingerprint>`, so it is checked rather than
trusted.

```bash
TOKEN=$(kubectl -n caterpillar get secret caterpillar-remediation \
  -o jsonpath='{.data.webhook-token}' | base64 -d)

curl -s -i -X POST localhost:8081/alerts \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "version": "4",
    "status": "firing",
    "receiver": "caterpillar-remediation",
    "alerts": [
      {
        "status": "firing",
        "fingerprint": "0123456789abcdef",
        "startsAt": "2026-01-01T00:00:00Z",
        "generatorURL": "https://prometheus.example/graph",
        "labels": { "alertname": "CaterpillarContextOverrun", "severity": "warning" },
        "annotations": { "summary": "a handoff threshold fired too late" }
      }
    ]
  }'
```

What the answers mean:

| Status | Means | Do |
|---|---|---|
| **202** `accepted 1 firing alert(s)` | parsed and queued. This is **not** "a task was created" | watch the logs, see below |
| **202** `accepted 0 firing alert(s)` | every member was skipped: `status` not `firing`, no `labels.alertname`, or a fingerprint that is not lowercase hex | fix the body |
| **401** | the bearer token does not match. A missing header and a wrong token answer identically — the difference is only useful to someone guessing | compare the secret to Alertmanager's `credentials_file` |
| **404** | wrong path. The only route is `POST /alerts`; `/api/v1/alerts` is Alertmanager's own API, not this one | fix the URL |
| **405** | you sent a GET | it is a POST |
| **413** | body over 1 MiB | your Alertmanager grouping is wrong, not this |
| **connection refused** | `remediation.enabled` is false, or the receiver refused to start for want of a token | check the pod logs for `remediation.disabled` / `remediation.no-token` |

A 202 means the delivery was *accepted*, not that a task exists. The decision happens on the
supervisor loop a moment later. Watch it:

```bash
kubectl -n caterpillar logs -f statefulset/caterpillar | grep -E 'alert\.|remediation\.'
```

- `alert.refused` with `reason: refused-no-policy` — no `alerts/policy.yaml` entry (step 3)
- `alert.refused` with `reason: refused-max-open` — `maxOpenTasks` already reached
- a task appearing under `tasks/ALERT-<fingerprint>/` in the state repo — it worked

Use a fingerprint you invented (`0123456789abcdef`) rather than a real one, so the test
never collides with a genuine alert's task or refusal record. Clean up afterwards by
deleting `alerts/refusals/0123456789abcdef.json` and the task directory from the state repo.

---

## Writing an `alerts/policy.yaml` entry

An alert becomes a task **only if an operator said in advance what it means and how a fix for
it is verified**. The file lives in the **state repo** at `alerts/policy.yaml`, is authored
by a human, and the supervisor never writes it — there is no `writeAlertPolicy`.

Parsing is **strict**: unknown keys, an unknown capability, a duplicate `alertname`, an empty
`acceptance`, a malformed repo ref and a `version` other than 1 are all parse errors naming
the entry and the field. That strictness is aimed at one specific typo — `acceptence:`
silently ignored would produce an entry with no acceptance commands, and the symptom is a
queue of tasks nothing can ever mark done. A **missing** file is an empty policy, not an
error.

Two worked examples, for the two alerts §11 already declares that this repo's own tests could
demonstrate a fix for:

```yaml
version: 1
alerts:
  # caterpillar_context_overrun_total > 0
  #
  # Should always be zero (§11). Non-zero means a session ran past its context window
  # before the handoff threshold fired, which is a defect in the threshold arithmetic in
  # src/agent/limits.ts — code this repo owns and whose tests would show a fix.
  - alertname: CaterpillarContextOverrun
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm run check
      - npm test
    goalPrefix: |
      caterpillar_context_overrun_total is above zero, which should be impossible: the
      handoff threshold in src/agent/limits.ts exists to end a session before the context
      window is reached. Find which session overran and why the threshold did not fire in
      time — the usual causes are a token estimate that undercounts tool results, and a
      single tool result larger than the remaining budget. Do not raise the threshold to
      make the metric go quiet; that is the symptom, not the cause.
    maxOpenTasks: 1

  # caterpillar_no_progress_streak >= 3
  #
  # Three consecutive sessions with no commit, no newly passing acceptance command and no
  # journal step (§11.1) — a task going in circles. Often the task, sometimes the detector.
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm run check
      - npm test
    goalPrefix: |
      A task has had three consecutive sessions with no measurable progress. Read that
      task's journal in the state repo first and decide which of two things this is: the
      task is genuinely wedged (the answer is a diagnosis and ask_human, not a patch), or
      the detector is wrong about it — a session that committed via a path the probe does
      not observe, or a fork-point baseline that makes the first commit invisible
      (src/supervisor/progress.ts and src/supervisor/probe.ts). Only the second one is a
      code change.
    runbook: https://github.com/caesarakalaeii/caterpillar/blob/main/docs/remediation-runbook.md
    maxOpenTasks: 1
```

Field by field:

- **`alertname`** — exact match against the alert's `alertname` label. Not a regex.
- **`workspace`** — a workspace this runner has configured, which is what decides the forge
  credential and the repo scope (§9.1).
- **`repos`** — at least one, `host/owner/name`. This is the token's scope for the session.
- **`acceptance`** — at least one command, verbatim, and §12 applies unchanged. There is no
  synthesised gate: a remediation task ends in a pull request like any other, and an entry
  with nothing to run would create a task nobody could ever close.
- **`requires`** — optional capabilities (§8). Almost always empty for these.
- **`goalPrefix`** — the most useful optional field. Say what the alert usually means and,
  more importantly, what a *wrong* fix would look like. The model is told the alert is a
  symptom, but it does not know your codebase's particular way of making a symptom go away.
- **`runbook`** — a URL surfaced in the goal. Nothing dereferences it.
- **`maxOpenTasks`** — default 1. An alert that keeps firing while a fix is in review must
  not open a second task saying the same thing. A `parked` task counts as *closed*: it is
  waiting on a human, and a fresh firing is exactly the nudge that should open a new task.

Which alerts are worth listing: the ones about the fleet's own code, where a repo's tests
could demonstrate a fix. §11's provider-cooldown alert is the instructive one to leave
**out** — nothing in this repo can fix an account that is out of budget, so it would produce
a task whose honest outcome is always `ask_human`. `awaiting-human > 24h` is about a human,
not about the code.

---

## Troubleshooting

### 401 from the webhook

The bearer token does not match. The receiver compares in constant time and answers a
missing header and a wrong token identically, so there is nothing to read into the message.

```bash
kubectl -n caterpillar get secret caterpillar-remediation -o jsonpath='{.data.webhook-token}' | base64 -d | md5sum
kubectl -n monitoring exec -it alertmanager-0 -- md5sum /etc/alertmanager/secrets/caterpillar-remediation/webhook-token
```

The usual cause is a trailing newline on one side. `credentials_file` is read verbatim; a
`base64 -d > file` that appended `\n` is a different token.

### 403 from the kube API

RBAC. Run the verifier — it turns "remediation is broken" into a table naming the verb, the
resource and the namespace:

```bash
kubectl -n caterpillar exec -it caterpillar-0 -- npm run verify:cluster-read
```

Check 5's table has one row per grant with two columns: what the API server said, and whether
that is what the feature needs. Add exactly the rows marked `WRONG` to the Role in that
namespace and re-apply. RBAC is additive, so nothing has to be removed.

If a **write** verb comes back `ALLOWED`, stop and fix the binding before enabling anything.
That is not a missing grant, it is a ServiceAccount bound to a broad ClusterRole, and the
entire safety argument for this feature is that the token cannot write.

### Loki returns nothing

`cluster_logs` answers "No log lines in the last N minutes for {…}" and that is a *fact*, not
an error: an empty result and a wrong label look identical from the tool's side. Check 6 of
the preflight fails on zero streams for exactly this reason.

The usual cause is that **Loki's labels are not always `namespace` and `pod`.** They depend
on the collector: Promtail's `kubernetes_sd` gives `namespace`/`pod`, while some Alloy and
OpenTelemetry pipelines give `k8s_namespace_name`/`k8s_pod_name`. List what your Loki
actually has:

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100
curl -s localhost:3100/loki/api/v1/labels | jq
curl -s 'localhost:3100/loki/api/v1/label/namespace/values' | jq
```

If `namespace` is absent from that list, `cluster_logs` will always come back empty until the
collector's relabelling is fixed. That is a change in the logging pipeline, not in this repo:
`src/cluster/client.ts` builds `{namespace="…", pod=~"…"}` from validated parts on purpose,
and a configurable label template would be one more string a session could aim at a
namespace the guard just refused.

Second most common: the URL names a gateway that does not exist. See step 2.

### An alert was refused for having no policy entry

The record is in the **state repo** at `alerts/refusals/<fingerprint>.json`:

```json
{
  "fingerprint": "a1b2c3d4e5f60718",
  "alertname": "CaterpillarNoProgress",
  "reason": "refused-no-policy",
  "at": "2026-01-01T03:14:00Z"
}
```

It exists so the fleet is *quieter* than the alert: Alertmanager re-sends a firing alert every
few minutes and Keel rolls the pod on every push to main, so anything remembered in memory
would re-notify for every declined alert on every deploy. One record, one notification.

To clear it — after adding the policy entry — delete the file and push:

```bash
git -C <state-repo> rm alerts/refusals/a1b2c3d4e5f60718.json
git -C <state-repo> commit -m "ops: clear refusal now that CaterpillarNoProgress has a policy"
git -C <state-repo> push
```

You do not have to: the next firing after the entry exists is handled on its merits and the
record is cleared by the success path anyway. Delete it when you want the notification back
sooner than the next firing.

Note the two refusal reasons are different problems. `refused-no-policy` is step 3 not done.
`refused-max-open` means an earlier task for this alertname is still open — find it with:

```bash
grep -l '"alertname": "CaterpillarNoProgress"' <state-repo>/alerts/refusals/*.json
```

and look up each record's `task` under `tasks/`. A record naming a task that no longer exists
contributes nothing, so deleting a stuck task by hand frees the slot.

### The preflight itself will not run

Outside a cluster it exits non-zero with one line, by design. Inside a pod:

- *"could not read the supervisor config"* — pass the path as the first argument or set
  `CONFIG_PATH`; in the pod it is `/etc/caterpillar/config/config.json`. `RUNNER_ID` must be
  set too, exactly as the supervisor requires it (the pod sets it via `fieldRef`).
- *"missing or empty: …/token"* — the ServiceAccount may have
  `automountServiceAccountToken: false`, or the Pod spec may. Remove that and roll.
- Certificate errors — the mounted CA is not the one this API server presents. Supply the
  right CA. There is no flag that skips verification and there will not be one.
