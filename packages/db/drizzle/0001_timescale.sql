-- Custom SQL migration: TimescaleDB objects, seed data and CHECK constraints.
--
-- drizzle-orm's migrate() runs ALL pending migrations in ONE transaction (DB-7), so everything here
-- must be transaction-safe:
--   * continuous aggregates are created WITH NO DATA (WITH DATA fails with 25001);
--   * never CALL refresh_continuous_aggregate() in a migration;
--   * no CREATE INDEX CONCURRENTLY.
-- Policies (compression, retention, cagg refresh) are NOT created here: the worker owns them and
-- reconciles them from env at startup (TSDB-3). Test databases therefore run no background jobs.
-- Hypertables use create_default_indexes => false; every index is declared in the drizzle schema, so
-- drizzle-kit sees no drift.

CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint

-- xp_samples: 5-min change-only buckets. 7-day chunks; columnstore segmented by the upsert key prefix
-- so an ON CONFLICT into an old chunk only decompresses one (account, skill) batch.
SELECT create_hypertable('xp_samples', by_range('bucket', INTERVAL '7 days'), create_default_indexes => false);
--> statement-breakpoint
ALTER TABLE xp_samples SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'account_id, skill_id',
  timescaledb.orderby = 'bucket DESC'
);
--> statement-breakpoint

-- location_samples: <= 1 row/min/account, kept ~30 days. 1-day chunks.
SELECT create_hypertable('location_samples', by_range('ts', INTERVAL '1 day'), create_default_indexes => false);
--> statement-breakpoint

-- raw_payloads: kept 72 h, compressed after 6 h. 2-hour chunks so both policies act close to the
-- configured age. PK is (id, received_at): the partition column must be in every unique constraint.
SELECT create_hypertable('raw_payloads', by_range('received_at', INTERVAL '2 hours'), create_default_indexes => false);
--> statement-breakpoint
ALTER TABLE raw_payloads SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'device_id',
  timescaledb.orderby = 'received_at DESC, id'
);
--> statement-breakpoint

-- Continuous aggregates. XP is a monotonic counter: always last(), never avg().
-- materialized_only = false: buckets newer than the refresh watermark are computed live.
CREATE MATERIALIZED VIEW xp_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT account_id,
       skill_id,
       time_bucket(INTERVAL '1 hour', bucket) AS bucket,
       last(xp, bucket)    AS xp,
       last(level, bucket) AS level
FROM xp_samples
GROUP BY account_id, skill_id, time_bucket(INTERVAL '1 hour', bucket)
WITH NO DATA;
--> statement-breakpoint
CREATE INDEX xp_hourly_account_skill_bucket_idx ON xp_hourly (account_id, skill_id, bucket DESC);
--> statement-breakpoint

-- Hierarchical continuous aggregate on xp_hourly (UTC days).
CREATE MATERIALIZED VIEW xp_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT account_id,
       skill_id,
       time_bucket(INTERVAL '1 day', bucket) AS bucket,
       last(xp, bucket)    AS xp,
       last(level, bucket) AS level
FROM xp_hourly
GROUP BY account_id, skill_id, time_bucket(INTERVAL '1 day', bucket)
WITH NO DATA;
--> statement-breakpoint
CREATE INDEX xp_daily_account_skill_bucket_idx ON xp_daily (account_id, skill_id, bucket DESC);
--> statement-breakpoint

-- Skills in RuneLite's Skill.values() order (the order the plugin sends them). New names are added
-- by ingest with sort_order 1000. "Overall" is derived by the hub (sum of all skills).
INSERT INTO skills (name, kind, sort_order)
SELECT name, kind, sort_order FROM (VALUES
  ('Overall', 'derived', 0),
  ('Attack', 'plugin', 1), ('Defence', 'plugin', 2), ('Strength', 'plugin', 3),
  ('Hitpoints', 'plugin', 4), ('Ranged', 'plugin', 5), ('Prayer', 'plugin', 6),
  ('Magic', 'plugin', 7), ('Cooking', 'plugin', 8), ('Woodcutting', 'plugin', 9),
  ('Fletching', 'plugin', 10), ('Fishing', 'plugin', 11), ('Firemaking', 'plugin', 12),
  ('Crafting', 'plugin', 13), ('Smithing', 'plugin', 14), ('Mining', 'plugin', 15),
  ('Herblore', 'plugin', 16), ('Agility', 'plugin', 17), ('Thieving', 'plugin', 18),
  ('Slayer', 'plugin', 19), ('Farming', 'plugin', 20), ('Runecraft', 'plugin', 21),
  ('Hunter', 'plugin', 22), ('Construction', 'plugin', 23), ('Sailing', 'plugin', 24)
) AS s(name, kind, sort_order)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- Enum-like text columns: drizzle's { enum } is TypeScript-only, so enforce the values here.
ALTER TABLE skills ADD CONSTRAINT skills_kind_chk CHECK (kind IN ('plugin', 'derived'));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active', 'grace'));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_offboard_reason_chk
  CHECK (offboard_reason IS NULL OR offboard_reason IN ('left_guild', 'lost_role', 'admin', 'self_delete'));
--> statement-breakpoint
ALTER TABLE osrs_accounts ADD CONSTRAINT osrs_accounts_status_chk CHECK (status IN ('active', 'hidden'));
--> statement-breakpoint
ALTER TABLE account_links ADD CONSTRAINT account_links_role_chk CHECK (role IN ('owner', 'contributor'));
--> statement-breakpoint
ALTER TABLE account_sharing ADD CONSTRAINT account_sharing_audience_chk
  CHECK (audience IN ('private', 'guild', 'selected'));
--> statement-breakpoint
ALTER TABLE account_sharing ADD CONSTRAINT account_sharing_category_chk
  CHECK (category IN ('stats', 'events', 'activity', 'location_live', 'location_history', 'equipment', 'inventory'));
--> statement-breakpoint
ALTER TABLE account_share_grants ADD CONSTRAINT account_share_grants_category_chk
  CHECK (category IN ('stats', 'events', 'activity', 'location_live', 'location_history', 'equipment', 'inventory'));
--> statement-breakpoint
ALTER TABLE play_sessions ADD CONSTRAINT play_sessions_end_reason_chk
  CHECK (end_reason IS NULL OR end_reason IN ('logout', 'shutdown', 'disabled', 'timeout'));
--> statement-breakpoint
ALTER TABLE pairing_codes ADD CONSTRAINT pairing_codes_code_chk CHECK (code ~ '^[0-9]{5}$');
