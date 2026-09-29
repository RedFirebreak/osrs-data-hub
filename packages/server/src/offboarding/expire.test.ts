import {
  accountLinks,
  accountShareGrants,
  accountSharing,
  apiKeys,
  auditLog,
  devices,
  events,
  latestState,
  osrsAccounts,
  session,
  userSettings,
  users,
  xpSamples,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMaterializationTables, deleteAccounts, expireGracePeriods } from './expire';
import {
  refreshXpAggregates,
  seedAccount,
  seedApiKey,
  seedAudit,
  seedDevice,
  seedLink,
  seedSession,
  seedUser,
  seedXp,
  type SeededAccount,
} from './test-support';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('expire');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const HOUR = 3_600_000;
const XP_BUCKETS = ['2026-01-10T10:00:00Z', '2026-01-10T11:05:00Z', '2026-01-11T09:00:00Z'];

async function viewCount(view: 'xp_hourly' | 'xp_daily', accountId: number): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(view)} WHERE account_id = ${accountId}`,
  );
  return res.rows[0]?.n ?? -1;
}

async function materializedCount(accountId: number): Promise<number> {
  let n = 0;
  for (const m of await accountMaterializationTables(t.db)) {
    const res = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(m.schema)}.${sql.identifier(m.name)} WHERE account_id = ${accountId}`,
    );
    n += res.rows[0]?.n ?? 0;
  }
  return n;
}

/**
 * Queries issued on a pg client while another one is still running on it. pg 8 queues them with a
 * one-time deprecation warning and pg 9 drops the queue (DB-14); a pool query takes its own client,
 * so only concurrent queries on one transaction count.
 */
async function countOverlappingQueries(run: () => Promise<unknown>): Promise<number> {
  type Query = (this: object, ...args: unknown[]) => unknown;
  const proto = pg.Client.prototype as unknown as { query: Query };
  const original = proto.query;
  const running = new WeakMap<object, number>();
  let overlaps = 0;
  proto.query = function (this: object, ...args: unknown[]) {
    const n = running.get(this) ?? 0;
    if (n > 0) overlaps++;
    running.set(this, n + 1);
    const done = () => running.set(this, (running.get(this) ?? 1) - 1);
    const last = args.at(-1);
    // pg-pool's pool.query() uses the callback form; drizzle's transactions the promise form.
    if (typeof last === 'function') {
      const callback = last as (...a: unknown[]) => unknown;
      return original.apply(this, [
        ...args.slice(0, -1),
        (...res: unknown[]) => {
          done();
          return callback(...res);
        },
      ]);
    }
    return (original.apply(this, args) as Promise<unknown>).finally(done);
  };
  try {
    await run();
  } finally {
    proto.query = original;
  }
  return overlaps;
}

async function accountExists(id: number): Promise<boolean> {
  const rows = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.id, id));
  return rows.length > 0;
}

async function accountRow(id: number) {
  const [row] = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.id, id));
  return row;
}

describe('accountMaterializationTables', () => {
  it('finds the materialization hypertables of xp_hourly and xp_daily', async () => {
    const tables = await accountMaterializationTables(t.db);
    expect(tables).toHaveLength(2);
    for (const m of tables) {
      expect(m.schema).toBe('_timescaledb_internal');
      expect(m.name).toMatch(/^_materialized_hypertable_\d+$/);
    }
  });

  it('is needed: the FK cascade alone leaves materialized rows behind (TSDB-2)', async () => {
    const account = await seedAccount(t.db);
    await seedXp(t.db, account.id, XP_BUCKETS);
    await refreshXpAggregates(t.db);
    await t.db.delete(osrsAccounts).where(eq(osrsAccounts.id, account.id));
    expect(
      await t.db.select().from(xpSamples).where(eq(xpSamples.accountId, account.id)),
    ).toHaveLength(0);
    expect(await materializedCount(account.id)).toBeGreaterThan(0);
    expect(await viewCount('xp_hourly', account.id)).toBe(3);

    const tables = await accountMaterializationTables(t.db);
    await t.db.transaction((tx) => deleteAccounts(tx, [account.id], tables));
    expect(await materializedCount(account.id)).toBe(0);
    expect(await viewCount('xp_hourly', account.id)).toBe(0);
    expect(await viewCount('xp_daily', account.id)).toBe(0);
  });
});

