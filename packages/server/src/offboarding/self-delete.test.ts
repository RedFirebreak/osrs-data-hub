/**
 * "Delete my data" (D-78): the confirmation word, who may use it, what it revokes at once, the
 * 7-day undo by signing in, and the hard delete once the 7 days are over.
 */
import { parseConfig, setConfigForTests } from '@hub/core';
import { apiKeys, auditLog, devices, osrsAccounts, session, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestMetrics } from '../metrics';
import { countsBy } from '../metrics-test-support';
import { expireGracePeriods } from './expire';
import {
  SELF_DELETE_UNDO_DAYS,
  SelfDeleteError,
  deleteMyData,
  isSelfDeleteConfirmation,
} from './self-delete';
import { recordSignIn, type SignInSnapshot } from './sign-in';
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
  t = await createTestDatabase('selfdelete');
});
afterAll(async () => {
  setConfigForTests(undefined);
  await t.drop();
});

const NOW = new Date('2026-09-29T10:00:00Z');
const DAY = 86_400_000;
const UNTIL = new Date(NOW.getTime() + SELF_DELETE_UNDO_DAYS * DAY);
const SNAPSHOT: SignInSnapshot = {
  name: 'Back again',
  image: 'https://cdn.discordapp.com/avatars/1/a.png',
  nickname: null,
  roles: [],
  isAdmin: false,
};

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row;
}

async function accountRow(id: number) {
  const [row] = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.id, id));
  return row;
}

async function offboardedEntries(userId: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'user.offboarded'), eq(auditLog.targetId, userId)));
}

async function refusal(promise: Promise<unknown>): Promise<SelfDeleteError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SelfDeleteError);
  return err as SelfDeleteError;
}

describe('isSelfDeleteConfirmation', () => {
  it('accepts the word "delete", trimmed and in any case', () => {
    for (const ok of ['delete', 'DELETE', ' Delete ', '\tdelete\n']) {
      expect(isSelfDeleteConfirmation(ok)).toBe(true);
    }
    for (const bad of ['', 'del', 'deleted', 'delete me', 'd e l e t e', null, undefined, 1]) {
      expect(isSelfDeleteConfirmation(bad)).toBe(false);
    }
  });
});

describe('deleteMyData', () => {
  it('refuses without the confirmation word and changes nothing', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    for (const confirm of ['', 'yes', 'delete my data']) {
      const err = await refusal(deleteMyData(t.db, { userId, confirm, now: NOW }));
      expect(err.code).toBe('invalid');
      expect(err.message).toContain('"delete"');
    }
    expect((await userRow(userId))?.status).toBe('active');
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.revokedAt).toBeNull();
    expect(await offboardedEntries(userId)).toHaveLength(0);
  });

  it('refuses a user who is not active, and an unknown user', async () => {
    for (const reason of ['left_guild', 'admin', 'self_delete'] as const) {
      const graceUntil = new Date(NOW.getTime() + 3 * DAY);
      const userId = await seedUser(t.db, { status: 'grace', offboardReason: reason, graceUntil });
      const err = await refusal(deleteMyData(t.db, { userId, confirm: 'delete', now: NOW }));
      expect(err.code).toBe('invalid');
      // The earlier grace period and reason stay as they were.
      expect(await userRow(userId)).toMatchObject({ graceUntil, offboardReason: reason });
    }
    const err = await refusal(
      deleteMyData(t.db, { userId: 'nobody', confirm: 'delete', now: NOW }),
    );
    expect(err.code).toBe('invalid');
  });

  it('revokes devices, API keys and sessions at once and schedules the delete in 7 days', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const keyId = await seedApiKey(t.db, userId);
    await seedSession(t.db, userId);
    await seedSession(t.db, userId);

    const metrics = createTestMetrics();
    const result = await deleteMyData(t.db, { userId, confirm: ' Delete ', now: NOW, metrics });

    expect(result).toEqual({
      graceUntil: UNTIL,
      transferred: 0,
      hidden: 0,
      revokedDevices: 1,
      deletedSessions: 2,
    });
    expect(await userRow(userId)).toMatchObject({
      status: 'grace',
      graceUntil: UNTIL,
      offboardReason: 'self_delete',
    });
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device).toMatchObject({ revokedAt: NOW, revokedReason: 'offboarding' });
    const [key] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(key?.revokedAt).toEqual(NOW);
    expect(await t.db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    // The "Delete my data" count.
    expect(await countsBy(metrics.offboardedUsers, 'reason')).toEqual({ self_delete: 1 });
  });

  it('audits the user as the one who did it', async () => {
    const userId = await seedUser(t.db);
    await deleteMyData(t.db, { userId, confirm: 'delete', now: NOW });
    expect(await offboardedEntries(userId)).toEqual([
      expect.objectContaining({
        actorUserId: userId,
        actorLabel: null,
        targetType: 'user',
        targetId: userId,
        meta: expect.objectContaining({ reason: 'self_delete', graceUntil: UNTIL.toISOString() }),
      }),
    ]);
  });

  it('passes owned accounts to the longest-linked active contributor, else hides them', async () => {
    const userId = await seedUser(t.db);
    const newer = await seedUser(t.db);
    const longest = await seedUser(t.db);
    const blocked = await seedUser(t.db);
    const shared = await seedAccount(t.db, { owner: userId });
    await seedLink(t.db, shared.id, newer, { firstSeen: new Date('2026-05-01') });
    await seedLink(t.db, shared.id, longest, { firstSeen: new Date('2026-02-01') });
    await seedLink(t.db, shared.id, blocked, { firstSeen: new Date('2025-01-01'), blocked: true });
    const lonely = await seedAccount(t.db, { owner: userId });
    await seedLink(t.db, lonely.id, blocked, { blocked: true });

    const result = await deleteMyData(t.db, { userId, confirm: 'delete', now: NOW });

    expect(result).toMatchObject({ transferred: 1, hidden: 1 });
    expect(await accountRow(shared.id)).toMatchObject({ ownerUserId: longest, status: 'active' });
    expect(await accountRow(lonely.id)).toMatchObject({
      ownerUserId: userId,
      status: 'hidden',
      hiddenAt: NOW,
    });
  });

  it('keeps 7 days whatever OFFBOARD_GRACE_DAYS says', async () => {
    setConfigForTests(
      parseConfig({ APP_URL: 'http://hub.test', OFFBOARD_GRACE_DAYS: '2', DATABASE_URL: t.url }),
    );
    try {
      const userId = await seedUser(t.db);
      const result = await deleteMyData(t.db, { userId, confirm: 'delete', now: NOW });
      expect(result.graceUntil).toEqual(UNTIL);
    } finally {
      setConfigForTests(undefined);
    }
  });
});

