import {
  accountLinks,
  osrsAccounts,
  pgErrorCode,
  users,
  type Db,
  type OffboardReason,
  type Tx,
  type UserStatus,
} from '@hub/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { auditTransfer, findSuccessor, lockAccounts, setOwner, type AuditActor } from './accounts';

const LOCK_TIMEOUT = '10s';
const SYSTEM: AuditActor = { actorUserId: null, actorLabel: 'system' };

/** A continuous aggregate's materialization hypertable (schema-qualified). */
export interface MaterializationTable {
  schema: string;
  name: string;
}

/**
 * Hard-deletes users whose grace period expired: the user (cascades links, grants, settings,
 * sessions, devices, keys) and every account left with no active contributor, including its
 * continuous-aggregate rows (TSDB-2). Audit entries are anonymized by the FK (set null).
 */
export async function expireGracePeriods(
  db: Db,
  opts: { now?: Date },
): Promise<{ deletedUsers: number; deletedAccounts: number }> {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, 'grace'), lte(users.graceUntil, now)))
    .orderBy(asc(users.graceUntil), asc(users.id));
  if (due.length === 0) return { deletedUsers: 0, deletedAccounts: 0 };

  const caggTables = await accountMaterializationTables(db);
  let deletedUsers = 0;
  let deletedAccounts = 0;
  const failedCodes: string[] = [];
  // One transaction per user: a user that fails (lock timeout, …) doesn't hold back the others.
  for (const { id: userId } of due) {
    try {
      const deleted = await db.transaction((tx) => expireUser(tx, { userId, now, caggTables }));
      if (deleted !== null) {
        deletedUsers++;
        deletedAccounts += deleted;
      }
    } catch (err) {
      failedCodes.push(pgErrorCode(err) ?? 'unknown');
    }
  }
  if (failedCodes.length > 0) {
    // Codes only: a DB error's message carries bound parameters (DB-3).
    throw new Error(
      `expireGracePeriods: ${failedCodes.length} of ${due.length} users failed (${failedCodes.join(', ')}); ${deletedUsers} deleted`,
    );
  }
  return { deletedUsers, deletedAccounts };
}

/**
 * The materialization hypertables of every continuous aggregate in the current schema that has an
 * `account_id` column (xp_hourly and xp_daily today). The FK cascade from osrs_accounts removes raw
 * rows, but a cagg keeps its materialized rows, and the cagg itself is a view that can't be deleted
 * from: see TSDB-2.
 */
export async function accountMaterializationTables(db: Db | Tx): Promise<MaterializationTable[]> {
  const res = await db.execute<{ schema: string; name: string }>(sql`
    SELECT ca.materialization_hypertable_schema AS schema,
           ca.materialization_hypertable_name AS name
    FROM timescaledb_information.continuous_aggregates ca
    WHERE ca.view_schema = current_schema()
      AND EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = ca.materialization_hypertable_schema
          AND c.table_name = ca.materialization_hypertable_name
          AND c.column_name = 'account_id')
    ORDER BY ca.view_name`);
  return res.rows.map((r) => ({ schema: r.schema, name: r.name }));
}

/**
 * Deletes accounts and everything they own: the FK cascade covers the plain tables and the raw
 * hypertables (xp_samples, location_samples, …), and the aggregates' materialized rows are deleted
 * explicitly (TSDB-2). raw_payloads has no FK; its retention policy removes those rows (D-40).
 */
