import type { Viewer } from '@hub/core';
import { auditLog, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAccount, seedDevice, seedLink, seedUser } from '../offboarding/test-support';
import { AdminError } from './errors';
import { adminOffboardUser, adminRestoreUser, listUsers } from './users';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('adminusers');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 86_400_000;

const admin = (userId: string): Viewer => ({ userId, status: 'active', isAdmin: true });

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row;
}

describe('listUsers', () => {
  it('lists every user by name with active devices and linked accounts', async () => {
    const zed = await seedUser(t.db, {
      name: 'zed',
      discordId: '42',
      isAdmin: true,
      image: 'https://cdn.example/zed.png',
      lastVerifiedAt: NOW,
      verifyFailures: 2,
    });
    const anna = await seedUser(t.db, {
      name: 'Anna',
      status: 'grace',
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
      offboardReason: 'left_guild',
    });
    const bob = await seedUser(t.db, { name: 'bob' });
    await seedDevice(t.db, zed);
    await seedDevice(t.db, zed);
    await seedDevice(t.db, zed, { revokedAt: NOW, revokedReason: 'user' });
    const owned = await seedAccount(t.db, { owner: zed });
    await seedLink(t.db, owned.id, bob);
    const blocking = await seedAccount(t.db, { owner: bob });
    await seedLink(t.db, blocking.id, zed, { blocked: true });

    const rows = await listUsers(t.db);

    expect(rows.map((r) => r.name)).toEqual(['Anna', 'bob', 'zed']);
    expect(rows.find((r) => r.id === zed)).toEqual({
      id: zed,
      name: 'zed',
      image: 'https://cdn.example/zed.png',
      discordId: '42',
      isAdmin: true,
      status: 'active',
      graceUntil: null,
      offboardReason: null,
      lastVerifiedAt: NOW,
      verifyFailures: 2,
      createdAt: expect.any(Date),
      devices: 2,
      accounts: 1,
    });
    expect(rows.find((r) => r.id === anna)).toMatchObject({
      status: 'grace',
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
      offboardReason: 'left_guild',
      devices: 0,
      accounts: 0,
    });
    expect(rows.find((r) => r.id === bob)).toMatchObject({ devices: 0, accounts: 2 });
  });
});

describe('adminOffboardUser', () => {
  it("offboards with reason 'admin' and the admin as actor", async () => {
    const actor = await seedUser(t.db, { isAdmin: true });
    const target = await seedUser(t.db);
    const account = await seedAccount(t.db, { owner: target });

    const result = await adminOffboardUser(t.db, {
      actor: admin(actor),
      userId: target,
      graceDays: 30,
      now: NOW,
    });

    expect(result).toMatchObject({ hidden: [account.id], transferred: [] });
    expect(await userRow(target)).toMatchObject({
      status: 'grace',
      offboardReason: 'admin',
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
    });
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.offboarded'), eq(auditLog.targetId, target)));
    expect(entry).toMatchObject({
      actorUserId: actor,
      actorLabel: null,
      meta: { reason: 'admin' },
    });
  });

  it('turns a membership offboarding into an admin one, keeping the earlier date', async () => {
    const actor = await seedUser(t.db, { isAdmin: true });
    const until = new Date(NOW.getTime() + 3 * DAY);
    const target = await seedUser(t.db, {
      status: 'grace',
      graceUntil: until,
      offboardReason: 'left_guild',
    });

    await adminOffboardUser(t.db, { actor: admin(actor), userId: target, graceDays: 30, now: NOW });

    expect(await userRow(target)).toMatchObject({ offboardReason: 'admin', graceUntil: until });
  });

  it('refuses non-admins, the actor themselves and unknown users', async () => {
    const actor = await seedUser(t.db, { isAdmin: true });
    const target = await seedUser(t.db);
    const attempt = (a: Viewer, userId: string) =>
      adminOffboardUser(t.db, { actor: a, userId, graceDays: 30, now: NOW });

    await expect(
      attempt({ userId: actor, status: 'active', isAdmin: false }, target),
    ).rejects.toThrow(new AdminError('forbidden', 'admins only'));
    await expect(
      attempt({ userId: actor, status: 'grace', isAdmin: true }, target),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(attempt(admin(actor), actor)).rejects.toMatchObject({ code: 'invalid' });
    await expect(attempt(admin(actor), 'nobody')).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempt(admin(actor), '')).rejects.toMatchObject({ code: 'not_found' });
    expect((await userRow(target))?.status).toBe('active');
  });
});

describe('adminRestoreUser', () => {
  it('restores a user in grace, whatever the reason', async () => {
    const actor = await seedUser(t.db, { isAdmin: true });
    const target = await seedUser(t.db);
    const account = await seedAccount(t.db, { owner: target });
    await adminOffboardUser(t.db, { actor: admin(actor), userId: target, graceDays: 30, now: NOW });

    const result = await adminRestoreUser(t.db, { actor: admin(actor), userId: target });

    expect(result).toEqual({ unhidden: [account.id] });
    expect(await userRow(target)).toMatchObject({
      status: 'active',
      graceUntil: null,
      offboardReason: null,
    });
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.restored'), eq(auditLog.targetId, target)));
    expect(entry).toMatchObject({ actorUserId: actor, meta: { previousReason: 'admin' } });
  });

  it('refuses non-admins and unknown users', async () => {
    const actor = await seedUser(t.db);
    await expect(
      adminRestoreUser(t.db, {
        actor: { userId: actor, status: 'active', isAdmin: false },
        userId: actor,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      adminRestoreUser(t.db, { actor: admin(actor), userId: 'nobody' }),
    ).rejects.toMatchObject({ name: 'AdminError', code: 'not_found' });
  });
});
