import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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

/**
 * `user`: a member's own key, reading what its creator may see (D-69, D-70). `service`: an
 * integration key an admin created, belonging to no user and reading the guild audience (D-88).
 */
export const API_KEY_KINDS = ['user', 'service'] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/**
 * `all_visible`: whatever the key's principal can see, on every request; `list`: `account_ids`.
 * Like `kind`, typed here only: neither column has a CHECK constraint in the database.
 */
export const API_KEY_ACCOUNT_SCOPES = ['all_visible', 'list'] as const;

/**
 * Public API keys (Milestone 3). Shown once as ohub_<prefix>_<secret>; only sha256(secret) stored.
 * A user key has its creator in `user_id` (cascade: the key goes with the user); a service key has
 * none (D-88) and records who created it in `created_by_user_id`, which offboarding leaves alone.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: text('kind', { enum: API_KEY_KINDS }).default('user').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Who created it, for the admin page and the audit trail; null once that user is deleted. */
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    categories: text('categories').array().notNull(),
    accountScope: text('account_scope', { enum: API_KEY_ACCOUNT_SCOPES })
      .default('all_visible')
      .notNull(),
    accountIds: integer('account_ids').array(),
    /** Requests per sliding minute; null = the default of its kind (D-72, D-88). */
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_uidx').on(t.prefix),
    index('api_keys_user_idx').on(t.userId),
    // A user key always has its user; a service key never has one.
    check('api_keys_kind_user_check', sql`(${t.kind} = 'user') = (${t.userId} IS NOT NULL)`),
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