export async function deleteAccounts(
  tx: Tx,
  accountIds: readonly number[],
  caggTables: readonly MaterializationTable[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const ids = [...accountIds];
  await tx.delete(osrsAccounts).where(inArray(osrsAccounts.id, ids));
  for (const t of caggTables) {
    await tx.execute(
      sql`DELETE FROM ${sql.identifier(t.schema)}.${sql.identifier(t.name)} WHERE ${inArray(sql`account_id`, ids)}`,
    );
  }
}

/**
 * Deletes one expired user and settles the accounts linked to them; returns the number of accounts
 * deleted, or null when the user was restored (or deleted) meanwhile.
 *
 * Each linked account is kept when a non-blocked link of another user who stays remains: an active
 * user keeps it outright, and a user still inside their own grace period keeps it until that period
 * ends (their return must find it, handoff §14.4). An account whose owner was the deleted user
 * passes to the best such user (findSuccessor: active first, then linked longest). Whether a user
 * stays is read from their row now, not from the run's list of due users: one who logged in since
 * that list was made is back (and must not lose the account), one whose grace also ended is leaving.
 * Everything else is deleted with its data.
 */
async function expireUser(
  tx: Tx,
  ctx: { userId: string; now: Date; caggTables: MaterializationTable[] },
): Promise<number | null> {
  const { userId, now } = ctx;
  await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
  const [user] = await tx
    .select({ offboardReason: users.offboardReason })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'grace'), lte(users.graceUntil, now)))
    .for('update');
  if (!user) return null;

  const accountIds = await linkedAccounts(tx, userId);
  await lockAccounts(tx, accountIds);
  await anonymizeAuditEntries(tx, userId);
  // Cascades links, grants, settings, sessions, OAuth accounts, devices, pairing codes and API keys;
  // sets osrs_accounts.owner_user_id and audit_log.actor_user_id to null.
  await tx.delete(users).where(eq(users.id, userId));

  const toDelete: number[] = [];
  for (const accountId of accountIds) {
    const [account] = await tx
      .select({
        publicId: osrsAccounts.publicId,
        ownerUserId: osrsAccounts.ownerUserId,
        ownerStatus: users.status,
        ownerGraceUntil: users.graceUntil,
      })
      .from(osrsAccounts)
      .leftJoin(users, eq(users.id, osrsAccounts.ownerUserId))
      .where(eq(osrsAccounts.id, accountId))
      .for('update', { of: osrsAccounts });
    if (!account) continue;
    // An owner who stays (active, or in a grace period that hasn't ended) keeps the account as is.
    if (staysAt(account.ownerStatus, account.ownerGraceUntil, now)) continue;
    const successor = await findSuccessor(tx, accountId, {
      exclude: [],
      graceUntilAfter: now,
    });
    if (!successor) {
      toDelete.push(accountId);
    } else if (account.ownerUserId === null) {
      await setOwner(tx, accountId, successor, now);
      // `from` stays null: the deleted user's id is not kept anywhere.
      await auditTransfer(tx, SYSTEM, account, {
        from: null,
        to: successor.userId,
        reason: 'grace_expired',
      });
    }
    // else: its owner's grace period has ended too; their own expiry (later in this run, or the
    // next one if it fails) transfers the account.
  }
  await deleteAccounts(tx, toDelete, ctx.caggTables);
  await auditDeleted(tx, user.offboardReason, toDelete.length, accountIds.length);
  return toDelete.length;
}

/** Whether a user (an owner, here) stays past `now`: active, or in a grace period not yet over. */
function staysAt(status: UserStatus | null, graceUntil: Date | null, now: Date): boolean {
  if (status === 'active') return true;
  return status === 'grace' && graceUntil !== null && graceUntil > now;
}

/** Accounts the user is linked to or owns, ascending. */
async function linkedAccounts(tx: Tx, userId: string): Promise<number[]> {
  // One statement: a transaction is one pg client, and Promise.all on it overlaps queries (DB-14).
  const rows = await tx
    .select({ id: accountLinks.accountId })
    .from(accountLinks)
    .where(eq(accountLinks.userId, userId))
    .union(
      tx
        .select({ id: osrsAccounts.id })
        .from(osrsAccounts)
        .where(eq(osrsAccounts.ownerUserId, userId)),
    );
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

/**
 * "Audit entries are anonymized" (handoff §14.5). The FK only nulls actor_user_id; the user's id also
 * sits in target_id of entries about them and in meta values (from/to, userId, ownerUserId, …), and
 * actor_label may hold a display-name snapshot of theirs. All of those become null. Runs before the
 * delete, while actor_user_id still identifies their own entries.
 */
async function anonymizeAuditEntries(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE audit_log SET target_id = NULL
    WHERE target_type = 'user' AND target_id = ${userId}`);
  await tx.execute(sql`
    UPDATE audit_log SET actor_label = NULL
    WHERE actor_user_id = ${userId} AND actor_label IS NOT NULL`);
  await tx.execute(sql`
    UPDATE audit_log AS a
    SET meta = (
      SELECT jsonb_object_agg(
        e.key, CASE WHEN e.value = to_jsonb(${userId}::text) THEN 'null'::jsonb ELSE e.value END)
      FROM jsonb_each(a.meta) AS e)
    WHERE jsonb_typeof(a.meta) = 'object'
      AND EXISTS (
        SELECT 1 FROM jsonb_each(a.meta) AS e WHERE e.value = to_jsonb(${userId}::text))`);
}

async function auditDeleted(
  tx: Tx,
  reason: OffboardReason | null,
  accountsDeleted: number,
  accountsLinked: number,
): Promise<void> {
  await audit(tx, {
    ...SYSTEM,
    action: 'user.deleted',
    targetType: 'user',
    targetId: null,
    meta: { reason, accountsDeleted, accountsKept: accountsLinked - accountsDeleted },
  });
}
