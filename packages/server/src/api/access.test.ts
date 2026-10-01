/**
 * What a key may read (D-70): the key's categories ∩ its account scope ∩ what its creator may see
 * right now, through the shared loaders, on every request.
 */
import { CATEGORIES, type Category } from '@hub/core';
import { accountLinks, accountSharing, osrsAccounts, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadVisibleAccounts, restrictAccess } from '../accounts/load';
import {
  seedAccount,
  seedGrant,
  seedLatestState,
  seedLink,
  seedSharing,
  seedUser,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { loadApiAccount, loadApiAccounts, requireApiAccounts } from './access';
import { apiGetAccount, apiListAccounts } from './accounts';
import { ApiError } from './errors';
import { apiMe } from './me';
import { makeKey, present, reauth } from './test-support';

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let zezima: SeededAccount;
let other: SeededAccount;

const NOW = new Date('2026-09-28T12:00:00Z');

beforeAll(async () => {
  t = await createTestDatabase('api-access');
  owner = await seedUser(t.db, { name: 'Owner' });
  member = await seedUser(t.db, { name: 'Member' });
  zezima = await seedAccount(t.db, { name: 'Zezima', owner: owner.id });
  other = await seedAccount(t.db, { name: 'Other', owner: owner.id });
  for (const account of [zezima, other]) {
    await seedLatestState(t.db, account.id, {
      lastSeen: NOW,
      gameState: 'LOGGED_IN',
      world: 302,
      skills: skillMap({ Attack: [13_034_431, 99] }),
      skillsUpdatedAt: NOW,
      location: { x: 3164, y: 3487, plane: 0 },
      locationUpdatedAt: NOW,
      inventory: [],
      inventoryUpdatedAt: NOW,
    });
  }
  // Both keep their locations, equipment and inventory private (every category is guild by default,
  // D-96): categories a member's key can ask for but not get.
  for (const account of [zezima, other]) {
    for (const c of ['location_live', 'location_history', 'equipment', 'inventory'] as const)
      await seedSharing(t.db, account.id, c, 'private');
  }
});

afterAll(async () => {
  await t.drop();
});

const sections = (detail: object) =>
  Object.keys(detail).filter((k) =>
    ['presence', 'vitals', 'skills', 'location', 'equipment', 'inventory'].includes(k),
  );

async function setAudience(
  accountId: number,
  category: Category,
  audience: 'private' | 'guild' | 'selected',
) {
  await t.db
    .insert(accountSharing)
    .values({ accountId, category, audience })
    .onConflictDoUpdate({
      target: [accountSharing.accountId, accountSharing.category],
      set: { audience },
    });
}

describe('categories: the key’s ∩ what the creator may see', () => {
  it('gives a member’s key the guild categories only, and omits the other sections', async () => {
    const { principal } = await makeKey(t.db, member.id, {}, NOW);
    const detail = present(await apiGetAccount(t.db, principal, zezima.publicId, NOW));
    expect(detail.categories).toEqual(['stats', 'events', 'activity']);
    expect(sections(detail)).toEqual(['presence', 'vitals', 'skills']);
    expect(detail).not.toHaveProperty('location');
    expect(detail).not.toHaveProperty('inventory');
  });

  it('narrows further to the key’s own categories', async () => {
    const { principal } = await makeKey(
      t.db,
      member.id,
      { categories: ['stats', 'location_live'] },
      NOW,
    );
    const detail = present(await apiGetAccount(t.db, principal, zezima.publicId, NOW));
    expect(detail.categories).toEqual(['stats']);
    expect(sections(detail)).toEqual(['skills']);
  });

  it('answers 404 (null) when none of the key’s categories is shared with its creator', async () => {
    const { principal } = await makeKey(t.db, member.id, { categories: ['location_live'] }, NOW);
    expect(await apiGetAccount(t.db, principal, zezima.publicId, NOW)).toBeNull();
    expect(await apiListAccounts(t.db, principal, {}, NOW)).toEqual([]);
    expect((await apiMe(t.db, principal)).visibleAccounts).toBe(0);
  });

  it('follows a grant at once: the next request sees the category', async () => {
    const grantee = await seedUser(t.db);
    const { principal } = await makeKey(t.db, grantee.id, { categories: ['location_live'] }, NOW);
    expect(await loadApiAccount(t.db, principal, zezima.publicId)).toBeNull();
    await setAudience(zezima.id, 'location_live', 'selected');
    await seedGrant(t.db, zezima.id, 'location_live', grantee.id);
    const detail = present(await apiGetAccount(t.db, principal, zezima.publicId, NOW));
    expect(detail.location).toMatchObject({ shared: true, x: 3164, y: 3487 });
    await setAudience(zezima.id, 'location_live', 'private');
    expect(await apiGetAccount(t.db, principal, zezima.publicId, NOW)).toBeNull();
  });

  it('gives the owner’s and a contributor’s key every category the key has', async () => {
    const contributor = await seedUser(t.db);
    await seedLink(t.db, zezima.id, contributor.id);
    for (const userId of [owner.id, contributor.id]) {
      const { principal } = await makeKey(t.db, userId, {}, NOW);
      const detail = present(await apiGetAccount(t.db, principal, zezima.publicId, NOW));
      expect(detail.categories).toEqual([...CATEGORIES]);
      expect(sections(detail)).toEqual([
        'presence',
        'vitals',
        'skills',
        'location',
        'equipment',
        'inventory',
      ]);
    }
  });
});

describe('account scope', () => {
  it('limits a list key to its accounts; the others answer 404', async () => {
    const { principal } = await makeKey(
      t.db,
      member.id,
      { accountScope: 'list', accountPublicIds: [zezima.publicId] },
      NOW,
    );
    expect((await apiListAccounts(t.db, principal, {}, NOW)).map((a) => a.name)).toEqual([
      'Zezima',
    ]);
    expect(await apiGetAccount(t.db, principal, other.publicId, NOW)).toBeNull();
    expect((await apiMe(t.db, principal)).visibleAccounts).toBe(1);
    const all = await makeKey(t.db, member.id, {}, NOW);
    expect((await apiMe(t.db, all.principal)).visibleAccounts).toBe(2);
  });

  it('still needs the creator to see a listed account: a list never widens access', async () => {
    const lister = await seedUser(t.db);
    const shared = await seedAccount(t.db, { name: 'Soon private', owner: owner.id });
    const { key, principal } = await makeKey(
      t.db,
      lister.id,
      { accountScope: 'list', accountPublicIds: [shared.publicId] },
      NOW,
    );
    expect(await loadApiAccount(t.db, principal, shared.publicId)).not.toBeNull();
    for (const c of CATEGORIES) await setAudience(shared.id, c, 'private');
    // The same principal, and a freshly authenticated one: both lose it at once.
    expect(await loadApiAccount(t.db, principal, shared.publicId)).toBeNull();
    expect(await loadApiAccount(t.db, await reauth(t.db, key, NOW), shared.publicId)).toBeNull();
  });
});

describe('the creator’s visibility, evaluated on every request', () => {
  it('drops an account from an all_visible key as soon as the owner stops sharing it', async () => {
    const watcher = await seedUser(t.db);
    const account = await seedAccount(t.db, { name: 'Changing', owner: owner.id });
    const { principal } = await makeKey(t.db, watcher.id, {}, NOW);
    expect((await loadApiAccounts(t.db, principal)).map((e) => e.account.id)).toContain(account.id);
    for (const c of CATEGORIES) await setAudience(account.id, c, 'private');
    expect((await loadApiAccounts(t.db, principal)).map((e) => e.account.id)).not.toContain(
      account.id,
    );
  });

  it('never shows hidden accounts, not even to their contributors’ keys', async () => {
    const contributor = await seedUser(t.db);
    const hidden = await seedAccount(t.db, { name: 'Hidden', owner: owner.id, status: 'hidden' });
    await seedLink(t.db, hidden.id, contributor.id);
    const { principal } = await makeKey(t.db, contributor.id, {}, NOW);
    expect(await apiGetAccount(t.db, principal, hidden.publicId, NOW)).toBeNull();
    await t.db.update(osrsAccounts).set({ status: 'active' }).where(eq(osrsAccounts.id, hidden.id));
    expect(await apiGetAccount(t.db, principal, hidden.publicId, NOW)).not.toBeNull();
  });

  it('gives an admin creator no override: no hidden accounts, no private categories', async () => {
    const admin = await seedUser(t.db, { isAdmin: true });
    const hidden = await seedAccount(t.db, { name: 'Hidden 2', owner: owner.id, status: 'hidden' });
    const { principal } = await makeKey(t.db, admin.id, {}, NOW);
    // Even a principal claiming to be an admin is treated as none.
    const claimed = { ...principal, viewer: { ...principal.viewer, isAdmin: true } };
    for (const p of [principal, claimed]) {
      expect(await apiGetAccount(t.db, p, hidden.publicId, NOW)).toBeNull();
      const detail = present(await apiGetAccount(t.db, p, zezima.publicId, NOW));
      expect(detail.categories).toEqual(['stats', 'events', 'activity']);
    }
    // The UI's loader, without a restriction, still gives the admin both.
    const viewer = { userId: admin.id, status: 'active' as const, isAdmin: true };
    const all = await loadVisibleAccounts(t.db, viewer);
    expect(all.map((e) => e.account.id)).toContain(hidden.id);
  });

  it('treats a blocked contributor’s key like a plain member’s', async () => {
    const blocked = await seedUser(t.db);
    const account = await seedAccount(t.db, { name: 'Blocking', owner: owner.id });
    await seedLink(t.db, account.id, blocked.id, { blocked: true });
    const { principal } = await makeKey(t.db, blocked.id, {}, NOW);
    const detail = present(await apiGetAccount(t.db, principal, account.publicId, NOW));
    // A member's defaults: every category (D-96).
    expect(detail.categories).toEqual([...CATEGORIES]);
    for (const c of CATEGORIES) await setAudience(account.id, c, 'private');
    expect(await apiGetAccount(t.db, principal, account.publicId, NOW)).toBeNull();
    await t.db
      .update(accountLinks)
      .set({ blocked: false })
      .where(and(eq(accountLinks.accountId, account.id), eq(accountLinks.userId, blocked.id)));
    expect(present(await apiGetAccount(t.db, principal, account.publicId, NOW)).categories).toEqual(
      [...CATEGORIES],
    );
  });

  it('sees nothing once the creator is not active, even with an old principal', async () => {
    const leaver = await seedUser(t.db);
    const { principal } = await makeKey(t.db, leaver.id, {}, NOW);
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, leaver.id));
    // A request would already fail authentication; the read models refuse on their own too.
    const stale = { ...principal, viewer: { ...principal.viewer, status: 'grace' as const } };
    expect(await loadApiAccounts(t.db, stale)).toEqual([]);
    expect(await apiGetAccount(t.db, stale, zezima.publicId, NOW)).toBeNull();
  });
});

