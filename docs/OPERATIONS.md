# Operations

How to run osrs-data-hub for a guild: one VM, Docker Compose, behind the VM's existing reverse proxy.
The same images also run on Kubernetes (§9).

## 1. Configure

```bash
cp .env.example .env
```

Fill in at least `APP_URL`, `POSTGRES_PASSWORD` (and the same password in `DATABASE_URL`),
`AUTH_SECRET` (`openssl rand -base64 32`), the Discord application (`DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`), the bot token and the guild (`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_GUILD_NAME`), and at least one bootstrap admin (`ADMIN_DISCORD_USER_IDS`). Every variable and
its default is listed in `.env.example`.

- **`APP_URL` must be an origin** such as `https://hub.example.com`, with no path. The hub refuses to
  start otherwise (D-26). Players paste this URL into the plugin; it must include `https://`, because the
  plugin silently fails on a URL without a scheme.
- **Discord application:** add the redirect URI `${APP_URL}/api/auth/callback/discord`. The hub asks for
  the scopes `identify guilds.members.read` only.
- **Discord bot:** invite it to the guild with **no permissions**; it needs no privileged intents. It is
  only used to re-check membership every 6 hours. If the bot is not in the guild, re-verification logs
  errors but never removes anyone (DISCORD-1).
- **Icons** (`OSRS_ICONS_URL`, D-95): item, skill and slot pictures load in the browser from
  `https://icons.scapekeeper.com` by default, along with the CDN's small stack table (once per page
  load, browser-cached). For an offline or privacy-minded install, set it to empty (names only) or to a
  mirror: extract an osrs-icons release tarball into any static web root that sends
  `Access-Control-Allow-Origin: *`. It is read at runtime, so no image rebuild is needed.
- **Official hiscores** (`HISCORES_URL`, D-105): the worker looks each account up on
  `https://secure.runescape.com` by its in-game name, about 10 minutes after a session ends and once a
  day, at most one request every `HISCORES_REQUEST_INTERVAL_MS` (3 s). It pauses on anything but a
  clean answer (from a minute up to an hour), so a blocked server IP shows as
  `hub_hiscore_lookups_total{result="throttled"}` climbing and stale hiscores, never as errors for
  players. Set it to empty to turn the lookups off; a development or test stack should, or point it
  at a fake.

## 2. Start

```bash
docker compose up -d --build
docker compose logs -f web worker
```

`migrate` runs first and exits; `web` and `worker` start when it succeeded. The web container listens on
`127.0.0.1:3000` (override with `WEB_PORT`), the worker's metrics endpoint on `127.0.0.1:9464` (§7).

The `db` service is tuned by the image at first start: `DB_MEMORY` (default `2GB`) sets the memory it
tunes for, and `TS_TUNE_MAX_CONNS=100` keeps enough connections for the web, worker and job pools
(DB-5). The data volume is mounted at `/var/lib/postgresql` (TSDB-6).

## 3. Reverse proxy

Terminate TLS in the proxy you already run and forward to `127.0.0.1:3000`. Six requirements:

1. **Don't buffer `text/event-stream`.** The live stream (`/api/live/stream`) sends
   `X-Accel-Buffering: no`, which nginx honours; Caddy and Traefik stream by default.
2. **Forward the host.** Keep the original `Host` or set `X-Forwarded-Host`, and append the client address
   to `X-Forwarded-For`. `TRUST_PROXY_HOPS` (default 1) is the number of proxies whose
   `X-Forwarded-For` entries the hub trusts for rate limits. Count from the right, one hop per proxy
   that appends to the header: the hub takes the entry that many positions from the end (D-42). One
   proxy on the VM is 1; Cloudflare → cloudflared → Traefik is 2 (§9). Too low, and every client is
   the last proxy's address; too high, and the entry is one the client wrote itself.
3. **Serve the hub over HTTPS** (or `localhost`). Browsers send `Sec-Fetch-Site` only to secure
   origins, and some same-origin checks rely on it: on plain `http://<LAN address>` the export and
   the raw-payload viewer answer 403.
4. **Leave `/api/v1/*` to the hub.** Don't add CORS or caching headers in the proxy: the hub sets
   `Access-Control-Allow-Origin: *`, `ETag` and `Cache-Control` itself. `TRUST_PROXY_HOPS` also keys
   the API's failed-authentication limit (30 per minute per client IP, D-72): when it is wrong, every
   client appears as the proxy's address, and one client with a bad key locks every API client out
   for about a minute.