describe('after "Delete my data"', () => {
  it('is undone by signing in within the 7 days; devices stay revoked (D-78)', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const contributor = await seedUser(t.db);
    const hidden = await seedAccount(t.db, { owner: userId });
    const transferred = await seedAccount(t.db, { owner: userId });
    await seedLink(t.db, transferred.id, contributor);
    await deleteMyData(t.db, { userId, confirm: 'delete', now: NOW });

    const later = new Date(NOW.getTime() + 6 * DAY);
    expect(await recordSignIn(t.db, userId, SNAPSHOT, later)).toBe('ok');

    expect(await userRow(userId)).toMatchObject({
      status: 'active',
      graceUntil: null,
      offboardReason: null,
    });
    expect(await accountRow(hidden.id)).toMatchObject({ status: 'active', hiddenAt: null });
    // An account handed over meanwhile stays with its new owner.
    expect(await accountRow(transferred.id)).toMatchObject({ ownerUserId: contributor });
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.revokedReason).toBe('offboarding');
    // Nothing is deleted when the 7 days are over.
    await expireGracePeriods(t.db, { now: new Date(UNTIL.getTime() + 1000) });
    expect(await userRow(userId)).toMatchObject({ status: 'active' });
    expect(await accountRow(hidden.id)).toBeDefined();
  });

  it('hard-deletes the user and accounts without an active contributor after 7 days', async () => {
    const userId = await seedUser(t.db);
    const contributor = await seedUser(t.db);
    const own = await seedAccount(t.db, { owner: userId });
    const kept = await seedAccount(t.db, { owner: userId });
    await seedLink(t.db, kept.id, contributor);
    await deleteMyData(t.db, { userId, confirm: 'delete', now: NOW });

    // One second before the end: still there, and the user can still come back.
    await expireGracePeriods(t.db, { now: new Date(UNTIL.getTime() - 1000) });
    expect(await userRow(userId)).toBeDefined();
    expect(await accountRow(own.id)).toBeDefined();

    await expireGracePeriods(t.db, { now: new Date(UNTIL.getTime() + 1000) });
    expect(await userRow(userId)).toBeUndefined();
    expect(await accountRow(own.id)).toBeUndefined();
    expect(await accountRow(kept.id)).toMatchObject({ ownerUserId: contributor, status: 'active' });
    const deleted = await t.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.action, 'user.deleted'));
    expect(deleted.map((d) => d.meta)).toContainEqual(
      expect.objectContaining({ reason: 'self_delete' }),
    );
    // Anonymized: no offboarding entry names the user any more; the reason stays.
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'user.offboarded'));
    expect(entries.some((e) => e.targetId === userId || e.actorUserId === userId)).toBe(false);
    expect(entries.map((e) => e.meta)).toContainEqual(
      expect.objectContaining({ reason: 'self_delete' }),
    );
  });
});
