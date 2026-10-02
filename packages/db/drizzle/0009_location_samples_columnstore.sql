-- Custom SQL migration: columnstore for location_samples (D-102).
--
-- From plugin 1.6 the table holds every tile a player visits (up to about 100 rows a minute while
-- running) instead of one row a minute. Segmented by account and ordered newest first, as the trail
-- is read and as ON CONFLICT (account_id, ts) looks a point up, so a late insert into an old chunk
-- decompresses one account's batch only. Transaction-safe (DB-7); works on a hypertable that already
-- has rows. The compression policy itself belongs to the worker (D-40, packages/db/src/policies.ts).
--
-- From here on TSDB-11 applies to this table: no ADD COLUMN ... NOT NULL without a default and no
-- ALTER COLUMN ... SET DATA TYPE while chunks are compressed.
ALTER TABLE location_samples SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'account_id',
  timescaledb.orderby = 'ts DESC'
);
