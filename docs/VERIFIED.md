# Verified behaviour

Things in the shared layer that simply work as documented, confirmed live. Dated, newest last. Traps go
in [gotchas](gotchas/README.md) instead; this log exists so nobody re-verifies the same thing.

| Date | What | Where it was confirmed |
|---|---|---|
| 2026-09-28 | Server-sent events from a route handler flush incrementally: one event per second arrived about 1000 ms apart, with no buffering, and `text/event-stream` was not gzipped even with `Accept-Encoding: gzip, br`. | Research sandbox, Next 16.3.6: `next start`, standalone `server.js` and the Docker image (`curl -N`) |
| 2026-09-28 | One SSE response stays open past Node's 300 s `requestTimeout` (330 s, 329 events). On client disconnect both the `request.signal` abort and the stream's `cancel()` fire, so cleanup must be idempotent. | Research sandbox, Next 16.3.6 standalone |
| 2026-09-28 | A streaming body cap through `request.body.getReader()` works in a route handler: 413 for an oversize body both with `Content-Length` and chunked without it. | Research sandbox, Next 16.3.6 `next start` |
| 2026-09-28 | Next 16 consumes TS-source workspace packages (`exports` pointing at `./src/index.ts`) without `transpilePackages`, with Turbopack and with `--webpack`; standalone output bundles them into chunks. | Research sandbox, Next 16.3.6 pnpm workspace |
| 2026-09-28 | `instrumentation.ts` `register()` runs once at server start, before any request, under `next start` and the standalone `server.js`; `proxy.ts` always runs on the Node runtime (`node:crypto` works). | Research sandbox, Next 16.3.6 |
| 2026-09-28 | Route handler GETs are dynamic by default in Next 16 (`ƒ` in the build output, fresh `Date.now()` per call); `await connection()` from `next/server` works too. | Research sandbox, Next 16.3.6 |
| 2026-09-28 | `pg_notify()` called inside a transaction is delivered only at COMMIT, and never after a rollback. | Research sandbox, timescale/timescaledb:2.30.1-pg17 and -pg18, drizzle-orm 0.45.3 |
| 2026-09-28 | `lock_timeout` applies to `pg_advisory_xact_lock`: the waiter fails with `55P03 canceling statement due to lock timeout` (at `err.cause.code`, see DB-3); set it with `set_config('lock_timeout', $1, true)` (see DB-11). | Research sandbox, timescale/timescaledb:2.30.1-pg17 and -pg18, drizzle-orm 0.45.3 |
| 2026-09-28 | `INSERT … ON CONFLICT DO UPDATE SET xp = GREATEST(…)` works on compressed chunks and decompresses only the matching segment (EXPLAIN: 1 batch, 168 tuples); `ON CONFLICT DO NOTHING` works there too. | Research sandbox, timescale/timescaledb:2.30.1-pg17 and -pg18 |
| 2026-09-28 | `last(value, time)` works in a continuous aggregate and in a hierarchical one (`xp_daily` on `xp_hourly`), matching a ground-truth per-day max; real-time mode chains through both levels. | Research sandbox, timescale/timescaledb:2.30.1 |
| 2026-09-28 | `create_hypertable(…, by_range(…))` converts an empty drizzle-created table inside drizzle's migration transaction, with FKs to plain tables already attached; an FK `ON DELETE CASCADE` into a compressed hypertable works (138k rows in 29 ms). | Research sandbox, timescale/timescaledb:2.30.1-pg17 and -pg18 |
| 2026-09-28 | `CALL refresh_continuous_aggregate(…)` works when sent alone through `db.execute`, with bind parameters, outside a transaction. | Research sandbox, drizzle-orm 0.45.3 on timescale/timescaledb:2.30.1 |
| 2026-09-28 | Deleting one account's rows from each cagg's materialization hypertable clears them from both `xp_hourly` and `xp_daily` and leaves other accounts untouched (the GDPR path of TSDB-2). | Research sandbox, timescale/timescaledb:2.30.1-pg17 |
| 2026-09-28 | A server started with `-c timescaledb.max_background_workers=0` runs no Timescale schedulers: template clones work without the TSDB-4 lockdown, and policies can still be added. `DROP DATABASE … WITH (FORCE)` takes 24 to 38 ms. | Research sandbox, timescale/timescaledb:2.30.1-pg17 |
| 2026-09-28 | pg-boss 12.35 `start()` creates and migrates its schema (version 43) on TimescaleDB; `createQueue` (idempotent), `schedule` (upserts by name), `send` and `work` run; `stop({ graceful: true })` on SIGTERM exits 0. | Research sandbox, pg-boss 12.35.0 on timescale/timescaledb:2.30.1-pg18 and -pg17 |
| 2026-09-28 | Better Auth 1.7.6's Drizzle migrations apply cleanly on TimescaleDB pg18 (`session.expires_at` as `timestamptz`). | Research sandbox, timescale/timescaledb:2.30.1-pg18 (PG 18.6) |
| 2026-09-28 | `uuidv7()` is built into PostgreSQL 18 (PG17 answers `42883 function uuidv7() does not exist`). | Research sandbox, timescale/timescaledb:2.30.1-pg18 and -pg17 |
| 2026-09-28 | With `cookieCache` off, deleting a user's `session` rows directly (raw SQL, as the worker does) revokes them at once: the next `getSession` returns null. | Research sandbox, better-auth 1.7.6 on postgres:17-alpine |
| 2026-09-28 | tsup with `noExternal: [/.*/]` and the createRequire banner (TOOL-4) gives a self-contained ESM worker that runs from a folder without `node_modules` and in Docker; plain `pino()` with `redact` works inside it. | Research sandbox, tsup 8.5.1, pino 10.3.1, `node:24-alpine` |
| 2026-09-28 | `drizzle-kit generate` works with `"type": "module"` and extensionless multi-file schema imports; a second `migrate()` run is a no-op. | Research sandbox, drizzle-kit 0.31.11, drizzle-orm 0.45.3 |
| 2026-09-28 | Vitest 5 inline `test.projects` with Vite 8's built-in `resolve.tsconfigPaths` resolve the `@/` alias; route handlers can be unit-tested by calling `POST(new Request(…))`. | Research sandbox, vitest 5.0.2 |
| 2026-09-28 | Type-aware typescript-eslint (`projectService: true`) works with TypeScript 6.0.3 from one root `eslint.config.js`. | Research sandbox, ESLint 10.11.0, typescript-eslint 8.71.0 |
| 2026-09-28 | zod 4's `z.toJSONSchema()` emits JSON Schema draft 2020-12 (OpenAPI 3.1's dialect) and has an `openapi-3.0` target. | Research sandbox, zod 4.6.5 |
