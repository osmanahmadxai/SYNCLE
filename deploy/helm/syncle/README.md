# Syncle Helm chart

Runs Syncle — the API, the web GUI, and (unless you bring your own) a
PostgreSQL for Syncle's own metadata and a Redis for its job queue — on
Kubernetes.

```sh
helm install syncle ./deploy/helm/syncle \
  --namespace syncle --create-namespace \
  --set masterKey.value="$(openssl rand -base64 32)"
```

The **master key is the one thing you must set**: it encrypts every stored
connection password and signs every session, and the chart refuses to install
without one (a key generated inside a pod would be lost with the pod). Keep it
somewhere safe; `masterKey.existingSecret` takes one from a Secret of yours.

Then the first-run setup token is in the API's log
(`kubectl logs deploy/syncle-api | grep -A2 'setup token'`), and the GUI is
reachable with `kubectl port-forward svc/syncle 3002:3002` — or through an
ingress (`ingress.enabled=true`, `ingress.host=…`; put TLS in front, Syncle
serves plain HTTP — and let `GET /api/events`, the page's event stream, through
unbuffered and for up to 15 minutes: with ingress-nginx that is the two
annotations shown in `values.yaml`).

What is worth knowing:

- **Your own PostgreSQL or Redis**: `postgres.enabled=false` with
  `postgres.external.url` (or `existingSecret`/`key`); the same for `redis`.
  The in-cluster ones are single-replica StatefulSets on persistent volumes,
  fine for Syncle's own small metadata store and queue.
- **More than one API replica** (`api.replicas`) is safe: one process leads
  (the live change streams, the periodic sweeps), the rest share runs, polls
  and requests, and take over within `SYNCLE_LEADER_TTL_SECONDS` if the leader
  goes. Every replica needs the same key, database and Redis — which the chart
  gives them.
- **Tunables**: every `SYNCLE_*` setting the API reads goes under `api.env`,
  by name (see the configuration page of the docs).
- **Upgrades**: `helm upgrade` with a new `image.tag`; the API applies its
  own database migrations at start. Upgrade the whole release, not one
  component: the API and the web GUI come from the same image.

`helm template` and `helm lint` are run against this chart in CI; the values
file documents every option.
