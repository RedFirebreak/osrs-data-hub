# Changelog

Changes are consolidated per pull request, newest first. Each entry names the PR (or branch while it is
open), what changed, and any decision (`D-n`, see [ARCHITECTURE.md](ARCHITECTURE.md#decision-log)) or
gotcha (`AREA-n`, see [gotchas](gotchas/README.md)) it introduced.

## Game state and loot leaderboard for the live map (branch `red/map-loot-leaderboard`)

Two more API v1 additions requested by [ha-osrs-map](https://github.com/RedFirebreak/ha-osrs-map)
(D-94). Additive only (D-71).

- **`game_state` on `/snapshot`:** each account whose `activity` the key reads carries `game_state`
  (`LOGGED_IN`, `LOGIN_SCREEN`, `HOPPING`, …, or null), the same value as `presence.game_state` on
  `/accounts/{id}`; omitted without `activity`, like `online` and `world`.
- **`GET /api/v1/leaderboards/loot?period=day|week|month&limit=`:** the period's most valuable `loot`
  and `pk_loot` events (with a value, not on a special world) over the accounts whose `events` the key
  reads, as `{ period, from, to, entries: [{ rank, event }] }`; `limit` 1–50, default 10; periods as
  the gains leaderboards. Each `event` is exactly the `/events` one (`eventReadableAccounts` and
  `toApiEvents` are now shared from `events.ts`), location redaction included. Zod schemas, wire
  mapper and OpenAPI operation `getLootLeaderboard`.
- **Tests:** `loot-leaderboard.test.ts` (ordering, period cutoff and time zone, limit, types, special
  worlds, access, redaction against `/events`); the route in `events.test.ts` and the plumbing
  preflight list; `game_state` in the snapshot read-model, route and wire tests.
- **Docs:** API.md (`/snapshot` activity fields, the new endpoint, known consumers); ARCHITECTURE §14
  and D-94.

## Cut release button (branch `red/cut-release-workflow`)

Releases stay manual, one per feature or fix rather than one per merge, but no longer need a version
typed by hand (D-87 extended).

- **`.github/workflows/cut-release.yml`:** `workflow_dispatch` on `main` with a `patch` / `minor` /
  `major` choice. Computes the next `v*` tag from the latest one, creates the annotated tag and a GitHub
  Release with generated notes (`--notes-start-tag` the previous release), then publishes both images by
  calling the Release workflow. Refuses another branch, an already tagged head, or a head with no
  successful CI run on `main`.
- **`.github/workflows/release.yml`:** gains `workflow_call` with a `tag` input; the image tags come from
  that tag (or the pushed ref, as before) through metadata-action's `value=`. Concurrency moved to the
  job so it works when called. Manual tags and the branch dry run behave as before.
- **Docs:** OPERATIONS §10 Releases (the button, by hand, which bump, dry run); D-87.

## Integration keys for the guild live map (branch `red/osrs-hub-integration-keys-9b5b99`)

API additions for [ha-osrs-map](https://github.com/RedFirebreak/ha-osrs-map), which mirrors the hub's
`/api/v1` server-side. v1 stays additive (D-71).

- **Service keys** (D-88): admins create and revoke integration keys on the new **Admin → Integrations**
  page (`/admin/integrations`, `/api/app/admin/service-keys`, audited `service_key.created` /
  `service_key.revoked`). Same `ohub_<prefix>_<secret>` format and `api_keys` table as user keys, told
  apart by `kind`; no `user_id`, so offboarding anyone (the creating admin included) never revokes one and
  it counts towards no user's limit. Per-key rate limit (`rate_limit_per_minute`, default 600; user keys
  keep 120; `/snapshot` stays at 1/s). `/me` reports `key.kind`, `key.rate_limit_per_minute` and
  `user: null`. Migration `0005_service_keys`.
- **The guild audience as a resolver principal** (D-89): `resolveAccess` and the shared loaders take
  `GUILD_AUDIENCE` besides a user; a service key sees exactly the accounts and categories shared with the
  guild, never `private` or `selected`, with no admin override (D-70). No parallel code path.
- **Owner identity** (D-90): `owner: { name, discord_id } | null` on `/snapshot`, `/accounts` and
  `/accounts/{id}` for every key, as the guild page shows the owner to every member (D-68); contributors
  never.
- **`account_hash`** (D-91): the plugin's salted `accountHash`, for service keys only. A member's key
  never sees it: the hash is ingest's identity, and knowing another account's hash would let a member
  report data for it and become a contributor.
- **Bulk history** (D-92): `/xp?accounts=` takes 50 accounts with a service key (10 with a user key), and
  the new `GET /locations?accounts=a,b&from=&to=` returns every account's trail in one call, with the
  same points and thinning as `/accounts/{id}/locations`.
- **Push for keys deferred** (D-93): a key-authenticated SSE stream (handoff §18.3) would need its own
  subscriber model in the live hub; polling meets the map's freshness need. Recorded, not built.
- **Lower layers:** `WindowLimiter.hit/peek/usage` take a per-call limit; `AccountRow` carries
  `accountHash`; the API's route groups gain `locations`.
- **Docs:** ARCHITECTURE §9, §12, §14, D-88 … D-93; API.md (service keys, owner identity, `/locations`,
  the limits table, the live map consumer); handoff §18.3 status.
## Document the Kubernetes target (branch `red/k8s-target-docs-b1c403`)

Docs only, for the deployment that pulls the GHCR images (D-87) from a cluster.

- **OPERATIONS §9 Kubernetes:** the facts the cluster manifests rely on, so a change to any of them is
  caught in review: image users, PID 1 and ports; `GET /api/health` as readiness and liveness probe;
  `dist/migrate.js` as a one-shot initContainer; the shared `timescale/timescaledb` tag and its tuning
  variables; `TRUST_PROXY_HOPS=2` behind Cloudflare → cloudflared → Traefik; in-cluster scraping under
  the `hub-web` / `hub-worker` job names; the dashboard JSON and `alerts.yml` loaded verbatim.
- **`TRUST_PROXY_HOPS`** (OPERATIONS §3, `.env.example`): count from the right, one hop per proxy that
  appends, with what too low and too high do.
- D-85 notes that the dashboard and alert files are a contract with the cluster as well.

## Publish images to GHCR (branch `red/ghcr-publishing-k8s-onboard-b1c403`)

The web and worker images are now published, so a deployment outside the VM (the operator's Kubernetes
cluster, whose manifests live in its own repository) can pull them by exact tag (D-87).

- **`.github/workflows/release.yml`:** on a `v*` tag (and `workflow_dispatch`, which only pushes when run
  from a tag) builds the Dockerfile's `web` and `worker` targets for `linux/amd64` and pushes
  `ghcr.io/redfirebreak/osrs-data-hub-web` and `-worker` tagged `<x.y.z>` and `<x.y>`; no `latest`.
  OCI labels link the packages back to this repository; the layer cache is the Actions cache, one
  scope per target; the actions are pinned by commit SHA because the workflow has `packages: write`.
  One-time step after the first publish: make both GHCR packages public.
- **`renovate.json`:** `config:recommended` plus GitHub Action digest pinning. The three
  `timescale/timescaledb` references (`compose.yaml`, `compose.dev.yaml`, `ci.yml`) are one group, so
  they cannot drift; Node major bumps in the Dockerfile are off (TOOL-6). No automerge.
- The Compose path, the Dockerfile targets, users, ports, entrypoints and `/api/health` are unchanged.

## Inventory slots from plugin 1.5.1 (branch `red/tender-curie-n2va8s`)

HA Exporter 1.5.1 (`@9835dbe`) sends `inventorySlot` (0..27) on each inventory item, so the account
page's inventory now looks as it does in game, gaps included (D-86).

- **Parser** (`@hub/core`): `ItemData.inventorySlot`, a non-negative int32; an invalid one drops the
  inventory section like any other invalid item field. It was already kept in `latest_state` (loose
  objects), so inventories from 1.5.1 plugins place correctly as soon as this ships; no migration.
- **Grid:** `inventorySlots` puts each item at its slot; items without one (1.5 plugins), outside
  0..27 or on a slot already taken fill the first free slots in the order sent. `MIN_PLUGIN_VERSION`
  stays `1.5`.
- **API and Download my data:** items carry `inventory_slot` (`null` on equipment and from older
  plugins); documented in API.md with an example.
- **Docs:** ARCHITECTURE §3 (the v1.5.1 protocol change), §12, D-86; PLUGIN-11 now says where the slot
  is and isn't sent.

## M4 metrics dashboards (branch `red/m4-metrics-dashboards-db30d3`)

Handoff §16's metrics, complete, with a Grafana dashboard and alert rules as code (D-84, D-85).

- **Gap analysis.** Of §16, job durations were missing (only logged), and the Discord verification
  failures were counted in the worker, which nothing scraped, so `/metrics` always showed 0. Added since
  the handoff and now counted: the public API, Download and Delete my data, live streams refused by the
  per-user limit (D-80), the grace expiry and the orphan purge, and the verification circuit breaker.
- **New metrics** (`packages/server/src/metrics.ts`, table in ARCHITECTURE §13): `hub_job_*`
  (duration, runs by result, last success, per `job_name`), `hub_discord_verify_checks_total{verdict}`,
  `hub_discord_verify_breaker_trips_total{rule}`, `hub_offboarded_users_total{reason}`,
  `hub_grace_expired_users_total`, `hub_accounts_deleted_total{cause}`, `hub_data_exports_total{result}`,
  `hub_live_streams_refused_total`, `hub_play_sessions_open`, `hub_play_sessions_timed_out_total`, and
  `hub_api_requests_total{group,status}`, `hub_api_request_duration_seconds{group}`,
  `hub_api_rate_limited_total{limit}`, `hub_api_auth_failures_total{reason}`. Every label is a fixed set
  (D-53); known label combinations start at 0, so the first event after a restart shows in `increase()`
  (PROM-1).
- **Worker `/metrics`** (D-84): `WORKER_METRICS_PORT` (default 9464, 0 = off), the web route's rules
  (404 without `METRICS_TOKEN`, 401 without the bearer token) through a shared `metricsAccess`. Compose
  publishes it on `WORKER_METRICS_BIND` (default `127.0.0.1`).
- **Dashboards and alerts** (D-85): `ops/grafana/dashboards/hub-overview.json` (datasource and job
  variables, no hardcoded uid, named colours for both themes), `ops/prometheus/alerts.yml` (ingest 5xx
  ratio, no payloads while players are online, breaker tripped, job failing or stale), and
  `ops/prometheus/scrape-example.yml` for an existing Prometheus.
- **Local stack:** `compose.monitoring.yaml` runs Prometheus and Grafana (provisioned from `ops/`) that
  scrape `pnpm dev` and `pnpm dev:worker` on the host; `.claude/launch.json` can start the worker too.
- **Docs:** OPERATIONS §3 (keep `/metrics` to the Prometheus server in Caddy and nginx) and §7 (pointing
  Prometheus at the hub, importing the dashboard), DEVELOPMENT "Monitoring stack", ARCHITECTURE §2, §11,
  §13, §14.
- **Fixed:** cancelling Download my data halfway logged `export: failed while streaming`: the pull still
  running when the client cancelled threw at `enqueue` (NEXT-16). It is now counted as cancelled, not
  logged as an error.
- `checkApiRate` now says which limit refused a request (`limit: 'key' | 'snapshot'`).
## Unreleased — branch `sj/ingest-rejections-chart`

- **Rejected payloads on the ingest chart** (D-83): Admin → Ingest health's "Payloads per minute"
  chart gets a third series, *Rejected, not archived*: responses whose body never reached
  `raw_payloads` (unknown or revoked tokens 401, decommissioned 410, oversized 413, rate-limited 429,
  outdated plugin, a failed archive write). Before, two 401s showed under "Since the hub started" but
  nowhere on the chart, whose "Other statuses" only ever counts archived payloads. Ingest counts them
  per minute and status in memory (`RecentMinuteCounts`, the last 60 minutes, on the metrics object);
  like the Prometheus counters they start at zero when the web process restarts. The chart's third
  colour is slot 3 of the palette (aqua), validated with the other two in both modes.

## Unreleased — V1 (branch `red/eloquent-johnson-yufg78`)

Milestones M0 and M1 and the M2 scope of the handoff, plus two M4 items (leaderboards, the decommission
switch). Status per milestone: [ARCHITECTURE.md §14](ARCHITECTURE.md#14-milestones-and-status).

### Follow-ups before the PR

- The guild page lists an account under its owner only, unless the viewer may read its contributor
  list (owner, contributors, admins), matching the sharing settings (D-68).
- The Plugin Hub serves HA Exporter 1.5: side-load notes removed from the docs.
- Fixed: on Node 24, which the Docker image runs, every `/api/auth/*` request answered 500, so nobody could
  sign in. The auth route copied Next's Proxy-wrapped request with `new Request(request, …)`, which
  Node 24 can't do (NEXT-13); it now copies the request from its parts. The CI E2E job caught this after
  local runs on Node 22 had passed. A regression test hands the route a Proxy-wrapped request.
- A `readBodyCapped` test no longer depends on how far Node's streams read ahead (Node 24 reads
  one chunk more than Node 22).
- Local dev reads the root `.env`: `pnpm dev`, `pnpm dev:worker` and `pnpm db:migrate` preload
  `tools/dev-env.mjs`, which loads `.env` and, on top, an optional gitignored `.env.dev` for dev-only
  overrides (the database on `127.0.0.1` while `.env` keeps `db` for the full stack). Before, Next read
  only `apps/web/.env*` and tsx read nothing, so `pnpm db:migrate` stopped with `DATABASE_URL is not set`
  on the documented setup. Not `--env-file`, which crashes `next dev` (NEXT-15). `.claude/launch.json`
  starts the web app for Claude's browser preview; DEVELOPMENT.md covers `.env.dev` and a no-admin
  `corepack enable` on Windows.
- LF line endings in every checkout: a root `.gitattributes` (`* text=auto eol=lf`) overrides the
  `core.autocrlf=true` that Git for Windows sets system-wide. Before, a Windows clone checked everything out
  as CRLF and `pnpm format:check` flagged 548 files (TOOL-9). The raw OkHttp captures in
  `packages/fixtures/http` stay CRLF (`-text`, and a matching `.editorconfig` section) because tests split
  them on `"\r\n\r\n"`. The index was already LF, so the renormalize changed no file. An existing Windows
  checkout keeps its CRLF files until they are checked out again (TOOL-9 has the command).

### Guild feed filter and the live location default

- **Guild feed filter** (D-81): Admin → Settings (a new tab) sets a minimum loot value for the guild
  page's activity feed and whether it shows virtual levels (level-ups past 99; off by default, combat
  level always shown). Stored in `hub_settings` under `guild_feed` and audited. Applied to the feed's
  pages in SQL and to its live events in the browser, through one rule (`inGuildFeed` in `@hub/core`).
  Account timelines, the dashboard, toasts and the API are unchanged.
- **Live location is shared with the guild by default** (D-82, supersedes D-22 for `location_live`);
  location history stays private. Migration `0004_location_live_keep_private` pins every existing
  account to `private`, so nothing that was private becomes visible. Death and superior coordinates
  follow live location, so guild members now see them by default for new accounts.

### M4 (part) — data rights, and fixes from review

- **Delete my data** (Settings, D-78): the offboarding pipeline with reason `self_delete` and a fixed
  7-day grace. Devices, API keys and sessions are revoked at once; owned accounts pass to the
  longest-linked active contributor or are hidden; the grace expiry hard-deletes after 7 days.
  Signing in again within them is the undo. Confirmed by typing `delete`
  (`POST /api/app/me/delete`); the login page then says when the data goes.
- **Download my data** (Settings, D-79): `GET /api/app/export` streams one JSON document (snake_case,
  `format`/`version`) with the profile, settings, devices, API keys, sign-in sessions, sharing, audit
  entries (other people's ids replaced by `[redacted]`) and every account the user owns or plays on,
  limited to the categories they can see today, with keyset-paginated histories. One export per user
  per 10 minutes, same-origin, audited `user.exported`. The privacy page describes both, and the IP
  addresses the hub stores.
- Review limits (D-80): at most 5 live streams per user (429 + `Retry-After`, the browser polls
  meanwhile); `/api/app/members` only for users who can manage sharing (403 otherwise); the
  raw-payload viewer's audited GET requires the same origin.
- Focus no longer falls to `<body>` after revoking a device or an API key, creating a key, sharing
  changes, admin actions or the decommission switch (`lib/focus.ts`).
- The pairing wizard resumes its code after a reload (`?code=<id>`) instead of starting over.
- Unknown or invisible account pages answer a real 404 instead of 200 (NEXT-14).
- D-35's wording now says what the code does: signing in restores every offboarding except an
  admin's.

### M3 — public API

- Decisions D-69 … D-77: key format and storage, access per request (creator ∩ categories ∩
  scope, 404 outside it, no admin override), `/api/v1` conventions and CORS, rate limits, the cursor
  feed, the snapshot, OpenAPI from zod, the API keys page, snake_case JSON keys.
- Server half (`packages/server/src/api/`): API keys (created shown once as `ohub_<prefix>_<secret>`,
  only `sha256(secret)` stored, constant-time check, at most 10 active, `last_used_at` at most once a
  minute, audited); key access on the shared loaders (`AccessRestriction`); a read model for every
  endpoint of handoff §13; the `/events` cursor feed over the settled prefix (10 s, D-73) with
  location redaction; `/snapshot` with a content ETag and `since`; per-key, snapshot and failed-auth
  rate limits (`WindowLimiter.usage` added to core). 136 tests.
- Web half (`apps/web`): every `/api/v1` endpoint of handoff §13, `/api/v1/openapi.json` and a JSON 404
  for unknown v1 paths, all behind one wrapper (`withApiKey`): bearer keys only, the failed-auth limit
  per IP answered before any database access, one 401 for every refused key, per-key and 1/s snapshot
  limits with `X-RateLimit-*`, CORS on every response and OPTIONS → 204. snake_case JSON through typed
  mappers (D-77); `/snapshot` with a weak ETag, `If-None-Match` → 304 and `since`; `/events` with
  `meta.next_cursor`. OpenAPI 3.1 generated per request from the routes' zod schemas (D-75), which the
  route tests also parse every response with. `/docs/api`: Scalar 1.72.2 from jsDelivr with SRI.
- The API keys page (`/api-keys`) and `/api/app/api-keys` routes: create (shown once), list, revoke
  (D-76), and an "API keys" item in the navigation. The header now switches to the full navigation at
  1024 px instead of 768 px: at tablet widths six items wrapped and cut off the hub's name.
- `errorResponse` maps the server's `ApiError` and `ApiKeyError`. 105 web tests; the web suite passes on
  Node 22 and 24, and the standalone build was checked on Node 24 (NEXT-13). The screenshot run covers
  the API keys page, its dialog, the header at 820 and 1024 px, and `/docs/api`.
- `docs/API.md`: the consumer guide (authentication, conventions, rate limits, CORS, every endpoint with
  an example, the events cursor, the known consumers).

### Process and docs

- Archived the design handoff (draft 2) at `docs/design/HANDOFF-draft2.md` and recorded its settled
  decisions as D-1 … D-25; decisions taken while building are D-26 … D-67.
- The gotcha registry (`docs/gotchas/`, `tools/check_gotchas.py`, the `gotcha` skill and the hook that
  validates it after markdown edits): 79 traps across the plugin protocol, Next.js, Better Auth and
  Discord, Postgres/Drizzle/TimescaleDB, pg-boss, zod and the toolchain.
- `docs/DEVELOPMENT.md` (first run, commands, tests and the database, e2e and screenshots, CI),
  `docs/OPERATIONS.md`, `docs/VERIFIED.md`, the project README and `packages/server/README.md`.

### M0 — scaffold

- pnpm workspace (`apps/web`, `apps/worker`, `packages/core|db|server|fixtures`), TypeScript 6.0.3,
  ESLint 10 flat config, Vitest projects, Prettier (D-41, TOOL-1, TOOL-3, TOOL-7).
- Compose on `timescale/timescaledb:2.30.1-pg18` with `web`, `worker`, a one-shot `migrate` and an
  optional `backup` service (D-5, D-27); one Dockerfile with `web` and `worker` targets on
  `node:24-alpine` (TOOL-4, TOOL-6, NEXT-9).
- `packages/db`: the Drizzle schema (handoff §8), the init migration, a custom TimescaleDB migration
  (hypertables, columnstore, `xp_hourly`/`xp_daily` continuous aggregates, skill seed, CHECKs) and later
  indexes (per-account feed; device foreign keys, `0003_device_fk_indexes`). Policies are reconciled
  from env by the worker, not created in migrations (D-7, D-8, D-40, TSDB-3). Test runs get their own
  migrated template database, cloned per test file (TSDB-4).
- `packages/fixtures`: 28 wire-exact v1.5 payloads built from the plugin source (`0ec2a36`).
- CI on every pull request: gotcha registry, Prettier, `tsc`, ESLint, migrations in sync, Vitest
  against a TimescaleDB service, `next build` and the worker bundle, both Docker images, and the wizard
  end to end.

### Pure logic — `@hub/core`

- Lenient section-by-section payload parsing with NUL and lone-surrogate sanitizing and skill limits
  (D-10, D-31, ZOD-1, DB-1, PLUGIN-7, PLUGIN-9); the version gate (D-1); timestamps and per-device
  staleness (D-17, D-18, D-33); event normalization (D-16, D-44); presence timing (D-28); snapshot
  planning with special worlds and the XP guard (D-24, D-45, D-47); the permission resolver and
  redaction (D-22); the toast filter; rate limiters; crypto helpers; config (APP_URL an origin, D-26).
  Declared `"sideEffects": false` (D-67, NEXT-12).

### M1 — ingest and onboarding

- Ingest (`POST /api/osrs-data/events`, `packages/server/src/ingest/`): the status semantics of handoff
  §7.7 (D-19, D-29, D-30, PLUGIN-3, PLUGIN-5), streaming body cap, per-device token bucket (D-57), raw
  archive, account resolution under a per-account advisory lock, owner/contributor links (D-21, D-48),
  derived writes and `latest_state`, in-process retries and the chunk-creation lock (D-49, D-58,
  TSDB-12), the user and device re-checks under row locks (D-55), `pg_notify` inside the transaction
  (D-32), and the D-60 takeover of an account hidden because its owner is in grace.
- Pairing (`POST /api/osrs-data/pair`): 5-digit codes, version gate, limits and lockout (D-54, D-59),
  decommission answered first (D-56); GET on either plugin endpoint answers 400 with the "enter the exact
  URL" text, never a redirect (D-38, PLUGIN-2).
- Sign-in: Better Auth with Discord, the guild and role gate before any row is written, Discord tokens
  stripped, unused endpoints off (D-9, D-35, D-39, AUTH-1 … AUTH-10, DISCORD-1).
- The live stream and its polling fallback (`/api/live/stream`, `/api/live/events`), one LISTEN
  connection and hub per process (D-37, NEXT-3, DB-4); `/api/health`; token-protected `/metrics` with
  bounded labels (D-14, D-53).
- Web shell: login with a message per refusal, the signed-in layout (navigation, user menu,
  live-connection indicator), the dashboard ("Online now", account cards, an empty state pointing at
  the wizard), Settings (toast filter, time zone; `PATCH /api/app/settings`, D-36), the public privacy
  page, and the browser's live client with toasts (ARCHITECTURE §10). Real headings throughout; the
  minimum loot value refuses a decimal comma ("1,5m") instead of reading it as 15M.
- The pairing wizard (handoff §6.3) and the Devices page: codes via `POST /api/app/pairing-codes`,
  progress from live `pairing` and `device` messages with a poll of every code the plugin may still
  use, the "too old (version …)" alert, rename and revoke (`/api/app/devices/[id]`). A pairing code's
  status no longer reveals an account the user can't see anymore (D-22).

### M2 — history, sharing, guild, jobs, admin

- Account page `/accounts/[publicId]`: skills with gains, XP chart, sessions and playtime, events
  timeline, vitals, live location as text, gear and its change log, inventory, wealth, and the sharing
  panel (audiences, grants, block/unblock/remove, transfer, claim; D-22, D-52). Every section is hidden,
  "Not shared" or shown (D-4); day-only stamps for viewers without `activity` (D-50); an id that can't
  be one is a plain 404 (DB-1). Read models with XP lookups from raw samples first (D-51, TSDB-7,
  TSDB-13). Routes: `GET /api/app/accounts/[publicId]/{xp,sessions,equipment,wealth,locations}`,
  `GET|PATCH …/sharing`, `GET /api/app/feed`, `GET /api/app/members`.
- Guild page `/guild`: members with visible accounts and live online dots, the activity feed, gains
  leaderboards per period and skill.
- Worker (`apps/worker`): close stale sessions every minute, Discord re-verification every 15 minutes
  over users due (D-43) with two circuit breakers (D-62, supersedes D-34's), grace expiry then the
  time-gated purge of orphaned accounts hourly (D-25, D-61, TSDB-2), audit-log pruning daily, Timescale
  policies at startup; `stately` queues re-created when their policy changed (D-63, PGBOSS-1,
  PGBOSS-2); job failures logged and stored without bound parameters (DB-3). Offboarding and restore
  (D-35, D-60).
- Admin (`/admin/*`, handoff §12): users (offboard, restore), devices (revoke), ingest health (rates,
  401s and 429s since start), raw payloads with an audited viewer, audit log, configuration (secrets
  redacted), and the decommission switch (410, D-56). Routes under `/api/app/admin/*`.

### Web platform hardening (review passes)

- Pages never renew sessions; route handlers do, so active users are no longer signed out 7 days after
  signing in (D-64, AUTH-12). A database outage shows the error page instead of `/login`, and signed-in
  API routes answer it 503 + `Retry-After` instead of 500 (D-64, AUTH-13). Better Auth's own log lines
  go through pino without error objects, so a failed session lookup no longer prints the session token
  (AUTH-13). `/api/auth/list-sessions` is off (D-39). Tests run Better Auth's Origin check (D-66,
  AUTH-11).
- Open redirects in the sign-out callback path closed (tab/newline and encoded slashes); sign-in and
  sign-out failures surface as toasts; misdirected plugin GETs are logged only for paired devices.
- Live: a replay cut off at 200 events ends with `resync`; cursor 0 is a cursor, so a polling client on
  a new hub gets the hub's first events (D-65).
- Accessibility and layout: headings, landmarks, live-region noise, focus rings, contrast, phone widths
  (code boxes at 320 px, tables), WCAG 2.5.3 names; dark mode (it never switched on), toasts below the
  header, chart legends and short XP histories; a 404 inside the signed-in layout keeps the header.
- Playwright end-to-end test of the wizard (`pnpm test:e2e`, CI job "E2E (wizard)", D-13): a
  non-member is refused, a member pairs (1.4 refused, 1.5 accepted), sees first data and the account
  card, gets a toast; revoking a device locks the plugin out. The wizard takes about 1.5 s against the
  2-minute goal (handoff §2). Recorded TOOL-8. `E2E_SCREENSHOTS=1` screenshots every page at two sizes
  in light and dark for visual review.

### Integration

- `next build` works again: `packages/db/src/migrate.ts` derives its folder from `import.meta.url`
  (NEXT-11).
- The payload fixtures are back to their wire-exact single lines: a repo-wide `prettier --write` had
  pretty-printed them and three core tests failed; `packages/fixtures/payloads/**` is now in
  `.prettierignore` (TOOL-7).
- `@hub/core` is `"sideEffects": false`: the browser no longer downloads an 839 KB chunk with
  crypto-browserify and zod (D-67, NEXT-12). `HUB_NAME` is cut by code point and trimmed after the
  cut, so the decommission confirmation can always be typed.
- Web routes and the sign-in hook reach the database only through `@hub/server` (`settledLiveCursor`,
  `pingDatabase`, `authenticateDevice`, `recordSignIn`).
- The worker says at startup when re-verification is off (no `DISCORD_BOT_TOKEN`/`DISCORD_GUILD_ID`),
  and its log lines carry `service: "worker"` once instead of twice.
- Both Docker images were built and run as the compose stack runs them (migrate one-shot, web,
  worker): the web image's `HEALTHCHECK` now probes `${PORT:-3000}` instead of a hard-coded 3000, which
  reported a healthy server as unhealthy whenever `PORT` was overridden.
