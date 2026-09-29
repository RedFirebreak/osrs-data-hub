import { accountLinks, apiKeys, auditLog, devices, osrsAccounts, session, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_LOCK_CLASS } from '../ingest/store';
import { nextGraceState, offboardUser, restoreUser } from './offboard';
import {
  seedAccount,
  seedApiKey,
  seedDevice,
  seedLink,
  seedSession,
  seedUser,
} from './test-support';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('offboard');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 86_400_000;

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row;
}

async function accountRow(id: number) {
  const [row] = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.id, id));
  return row;
}

async function roles(accountId: number) {
  const rows = await t.db
    .select({ userId: accountLinks.userId, role: accountLinks.role })
    .from(accountLinks)
    .where(eq(accountLinks.accountId, accountId));
  return Object.fromEntries(rows.map((r) => [r.userId, r.role]));
}

async function audits(action: string, targetId?: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, action), targetId ? eq(auditLog.targetId, targetId) : undefined),
    );
}

describe('nextGraceState', () => {
  const until30 = new Date(NOW.getTime() + 30 * DAY);
  const until7 = new Date(NOW.getTime() + 7 * DAY);

  it('starts a grace period for an active user', () => {
    expect(
      nextGraceState(
        { status: 'active', graceUntil: null, offboardReason: null },
        'lost_role',
        until30,
      ),
    ).toEqual({ graceUntil: until30, reason: 'lost_role', changed: true });
  });

  it('keeps the earliest grace_until and the first membership reason', () => {
    const inGrace = {
      status: 'grace' as const,
      graceUntil: until7,
      offboardReason: 'left_guild' as const,
    };
    expect(nextGraceState(inGrace, 'lost_role', until30)).toEqual({
      graceUntil: until7,
      reason: 'left_guild',
      changed: false,
    });
    const later = { ...inGrace, graceUntil: until30 };
    expect(nextGraceState(later, 'left_guild', until7)).toEqual({
      graceUntil: until7,
      reason: 'left_guild',
      changed: true,
    });
  });

  it("lets 'admin' replace any reason and nothing replace 'admin' (D-35)", () => {
    const left = {
      status: 'grace' as const,
      graceUntil: until7,
      offboardReason: 'left_guild' as const,
    };
    expect(nextGraceState(left, 'admin', until30)).toMatchObject({
      reason: 'admin',
      changed: true,
    });
    const admin = { ...left, offboardReason: 'admin' as const };
    expect(nextGraceState(admin, 'left_guild', until30)).toMatchObject({
      reason: 'admin',
      changed: false,
    });
  });

  it('treats a grace user without grace_until as a fresh offboarding', () => {
    expect(
      nextGraceState({ status: 'grace', graceUntil: null, offboardReason: null }, 'admin', until7),
    ).toEqual({ graceUntil: until7, reason: 'admin', changed: true });
  });
});

