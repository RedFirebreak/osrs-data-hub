/**
 * Metrics' one table of its own (D-109): an account's goals, a target level, XP or kill count that
 * Metrics shows progress and an ETA for. Everything else Metrics shows is read from the tables the
 * hub already keeps (D-106).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { osrsAccounts } from './accounts';
import { isOneOf } from './checks';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** A level of a skill, an amount of XP in a skill, or a kill count on the hiscores. */
export const GOAL_KINDS = ['level', 'xp', 'kc'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** At most one goal per account, kind and target: a new one replaces the old. */
export const accountGoals = pgTable(
  'account_goals',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: GOAL_KINDS }).notNull(),
    /** A skill name for `level` and `xp`, a hiscores activity name for `kc`. */
    target: text('target').notNull(),
    /** The level, XP or kill count to reach. */
    value: bigint('value', { mode: 'number' }).notNull(),
    /** Who set it; null once that user is gone. */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('account_goals_target_uidx').on(t.accountId, t.kind, t.target),
    // For the users FK's ON DELETE SET NULL, as on events.device_id.
    index('account_goals_created_by_idx').on(t.createdBy),
    check('account_goals_kind_chk', isOneOf(t.kind, GOAL_KINDS)),
    check('account_goals_value_chk', sql`${t.value} > 0`),
  ],
);