5. **Never redirect `/api/osrs-data/*`.** The plugin turns a 301/302 into a body-less GET and doesn't
   follow 307/308, so data is lost silently (PLUGIN-2). Redirect http → https for the UI only, or tell
   players to use the `https://` URL exactly as the wizard shows it.
6. **Keep `/metrics` off the internet.** It is token-protected, but nothing outside your monitoring needs
   it: answer 404 to everyone except your Prometheus server (examples below and in §7). The worker's
   metrics port is never behind the proxy.

Examples:

```caddyfile
hub.example.com {
  # /metrics only for the Prometheus server (drop the matcher's allow-list to block it entirely).
  @metrics_blocked {
    path /metrics /metrics/*
    not remote_ip 10.0.0.5
  }
  respond @metrics_blocked 404
  reverse_proxy 127.0.0.1:3000
}
```

```nginx
location = /metrics {
  allow 10.0.0.5;               # your Prometheus server; remove to block /metrics entirely
  deny all;
  proxy_pass http://127.0.0.1:3000;
}
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;          # SSE
  proxy_read_timeout 1h;        # long-lived SSE connections
}
```

## 4. Deploys

```bash
git pull && docker compose up -d --build
```

A short outage is safe: while the web service restarts the proxy returns 502/503, the plugin backs off
and queues events for up to 10 minutes, and resends them (duplicates are ignored by event id).

## 5. Backups

The optional `backup` service runs `pg_dump` nightly (UTC hour `BACKUP_HOUR`, default 3) and keeps 14
daily and 8 weekly dumps in `BACKUP_DIR` (default `./backups`):

```bash
docker compose --profile backup up -d
docker compose run --rm backup --once        # take one now
```

Copy `BACKUP_DIR` off the machine (rsync, restic, object storage).

**Restore** into an empty database (test this at least once):

```bash
docker compose stop web worker
docker compose exec db psql -U hub -d postgres -c 'DROP DATABASE hub WITH (FORCE)' -c 'CREATE DATABASE hub'
docker compose exec db psql -U hub -d hub -c 'CREATE EXTENSION timescaledb' -c 'SELECT timescaledb_pre_restore()'
docker compose exec -T db pg_restore -U hub -d hub --no-owner < backups/daily/hub-<stamp>.dump
docker compose exec db psql -U hub -d hub -c 'SELECT timescaledb_post_restore()'
docker compose start web worker
```

The restore procedure has not been drilled yet (Milestone 4); treat it as a draft until it has.

## 6. Retention

Retention is set by env and applied by the worker at startup (it compares and replaces TimescaleDB
policies, D-40):

| Data | Kept | Variable |
|---|---|---|
| Raw XP samples (5-min) | 365 days | `XP_RAW_RETENTION_DAYS` (min 14) |
| Hourly and daily XP | forever | — |
| Location trail (every tile since plugin 1.6, compressed after a day) | 30 days | `LOCATION_RETENTION_DAYS` |
| Raw ingest payloads | 72 hours | `RAW_PAYLOAD_RETENTION_HOURS` |
| Audit log | 2 years | `AUDIT_LOG_RETENTION_DAYS` |
| Events, sessions, equipment, wealth | forever | — |
| Official hiscores: latest lookup, score changes, XP filled from them | forever (the latest while the account exists) | — |

Never run `refresh_continuous_aggregate` by hand with a NULL start on `xp_hourly`/`xp_daily`: refreshing
a range whose raw data retention already dropped erases the aggregated history (TSDB-1).

## 7. Monitoring

- `GET /api/health`: 200 when the web service can reach the database.
- **Metrics**, off until `METRICS_TOKEN` is set (`openssl rand -hex 32`); both endpoints then want
  `Authorization: Bearer <METRICS_TOKEN>` (401 otherwise):
  - the web service's `GET /metrics`: ingest (by status, events by type, duplicates, skipped, latency,
    plugin versions), live connections and refused streams, pairing, the public API (requests by route
    group and status, latency, 429s by limit, failed key authentications) and data exports;
  - the worker's `GET /metrics` on port `WORKER_METRICS_PORT` (9464): job durations, runs and last
    success, Discord re-verification (checks, failures, circuit-breaker trips), open play sessions,
    grace expiries and deleted accounts (D-84), official hiscores lookups by result and XP fills
    (D-105).

  The full list is in [ARCHITECTURE.md §13](ARCHITECTURE.md#13-configuration-and-operations). Labels
  are fixed sets: no user, account or device ids, names, IP addresses or coordinates.
- Logs are JSON on stdout (pino). They never contain tokens, request bodies or coordinates.

### Pointing your Prometheus at the hub

[`ops/prometheus/scrape-example.yml`](../ops/prometheus/scrape-example.yml) has both scrape jobs; keep
their names `hub-web` and `hub-worker`. Put the token in a file readable by Prometheus only and use
`authorization.credentials_file`.

- **Prometheus on the hub VM:** scrape `127.0.0.1:3000` and `127.0.0.1:9464` directly.
- **Prometheus elsewhere (a monitoring server in your network):**
  - web: through the reverse proxy, `https://<your hub>/metrics`, with the proxy allowing `/metrics`
    from the Prometheus server only (§3, requirement 6);
  - worker: set `WORKER_METRICS_BIND` in `.env` to the VM's **private** address (it defaults to
    `127.0.0.1`), `docker compose up -d worker`, and firewall port 9464 to the Prometheus server. Never
    bind it to a public address: the token then crosses the network in plain HTTP.
