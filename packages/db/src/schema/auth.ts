/**
 * Better Auth tables (user/session/account/verification) plus the hub's user fields.
 *
 * Generated with `npx auth generate` (better-auth 1.7) and then hand-edited, see AUTH-2:
 *  - every timestamp is timestamptz (the generator emits `timestamp` without time zone);
 *  - unique (provider_id, account_id) on `account`.
 * Only the user model is renamed (`users`): unquoted `user` is a Postgres keyword.
 * Keep this file in step with `additionalFields` in apps/web/src/lib/auth.ts: Better Auth 1.7 validates
 * the schema at runtime and throws on every auth request when they disagree (AUTH-1).
 */
import { USER_STATUSES, type UserStatus } from '@hub/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { isNullOrOneOf, isOneOf } from './checks';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// Declared in @hub/core (the permission resolver reads it too); re-exported for this package's users.
export { USER_STATUSES, type UserStatus };

/** Why a user is in `grace`. Only membership reasons are undone by simply logging in again. */
export const OFFBOARD_REASONS = ['left_guild', 'lost_role', 'admin', 'self_delete'] as const;
export type OffboardReason = (typeof OFFBOARD_REASONS)[number];

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Placeholder `<discordId>@discord.invalid`: we don't request the email scope (AUTH-3).
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    discordId: text('discord_id').unique(),
    nickname: text('nickname'),
    roles: text('roles')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    isAdmin: boolean('is_admin').default(false).notNull(),
    status: text('status', { enum: USER_STATUSES }).default('active').notNull(),
    graceUntil: tstz('grace_until'),
    offboardReason: text('offboard_reason', { enum: OFFBOARD_REASONS }),
    lastVerifiedAt: tstz('last_verified_at'),
    /** Consecutive Discord re-verification failures (errors, not "not a member"). */
    verifyFailures: integer('verify_failures').default(0).notNull(),
  },
  (t) => [
    check('users_status_chk', isOneOf(t.status, USER_STATUSES)),
    check('users_offboard_reason_chk', isNullOrOneOf(t.offboardReason, OFFBOARD_REASONS)),
  ],
);

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: tstz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Always null: the hub strips OAuth tokens in a database hook (AUTH-4).
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('account_userId_idx').on(t.userId),
    uniqueIndex('account_provider_account_uidx').on(t.providerId, t.accountId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Per-user preferences. A missing row means defaults. */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  toastsEnabled: boolean('toasts_enabled').default(true).notNull(),
  /** null = every event type. */
  toastTypes: text('toast_types').array(),
  toastMinLootValue: bigint('toast_min_loot_value', { mode: 'number' }).default(0).notNull(),
  toastOwnAccountsOnly: boolean('toast_own_accounts_only').default(false).notNull(),
  timezone: text('timezone').default('UTC').notNull(),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});
