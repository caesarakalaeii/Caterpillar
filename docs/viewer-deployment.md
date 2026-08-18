# What `caesar-deployment` owes the viewer (caterpillar#60, Part B)

The code side is merged in `caesarakalaeii/caterpillar`. Nothing is deployed until these
three land, and until then the Ingress still balances across four pods.

## 1. `caterpillar-view` Deployment

Same image as the fleet, different command — `dist/` ships whole, so there is no second
build:

```yaml
spec:
  replicas: 1
  template:
    spec:
      automountServiceAccountToken: false      # it needs no kube API: discovery is DNS
      containers:
        - name: view
          image: ghcr.io/caesarakalaeii/caterpillar:main
          command: ["node", "/app/dist/cli/view.js"]
          ports:
            - name: web
              containerPort: 8080
          env:
            - name: VIEW_SERVICE
              value: _web._tcp.caterpillar-headless.caterpillar.svc.cluster.local
            # VIEW_PORT (8080), VIEW_TIMEOUT_MS (4000), VIEW_REFRESH_SECONDS (10),
            # VIEW_REQUIRE_FORWARDED_USER (defaults TRUE — leave it),
            # VIEW_FORWARDED_USER_HEADER (remote-user) are all optional.
          readinessProbe:
            httpGet: { path: /healthz, port: web }
          livenessProbe:
            httpGet: { path: /healthz, port: web }
```

No PVC, no secret, no ServiceAccount token, no state-repo credential. If it is asking for
any of those, something is wrong with the manifest and not with the process.

`/healthz` answers before the auth gate and reports only the VIEWER's health — a runner
being down is a thing it renders, not a reason for the kubelet to restart it.

## 2. A Service for it, and the Ingress repointed

`caterpillar-ingress` currently points at Service `caterpillar` port `web`, which balances
across all four pods. Point it at the viewer's Service instead, and keep the Authelia
forward-auth annotations **byte for byte** — the viewer's own `requireForwardedUser`
defaults to true and will 401 everything if they are dropped, which is the intended
fail-closed behaviour and will look like an outage if the annotations are lost.

## 3. Nothing is removed from the fleet

The runners' `web` port stays, in-cluster only: those `/api/*` endpoints ARE the viewer's
data source. `web.enabled` stays true in the fleet ConfigMap. The headless Service
`caterpillar-headless` must keep its **named** `web` port — the SRV lookup is
`_web._tcp.<headless>.<ns>.svc.cluster.local`, so an unnamed port makes the viewer discover
nothing and render an empty fleet.

## Verifying it without an Ingress

```sh
kubectl -n caterpillar port-forward deploy/caterpillar-view 8080:8080
# then, since the seatbelt is on by default:
curl -H 'Remote-User: you' localhost:8080/api/fleet | jq '.live, .unreachable, .source'
```

`unreachable` naming a pod is the viewer working, not failing: a replica that does not
answer is rendered next to its name rather than dropped.