describe('expireGracePeriods', () => {
  let expired: string;
  let expiresNow: string;
  let pending: string;
  let active: string;
  let activeOwner: string;
  let blockedActive: string;
  let expiredDevice: string;
  const acc: Record<string, SeededAccount> = {};

  beforeAll(async () => {
    expired = await seedUser(t.db, {
      name: 'Expired Name',
      status: 'grace',
      graceUntil: new Date(NOW.getTime() - HOUR),
      offboardReason: 'left_guild',
    });
    expiresNow = await seedUser(t.db, {
      status: 'grace',
      graceUntil: NOW,
      offboardReason: 'lost_role',
    });
    pending = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date(NOW.getTime() + 10 * 24 * HOUR),
      offboardReason: 'left_guild',
    });
    active = await seedUser(t.db);
    activeOwner = await seedUser(t.db);
    blockedActive = await seedUser(t.db);

    expiredDevice = await seedDevice(t.db, expired, {
      revokedAt: NOW,
      revokedReason: 'offboarding',
    });
    await seedSession(t.db, expired);
    await seedApiKey(t.db, expired);
    await t.db.insert(userSettings).values({ userId: expired, timezone: 'Europe/Amsterdam' });

    // Owned, no one else: deleted with all its data.
    acc.lonely = await seedAccount(t.db, { owner: expired, status: 'hidden' });
    // Owned, an active user linked meanwhile: kept, passes to them and becomes visible.
    acc.adopted = await seedAccount(t.db, { owner: expired, status: 'hidden' });
    await seedLink(t.db, acc.adopted.id, active);
    // Contributor on an active user's account: kept untouched.
    acc.contributed = await seedAccount(t.db, { owner: activeOwner });
    await seedLink(t.db, acc.contributed.id, expired);
    // Contributor on the account of someone still in grace: kept for their return.
    acc.pendingOwned = await seedAccount(t.db, { owner: pending, status: 'hidden' });
    await seedLink(t.db, acc.pendingOwned.id, expired);
    // Owned, only someone in grace linked: kept, hidden, passes to them.
    acc.toPending = await seedAccount(t.db, { owner: expired, status: 'hidden' });
    await seedLink(t.db, acc.toPending.id, pending);
    // Owned, only a blocked active contributor: a blocked link doesn't keep an account.
    acc.blockedOnly = await seedAccount(t.db, { owner: expired, status: 'hidden' });
    await seedLink(t.db, acc.blockedOnly.id, blockedActive, { blocked: true });
    // Shared by two users expiring in the same run: deleted.
    acc.shared = await seedAccount(t.db, { owner: expiresNow, status: 'hidden' });
    await seedLink(t.db, acc.shared.id, expired);

    for (const a of [acc.lonely, acc.adopted]) {
      await seedXp(t.db, a.id, XP_BUCKETS);
      await t.db.insert(latestState).values({ accountId: a.id, lastSeen: NOW });
      await t.db.insert(events).values({
        pluginEventId: `e-${a.id}`,
        accountId: a.id,
        deviceId: expiredDevice,
        type: 'loot',
        occurredAt: NOW,
        receivedAt: NOW,
        data: { type: 'loot' },
      });
    }
    await refreshXpAggregates(t.db);

    await seedAudit(t.db, {
      action: 'user.offboarded',
      actorLabel: 'worker',
      targetType: 'user',
      targetId: expired,
      meta: { reason: 'left_guild' },
    });
    await seedAudit(t.db, {
      action: 'sharing.changed',
      actorUserId: expired,
      actorLabel: 'Expired Name',
      targetType: 'osrs_account',
      targetId: acc.lonely.publicId,
      meta: { category: 'stats' },
    });
    await seedAudit(t.db, {
      action: 'account.ownership_transferred',
      actorLabel: 'system',
      targetType: 'osrs_account',
      targetId: acc.contributed.publicId,
      meta: { from: expired, to: activeOwner, reason: 'offboarding' },
    });
  });

  it('materialized XP rows exist before expiry (the TSDB-2 setup)', async () => {
    expect(await materializedCount(acc.lonely!.id)).toBeGreaterThan(0);
    expect(await viewCount('xp_hourly', acc.lonely!.id)).toBe(3);
    expect(await viewCount('xp_daily', acc.lonely!.id)).toBe(2);
  });

  it('deletes expired users and the accounts left without anyone to keep them', async () => {
    const result = await expireGracePeriods(t.db, { now: NOW });

    expect(result).toEqual({ deletedUsers: 2, deletedAccounts: 3 });
    const remaining = await t.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [expired, expiresNow, pending, active]));
    expect(remaining.map((r) => r.id).sort()).toEqual([pending, active].sort());

    for (const key of ['lonely', 'blockedOnly', 'shared']) {
      expect(await accountExists(acc[key]!.id), key).toBe(false);
    }
    for (const key of ['adopted', 'contributed', 'pendingOwned', 'toPending']) {
      expect(await accountExists(acc[key]!.id), key).toBe(true);
    }
  });

  it("cascades the users' rows", async () => {
    expect(await t.db.select().from(devices).where(eq(devices.userId, expired))).toHaveLength(0);
    expect(await t.db.select().from(session).where(eq(session.userId, expired))).toHaveLength(0);
    expect(await t.db.select().from(apiKeys).where(eq(apiKeys.userId, expired))).toHaveLength(0);
    expect(
      await t.db.select().from(userSettings).where(eq(userSettings.userId, expired)),
    ).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(accountLinks)
        .where(inArray(accountLinks.userId, [expired, expiresNow])),
    ).toHaveLength(0);
  });

  it("deletes a deleted account's data including its continuous-aggregate rows (TSDB-2)", async () => {
    const id = acc.lonely!.id;
    expect(await t.db.select().from(xpSamples).where(eq(xpSamples.accountId, id))).toHaveLength(0);
    expect(await t.db.select().from(events).where(eq(events.accountId, id))).toHaveLength(0);
    expect(await t.db.select().from(latestState).where(eq(latestState.accountId, id))).toHaveLength(
      0,
    );
    expect(await materializedCount(id)).toBe(0);
    expect(await viewCount('xp_hourly', id)).toBe(0);
    expect(await viewCount('xp_daily', id)).toBe(0);
  });

  it('keeps the full history of an account that passes to an active user', async () => {
    const id = acc.adopted!.id;
    expect(await accountRow(id)).toMatchObject({
      ownerUserId: active,
      status: 'active',
      hiddenAt: null,
    });
    const links = await t.db.select().from(accountLinks).where(eq(accountLinks.accountId, id));
    expect(links.map((l) => [l.userId, l.role])).toEqual([[active, 'owner']]);
    expect(await t.db.select().from(xpSamples).where(eq(xpSamples.accountId, id))).toHaveLength(3);
    expect(await viewCount('xp_hourly', id)).toBe(3);
    expect(await materializedCount(id)).toBeGreaterThan(0);
    const [event] = await t.db.select().from(events).where(eq(events.accountId, id));
    expect(event?.deviceId).toBeNull();
    const [transfer] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'account.ownership_transferred'),
          eq(auditLog.targetId, acc.adopted!.publicId),
        ),
      );
    expect(transfer).toMatchObject({
      actorLabel: 'system',
      meta: { from: null, to: active, reason: 'grace_expired' },
    });
  });

  it('keeps accounts for users still inside their grace period', async () => {
    expect(await accountRow(acc.pendingOwned!.id)).toMatchObject({
      ownerUserId: pending,
      status: 'hidden',
    });
    expect(await accountRow(acc.toPending!.id)).toMatchObject({
      ownerUserId: pending,
      status: 'hidden',
    });
    expect(await accountRow(acc.contributed!.id)).toMatchObject({
      ownerUserId: activeOwner,
      status: 'active',
    });
  });

  it('writes an anonymized user.deleted entry per user and scrubs the id from older ones', async () => {
    const deleted = await t.db.select().from(auditLog).where(eq(auditLog.action, 'user.deleted'));
    expect(deleted).toHaveLength(2);
    for (const entry of deleted) {
      expect(entry).toMatchObject({ actorUserId: null, actorLabel: 'system', targetId: null });
    }
    const metas = deleted
      .map((e) => e.meta)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(metas).toEqual([
      // 'shared' goes with the first of its two expiring users; the second finds nothing left.
      { reason: 'left_guild', accountsDeleted: 3, accountsKept: 4 },
      { reason: 'lost_role', accountsDeleted: 0, accountsKept: 0 },
    ]);

    const all = await t.db.select().from(auditLog);
    const text = JSON.stringify(all);
    expect(text).not.toContain(expired);
    expect(text).not.toContain('Expired Name');
    const [offboarded] = all.filter((e) => e.action === 'user.offboarded');
    expect(offboarded).toMatchObject({ targetType: 'user', targetId: null, actorLabel: 'worker' });
    const [changed] = all.filter((e) => e.action === 'sharing.changed');
    expect(changed).toMatchObject({
      actorUserId: null,
      actorLabel: null,
      meta: { category: 'stats' },
    });
    const transfer = all.find(
      (e) =>
        e.action === 'account.ownership_transferred' && e.targetId === acc.contributed!.publicId,
    );
    expect(transfer?.meta).toEqual({ from: null, to: activeOwner, reason: 'offboarding' });
  });

  it('does nothing on the next run', async () => {
    await expect(expireGracePeriods(t.db, { now: NOW })).resolves.toEqual({
      deletedUsers: 0,
      deletedAccounts: 0,
    });
  });

  it('removes an account left behind once its last grace user expires', async () => {
    const later = new Date(NOW.getTime() + 11 * 24 * HOUR);
    const result = await expireGracePeriods(t.db, { now: later });
    expect(result).toEqual({ deletedUsers: 1, deletedAccounts: 2 });
    expect(await accountExists(acc.pendingOwned!.id)).toBe(false);
    expect(await accountExists(acc.toPending!.id)).toBe(false);
    expect(await accountExists(acc.adopted!.id)).toBe(true);
  });

  it('never runs two queries at once on its transaction client (DB-14)', async () => {
    const user = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date(NOW.getTime() - HOUR),
    });
    const other = await seedUser(t.db);
    const owned = await seedAccount(t.db, { owner: user });
    const linked = await seedAccount(t.db, { owner: other });
    await seedLink(t.db, linked.id, user);

    const overlaps = await countOverlappingQueries(() => expireGracePeriods(t.db, { now: NOW }));

    expect(overlaps).toBe(0);
    expect(await accountExists(owned.id)).toBe(false);
    expect(await accountExists(linked.id)).toBe(true);
  });

  it('keeps an account for a co-reporter who came back after the run listed them as expiring', async () => {
    const first = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date(NOW.getTime() - 2 * HOUR),
    });
    const returning = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date(NOW.getTime() - HOUR),
    });
    const shared = await seedAccount(t.db, { owner: first, status: 'hidden' });
    await seedLink(t.db, shared.id, returning, { firstSeen: new Date('2026-02-01') });
    // `returning` logs in (restoreUser) while the run is already under way: here, the moment the
    // first user's row is deleted.
    await t.db.execute(
      sql.raw(`
        CREATE FUNCTION test_restore_on_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE users SET status = 'active', grace_until = NULL, offboard_reason = NULL
          WHERE id = '${returning}';
          RETURN OLD;
        END $$;
        CREATE TRIGGER test_restore_on_delete AFTER DELETE ON users
          FOR EACH ROW WHEN (OLD.id = '${first}') EXECUTE FUNCTION test_restore_on_delete();`),
    );
    try {
      const result = await expireGracePeriods(t.db, { now: NOW });

      expect(result).toEqual({ deletedUsers: 1, deletedAccounts: 0 });
      expect(await accountRow(shared.id)).toMatchObject({
        ownerUserId: returning,
        status: 'active',
        hiddenAt: null,
      });
    } finally {
      await t.db.execute(sql`DROP TRIGGER test_restore_on_delete ON users`);
      await t.db.execute(sql`DROP FUNCTION test_restore_on_delete()`);
    }
  });

  it("removes the user's grants on accounts that stay, and the deleted accounts' sharing", async () => {
    const leaving = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date(NOW.getTime() - HOUR),
    });
    const owner = await seedUser(t.db);
    const kept = await seedAccount(t.db, { owner });
    const gone = await seedAccount(t.db, { owner: leaving, status: 'hidden' });
    await t.db.insert(accountShareGrants).values([
      { accountId: kept.id, category: 'inventory', granteeUserId: leaving },
      { accountId: kept.id, category: 'equipment', granteeUserId: owner },
      { accountId: gone.id, category: 'inventory', granteeUserId: owner },
    ]);
    await t.db.insert(accountSharing).values([
      { accountId: kept.id, category: 'inventory', audience: 'selected' },
      { accountId: gone.id, category: 'inventory', audience: 'selected' },
    ]);

    expect(await expireGracePeriods(t.db, { now: NOW })).toEqual({
      deletedUsers: 1,
      deletedAccounts: 1,
    });

    const grants = await t.db
      .select({
        accountId: accountShareGrants.accountId,
        grantee: accountShareGrants.granteeUserId,
      })
      .from(accountShareGrants)
      .where(inArray(accountShareGrants.accountId, [kept.id, gone.id]));
    expect(grants).toEqual([{ accountId: kept.id, grantee: owner }]);
    const sharing = await t.db
      .select({ accountId: accountSharing.accountId })
      .from(accountSharing)
      .where(inArray(accountSharing.accountId, [kept.id, gone.id]));
    expect(sharing).toEqual([{ accountId: kept.id }]);
  });

  it('skips a user who is no longer in grace', async () => {
    const restored = await seedUser(t.db, { graceUntil: new Date(NOW.getTime() - HOUR) });
    const result = await expireGracePeriods(t.db, { now: NOW });
    expect(result).toEqual({ deletedUsers: 0, deletedAccounts: 0 });
    expect(await t.db.select().from(users).where(eq(users.id, restored))).toHaveLength(1);
  });
});