describe('ids that cannot be public ids', () => {
  it('answers null without querying (no NUL reaches Postgres, DB-1)', async () => {
    const { principal } = await makeKey(t.db, member.id, {}, NOW);
    for (const id of ['', 'a b', 'x\u0000', 'é', 'x'.repeat(65)]) {
      expect(await apiGetAccount(t.db, principal, id, NOW)).toBeNull();
    }
  });
});

describe('requireApiAccounts', () => {
  it('returns the accounts in request order, or not_found for any the key cannot read', async () => {
    const { principal } = await makeKey(t.db, member.id, {}, NOW);
    const found = await requireApiAccounts(
      t.db,
      principal,
      [other.publicId, zezima.publicId, other.publicId],
      'stats',
      'accounts',
    );
    expect(found.map((e) => e.account.name)).toEqual(['Other', 'Zezima']);
    for (const ids of [[zezima.publicId, 'unknown1234'], ['x\u0000']]) {
      const err = await requireApiAccounts(t.db, principal, ids, 'stats', 'accounts').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: 'not_found' });
    }
    const inventory = await requireApiAccounts(
      t.db,
      principal,
      [zezima.publicId],
      'inventory',
      'accounts',
    ).catch((e: unknown) => e);
    expect(inventory).toMatchObject({
      code: 'not_found',
      message: `account ${zezima.publicId} not found`,
    });
    await expect(
      requireApiAccounts(t.db, principal, [], 'stats', 'accounts'),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('restrictAccess', () => {
  it('intersects categories, needs at least one, and never grants canManage', () => {
    const full = {
      visible: true,
      categories: new Set<Category>(CATEGORIES),
      relation: 'owner' as const,
      canManage: true,
    };
    expect(
      restrictAccess(full, { categories: new Set(['stats', 'inventory']), accountIds: null }),
    ).toEqual({
      visible: true,
      categories: new Set(['stats', 'inventory']),
      relation: 'owner',
      canManage: false,
    });
    const member = {
      ...full,
      relation: 'member' as const,
      canManage: false,
      categories: new Set<Category>(['stats']),
    };
    expect(
      restrictAccess(member, { categories: new Set(['inventory']), accountIds: null }).visible,
    ).toBe(false);
  });
});

describe('seeded sharing rows', () => {
  it('uses the defaults when there are none, every category guild (D-96; sanity check for the fixtures above)', async () => {
    const fresh = await seedAccount(t.db, { name: 'Defaults', owner: owner.id });
    await seedSharing(t.db, fresh.id, 'inventory', 'private');
    const { principal } = await makeKey(t.db, member.id, {}, NOW);
    expect(
      present(await loadApiAccount(t.db, principal, fresh.publicId)).access.categories,
    ).toEqual(new Set(CATEGORIES.filter((c) => c !== 'inventory')));
  });
});
