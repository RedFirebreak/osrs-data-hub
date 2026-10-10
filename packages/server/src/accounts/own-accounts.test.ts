import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { osrsAccounts } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listOwnAccounts } from './own-accounts';
import { seedAccount, seedLink, seedUser, type SeededUser } from './test-support';

const NOW = new Date('2026-10-10T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let t: TestDatabase;
let viewer: SeededUser;
let friend: SeededUser;
let admin: SeededUser;

beforeAll(async () => {
  t = await createTestDatabase('accounts-own');
  viewer = await seedUser(t.db, { name: 'Viewer' });
  friend = await seedUser(t.db, { name: 'Friend' });
  admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });

  await seedAccount(t.db, { name: 'Old main', owner: viewer.id, lastSeen: ago(600) });
  await seedAccount(t.db, {
    name: 'Shared alt',
    owner: friend.id,
    contributors: [viewer.id],
    lastSeen: ago(5),
  });
  // Someone else's, visible to the guild but not the viewer's.
  await seedAccount(t.db, { name: 'Guildie', owner: friend.id, lastSeen: ago(1) });
  // Played by the viewer too, but blocked by its owner.
  const blocked = await seedAccount(t.db, { name: 'Blocked', owner: friend.id, lastSeen: ago(1) });
  await seedLink(t.db, blocked.id, viewer.id, { blocked: true });
  // The viewer's, hidden since its owner left.
  const hidden = await seedAccount(t.db, { name: 'Ghost', owner: viewer.id, lastSeen: ago(2) });
  await t.db.update(osrsAccounts).set({ status: 'hidden' }).where(eq(osrsAccounts.id, hidden.id));
  await seedLink(t.db, hidden.id, admin.id);
});
afterAll(() => t.drop());

describe('listOwnAccounts', () => {
  it('lists owned and contributed accounts, the most recently played first', async () => {
    const own = await listOwnAccounts(t.db, viewer.viewer);
    expect(own.map((a) => a.name)).toEqual(['Shared alt', 'Old main']);
    expect(own[0]).toEqual({
      publicId: expect.any(String) as string,
      name: 'Shared alt',
      accountType: 0,
    });
  });

  it('leaves out accounts the viewer only sees, is blocked on, or that are hidden', async () => {
    const names = (await listOwnAccounts(t.db, viewer.viewer)).map((a) => a.name);
    expect(names).not.toContain('Guildie');
    expect(names).not.toContain('Blocked');
    expect(names).not.toContain('Ghost');
    // Hidden accounts are an admin's to see (the dashboard's rule).
    expect((await listOwnAccounts(t.db, admin.viewer)).map((a) => a.name)).toEqual(['Ghost']);
  });

  it('is empty for someone who is no longer active', async () => {
    expect(await listOwnAccounts(t.db, { ...viewer.viewer, status: 'grace' })).toEqual([]);
  });
});
