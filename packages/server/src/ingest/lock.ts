/**
 * Ingest's per-account advisory lock, shared by every writer of an account's rows (offboarding,
 * grace expiry, restore, sharing, a device's session close-out in ./device). Its own module so the
 * ownership code ingest calls (../offboarding/accounts) can take it without an import cycle.
 *
 * Lock order, for every writer: the acting/reporting user's row (ingest: FOR SHARE; offboarding and
 * restore: FOR NO KEY UPDATE) → the account locks, ascending ids → the account's rows, with
 * osrs_accounts written as late as possible and chunk-creating writes behind ./chunks' shared lock
 * (TSDB-12, D-55, D-58).
 */
import type { Tx } from '@hub/db';
import { sql } from 'drizzle-orm';

/** First key of the per-account advisory lock: 'OS'. The second is the account id (both int4). */
export const ACCOUNT_LOCK_CLASS = 0x4f53;

/**
 * Serializes all work on one account until commit. The caller's lock_timeout bounds the wait (55P03).
 * Both keys are int4 so the lock shares the (int4, int4) space with pg_advisory_lock(0x4f53, id).
 */
export async function lockAccount(tx: Tx, accountId: number): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_CLASS}::int4, ${accountId}::int4)`,
  );
}
