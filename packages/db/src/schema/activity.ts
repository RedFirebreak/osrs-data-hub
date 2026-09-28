import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { osrsAccounts } from './accounts';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Plugin events, normalized (handoff §7.5). The one dedupe mechanism is the unique
 * (account_id, plugin_event_id, sub_index), kept forever. `sub_index` is NOT NULL: a NULL in a unique
 * key would let a resend insert a second row (DB-2).
 */
export const events = pgTable(
  'events',
  {
    /** Public id (uuid v7). */
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** API/SSE cursor. Assigned at insert, not commit: readers must allow for gaps (DB-4). */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    pluginEventId: text('plugin_event_id').notNull(),
    subIndex: smallint('sub_index').default(0).notNull(),
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** lower_snake for known types (loot, pk_loot, level_up, …); unknown types stored as sent. */
    type: text('type').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    receivedAt: tstz('received_at').notNull(),
    /** clock_timestamp() at insert: the cursor feed only serves rows older than a few seconds. */
    insertedAt: tstz('inserted_at').default(sql`clock_timestamp()`).notNull(),
    valueGp: bigint('value_gp', { mode: 'number' }),
    itemId: integer('item_id'),
    npcId: integer('npc_id'),
    skill: text('skill'),
    level: smallint('level'),
    tier: text('tier'),
    points: smallint('points'),
    specialWorld: boolean('special_world').default(false).notNull(),
    /** The original event (from the raw JSON, not the zod output), NUL characters stripped. */
    data: jsonb('data').notNull(),
  },
  (t) => [
    uniqueIndex('events_dedupe_uidx').on(t.accountId, t.pluginEventId, t.subIndex),
    uniqueIndex('events_seq_uidx').on(t.seq),
    index('events_account_occurred_idx').on(t.accountId, t.occurredAt.desc()),
    index('events_type_occurred_idx').on(t.type, t.occurredAt.desc()),
  ],
);

export const SESSION_END_REASONS = ['logout', 'shutdown', 'disabled', 'timeout'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** Play sessions: at most one open (ended_at null) per account. */
export const playSessions = pgTable(
  'play_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    startedAt: tstz('started_at').notNull(),
    /** Receive time of the last in-game payload; a timed-out session ends here. */
    lastSeenAt: tstz('last_seen_at').notNull(),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason', { enum: SESSION_END_REASONS }),
    worlds: integer('worlds').array().default(sql`'{}'::integer[]`).notNull(),
  },
  (t) => [
    uniqueIndex('play_sessions_open_uidx')
      .on(t.accountId)
      .where(sql`${t.endedAt} is null`),
    index('play_sessions_account_started_idx').on(t.accountId, t.startedAt.desc()),
  ],
);

/** A row per change of the slot → itemId map. */
export const equipmentChanges = pgTable(
  'equipment_changes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    changedAt: tstz('changed_at').notNull(),
    equipment: jsonb('equipment').notNull(),
  },
  (t) => [index('equipment_changes_account_idx').on(t.accountId, t.changedAt.desc())],
);

/** Carried wealth (inventory + equipment, GE value) per UTC day. */
export const wealthDaily = pgTable(
  'wealth_daily',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
    maxValue: bigint('max_value', { mode: 'number' }).notNull(),
    updatedAt: tstz('updated_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ name: 'wealth_daily_pk', columns: [t.accountId, t.day] })],
);
