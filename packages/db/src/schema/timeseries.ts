/**
 * Timescale hypertables and continuous aggregates. The tables are created by the drizzle-kit migration
 * and converted to hypertables by the custom `timescale` migration (create_default_indexes => false,
 * so every index is declared here and drizzle-kit never sees drift). Continuous aggregates are views
 * created in that migration and declared here with `.existing()` so they are typed but never generated.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { osrsAccounts } from './accounts';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** 5-minute buckets, change-only: a row exists only where that skill's XP changed. */
export const xpSamples = pgTable(
  'xp_samples',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    skillId: smallint('skill_id').notNull(),
    bucket: tstz('bucket').notNull(),
    // Overall can reach 24 × 200M = 4.8e9: bigint, but safe as a JS number.
    xp: bigint('xp', { mode: 'number' }).notNull(),
    level: smallint('level').notNull(),
  },
  (t) => [
    primaryKey({ name: 'xp_samples_pk', columns: [t.accountId, t.skillId, t.bucket] }),
    index('xp_samples_bucket_idx').on(t.bucket.desc()),
  ],
);

/** At most one sample per account per minute (the bucket start), kept LOCATION_RETENTION_DAYS. */
export const locationSamples = pgTable(
  'location_samples',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    ts: tstz('ts').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    plane: smallint('plane').notNull(),
    world: integer('world'),
    onBoat: boolean('on_boat').default(false).notNull(),
  },
  (t) => [
    unique('location_samples_account_ts_uq').on(t.accountId, t.ts),
    index('location_samples_ts_idx').on(t.ts.desc()),
  ],
);

/**
 * Every ingest request body, kept RAW_PAYLOAD_RETENTION_HOURS. `body` is text, not jsonb: invalid JSON
 * must be archivable and jsonb rejects the \u0000 escapes Gson emits (DB-1).
 */
export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    receivedAt: tstz('received_at').notNull(),
    deviceId: uuid('device_id'),
    accountId: integer('account_id'),
    /** HTTP status returned; null while processing. */
    status: smallint('status'),
    pluginVersion: text('plugin_version'),
    /** Skipped sections/events, error class, timings. */
    meta: jsonb('meta'),
    body: text('body').notNull(),
  },
  (t) => [
    primaryKey({ name: 'raw_payloads_pk', columns: [t.id, t.receivedAt] }),
    index('raw_payloads_received_at_idx').on(t.receivedAt.desc()),
    index('raw_payloads_device_idx').on(t.deviceId, t.receivedAt.desc()),
  ],
);

const xpAggregateColumns = {
  accountId: integer('account_id').notNull(),
  skillId: smallint('skill_id').notNull(),
  bucket: tstz('bucket').notNull(),
  xp: bigint('xp', { mode: 'number' }).notNull(),
  level: smallint('level').notNull(),
};

/** Continuous aggregate: last XP per hour (real-time). Kept forever. */
export const xpHourly = pgView('xp_hourly', xpAggregateColumns).existing();

/** Hierarchical continuous aggregate on xp_hourly: last XP per UTC day (real-time). Kept forever. */
export const xpDaily = pgView('xp_daily', xpAggregateColumns).existing();