describe('offboardUser', () => {
  it('moves the user to grace and revokes devices, API keys and sessions', async () => {
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const d1 = await seedDevice(t.db, userId);
    const earlier = new Date('2026-09-01T00:00:00Z');
    const d2 = await seedDevice(t.db, userId, { revokedAt: earlier, revokedReason: 'user' });
    const otherDevice = await seedDevice(t.db, other);
    const key = await seedApiKey(t.db, userId);
    await seedSession(t.db, userId);
    await seedSession(t.db, userId);
    const otherSession = await seedSession(t.db, other);

    const result = await offboardUser(t.db, {
      userId,
      reason: 'left_guild',
      graceDays: 30,
      now: NOW,
      actorLabel: 'worker',
    });

    expect(result).toEqual({ transferred: [], hidden: [], revokedDevices: 1, deletedSessions: 2 });
    expect(await userRow(userId)).toMatchObject({
      status: 'grace',
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
      offboardReason: 'left_guild',
    });
    const devs = await t.db
      .select({ id: devices.id, revokedAt: devices.revokedAt, reason: devices.revokedReason })
      .from(devices)
      .where(inArray(devices.id, [d1, d2, otherDevice]));
    const byId = Object.fromEntries(devs.map((d) => [d.id, d]));
    expect(byId[d1]).toMatchObject({ revokedAt: NOW, reason: 'offboarding' });
    // An already revoked device keeps its original time and reason.
    expect(byId[d2]).toMatchObject({ revokedAt: earlier, reason: 'user' });
    expect(byId[otherDevice]).toMatchObject({ revokedAt: null, reason: null });
    const [k] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, key));
    expect(k?.revokedAt).toEqual(NOW);
    expect(await t.db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    expect(await t.db.select().from(session).where(eq(session.id, otherSession))).toHaveLength(1);

    const [entry] = await audits('user.offboarded', userId);
    expect(entry).toMatchObject({
      actorUserId: null,
      actorLabel: 'worker',
      targetType: 'user',
      meta: {
        reason: 'left_guild',
        graceUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
        transferred: 0,
        hidden: 0,
        revokedDevices: 1,
        revokedApiKeys: 1,
        deletedSessions: 2,
      },
    });
  });

  it('transfers each owned account to the active, non-blocked contributor linked longest', async () => {
    const owner = await seedUser(t.db);
    const newest = await seedUser(t.db);
    const longest = await seedUser(t.db);
    const blocked = await seedUser(t.db);
    const inGrace = await seedUser(t.db, { status: 'grace', graceUntil: new Date('2026-10-01') });
    const account = await seedAccount(t.db, { owner });
    await seedLink(t.db, account.id, newest, { firstSeen: new Date('2026-03-01') });
    await seedLink(t.db, account.id, longest, { firstSeen: new Date('2026-01-01') });
    await seedLink(t.db, account.id, blocked, { firstSeen: new Date('2025-06-01'), blocked: true });
    await seedLink(t.db, account.id, inGrace, { firstSeen: new Date('2025-01-01') });

    const result = await offboardUser(t.db, {
      userId: owner,
      reason: 'lost_role',
      graceDays: 30,
      now: NOW,
    });

    expect(result.transferred).toEqual([account.id]);
    expect(result.hidden).toEqual([]);
    expect(await accountRow(account.id)).toMatchObject({
      ownerUserId: longest,
      status: 'active',
      hiddenAt: null,
    });
    expect(await roles(account.id)).toEqual({
      [owner]: 'contributor',
      [newest]: 'contributor',
      [longest]: 'owner',
      [blocked]: 'contributor',
      [inGrace]: 'contributor',
    });
    const [entry] = await audits('account.ownership_transferred', account.publicId);
    expect(entry).toMatchObject({
      actorLabel: 'system',
      targetType: 'osrs_account',
      meta: { from: owner, to: longest, reason: 'offboarding' },
    });
  });

  it('hides an owned account without an active contributor and leaves others alone', async () => {
    const owner = await seedUser(t.db);
    const blocked = await seedUser(t.db);
    const inGrace = await seedUser(t.db, { status: 'grace', graceUntil: new Date('2026-10-01') });
    const someoneElse = await seedUser(t.db);
    const lonely = await seedAccount(t.db, { owner });
    await seedLink(t.db, lonely.id, blocked, { blocked: true });
    await seedLink(t.db, lonely.id, inGrace);
    const notOwned = await seedAccount(t.db, { owner: someoneElse });
    await seedLink(t.db, notOwned.id, owner);

    const result = await offboardUser(t.db, {
      userId: owner,
      reason: 'left_guild',
      graceDays: 30,
      now: NOW,
    });

    expect(result).toMatchObject({ transferred: [], hidden: [lonely.id] });
    expect(await accountRow(lonely.id)).toMatchObject({
      ownerUserId: owner,
      status: 'hidden',
      hiddenAt: NOW,
    });
    expect(await accountRow(notOwned.id)).toMatchObject({
      ownerUserId: someoneElse,
      status: 'active',
    });
    expect(await roles(notOwned.id)).toEqual({ [someoneElse]: 'owner', [owner]: 'contributor' });
  });

  it('is idempotent for a user already in grace and keeps the earliest grace_until', async () => {
    const userId = await seedUser(t.db);
    await seedDevice(t.db, userId);
    const account = await seedAccount(t.db, { owner: userId });
    await offboardUser(t.db, { userId, reason: 'left_guild', graceDays: 30, now: NOW });

    const later = new Date(NOW.getTime() + 2 * DAY);
    const again = await offboardUser(t.db, {
      userId,
      reason: 'lost_role',
      graceDays: 30,
      now: later,
    });

    expect(again).toEqual({ transferred: [], hidden: [], revokedDevices: 0, deletedSessions: 0 });
    expect(await userRow(userId)).toMatchObject({
      status: 'grace',
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
      offboardReason: 'left_guild',
    });
    expect((await accountRow(account.id))?.hiddenAt).toEqual(NOW);
    expect(await audits('user.offboarded', userId)).toHaveLength(1);

    // A shorter grace period (e.g. a 7-day self-delete) moves the date earlier.
    await offboardUser(t.db, { userId, reason: 'self_delete', graceDays: 7, now: later });
    expect((await userRow(userId))?.graceUntil).toEqual(new Date(later.getTime() + 7 * DAY));
    expect(await audits('user.offboarded', userId)).toHaveLength(2);
  });

  it('transfers an account hidden earlier once an active contributor exists', async () => {
    const owner = await seedUser(t.db);
    const account = await seedAccount(t.db, { owner });
    await offboardUser(t.db, { userId: owner, reason: 'left_guild', graceDays: 30, now: NOW });
    const newcomer = await seedUser(t.db);
    await seedLink(t.db, account.id, newcomer);

    const result = await offboardUser(t.db, {
      userId: owner,
      reason: 'admin',
      graceDays: 30,
      now: NOW,
      actorUserId: newcomer,
    });

    expect(result.transferred).toEqual([account.id]);
    expect(await accountRow(account.id)).toMatchObject({
      ownerUserId: newcomer,
      status: 'active',
      hiddenAt: null,
    });
    expect((await userRow(owner))?.offboardReason).toBe('admin');
    const entries = await audits('user.offboarded', owner);
    expect(entries.at(-1)).toMatchObject({ actorUserId: newcomer, actorLabel: null });
  });

  it('does nothing for an unknown user', async () => {
    const before = await t.db.select().from(auditLog);
    await expect(
      offboardUser(t.db, { userId: 'nobody', reason: 'admin', graceDays: 30, now: NOW }),
    ).resolves.toEqual({ transferred: [], hidden: [], revokedDevices: 0, deletedSessions: 0 });
    expect(await t.db.select().from(auditLog)).toHaveLength(before.length);
  });

  it('refuses a negative or non-finite grace period', async () => {
    const userId = await seedUser(t.db);
    await expect(
      offboardUser(t.db, { userId, reason: 'admin', graceDays: -1, now: NOW }),
    ).rejects.toThrow(RangeError);
    await expect(
      offboardUser(t.db, { userId, reason: 'admin', graceDays: Number.NaN, now: NOW }),
    ).rejects.toThrow(RangeError);
    expect((await userRow(userId))?.status).toBe('active');
  });
});