- **Alerts:** copy [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml) next to your
  `prometheus.yml` and add it to `rule_files`. It alerts on an ingest 5xx ratio above 5%, no accepted
  payloads for 10 minutes while play sessions are open, a tripped verification breaker, a job failing
  3 times in an hour, and a job that hasn't succeeded for a few of its periods. Routing them needs your
  Alertmanager.

Check a scrape by hand: `curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics`.

### Importing the dashboard

In Grafana: **Dashboards → New → Import**, upload
[`ops/grafana/dashboards/hub-overview.json`](../ops/grafana/dashboards/hub-overview.json) and pick your
Prometheus in the **Data source** variable at the top (the JSON names no datasource). The **Job**
variable lists the scrape jobs that export hub metrics; All sums web and worker, which is what every
panel expects. To change the dashboard, edit it in Grafana, export it as JSON (with "Export for sharing
externally" off) and commit it over the file, so the repo stays the source (D-85). A Kubernetes
deployment loads this file and `alerts.yml` as they are (§9), so a change here is a change there.

Some panels need a little history: re-verification, grace expiry and the audit-log prune run every
15 minutes, hourly and daily, so their panels use one-hour windows. The "last success" panel and the
`HubJobStale` alert only know about runs since the worker last started.

### Local stack

For development there is an opt-in Prometheus + Grafana that scrapes `pnpm dev` and `pnpm dev:worker` on
the host: see [DEVELOPMENT.md](DEVELOPMENT.md#monitoring-stack). It is not meant for production.
- A user who ran **Delete my data** shows in Admin → Users as in grace with reason `self_delete` for
  7 days; an admin restore undoes it, as signing in does (D-78). The export limit (one per user per
  10 minutes) and the live-stream limit are kept in the web process's memory and reset on restart.

## 8. Decommissioning

The admin decommission switch makes ingest answer **410**, which disables the connection in every
plugin permanently (the player has to re-pair to use another hub). Use it only when shutting the
instance down for good.

## 9. Kubernetes

Kubernetes is a supported deployment target: the images published to GHCR on every version tag (D-87)
run from a cluster instead of Compose. The manifests are not in this repository; the operator's cluster
repository owns the deployment shape (Argo CD, Traefik behind a Cloudflare tunnel, a bjw-s
app-template release). What lives here is the contract those manifests rely on. Changing any item
below changes the cluster too, so call it out in the PR.

- **Images.** `ghcr.io/redfirebreak/osrs-data-hub-web:<x.y.z>` and
  `ghcr.io/redfirebreak/osrs-data-hub-worker:<x.y.z>`, pinned to an exact version there and bumped by
  Renovate; there is no `latest`. Both run as the `node` user (uid 1000), with `node` as PID 1 (the
  `CMD` is the binary, no shell or init) and need no capabilities. The web image listens on `3000` with
  `HOSTNAME=0.0.0.0` baked in (NEXT-9). The worker listens on `WORKER_METRICS_PORT` (default `9464`,
  `0` = no listener) on all interfaces; it answers 404 until `METRICS_TOKEN` is set and 401 without the
  bearer token. `WORKER_METRICS_BIND` is a Compose-only setting (it picks the host address Compose
  publishes on) and means nothing in a cluster.
- **Configuration** is the same environment variables as §1 (`.env.example`); there is no
  Kubernetes-specific setting. `APP_URL` is the public origin, as always (D-26).
- **Probes.** `GET /api/health` is both the readiness and the liveness probe of the web pod: 200 when
  `SELECT 1` succeeds within 2 s, 503 otherwise, no auth, nothing about the deployment in the body. The
  worker has no health endpoint; its liveness is the process.
- **Migrations** run as an initContainer, from the worker image, with
  `node --enable-source-maps dist/migrate.js` and `DATABASE_URL`. That is the Compose `migrate` service,
  so `dist/migrate.js` must stay a one-shot that exits 0 once every migration is applied and non-zero
  on any failure, and only one instance runs at a time (one `web` and one `worker` replica, D-5).
- **Database.** The same `timescale/timescaledb:<x>-pg18` image as `compose.yaml`, with
  `TS_TUNE_MEMORY`, `TS_TUNE_MAX_CONNS=100` (DB-5), `TIMESCALEDB_TELEMETRY=off` and its volume mounted
  at `/var/lib/postgresql` (TSDB-6). Renovate bumps the three references here in one PR
  (`renovate.json`); when the pinned tag changes here, it changes in the cluster repository too.
- **Proxy chain.** Behind Cloudflare → cloudflared → Traefik the web pod receives
  `X-Forwarded-For: <client>, <cloudflared pod>`, so the deployment sets `TRUST_PROXY_HOPS=2` (§3,
  requirement 2). Traefik streams `text/event-stream` and forwards `Host` by default; the live stream's
  25 s heartbeat keeps the tunnel's idle timeout from closing it.
- **Metrics.** `/metrics` on the public hostname is denied by the ingress (§3, requirement 6).
  Prometheus scrapes the web and worker Services in-cluster with `METRICS_TOKEN`, under the job names
  `hub-web` and `hub-worker` that the dashboard's `job` variable expects (§7).
- **Dashboard and alerts.** [`ops/grafana/dashboards/hub-overview.json`](../ops/grafana/dashboards/hub-overview.json)
  and [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml) are consumed verbatim by the cluster,
  as a Grafana dashboard ConfigMap and a PrometheusRule (D-85). Renaming a metric, a label, an alert or
  the `job` variable breaks them there as well as in a self-managed Grafana.

## 10. Releases

A release is a git tag `v<major>.<minor>.<patch>` on `main`; the Release workflow builds the two images
for it and publishes them to GHCR as `<major>.<minor>.<patch>` and `<major>.<minor>` (D-87). Nothing is
released on merge: cut one when a feature or fix is ready, one version per PR or a few PRs together.
Dependency updates are the exception, they release themselves on a schedule.

- **The button.** GitHub → Actions → **Cut release** → Run workflow, branch `main`, choose `patch`,
  `minor` or `major`. It computes the next version from the latest tag, tags `main`'s head, creates a
  GitHub Release whose notes list the PRs merged since the previous tag, and publishes both images. It
  refuses to run from another branch, on a commit that is already tagged, or on a commit whose CI run
  on `main` has not succeeded yet (wait for it, or fix it).
- **The schedule.** The same workflow runs by itself on Wednesday at 15:00 and Sunday at 09:00
  (Amsterdam time) for the updates Renovate merges on its own (D-99). It cuts a `patch` when Renovate
  merged something the images are built from since the latest tag: a dependency, the lockfile, the
  Dockerfile; not a workflow pin, a Compose image, docs or `ops/`. It releases `main`'s head, so a
  feature or fix that was merged but not released yet goes out with it, as a patch. In every other
  case it releases nothing and the run's summary says why: no such update, a head that is already
  released, no green CI run on the head, or a held release (next item).
- **The `breaking` label.** Put it on a PR that needs a `major` (see *Which bump*). While a merged PR
  with that label is in no release, the schedule releases nothing; cut the release with the button and
  it carries on.
- **By hand,** the same thing without the guards: create a Release in the GitHub UI with a new tag, or
  `gh release create v0.2.0 --generate-notes`, or `git tag v0.2.0 && git push origin v0.2.0`. A tag
  pushed by a person triggers the Release workflow directly.
- **Which bump.** `patch` for fixes and small changes, `minor` for a feature, `major` when a deployment
  has to change something to upgrade: an env variable renamed or made required, a manual migration
  step, an image contract in §9. Say so in the release notes; that is what the cluster's Renovate PR
  links to.
- **Dry run.** Actions → **Release** → Run workflow on any branch builds both images without pushing.
- **Old versions stay.** Nothing prunes the GHCR packages. They are public, so their storage and pulls
  are free, and a deployment pinned to an older version, or rolling back to one, must still be able to
  pull it.

The cluster picks a new version up through its Renovate (§9); Compose deployments pull whatever tag
their `compose.yaml` names, or build locally as before.
