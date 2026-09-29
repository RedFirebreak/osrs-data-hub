# Changelog

Changes are consolidated per pull request, newest first. Each entry names the PR (or branch while it is
open), what changed, and any decision (`D-n`, see [ARCHITECTURE.md](ARCHITECTURE.md#decision-log)) or
gotcha (`AREA-n`, see [gotchas](gotchas/README.md)) it introduced.

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

### M3 — public API (in progress)

- Decisions D-69 … D-77: key format and storage, access per request (creator ∩ categories ∩
  scope, 404 outside it, no admin override), `/api/v1` conventions and CORS, rate limits, the cursor
  feed, the snapshot, OpenAPI from zod, the API keys page, snake_case JSON keys.
- Server half (`packages/server/src/api/`): API keys (created shown once as `ohub_<prefix>_<secret>`,
  only `sha256(secret)` stored, constant-time check, at most 10 active, `last_used_at` at most once a
  minute, audited); key access on the shared loaders (`AccessRestriction`); a read model for every
  endpoint of handoff §13; the `/events` cursor feed over the settled prefix (10 s, D-73) with
  location redaction; `/snapshot` with a content ETag and `since`; per-key, snapshot and failed-auth
  rate limits (`WindowLimiter.usage` added to core). 136 tests.

### Process and docs

- Archived the design handoff (draft 2) at `docs/design/HANDOFF-draft2.md` and recorded its settled
  decisions as D-1 … D-25; decisions taken while building are D-26 … D-67.
- The gotcha registry (`docs/gotchas/`, `tools/check_gotchas.py`, the `gotcha` skill and the hook that
  validates it after markdown edits): 78 traps across the plugin protocol, Next.js, Better Auth and
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