describe('restoreUser', () => {
  it('reactivates the user and un-hides only the accounts they own', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const contributor = await seedUser(t.db);
    const hiddenOwn = await seedAccount(t.db, { owner: userId });
    const transferred = await seedAccount(t.db, { owner: userId });
    await seedLink(t.db, transferred.id, contributor);
    const otherOwner = await seedUser(t.db, {
      status: 'grace',
      graceUntil: new Date('2026-10-20'),
    });
    const hiddenOther = await seedAccount(t.db, { owner: otherOwner, status: 'hidden' });
    await seedLink(t.db, hiddenOther.id, userId);
    await offboardUser(t.db, { userId, reason: 'left_guild', graceDays: 30, now: NOW });

    const result = await restoreUser(t.db, { userId, actorLabel: 'login' });

    expect(result).toEqual({ unhidden: [hiddenOwn.id] });
    expect(await userRow(userId)).toMatchObject({
      status: 'active',
      graceUntil: null,
      offboardReason: null,
    });
    expect(await accountRow(hiddenOwn.id)).toMatchObject({ status: 'active', hiddenAt: null });
    // Transferred accounts stay with their new owner; the returning user remains a contributor.
    expect(await accountRow(transferred.id)).toMatchObject({ ownerUserId: contributor });
    expect(await roles(transferred.id)).toEqual({
      [userId]: 'contributor',
      [contributor]: 'owner',
    });
    expect((await accountRow(hiddenOther.id))?.status).toBe('hidden');
    // Devices stay revoked: the player re-pairs through the wizard.
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.revokedReason).toBe('offboarding');
    const [entry] = await audits('user.restored', userId);
    expect(entry).toMatchObject({
      actorLabel: 'login',
      meta: { previousReason: 'left_guild', unhidden: 1 },
    });
  });

  it('is a no-op for an active or unknown user', async () => {
    const userId = await seedUser(t.db);
    expect(await restoreUser(t.db, { userId })).toEqual({ unhidden: [] });
    expect(await restoreUser(t.db, { userId: 'nobody' })).toEqual({ unhidden: [] });
    expect(await audits('user.restored', userId)).toHaveLength(0);
  });

  it('runs inside a caller transaction', async () => {
    const userId = await seedUser(t.db);
    await offboardUser(t.db, { userId, reason: 'lost_role', graceDays: 30, now: NOW });
    await t.db.transaction(async (tx) => {
      await restoreUser(tx, { userId, actorUserId: userId });
    });
    expect((await userRow(userId))?.status).toBe('active');
    const [entry] = await audits('user.restored', userId);
    expect(entry).toMatchObject({ actorUserId: userId, actorLabel: null });
  });
});

