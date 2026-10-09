/**
 * The official OSRS hiscores of each account (D-105), read by the worker's sync-hiscores job. Plain
 * tables: one row per account, and a change log of activity scores that stays small (a few rows per
 * account per day).
 */
import { HISCORE_MODES } from '@hub/core';
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { osrsAccounts } from './accounts';
import { isOneOf } from './checks';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * The result of an account's latest lookup: `ok` (found), `not_found` (the name isn't on the main
 * table: renamed, or too low to be ranked) or `mismatch` (the hiscores had a skill lower than the
 * plugin reported it: they lag behind, or the name now belongs to someone else).
 */
export const HISCORE_STATUSES = ['ok', 'not_found', 'mismatch'] as const;
export type HiscoreStatus = (typeof HISCORE_STATUSES)[number];

export { HISCORE_MODES };

/**
 * One row per account, created at its first lookup. `main` and `mode_table` hold the parsed
 * hiscores (@hub/core Hiscores) of the last lookup that was `ok`; a `not_found` or `mismatch` keeps
 * them and only moves `status` and the attempt times.
 */
export const accountHiscores = pgTable(
  'account_hiscores',
  {
    accountId: integer('account_id')
      .primaryKey()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    /** The name and table of the latest lookup: a rename or a new account type looks again. */
    lookupName: text('lookup_name').notNull(),
    mode: text('mode', { enum: HISCORE_MODES }).notNull(),
    status: text('status', { enum: HISCORE_STATUSES }).notNull(),
    lastAttemptAt: tstz('last_attempt_at').notNull(),
    /** Not looked up again before this (after not_found or a mismatch); null = no wait. */
    nextAttemptAt: tstz('next_attempt_at'),
    /** When `main` was read; null while no lookup was ok. */
    fetchedAt: tstz('fetched_at'),
    /** The main table. */
    main: jsonb('main'),
    /** The account's own iron table; null for `regular`, or when it isn't listed there. */
    modeTable: jsonb('mode_table'),
  },
  (t) => [
    check('account_hiscores_mode_chk', isOneOf(t.mode, HISCORE_MODES)),
    check('account_hiscores_status_chk', isOneOf(t.status, HISCORE_STATUSES)),
  ],
);

/**
 * Every change of an activity score on the main table (a kill count, a clue count), at the time it
 * was read: the history kill-count gains are built from. Kept forever like the other change logs.
 *
 * A `baseline` row starts a series: the score is known from here on, but what came before it is
 * not, so it is never a gain. That is every score of an account's first lookup, of the first lookup
 * after a rename or after one that wasn't `ok`, and a score that appears for the first time (it was
 * below the hiscores' threshold, so its earlier value is unknown, not 0). A gain is the difference
 * between two rows of one series: a row and the baseline-or-later row before it.
 */
export const activityScores = pgTable(
  'activity_scores',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    /** The hiscores' row name, as Jagex writes it ("Zulrah", "Clue Scrolls (all)"). */
    activity: text('activity').notNull(),
    readAt: tstz('read_at').notNull(),
    score: integer('score').notNull(),
    /** Starts a series: no gain up to this row (see above). */
    baseline: boolean('baseline').notNull(),
  },
  (t) => [primaryKey({ name: 'activity_scores_pk', columns: [t.accountId, t.activity, t.readAt] })],
);

/**
 * Which xp_samples the hiscores wrote (D-105): XP made outside RuneLite, stamped at the lookup that
 * found it rather than when it was earned, so a chart can say where a gain came from. One row per
 * filled sample, same key as xp_samples. Kept apart rather than as a column on xp_samples, whose
 * last-value rollups (xp_hourly, xp_daily) would not carry it; a plain table, like the change logs.
 */
export const hiscoreXpFills = pgTable(
  'hiscore_xp_fills',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => osrsAccounts.id, { onDelete: 'cascade' }),
    skillId: smallint('skill_id').notNull(),
    bucket: tstz('bucket').notNull(),
    /** The XP the hiscores showed; xp_samples holds the greater of it and the plugin's. */
    xp: bigint('xp', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ name: 'hiscore_xp_fills_pk', columns: [t.accountId, t.skillId, t.bucket] })],
);
