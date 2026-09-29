# Operations

How to run osrs-data-hub for a guild: one VM, Docker Compose, behind the VM's existing reverse proxy.

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

## 2. Start

```bash
docker compose up -d --build
docker compose logs -f web worker
```

`migrate` runs first and exits; `web` and `worker` start when it succeeded. The web container listens on
`127.0.0.1:3000` (override with `WEB_PORT`).

The `db` service is tuned by the image at first start: `DB_MEMORY` (default `2GB`) sets the memory it
tunes for, and `TS_TUNE_MAX_CONNS=100` keeps enough connections for the web, worker and job pools
(DB-5). The data volume is mounted at `/var/lib/postgresql` (TSDB-6).

## 3. Reverse proxy

Terminate TLS in the proxy you already run and forward to `127.0.0.1:3000`. Four requirements:

1. **Don't buffer `text/event-stream`.** The live stream (`/api/live/stream`) sends
   `X-Accel-Buffering: no`, which nginx honours; Caddy and Traefik stream by default.
2. **Forward the host.** Keep the original `Host` or set `X-Forwarded-Host`, and append the client address
   to `X-Forwarded-For`. `TRUST_PROXY_HOPS` (default 1) is the number of proxies whose
   `X-Forwarded-For` entries the hub trusts for rate limits.
3. **Leave `/api/v1/*` to the hub.** Don't add CORS or caching headers in the proxy: the hub sets
   `Access-Control-Allow-Origin: *`, `ETag` and `Cache-Control` itself. `TRUST_PROXY_HOPS` also keys
   the API's failed-authentication limit (30 per minute per client IP, D-72): when it is wrong, every
   client appears as the proxy's address, and one client with a bad key locks every API client out
   for about a minute.
4. **Never redirect `/api/osrs-data/*`.** The plugin turns a 301/302 into a body-less GET and doesn't
   follow 307/308, so data is lost silently (PLUGIN-2). Redirect http → https for the UI only, or tell
   players to use the `https://` URL exactly as the wizard shows it.

Examples:

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

```nginx
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
| Location trail | 30 days | `LOCATION_RETENTION_DAYS` |
| Raw ingest payloads | 72 hours | `RAW_PAYLOAD_RETENTION_HOURS` |
| Audit log | 2 years | `AUDIT_LOG_RETENTION_DAYS` |
| Events, sessions, equipment, wealth | forever | — |

Never run `refresh_continuous_aggregate` by hand with a NULL start on `xp_hourly`/`xp_daily`: refreshing
a range whose raw data retention already dropped erases the aggregated history (TSDB-1).

## 7. Monitoring

- `GET /api/health`: 200 when the web service can reach the database.
- `GET /metrics`: Prometheus metrics, enabled when `METRICS_TOKEN` is set; send
  `Authorization: Bearer <METRICS_TOKEN>`. Ingest by status, events by type, duplicates, skipped
  sections/events, latency, plugin versions, pairing attempts, SSE connections and Discord verification
  failures.
- Logs are JSON on stdout (pino). They never contain tokens, request bodies or coordinates.

## 8. Decommissioning

The admin decommission switch makes ingest answer **410**, which disables the connection in every
plugin permanently (the player has to re-pair to use another hub). Use it only when shutting the
instance down for good.
