import { auditLog, osrsAccounts, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordSignIn, type SignInSnapshot } from './sign-in';
import { seedAccount, seedUser } from './test-support';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('signin');
});
afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-29T10:00:00Z');
const SNAPSHOT: SignInSnapshot = {
  name: 'Zezima (nick)',
  image: 'https://cdn.discordapp.com/avatars/1/a.png',
  nickname: 'nick',
  roles: ['r1', 'r2'],
  isAdmin: true,
};

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row!;
}

describe('recordSignIn', () => {
  it("refreshes an active user's member data and verification stamp", async () => {
    const id = await seedUser(t.db, { name: 'Old', verifyFailures: 3, roles: ['old'] });
    expect(await recordSignIn(t.db, id, SNAPSHOT, NOW)).toBe('ok');
    expect(await userRow(id)).toMatchObject({
      name: SNAPSHOT.name,
      image: SNAPSHOT.image,
      nickname: 'nick',
      roles: ['r1', 'r2'],
      isAdmin: true,
      status: 'active',
      lastVerifiedAt: NOW,
      verifyFailures: 0,
    });
  });

  it('brings back a user in grace for a membership reason, with their hidden accounts (D-35)', async () => {
    const id = await seedUser(t.db, {
      status: 'grace',
      offboardReason: 'left_guild',
      graceUntil: new Date('2026-10-20T00:00:00Z'),
    });
    const acc = await seedAccount(t.db, { owner: id, status: 'hidden' });
    expect(await recordSignIn(t.db, id, SNAPSHOT, NOW)).toBe('ok');
    expect(await userRow(id)).toMatchObject({
      status: 'active',
      graceUntil: null,
      offboardReason: null,
      name: SNAPSHOT.name,
    });
    const [account] = await t.db
      .select({ status: osrsAccounts.status })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, acc.id));
    expect(account?.status).toBe('active');
    const restored = await t.db
      .select({ actorLabel: auditLog.actorLabel })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.restored'), eq(auditLog.targetId, id)));
    expect(restored).toEqual([{ actorLabel: 'login' }]);
  });

  it('refuses a user an admin offboarded and writes nothing (D-35)', async () => {
    const id = await seedUser(t.db, {
      name: 'Removed',
      status: 'grace',
      offboardReason: 'admin',
      graceUntil: new Date('2026-10-20T00:00:00Z'),
    });
    const before = await userRow(id);
    expect(await recordSignIn(t.db, id, SNAPSHOT, NOW)).toBe('revoked');
    expect(await userRow(id)).toEqual(before);
  });
});
