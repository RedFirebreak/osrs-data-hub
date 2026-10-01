import { DAY_MS } from '@hub/core';
import { osrsAccounts, pgErrorCode, type Db, type Tx } from '@hub/db';
import { sql } from 'drizzle-orm';
import { SYSTEM_ACTOR, audit } from '../audit';
import { getMetrics, type HubMetrics } from '../metrics';
import { lockAccounts } from './accounts';
import { accountMaterializationTables, deleteAccounts, type MaterializationTable } from './expire';

const LOCK_TIMEOUT = '10s';
const DEFAULT_BATCH = 200;

/**
 * An account nobody can reclaim: no owner, and no non-blocked link to any user. Links cascade away
 * with deleted users and a user in grace still owns or links their accounts, so "no owner and no
 * non-blocked link" means no existing user who could take it over (blocked contributors can't: their
 * payloads are dropped and ownership never passes to them).
 */
const orphaned = (cutoff: Date) => sql`
  ${osrsAccounts.ownerUserId} IS NULL
  AND coalesce(${osrsAccounts.hiddenAt}, ${osrsAccounts.lastSeen}) < ${cutoff}
  AND NOT EXISTS (
    SELECT 1 FROM account_links l
    WHERE l.account_id = ${osrsAccounts.id} AND NOT l.blocked)`;

/**
 * Time-gated purge of orphaned accounts (D-61). Hard-deletes every account with no owner and no
 * non-blocked link once it has been hidden, or if never hidden unseen, for `graceDays`
 * (`coalesce(hidden_at, last_seen) < now − graceDays`), with all its data including the continuous
 * aggregates' materialized rows (TSDB-2).
 *
 * Accounts whose owner is in grace are not touched here: that owner's grace expiry settles them
 * (transfer to a successor, or delete, handoff §14.5). What is left for this job: bare rows from a
 * refused first payload, and accounts left with only blocked contributors. Without it their data would
 * stay forever and never be matched again.
 *
 * Each account is re-checked under ingest's per-account lock before it is deleted, so a payload that
 * links a user in the meantime keeps it. One transaction per account; failures are collected and
 * reported by SQLSTATE only (DB-3). Each purged account counts in
 * hub_accounts_deleted_total{cause="orphan_purge"}.
 */
export async function purgeOrphanedAccounts(
  db: Db,
  opts: { graceDays: number; now?: Date; batchSize?: number; metrics?: HubMetrics },
): Promise<{ purged: number }> {
  if (!Number.isInteger(opts.graceDays) || opts.graceDays < 0) {
    throw new Error('purgeOrphanedAccounts: graceDays must be a whole number >= 0');
  }
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.graceDays * DAY_MS);
  const candidates = await db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(orphaned(cutoff))
    .orderBy(osrsAccounts.id)
    .limit(opts.batchSize ?? DEFAULT_BATCH);
  if (candidates.length === 0) return { purged: 0 };

  const metrics = opts.metrics ?? getMetrics();
  const caggTables = await accountMaterializationTables(db);
  let purged = 0;
  const failedCodes: string[] = [];
  for (const { id } of candidates) {
    try {
      if (
        await db.transaction((tx) =>
          purgeAccount(tx, id, { cutoff, graceDays: opts.graceDays, caggTables }),
        )
      ) {
        purged++;
        metrics.accountsDeleted.inc({ cause: 'orphan_purge' });
      }
    } catch (err) {
      failedCodes.push(pgErrorCode(err) ?? 'unknown');
    }
  }
  if (failedCodes.length > 0) {
    throw new Error(
      `purgeOrphanedAccounts: ${failedCodes.length} of ${candidates.length} accounts failed (${failedCodes.join(', ')}); ${purged} purged`,
    );
  }
  return { purged };
}

/**
 * Deletes one account if it is still orphaned under the account lock; returns whether it did.
 * Exported for tests (the re-check is what keeps a concurrently linked account).
 */
export async function purgeAccount(
  tx: Tx,
  accountId: number,
  ctx: { cutoff: Date; graceDays: number; caggTables: readonly MaterializationTable[] },
): Promise<boolean> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
  // Ingest's lock first (lock order: account lock → rows, see ingest/lock.ts and TSDB-12).
  await lockAccounts(tx, [accountId]);
  const [still] = await tx
    .select({ publicId: osrsAccounts.publicId, hiddenAt: osrsAccounts.hiddenAt })
    .from(osrsAccounts)
    .where(sql`${osrsAccounts.id} = ${accountId} AND ${orphaned(ctx.cutoff)}`)
    .for('update');
  if (!still) return false;
  await deleteAccounts(tx, [accountId], ctx.caggTables);
  await audit(tx, {
    ...SYSTEM_ACTOR,
    action: 'account.purged',
    targetType: 'osrs_account',
    targetId: still.publicId,
    meta: { reason: 'orphaned', wasHidden: still.hiddenAt !== null, graceDays: ctx.graceDays },
  });
  return true;
}
