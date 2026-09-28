import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const DEVICE_REVOKE_REASONS = ['user', 'admin', 'offboarding'] as const;
export type DeviceRevokeReason = (typeof DEVICE_REVOKE_REASONS)[number];

/** One paired RuneLite connection = one token. Only sha256(token) is stored. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    tokenHash: text('token_hash').notNull(),
    pluginVersion: text('plugin_version'),
    /** Set when the device sent a version below MIN_PLUGIN_VERSION; cleared by a good one. */
    outdatedAt: tstz('outdated_at'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    lastSeenAt: tstz('last_seen_at'),
    /** First payload that carried an account (the wizard's "receiving data for …" step). */
    firstDataAt: tstz('first_data_at'),
    lastIp: text('last_ip'),
    revokedAt: tstz('revoked_at'),
    revokedReason: text('revoked_reason', { enum: DEVICE_REVOKE_REASONS }),
  },
  (t) => [
    uniqueIndex('devices_token_hash_uidx').on(t.tokenHash),
    index('devices_user_idx').on(t.userId),
  ],
);

/** 5-digit single-use codes; unique among unconsumed rows (expired rows are deleted on reuse). */
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    code: text('code').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    lastOutdatedAttemptAt: tstz('last_outdated_attempt_at'),
    lastOutdatedVersion: text('last_outdated_version'),
  },
  (t) => [
    uniqueIndex('pairing_codes_active_code_uidx')
      .on(t.code)
      .where(sql`${t.consumedAt} is null`),
    index('pairing_codes_user_idx').on(t.userId),
  ],
);
