import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** Public API keys (Milestone 3). Shown once as ohub_<prefix>_<secret>; only sha256(secret) stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    categories: text('categories').array().notNull(),
    accountScope: text('account_scope', { enum: ['all_visible', 'list'] })
      .default('all_visible')
      .notNull(),
    accountIds: integer('account_ids').array(),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_uidx').on(t.prefix),
    index('api_keys_user_idx').on(t.userId),
  ],
);

/** Audit trail. The actor is set null when a user is hard-deleted (anonymized). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz('at').defaultNow().notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'system', 'worker', or a display name snapshot. */
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: jsonb('meta'),
  },
  (t) => [index('audit_log_at_idx').on(t.at.desc())],
);

/** Instance-wide switches (e.g. the decommission switch that makes ingest answer 410). */
export const hubSettings = pgTable('hub_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
  updatedBy: text('updated_by'),
});