/** A promise and its resolve function, to hold a transaction open at a known point. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Resolves once `blocked()` holds, so the interleaving is the one the test intends. */
async function waitUntilBlocked(blocked: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await blocked()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the other transaction never blocked');
}

/** True while some backend of this test database waits on a lock. */
async function someoneWaitsForALock(): Promise<boolean> {
  const res = await t.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`);
  return (res.rows[0]?.n ?? 0) > 0;
}

describe('offboardUser concurrency', () => {
  it('revokes a device that a pairing creates while the offboarding waits', async () => {
    const userId = await seedUser(t.db);
    const inserted = gate();
    const release = gate();
    let deviceId = '';
    // What pairing's consumeCode does: the creator's row FOR SHARE, then the device.
    const pairing = t.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('share');
      const [row] = await tx
        .insert(devices)
        .values({ userId, tokenHash: `pair-${userId}` })
        .returning({ id: devices.id });
      deviceId = row!.id;
      inserted.open();
      await release.promise;
    });
    await inserted.promise;

    const offboarding = offboardUser(t.db, {
      userId,
      reason: 'left_guild',
      graceDays: 30,
      now: NOW,
    });
    await waitUntilBlocked(someoneWaitsForALock);
    release.open();
    await pairing;

    expect(await offboarding).toMatchObject({ revokedDevices: 1 });
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device).toMatchObject({ revokedAt: NOW, revokedReason: 'offboarding' });
  });

  it('does not deadlock with a payload for another account that creates a chunk (TSDB-12)', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const owned = await seedAccount(t.db, { owner: userId });
    const other = await seedAccount(t.db, { owner: await seedUser(t.db) });
    await seedLink(t.db, other.id, userId);
    const locked = gate();
    const release = gate();
    // Ingest for the account the user doesn't own: its lock, the device row, then an insert that
    // needs a new xp_samples chunk, which takes SHARE ROW EXCLUSIVE on osrs_accounts and so waits
    // for every open writer of that table.
    const ingest = t.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_CLASS}::int4, ${other.id}::int4)`,
      );
      await tx.update(devices).set({ lastSeenAt: NOW }).where(eq(devices.id, deviceId));
      locked.open();
      await release.promise;
      await tx.execute(sql`LOCK TABLE osrs_accounts IN SHARE ROW EXCLUSIVE MODE`);
    });
    await locked.promise;

    const offboarding = offboardUser(t.db, {
      userId,
      reason: 'left_guild',
      graceDays: 30,
      now: NOW,
    });
    await waitUntilBlocked(someoneWaitsForALock);
    release.open();

    const [ingestResult, offboardResult] = await Promise.allSettled([ingest, offboarding]);
    expect(ingestResult.status).toBe('fulfilled');
    expect(offboardResult).toEqual({
      status: 'fulfilled',
      value: { transferred: [], hidden: [owned.id], revokedDevices: 1, deletedSessions: 0 },
    });
  });

  it("waits for an in-flight ingest transaction on an owned account (ingest's lock order)", async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const account = await seedAccount(t.db, { owner: userId });
    const locked = gate();
    const release = gate();
    // What ingest's storeInTransaction does: the account lock, then the device row, then (later)
    // the account row.
    const ingest = t.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_CLASS}::int4, ${account.id}::int4)`,
      );
      await tx.select().from(devices).where(eq(devices.id, deviceId)).for('update');
      await tx.update(devices).set({ lastSeenAt: NOW }).where(eq(devices.id, deviceId));
      locked.open();
      await release.promise;
      await tx.update(osrsAccounts).set({ lastSeen: NOW }).where(eq(osrsAccounts.id, account.id));
    });
    await locked.promise;

    const offboarding = offboardUser(t.db, {
      userId,
      reason: 'left_guild',
      graceDays: 30,
      now: NOW,
    });
    await waitUntilBlocked(someoneWaitsForALock);
    release.open();
    await ingest;

    expect(await offboarding).toEqual({
      transferred: [],
      hidden: [account.id],
      revokedDevices: 1,
      deletedSessions: 0,
    });
    expect(await accountRow(account.id)).toMatchObject({ status: 'hidden', lastSeen: NOW });
  });
});
