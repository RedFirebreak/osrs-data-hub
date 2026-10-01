import { ACCOUNT_STATUSES, AUDIENCES, CATEGORIES, LINK_ROLES, type AccountStatus } from '@hub/core';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { isOneOf } from './checks';
import { devices } from './devices';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const SKILL_KINDS = ['plugin', 'derived'] as const;

/**
 * Skill ids. Grows when the plugin sends a skill name we haven't seen ("don't hardcode the list").
 * `Overall` is a hub-derived pseudo-skill (kind 'derived'); "Combat" only appears in levelUp events and
 * is never stored here.
 */
export const skills = pgTable(
  'skills',
  {
    id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
    name: text('name').notNull().unique(),
    kind: text('kind', { enum: SKILL_KINDS }).default('plugin').notNull(),
    sortOrder: smallint('sort_order').default(1000).notNull(),
  },
  (t) => [check('skills_kind_chk', isOneOf(t.kind, SKILL_KINDS))],
);

// Declared in @hub/core (the permission resolver reads it too); re-exported for this package's users.
export { ACCOUNT_STATUSES, type AccountStatus };

/** An OSRS character, keyed by the plugin's salted accountHash. Accounts don't belong to users. */
export const osrsAccounts = pgTable(
  'osrs_accounts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    /** Short opaque id used in URLs and the API; never the serial. */
    publicId: text('public_id').notNull().unique(),
    accountHash: text('account_hash').notNull().unique(),
    currentName: text('current_name').notNull(),
    /** toJagexName(name).toLowerCase(), for name lookups. */
    nameNormalized: text('name_normalized').notNull(),
    /** IRONMAN varbit: 0 normal, 1 IM, 2 UIM, 3 HCIM, 4 GIM, 5 HCGIM, 6 UGIM. */
    accountType: smallint('account_type'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    firstSeen: tstz('first_seen').defaultNow().notNull(),
    lastSeen: tstz('last_seen').defaultNow().notNull(),
    status: text('status', { enum: ACCOUNT_STATUSES }).default('active').notNull(),
    hiddenAt: tstz('hidden_at'),
  },
  (t) => [
    index('osrs_accounts_name_normalized_idx').on(t.nameNormalized),
    index('osrs_accounts_owner_idx').on(t.ownerUserId),
    check('osrs_accounts_status_chk', isOneOf(t.status, ACCOUNT_STATUSES)),
  ],
);

export const accountNames = pgTable(
  'account_names',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    firstSeen: tstz('first_seen').defaultNow().notNull(),
    lastSeen: tstz('last_seen').defaultNow().notNull(),
  },
  (t) => [primaryKey({ name: 'account_names_pk', columns: [t.accountId, t.name] })],
);

export { LINK_ROLES };

/** Users whose devices reported an account. `role` mirrors osrs_accounts.owner_user_id. */
export const accountLinks = pgTable(
  'account_links',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: LINK_ROLES }).default('contributor').notNull(),
    firstSeen: tstz('first_seen').defaultNow().notNull(),
    lastSeen: tstz('last_seen').defaultNow().notNull(),
    blocked: boolean('blocked').default(false).notNull(),
    blockedAt: tstz('blocked_at'),
  },
  (t) => [
    primaryKey({ name: 'account_links_pk', columns: [t.accountId, t.userId] }),
    index('account_links_user_idx').on(t.userId),
    check('account_links_role_chk', isOneOf(t.role, LINK_ROLES)),
  ],
);

/** Which accounts each device has reported (the Devices page, and device → account attribution). */
export const deviceAccounts = pgTable(
  'device_accounts',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    firstSeen: tstz('first_seen').defaultNow().notNull(),
    lastSeen: tstz('last_seen').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: 'device_accounts_pk', columns: [t.deviceId, t.accountId] }),
    index('device_accounts_account_idx').on(t.accountId),
  ],
);

/** Missing row = the category's default audience (see @hub/core sharing defaults). */
export const accountSharing = pgTable(
  'account_sharing',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    category: text('category', { enum: CATEGORIES }).notNull(),
    audience: text('audience', { enum: AUDIENCES }).notNull(),
    updatedAt: tstz('updated_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: 'account_sharing_pk', columns: [t.accountId, t.category] }),
    check('account_sharing_audience_chk', isOneOf(t.audience, AUDIENCES)),
    check('account_sharing_category_chk', isOneOf(t.category, CATEGORIES)),
  ],
);

export const accountShareGrants = pgTable(
  'account_share_grants',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    category: text('category', { enum: CATEGORIES }).notNull(),
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'account_share_grants_pk',
      columns: [t.accountId, t.category, t.granteeUserId],
    }),
    index('account_share_grants_grantee_idx').on(t.granteeUserId),
    check('account_share_grants_category_chk', isOneOf(t.category, CATEGORIES)),
  ],
);

/**
 * Current state per account. A section that is missing from a payload keeps its previous value and
 * its own *_updated_at (the player may have stopped sharing it). Only `location` expires (2 min) for
 * live views.
 */
export const latestState = pgTable('latest_state', {
  accountId: integer('account_id')
    .primaryKey()
    .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
  /** Device and (clamped) payload time of the last applied snapshot; staleness is per device. */
  sourceDeviceId: uuid('source_device_id').references(() => devices.id, { onDelete: 'set null' }),
  sourceTs: tstz('source_ts'),
  /** Presence: refreshed by every accepted payload, including stale ones. */
  lastSeen: tstz('last_seen').notNull(),
  lastDeviceId: uuid('last_device_id').references(() => devices.id, { onDelete: 'set null' }),
  gameState: text('game_state'),
  tickDelay: integer('tick_delay'),
  world: integer('world'),
  worldTypes: text('world_types').array(),
  specialWorld: boolean('special_world').default(false).notNull(),
  worldUpdatedAt: tstz('world_updated_at'),
  hpCurrent: smallint('hp_current'),
  hpMax: smallint('hp_max'),
  healthUpdatedAt: tstz('health_updated_at'),
  prayerCurrent: smallint('prayer_current'),
  prayerMax: smallint('prayer_max'),
  prayerUpdatedAt: tstz('prayer_updated_at'),
  spellbookId: smallint('spellbook_id'),
  spellbook: text('spellbook'),
  spellbookUpdatedAt: tstz('spellbook_updated_at'),
  /** {x, y, plane, isOnBoat} */
  location: jsonb('location'),
  locationUpdatedAt: tstz('location_updated_at'),
  /** {"Attack": {"xp": 13034431, "level": 99}, …} as sent (levels are virtual above 99). */
  skills: jsonb('skills'),
  skillsUpdatedAt: tstz('skills_updated_at'),
  /** Inventory items as sent: one entry per slot. */
  inventory: jsonb('inventory'),
  inventoryUpdatedAt: tstz('inventory_updated_at'),
  /** Equipment items as sent, with equipmentSlot. */
  equipment: jsonb('equipment'),
  equipmentUpdatedAt: tstz('equipment_updated_at'),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});
