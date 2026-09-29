# Database: Postgres, Drizzle and TimescaleDB

Postgres behaviour, drizzle-orm 0.45 and drizzle-kit 0.31 (queries, errors, the migrator), and TimescaleDB 2.30 (hypertables, compression, continuous aggregates, policies, the Docker image).

| ID | Symptom |
|---|---|
| [DB-1](#db-1) | An insert fails with `22P02 invalid input syntax for type json` or `unsupported Unicode escape sequence` (`\u0000 cannot be converted to text`). |
| [DB-2](#db-2) | A resent event is stored twice although the insert uses `ON CONFLICT … DO NOTHING` on a unique key. |
| [DB-3](#db-3) | A caught database error has `err.code === undefined`, and its logged message contains tokens, coordinates or other bound parameters. |
| [DB-4](#db-4) | A cursor feed (`?after=<seq>`, SSE `Last-Event-ID`) permanently misses some rows that are in the table. |
| [DB-5](#db-5) | Connections fail with `sorry, too many clients already` (53300) once web, worker and pg-boss are all running. |
| [DB-6](#db-6) | `drizzle-kit push` drops indexes nobody declared without asking, or drops and re-adds a `*_pk` on every run although the schema didn't change. |
| [DB-7](#db-7) | `migrate()` fails with 25001 `CREATE MATERIALIZED VIEW ... WITH DATA cannot run inside a transaction block` or `refresh_continuous_aggregate() cannot run inside a transaction block`, and no pending migration is applied. |
| [DB-8](#db-8) | `migrate()` reports success, but a migration merged from another branch never ran (its tables or columns are missing). |
| [DB-9](#db-9) | The first payloads from a brand-new account fail with 23505 `duplicate key value violates unique constraint`, or `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns no row. |
| [DB-10](#db-10) | A policy is replaced on every start, or an interval check fails, when one side says `'1 year'` and the other `'365 days'`. |
| [DB-11](#db-11) | `SET LOCAL lock_timeout = $1` fails with `42601 syntax error at or near "$1"`. |
| [DB-12](#db-12) | The bundled migrate entrypoint fails with `Can't find meta/_journal.json file`. |
| [DB-13](#db-13) | `pg_notify` fails with `22023 payload string too long` and takes the transaction it was called in down with it. |
| [DB-14](#db-14) | Node logs `DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated`, from code that runs several queries with `Promise.all` inside `db.transaction`. |
| [TSDB-1](#tsdb-1) | Hourly or daily XP history older than the raw retention disappears from `xp_hourly`/`xp_daily` after a refresh. |
| [TSDB-2](#tsdb-2) | After deleting an account, its rows are still in `xp_hourly`/`xp_daily`, and `DELETE FROM xp_hourly` fails with `55000 cannot delete from view`. |
| [TSDB-3](#tsdb-3) | A changed retention or compression setting has no effect after restart; the log only shows `WARNING: … A policy already exists with different arguments`. |
| [TSDB-4](#tsdb-4) | `CREATE DATABASE x TEMPLATE tpl` fails after about 5 s with `55006 source database "tpl" is being accessed by other users`, intermittently. |
| [TSDB-5](#tsdb-5) | Raw payloads configured to live 72 hours are still there after three days, up to about four. |
| [TSDB-6](#tsdb-6) | The database container exits (1) at start with `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"…`. |
| [TSDB-7](#tsdb-7) | A new continuous aggregate returns 0 rows, or a recent hour in `xp_hourly` shows an older value than `xp_samples` holds. |
| [TSDB-8](#tsdb-8) | A unique-violation error names a constraint like `1_location_samples_account_ts_uq` on a table like `_hyper_2_1_chunk`, not the one you declared. |
| [TSDB-9](#tsdb-9) | Compression, `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` or `add_retention_policy` fail with `functionality not supported under the current "apache" license`. |
| [TSDB-10](#tsdb-10) | Timescale jobs (retention, compression, refresh) silently stop running in some databases, and the server log says `TimescaleDB background worker limit of 16 exceeded`. |
| [TSDB-11](#tsdb-11) | A drizzle-kit-generated migration fails on a hypertable with `operation not supported on hypertables with compressed chunks` or `cannot add column with NOT NULL constraint without default to a hypertable that has columnstore enabled`. |
| [TSDB-12](#tsdb-12) | Concurrent ingest transactions fail with `40P01 deadlock detected` around a chunk boundary (midnight, a new week); one of them waits for a `ShareRowExclusiveLock` on a plain table while inserting into a hypertable. |
| [TSDB-13](#tsdb-13) | A "last value at or before t" lookup (`ORDER BY bucket DESC LIMIT 1`) on `xp_hourly`/`xp_daily` gets slower as history grows; `EXPLAIN` shows a Sort over an Append of the materialized hypertable instead of an index scan. |

### DB-1
**An insert fails with `22P02 invalid input syntax for type json` or `unsupported Unicode escape sequence` (`\u0000 cannot be converted to text`).**
jsonb accepts only valid JSON and rejects the `\u0000` escape, which the plugin's Gson emits for NUL
([PLUGIN-7](plugin.md#plugin-7)): one NUL in any string fails the whole ingest transaction, and answered
with a 5xx it becomes a poison pill ([PLUGIN-3](plugin.md#plugin-3)). jsonb also decodes escapes,
reorders keys and keeps only the last duplicate key, so it can't serve as the archive of what arrived.
Fix: `raw_payloads.body` is `text` (packages/db/src/schema/timeseries.ts); every value headed for a jsonb
column goes through `stripNul` (packages/core/src/json.ts); a remaining data error is answered 400.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, 2026-09-28)*

### DB-2
**A resent event is stored twice although the insert uses `ON CONFLICT … DO NOTHING` on a unique key.**
NULLs are distinct in a UNIQUE constraint, so `(account_id, plugin_event_id, NULL)` never conflicts with
itself: with a nullable `sub_index` the resend inserted a second row (2 rows, against 1 with
`NULLS NOT DISTINCT`). Fix: every column of a dedupe key is NOT NULL with a default
(`sub_index smallint NOT NULL DEFAULT 0`, packages/db/src/schema/activity.ts), or the constraint is
declared `UNIQUE NULLS NOT DISTINCT`.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, 2026-09-28)*

### DB-3
**A caught database error has `err.code === undefined`, and its logged message contains tokens, coordinates or other bound parameters.**
drizzle-orm 0.45 wraps driver errors in `DrizzleQueryError`: `message` is
`Failed query: <sql>\nparams: <every bound value>` (errors.js:12), and the pg error with the SQLSTATE is
`err.cause` (`err.cause.code`). Checks on `err.code` never fire (lock timeouts not mapped to 503, unique
violations not recognised), and logging `err.message` leaks secrets and locations. Fix: `pgErrorCode(err)`
walks the `cause` chain and `safeDbErrorMessage(err)` returns only the Postgres message
(packages/db/src/errors.ts); never log `err.message` of a query error.

*Source: `OBSERVED` (research sandbox, drizzle-orm 0.45.3 on timescale/timescaledb:2.30.1-pg17 and -pg18, 2026-09-28); `SOURCE` (drizzle-orm 0.45.3 errors.js:12)*

### DB-4
**A cursor feed (`?after=<seq>`, SSE `Last-Event-ID`) permanently misses some rows that are in the table.**
Identity and serial values are taken at INSERT, not at COMMIT. Transaction A takes seq 1 and commits
slowly, B takes seq 2 and commits first; a reader between the two commits sees only 2, advances its
cursor to 2 and never sees 1. PG17's `transaction_timeout` is no fix: when it fires it terminates the
session. Fix: never hand out a cursor past rows that may still commit: serve only the seqs **below the
first row that is younger than a margin** (measured from a `clock_timestamp()` insert column), not "every
row older than the margin": filtering young rows one by one still returns a settled higher seq while a
lower one is held back, and the cursor skips it (packages/server/src/live/replay.ts `settledCeiling`).
Keep event-inserting transactions short (the events insert last, lock waits before it). Filtering on
`pg_snapshot_xmin(pg_current_snapshot())` is an untested alternative. The warning sits on `events.seq`
in packages/db/src/schema/activity.ts.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, `race.mjs`, 2026-09-28)*

### DB-5
**Connections fail with `sorry, too many clients already` (53300) once web, worker and pg-boss are all running.**
The timescale image's `timescaledb-tune` sets `max_connections` from `TS_TUNE_MEMORY`: 25 below 4 GB
(also at 2 GB), 50 at 4 GB, 100 at 8 GB and up, with 3 reserved for superusers. A `pg.Pool` defaults to
10 connections (pg-pool index.js:89), pg-boss opens its own pool, Next makes a second pool when the
module-level one is duplicated ([NEXT-3](nextjs.md#next-3)), and the SSE LISTEN client holds one more:
roughly 41 against 22 (the sum is inferred). The same script sizes `shared_buffers` from the host's RAM
when neither `TS_TUNE_MEMORY` nor a memory limit is set, and the image turns telemetry on unless
`TIMESCALEDB_TELEMETRY=off`. Fix: `TS_TUNE_MAX_CONNS: '100'`, `TS_TUNE_MEMORY` and
`TIMESCALEDB_TELEMETRY: 'off'` (compose.yaml); explicit pool sizes (`max` in `createDb`,
packages/db/src/client.ts) whose sum stays below the limit.

*Source: `OBSERVED` (research sandbox, `timescaledb-tune` dry runs in timescale/timescaledb:2.30.1, 2026-09-28); `SOURCE` (pg-pool index.js:89, pg-boss dist/db.js:40)*

### DB-6
**`drizzle-kit push` drops indexes nobody declared without asking, or drops and re-adds a `*_pk` on every run although the schema didn't change.**
push diffs the live database against the TS schema. Timescale's default hypertable indexes
(`<table>_<column>_idx`) aren't in the schema, so push drops them without a prompt. On PG18,
drizzle-kit 0.31.11 reads composite primary keys in the wrong column order (`(account_id, bucket,
skill_id)` for `(account_id, skill_id, bucket)`) and re-creates the PK every run, even without
Timescale; PG17 is not affected. pull shares the introspection. `generate` and `migrate` don't read the
live schema and are fine. Fix: never run push or pull, only `generate`, `check` and `migrate`
(packages/db/drizzle.config.ts); hypertables are created with `create_default_indexes => false` and every
index is declared in the drizzle schema (packages/db/drizzle/0001_timescale.sql).

*Source: `OBSERVED` (research sandbox, drizzle-kit 0.31.11 on timescale/timescaledb:2.30.1-pg17 and -pg18, 2026-09-28)*

### DB-7
**`migrate()` fails with 25001 `CREATE MATERIALIZED VIEW ... WITH DATA cannot run inside a transaction block` or `refresh_continuous_aggregate() cannot run inside a transaction block`, and no pending migration is applied.**
drizzle-orm's migrator runs all pending migrations in one transaction (pg-core/dialect.js:60); on a
failure everything rolls back, `__drizzle_migrations` included. A continuous aggregate defaults to
WITH DATA, and a refresh can't run in any transaction, not even the implicit one of a multi-statement
string. `create_hypertable`, columnstore settings, policy calls and `CREATE EXTENSION` are fine inside
it. The migrator also takes no lock, so two concurrent runs are unsafe. Fix: create caggs `WITH NO DATA`,
never refresh in a migration, keep `--> statement-breakpoint` between statements
(packages/db/drizzle/0001_timescale.sql, packages/db/src/migrate.ts); refresh later from code, alone,
through `db.execute` outside a transaction.

*Source: `OBSERVED` (research sandbox, drizzle-orm 0.45.3 on timescale/timescaledb:2.30.1, 2026-09-28); `SOURCE` (drizzle-orm 0.45.3 pg-core/dialect.js:60)*

### DB-8
**`migrate()` reports success, but a migration merged from another branch never ran (its tables or columns are missing).**
The migrator compares each migration's journal `when` with the `created_at` of the last applied one and
runs only newer ones (pg-core/dialect.js:62). A migration generated on a branch before a newer one was
applied from main has an older timestamp and is skipped silently, for good. Fix: after merging main into
a branch that adds migrations, delete the branch's generated SQL and snapshot and run
`drizzle-kit generate` again on top of main, so its journal `when` is the newest; check that the
journal's `when` values only increase (packages/db/drizzle/meta/_journal.json, packages/db/src/migrate.ts).

*Source: `OBSERVED` (research sandbox, drizzle-orm 0.45.3, an older-timestamp migration variant, 2026-09-28); `SOURCE` (drizzle-orm 0.45.3 pg-core/dialect.js:62)*

### DB-9
**The first payloads from a brand-new account fail with 23505 `duplicate key value violates unique constraint`, or `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns no row.**
On first login the plugin sends several payloads in the same tick, concurrently; two transactions insert
the same new `account_hash`. A plain INSERT gives the loser 23505, and `DO NOTHING RETURNING` gives it
zero rows and so no id. A per-account advisory lock taken after resolution doesn't help. Fix:
`INSERT … ON CONFLICT (<natural key>) DO UPDATE SET <touched column> = excluded.<column> RETURNING id`,
which returns the row to both transactions; the same for `account_links`, `latest_state` and `skills`. As
a backstop a racing 23505 counts as transient, 503 + `Retry-After` (`isTransientDbError`,
packages/db/src/errors.ts), never as a 400 data error ([PLUGIN-3](plugin.md#plugin-3)).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, `race.mjs`, 2026-09-28)*

### DB-10
**A policy is replaced on every start, or an interval check fails, when one side says `'1 year'` and the other `'365 days'`.**
Postgres compares intervals by counting a month as 30 days: `'1 year'::interval = '360 days'` is true
and `= '365 days'` is false, while `'8760 hours' = '365 days'` is true (days and hours convert at 24 h).
Timescale stores policy intervals as the text given. Fix: build intervals from integer days or hours only
(the retention settings are validated as positive integers, `validatePolicyConfig`,
packages/db/src/policies.ts); compare as `::interval`, never as strings.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, 2026-09-28)*

### DB-11
**`SET LOCAL lock_timeout = $1` fails with `42601 syntax error at or near "$1"`.**
`SET` is a utility statement and takes no bind parameters, and drizzle's `sql` template turns every
interpolated value into one. Fix: `SELECT set_config('lock_timeout', ${value}, true)`; the third argument
makes it transaction-local, like `SET LOCAL`. The timeout then also bounds `pg_advisory_xact_lock` waits
(55P03, see [VERIFIED.md](../VERIFIED.md)).

*Source: `OBSERVED` (research sandbox, drizzle-orm 0.45.3 on timescale/timescaledb:2.30.1-pg17 and -pg18, 2026-09-28)*

### DB-12
**The bundled migrate entrypoint fails with `Can't find meta/_journal.json file`.**
drizzle-orm's migrator reads `<folder>/meta/_journal.json` and each `<tag>.sql` from disk at runtime
(migrator.js:3-28). Bundling the code (tsup `noExternal`) doesn't carry them, and a path relative to the
source tree doesn't exist in the image. Fix: copy `packages/db/drizzle` into the image next to the bundle
and pass that folder, resolved from `import.meta.dirname`, to `runMigrations(url, folder)`
(packages/db/src/migrate.ts).

*Source: `OBSERVED` (research sandbox, drizzle-orm 0.45.3 bundled with tsup 8.5.1, 2026-09-28); `SOURCE` (drizzle-orm 0.45.3 migrator.js:3-28)*

### DB-13
**`pg_notify` fails with `22023 payload string too long` and takes the transaction it was called in down with it.**
A NOTIFY payload must be shorter than 8000 bytes: 7999 works, 8000 fails. Called inside the ingest
transaction, the failure rolls the ingest back too. Fix: notify identifiers (an account id, an event
seq), never serialized rows; listeners read the data themselves.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17 and -pg18, 2026-09-28)*

### DB-14
**Node logs `DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated`, from code that runs several queries with `Promise.all` inside `db.transaction`.**
A drizzle transaction handle is one pooled `pg` client. `Promise.all([tx.select…, tx.select…])` queues
several queries on that client at once; pg 8.23 still serializes them but warns, and pg 9 removes the
behaviour. The same helper is fine on the pool (`db`), which is why it only shows up once a caller passes
a transaction. Fix: run queries on a possibly-transactional handle sequentially
(packages/server/src/accounts/access.ts `loadAccountAccess`).

*Source: `OBSERVED` (server tests, pg 8.23.0, 2026-09-28)*

### TSDB-1
**Hourly or daily XP history older than the raw retention disappears from `xp_hourly`/`xp_daily` after a refresh.**
Retention drops raw chunks, and dropping them writes an invalidation for that range. The next refresh
whose window covers it recomputes those buckets from no rows and deletes the aggregated ones, and that
includes a manual `refresh_continuous_aggregate(…, NULL, …)`. Timescale doesn't check `start_offset`
against retention: a 400-day start with 300-day retention was accepted. Fix: refresh windows start
`CAGG_REFRESH_START_DAYS` (7) back and `validatePolicyConfig` refuses a raw retention below twice that
(packages/db/src/policies.ts); never run a NULL-start refresh on `xp_hourly` or `xp_daily` by hand.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-2
**After deleting an account, its rows are still in `xp_hourly`/`xp_daily`, and `DELETE FROM xp_hourly` fails with `55000 cannot delete from view`.**
The FK cascade removes the raw `xp_samples` rows (also on compressed chunks: 138k rows in 29 ms), but a
continuous aggregate keeps its materialized rows, and the cagg itself is a view. Fix: for each cagg, look
up `materialization_hypertable_schema`/`_name` in `timescaledb_information.continuous_aggregates` and
`DELETE FROM <that table> WHERE account_id = $1`; this is part of the account delete (GDPR) flow.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, `xp_hourly` and `xp_daily`, 2026-09-28)*

### TSDB-3
**A changed retention or compression setting has no effect after restart; the log only shows `WARNING: … A policy already exists with different arguments`.**
`add_*_policy(…, if_not_exists => true)` given different arguments returns -1 and leaves the old policy
as it was. Fix: compare the current config in `timescaledb_information.jobs` (as `::interval`,
[DB-10](#db-10)) and, only on a difference, `remove_*_policy(if_exists => true)` then `add_*`, in one
transaction under an advisory lock (packages/db/src/policies.ts). Migrations create no policies
(packages/db/drizzle/0001_timescale.sql).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-4
**`CREATE DATABASE x TEMPLATE tpl` fails after about 5 s with `55006 source database "tpl" is being accessed by other users`, intermittently.**
Every database with the extension gets a Timescale scheduler background worker connected to it.
Timescale stops it for `CREATE DATABASE`, but it restarts and races the copy: 28 of 30 sequential clones
failed. `ALLOW_CONNECTIONS false` alone isn't enough, because an already connected scheduler stays. Fix:
after migrating the template, `ALTER DATABASE tpl WITH ALLOW_CONNECTIONS false` and
`pg_terminate_backend` its sessions (packages/db/src/testing/global-setup.ts): 30/30 sequential and 16/16
parallel clones then succeed, about 31 ms each, and the clones do allow connections.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, 2026-09-28)*

### TSDB-5
**Raw payloads configured to live 72 hours are still there after three days, up to about four.**
`add_retention_policy`'s default `schedule_interval` is 1 day whatever `drop_after` is (a 72 h policy got
a 1-day schedule), and retention drops only whole chunks. Fix: pass `schedule_interval` explicitly for
every policy (15 min for raw payloads, 1 h for locations; packages/db/src/policies.ts) and keep chunks
small relative to the retention (2-hour chunks for `raw_payloads`,
packages/db/drizzle/0001_timescale.sql).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-6
**The database container exits (1) at start with `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"…`.**
The pg18 images set `PGDATA=/var/lib/postgresql/18/docker` and declare `VOLUME /var/lib/postgresql`; a
volume mounted at the pg17-style `/var/lib/postgresql/data` is refused. Fix: mount the parent,
`db-data:/var/lib/postgresql` (compose.yaml, compose.dev.yaml).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg18, 2026-09-28)*

### TSDB-7
**A new continuous aggregate returns 0 rows, or a recent hour in `xp_hourly` shows an older value than `xp_samples` holds.**
In 2.30 a cagg is materialized-only by default (`materialized_only = t`): it returns nothing until the
first refresh. With real-time mode on, buckets above the watermark are computed live, but a late write
into an already materialized bucket stays stale until the next refresh covers it (900 instead of 1000 in
the test). Fix: caggs are created with `timescaledb.materialized_only = false`
(packages/db/drizzle/0001_timescale.sql), and the hourly refresh uses `end_offset` 1 hour, so the open and
previous hours stay live, on a 15-minute schedule (packages/db/src/policies.ts).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-8
**A unique-violation error names a constraint like `1_location_samples_account_ts_uq` on a table like `_hyper_2_1_chunk`, not the one you declared.**
Constraints on a hypertable exist per chunk, and the error reports the chunk's copy
(`<n>_<constraint>` on `_hyper_<h>_<c>_chunk`). Fix: match on SQLSTATE 23505 (`pgErrorCode`,
packages/db/src/errors.ts) or use `ON CONFLICT`; never match on the constraint name.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-9
**Compression, `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` or `add_retention_policy` fail with `functionality not supported under the current "apache" license`.**
The `-oss` images run with `timescaledb.license = apache` and lack the TSL features: columnstore and
compression, continuous aggregates and retention policies all refuse. Fix: use the non-oss image
(`timescale/timescaledb:2.30.1-pg18`, license `timescale`; compose.yaml, compose.dev.yaml).

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1 `-oss` image, 2026-09-28)*

### TSDB-10
**Timescale jobs (retention, compression, refresh) silently stop running in some databases, and the server log says `TimescaleDB background worker limit of 16 exceeded`.**
Each database with the extension needs its own scheduler worker, and `timescaledb.max_background_workers`
defaults to 16: with about 22 databases (leftover test clones) the extra ones get none. Fix: drop test
databases `WITH (FORCE)` when a test file ends (plain `DROP DATABASE` also has 1.8 to 4.1 s outliers);
migrations create no policies, so clones have no jobs; a test server may run with
`-c timescaledb.max_background_workers=0`. `TS_TUNE_MAX_BG_WORKERS=0` does not do that:
timescaledb-tune 0.19.0 still writes 16.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1-pg17, 2026-09-28)*

### TSDB-11
**A drizzle-kit-generated migration fails on a hypertable with `operation not supported on hypertables with compressed chunks` or `cannot add column with NOT NULL constraint without default to a hypertable that has columnstore enabled`.**
drizzle-kit knows nothing about hypertables. With columnstore enabled, `ADD COLUMN` (nullable or with a
default) and `DROP COLUMN` work, but `ADD COLUMN … NOT NULL` without a default and
`ALTER COLUMN … SET DATA TYPE` fail, and `CREATE INDEX CONCURRENTLY` isn't supported on hypertables at
all. Fix: hand-edit such generated migrations: add the column with a default, and decompress the
affected chunks before a type change.

*Source: `OBSERVED` (research sandbox, timescale/timescaledb:2.30.1, 2026-09-28)*

### TSDB-12
**Concurrent ingest transactions fail with `40P01 deadlock detected` around a chunk boundary (midnight, a new week); one of them waits for a `ShareRowExclusiveLock` on a plain table while inserting into a hypertable.**
Inserting a row that needs a NEW chunk makes TimescaleDB create the chunk's foreign-key constraints,
which takes `ShareRowExclusiveLock` on every plain table the hypertable references (`osrs_accounts` for
`xp_samples`/`location_samples`), waits for every open writer of that table, and **keeps the lock until
commit**, while also holding the hypertable's chunk-creation lock (`ShareUpdateExclusiveLock`). Two faces:

- A transaction that already wrote `osrs_accounts` (or any referenced table) and then inserts at a chunk
  boundary deadlocks with another one doing the same, or with anything else that writes the referenced
  table and then waits on a row the first holds (offboarding revoking a device an ingest transaction
  has locked).
- Neither writes `osrs_accounts`, yet two transactions create chunks of two hypertables in different
  orders: one creates the `xp_samples` chunk (now holding `ShareRowExclusiveLock` on `osrs_accounts`)
  and then waits for the `location_samples` chunk another is creating, which waits for that
  `ShareRowExclusiveLock`. A new account's first snapshot (XP, then a location sample) next to an
  existing account's (a location sample only) is enough.

Retrying the transaction resolves it but costs `deadlock_timeout` (1 s) each time, and under load the
retries collide again. Fix: in a transaction, write the hypertables before (or without) touching the
referenced rows, create new referenced rows in their own committed statement first, and let only one
transaction at a time create chunks: packages/server/src/ingest/chunks.ts takes one advisory lock
before the first hypertable write whenever the target chunk range isn't known to exist yet. Pre-creating
chunks ahead of time would take creation out of the hot path entirely.

*Source: `OBSERVED` (ingest concurrency tests, timescale/timescaledb:2.30.1-pg18, 2026-09-28; the
two-hypertable face in the server integration run, 2026-09-29)*

### TSDB-13
**A "last value at or before t" lookup (`ORDER BY bucket DESC LIMIT 1`) on `xp_hourly`/`xp_daily` gets slower as history grows; `EXPLAIN` shows a Sort over an Append of the materialized hypertable instead of an index scan.**
A real-time continuous aggregate is a view: the union of the materialization hypertable and a live
aggregate over the raw rows above the watermark. The planner can't push `ORDER BY bucket DESC LIMIT 1`
through the aggregate, so it computes every bucket for that (account, skill) and sorts them; about
1.3 ms per lookup at 1,500 hourly rows versus 0.01 ms on the raw hypertable, and it grows with history.
Fix: look the value up in the raw hypertable first and only fall back to the aggregate for pairs the raw
lookup missed, with the `IS NULL` guard inside the LATERAL so the fallback isn't evaluated otherwise
(packages/server/src/accounts/xp.ts).

*Source: `OBSERVED` (accounts read-model benchmarks, timescale/timescaledb:2.30.1-pg18, 2026-09-28)*
