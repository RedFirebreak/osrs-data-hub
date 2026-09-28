# Gotchas

67 traps, grouped into five files, found while building osrs-data-hub. Each is written up
once under a stable ID and referenced by ID from everywhere else, so there is exactly one place to edit
when something changes. Package-agnostic: things that are true of the shared layer (the HA Exporter
plugin protocol, Next.js, Better Auth, Drizzle, Postgres/TimescaleDB, pg-boss, the Discord API, and the
pnpm/TypeScript/CI toolchain) and will bite the next app or package as well as the one that found them.

**Where a fact goes.** This is the one statement of the routing rule; skills and CLAUDE.md cite it.

| The behaviour is… | Goes in |
|---|---|
| True of the shared layer (plugin protocol, framework, library, database, Discord API, toolchain), and will bite the next app or package | a numbered entry here |
| True of one app or package only (`apps/web`, `apps/worker`, `packages/*`) | that package's `README.md` § "Expect these" |
| Read in the docs but never seen live | [open-questions.md](open-questions.md), no ID, not indexed |
| Something that simply works, confirmed live | [`docs/VERIFIED.md`](../VERIFIED.md), dated |

**How to use the index.** Match the symptom in the table at the bottom, then open the one file that entry
points to. The symptom column is deliberately specific enough to rule an entry out without opening anything.
Do not read this directory wholesale: the index is the discovery mechanism, and loading every area file
defeats the point of them being separate.

| File | Covers | Entries |
|---|---|---|
| [auth.md](auth.md) | `AUTH`, `DISCORD` — Better Auth 1.7 (Discord provider, Drizzle adapter, hooks, sessions, endpoints) and the Discord HTTP API (OAuth, guild member lookups) | 11 |
| [database.md](database.md) | `DB`, `TSDB` — Postgres behaviour, drizzle-orm 0.45 and drizzle-kit 0.31 (queries, errors, the migrator), and TimescaleDB 2.30 (hypertables, compression, continuous aggregates, policies, the Docker image) | 24 |
| [nextjs.md](nextjs.md) | `NEXT` — Next.js 16 (route handlers, server actions, RSC, proxy.ts, instrumentation, basePath, standalone output, the dev and build CLI) | 10 |
| [plugin.md](plugin.md) | `PLUGIN` — the HA Exporter v1.5 wire protocol as seen from the hub (payload shapes, Gson serialization, the OkHttp transport, status handling, the retry queue, the pairing panel) | 13 |
| [toolchain.md](toolchain.md) | `PGBOSS`, `TOOL`, `ZOD` — build, lint and package tooling (TypeScript, ESLint, pnpm, tsup, shadcn, Docker base images) and the pg-boss and zod libraries | 9 |
| [open-questions.md](open-questions.md) | read from docs, not yet observed — no IDs, not in the index | — |

**Source key.** Every entry ends with the source it was settled from:
`` `DOCS` `` = official documentation, `` `SOURCE` `` = read off the source code or shipped binary,
`` `OBSERVED` `` = seen live, which says where and on what date. An entry without `` `OBSERVED` `` is read
from docs and not yet confirmed in practice.

**Adding one.** IDs are permanent: a new entry takes the next free number in its prefix, and nothing is
ever renumbered. Put it in the area file in ID order, add its row to that file's table and one row to the
index below under its file's group, with the symptom text identical in both, and correct the count in the
first sentence of this file and in the file table. Then `python tools/check_gotchas.py` must print `OK`.
The `gotcha` skill walks this, including a trap that fits no existing file.

## Index

| ID | Area | Symptom |
|---|---|---|
| **[auth.md](auth.md)** | | |
| [AUTH-1](auth.md#auth-1) | Better Auth | Every auth request (sign-in, callback, `get-session`) fails with 500 and `SchemaMismatchError` (`SCHEMA_MISMATCH`). |
| [AUTH-2](auth.md#auth-2) | Better Auth | Expiry checks in raw SQL (`expires_at > now()`) are off by the server's UTC offset, or sign-in throws because two `account` rows match one Discord id. |
| [AUTH-3](auth.md#auth-3) | Better Auth | Discord sign-in comes back with `?error=email_not_found`, or Discord's consent screen asks for the user's email although only `identify guilds.members.read` is configured. |
| [AUTH-4](auth.md#auth-4) | Better Auth | The `account` table holds users' Discord access and refresh tokens in plaintext, and `POST /api/auth/get-access-token` hands them to the browser. |
| [AUTH-5](auth.md#auth-5) | Better Auth | Fields returned from `mapProfileToUser` or `getUserInfo` (`discordId`, `roles`, …) end up null, or OAuth sign-up fails with `?error=MISSING_FIELD&error_description=<field>+is+required`. |
| [AUTH-6](auth.md#auth-6) | Better Auth | A user rejected at sign-in (not in the guild) still leaves `users` and `account` rows behind, with a fresh token written. |
| [AUTH-7](auth.md#auth-7) | Better Auth | After a sign-up that failed halfway, a `users` row exists without its `account` row. |
| [AUTH-8](auth.md#auth-8) | Better Auth | A session deleted from the database (sign-out everywhere, offboarding) keeps working in the browser for up to 5 minutes. |
| [AUTH-9](auth.md#auth-9) | Better Auth | Behind the reverse proxy, Better Auth rate-limits all users together: one busy client gets everyone 429s. |
| [AUTH-10](auth.md#auth-10) | Better Auth | A signed-in user renames themselves with `POST /api/auth/update-user`, overriding the name that comes from Discord. |
| [DISCORD-1](auth.md#discord-1) | Discord | Re-verification marks every member, or a large share of them, as having left the guild in a single run. |
| **[database.md](database.md)** | | |
| [DB-1](database.md#db-1) | Database | An insert fails with `22P02 invalid input syntax for type json` or `unsupported Unicode escape sequence` (`\u0000 cannot be converted to text`). |
| [DB-2](database.md#db-2) | Database | A resent event is stored twice although the insert uses `ON CONFLICT … DO NOTHING` on a unique key. |
| [DB-3](database.md#db-3) | Database | A caught database error has `err.code === undefined`, and its logged message contains tokens, coordinates or other bound parameters. |
| [DB-4](database.md#db-4) | Database | A cursor feed (`?after=<seq>`, SSE `Last-Event-ID`) permanently misses some rows that are in the table. |
| [DB-5](database.md#db-5) | Database | Connections fail with `sorry, too many clients already` (53300) once web, worker and pg-boss are all running. |
| [DB-6](database.md#db-6) | Database | `drizzle-kit push` drops indexes nobody declared without asking, or drops and re-adds a `*_pk` on every run although the schema didn't change. |
| [DB-7](database.md#db-7) | Database | `migrate()` fails with 25001 `CREATE MATERIALIZED VIEW ... WITH DATA cannot run inside a transaction block` or `refresh_continuous_aggregate() cannot run inside a transaction block`, and no pending migration is applied. |
| [DB-8](database.md#db-8) | Database | `migrate()` reports success, but a migration merged from another branch never ran (its tables or columns are missing). |
| [DB-9](database.md#db-9) | Database | The first payloads from a brand-new account fail with 23505 `duplicate key value violates unique constraint`, or `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns no row. |
| [DB-10](database.md#db-10) | Database | A policy is replaced on every start, or an interval check fails, when one side says `'1 year'` and the other `'365 days'`. |
| [DB-11](database.md#db-11) | Database | `SET LOCAL lock_timeout = $1` fails with `42601 syntax error at or near "$1"`. |
| [DB-12](database.md#db-12) | Database | The bundled migrate entrypoint fails with `Can't find meta/_journal.json file`. |
| [DB-13](database.md#db-13) | Database | `pg_notify` fails with `22023 payload string too long` and takes the transaction it was called in down with it. |
| [TSDB-1](database.md#tsdb-1) | Timescale | Hourly or daily XP history older than the raw retention disappears from `xp_hourly`/`xp_daily` after a refresh. |
| [TSDB-2](database.md#tsdb-2) | Timescale | After deleting an account, its rows are still in `xp_hourly`/`xp_daily`, and `DELETE FROM xp_hourly` fails with `55000 cannot delete from view`. |
| [TSDB-3](database.md#tsdb-3) | Timescale | A changed retention or compression setting has no effect after restart; the log only shows `WARNING: … A policy already exists with different arguments`. |
| [TSDB-4](database.md#tsdb-4) | Timescale | `CREATE DATABASE x TEMPLATE tpl` fails after about 5 s with `55006 source database "tpl" is being accessed by other users`, intermittently. |
| [TSDB-5](database.md#tsdb-5) | Timescale | Raw payloads configured to live 72 hours are still there after three days, up to about four. |
| [TSDB-6](database.md#tsdb-6) | Timescale | The database container exits (1) at start with `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"…`. |
| [TSDB-7](database.md#tsdb-7) | Timescale | A new continuous aggregate returns 0 rows, or a recent hour in `xp_hourly` shows an older value than `xp_samples` holds. |
| [TSDB-8](database.md#tsdb-8) | Timescale | A unique-violation error names a constraint like `1_location_samples_account_ts_uq` on a table like `_hyper_2_1_chunk`, not the one you declared. |
| [TSDB-9](database.md#tsdb-9) | Timescale | Compression, `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` or `add_retention_policy` fail with `functionality not supported under the current "apache" license`. |
| [TSDB-10](database.md#tsdb-10) | Timescale | Timescale jobs (retention, compression, refresh) silently stop running in some databases, and the server log says `TimescaleDB background worker limit of 16 exceeded`. |
| [TSDB-11](database.md#tsdb-11) | Timescale | A drizzle-kit-generated migration fails on a hypertable with `operation not supported on hypertables with compressed chunks` or `cannot add column with NOT NULL constraint without default to a hypertable that has columnstore enabled`. |
| **[nextjs.md](nextjs.md)** | | |
| [NEXT-1](nextjs.md#next-1) | Next.js | Changing `basePath` or an `APP_URL` path prefix at runtime has no effect: the app still answers on the prefix it was built with and 404s on the new one. |
| [NEXT-2](nextjs.md#next-2) | Next.js | Redirects and absolute URLs built in a route handler point at `http://0.0.0.0:3000/…` or `localhost` instead of the public host. |
| [NEXT-3](nextjs.md#next-3) | Next.js | A module-level singleton exists twice: state set in a route handler reads empty in a page or server action (or in instrumentation), or two DB pools appear. |
| [NEXT-4](nextjs.md#next-4) | Next.js | A large request body arrives cut off at 10 MB and the handler returns 200 on the partial data; the log says `Request body exceeded 10MB for /… Only the first 10MB will be available`. |
| [NEXT-5](nextjs.md#next-5) | Next.js | Every Server Action (creating a pairing code, for one) fails with 500 `Invalid Server Actions request` behind the reverse proxy; the log says `x-forwarded-host` does not match `origin`. |
| [NEXT-6](nextjs.md#next-6) | Next.js | `AGENTS.md` and `CLAUDE.md` appear in the app directory after `next dev`, and the log says `Generated AGENTS.md and CLAUDE.md for AI agents`. |
| [NEXT-7](nextjs.md#next-7) | Next.js | A CI step running `next lint` passes even on code with lint errors, printing `Invalid project directory provided … /lint`. |
| [NEXT-8](nextjs.md#next-8) | Next.js | `tsc` on a fresh checkout fails with `Cannot find name 'PageProps'` or `Cannot find name 'RouteContext'`. |
| [NEXT-9](nextjs.md#next-9) | Next.js | The web container serves requests through its published port, but a localhost healthcheck inside it (`wget http://127.0.0.1:3000`) is refused. |
| [NEXT-10](nextjs.md#next-10) | Next.js | `next build` fails with `Module not found: Can't resolve './hash.js'` for an import inside a TS-source workspace package, while tsc, tsx and vitest accept it. |
| **[plugin.md](plugin.md)** | | |
| [PLUGIN-1](plugin.md#plugin-1) | Plugin | Ingest answers 400 to payloads sent at client start and right after login, or a player shows offline for a moment during loading screens and world hops. |
| [PLUGIN-2](plugin.md#plugin-2) | Plugin | A player's data silently stops arriving (no error on either side) and the access log shows a 3xx on `/api/osrs-data/*`, or a body-less `GET /api/osrs-data/events` carrying `X-Osrs-Token`. |
| [PLUGIN-3](plugin.md#plugin-3) | Plugin | After the hub answers one payload with a 5xx, that player's events from the next ~5.5 minutes never arrive and no snapshots arrive for ~15 minutes, while other players are fine. |
| [PLUGIN-4](plugin.md#plugin-4) | Plugin | The plugin pauses and later resends payloads the hub had already committed; the original requests took 10 s or longer. |
| [PLUGIN-5](plugin.md#plugin-5) | Plugin | The plugin ignores the hub's `Retry-After` and waits 30 s, 60 s, 120 s… instead. |
| [PLUGIN-6](plugin.md#plugin-6) | Plugin | Pairing rejects a code the player typed as five digits, or a code handled as a number loses its leading zero (`04817` → `4817`). |
| [PLUGIN-7](plugin.md#plugin-7) | Plugin | Searching stored raw payloads for `Kree'arra`, `d'hide` or `search=` finds nothing, and the raw bodies contain `\u0027`, `\u003d` or `\u0000`. |
| [PLUGIN-8](plugin.md#plugin-8) | Plugin | A normal-world account suddenly shows league (or other special-world) stats and inventory, with `SEASONAL` in its world types, although special-world sending is off. |
| [PLUGIN-9](plugin.md#plugin-9) | Plugin | Total level is higher than the game shows (2459 against the in-game 2372 in the fixtures), sometimes above 24 × 99. |
| [PLUGIN-10](plugin.md#plugin-10) | Plugin | Every payload from one player arrives twice, from two of their devices, with identical `eventId`s. |
| [PLUGIN-11](plugin.md#plugin-11) | Plugin | Carried wealth or item counts are off: five sharks arrive as five entries of `quantity: 1`, and inventory, kept and lost items don't add up the same way. |
| [PLUGIN-12](plugin.md#plugin-12) | Plugin | Deaths and superior spawns inside raids and other instances have coordinates nowhere near the player's live location in the same instance. |
| [PLUGIN-13](plugin.md#plugin-13) | Plugin | In the plugin's pairing panel, Submit does nothing: no dialog, no request reaches the hub, and the button stays disabled. |
| **[toolchain.md](toolchain.md)** | | |
| [PGBOSS-1](toolchain.md#pgboss-1) | pg-boss | pg-boss throws `Queue <name> does not exist` (or `not found`) on send or schedule, a worker never runs while `error` events repeat every poll, or a handler finds `job.data` undefined. |
| [TOOL-1](toolchain.md#tool-1) | Toolchain | After `pnpm add -D typescript`, typescript-eslint or Next's type check breaks; or `tsc` fails with `TS2591 Cannot find name 'node:crypto'`, `TS5101` (baseUrl) or `TS5107` (moduleResolution node). |
| [TOOL-2](toolchain.md#tool-2) | Toolchain | `shadcn init` in a script exits 0 having created nothing, or `next build` fails offline with `next/font: error … fonts.googleapis.com`. |
| [TOOL-3](toolchain.md#tool-3) | Toolchain | ESLint crashes with `TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function`. |
| [TOOL-4](toolchain.md#tool-4) | Toolchain | The tsup-bundled worker crashes at start with `Error: Dynamic require of "events" is not supported`, or with `ReferenceError: __dirname is not defined in ES module scope` from pino. |
| [TOOL-5](toolchain.md#tool-5) | Toolchain | `node_modules/.pnpm` holds several `drizzle-orm@0.45.3_<peers>` directories, and workspace packages resolve different ones. |
| [TOOL-6](toolchain.md#tool-6) | Toolchain | A Docker build on `node:26-alpine` fails with `sh: corepack: not found`. |
| [TOOL-7](toolchain.md#tool-7) | Toolchain | After `pnpm format`, `tools/check_gotchas.py` reports `has no '*Source: ...*' line` for every entry, and doc tables are re-padded. |
| [ZOD-1](toolchain.md#zod-1) | zod | Unknown or new fields in a plugin payload vanish after parsing: stored event data lacks keys the plugin sent. |

## Retired IDs

Not traps, and never to be cited: these numbers were merged into the entry named, or moved out, and
`tools/check_gotchas.py` fails any mention of them outside this table. The table exists so a citation in
git history or an old chat can still be resolved. A retired number is never reused.

| Retired | Now |
|---|---|
