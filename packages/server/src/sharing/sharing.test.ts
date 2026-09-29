import { CATEGORIES } from '@hub/core';
import { accountLinks, accountShareGrants, auditLog, osrsAccounts } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFeed } from '../accounts/list-feed';
import {
  seedAccount,
  seedEvent,
  seedGrant,
  seedLink,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { SharingError, type SharingErrorCode } from './errors';
import {
  addGrant,
  claimOwnership,
  removeContributor,
  removeGrant,
  setAudience,
  setContributorBlocked,
  transferOwnership,
} from './mutations';
import { getSharingSettings, listActiveMembers } from './settings';

let t: TestDatabase;
let owner: SeededUser;
let contributor: SeededUser;
let blocked: SeededUser;
let member: SeededUser;
let admin: SeededUser;
let inGrace: SeededUser;

/** An account owned by `owner`, with `contributor` and the blocked `blocked` linked. */
async function sharedAccount(opts: { status?: 'active' | 'hidden' } = {}): Promise<SeededAccount> {
  const account = await seedAccount(t.db, { name: 'Shared', owner: owner.id, status: opts.status });
  await seedLink(t.db, account.id, contributor.id, { firstSeen: new Date('2026-02-01T00:00:00Z') });
  await seedLink(t.db, account.id, blocked.id, {
    blocked: true,
    firstSeen: new Date('2026-01-01T00:00:00Z'),
  });
  return account;
}

async function auditRows(publicId: string) {
  return t.db
    .select({
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      meta: auditLog.meta,
    })
    .from(auditLog)
    .where(eq(auditLog.targetId, publicId))
    .orderBy(asc(auditLog.id));
}

async function expectRefused(promise: Promise<unknown>, code: SharingErrorCode): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SharingError);
  expect((err as SharingError).code).toBe(code);
}

async function linksOf(accountId: number) {
  return t.db
    .select({ userId: accountLinks.userId, role: accountLinks.role, blocked: accountLinks.blocked })
    .from(accountLinks)
    .where(eq(accountLinks.accountId, accountId))
    .orderBy(asc(accountLinks.userId));
}

async function accountRow(accountId: number) {
  const [row] = await t.db
    .select({
      ownerUserId: osrsAccounts.ownerUserId,
      status: osrsAccounts.status,
      hiddenAt: osrsAccounts.hiddenAt,
    })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.id, accountId));
  return row;
}

beforeAll(async () => {
  t = await createTestDatabase('sharing');
  owner = await seedUser(t.db, { name: 'Owner', image: 'https://cdn.example/o.png' });
  contributor = await seedUser(t.db, { name: 'contributor' });
  blocked = await seedUser(t.db, { name: 'Blocked' });
  member = await seedUser(t.db, { name: 'Member' });
  admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });
  inGrace = await seedUser(t.db, { name: 'Grace', status: 'grace' });
});

afterAll(async () => {
  await t.drop();
});

describe('getSharingSettings', () => {
  it('shows the owner every category with defaults, grants and contributors', async () => {
    const account = await sharedAccount();
    await seedSharing(t.db, account.id, 'equipment', 'selected');
    await seedGrant(t.db, account.id, 'equipment', member.id);
    await seedGrant(t.db, account.id, 'equipment', contributor.id);
    const settings = await getSharingSettings(t.db, owner.viewer, account.publicId);
    expect(settings?.canManage).toBe(true);
    expect(settings?.categories.map((c) => c.category)).toEqual([...CATEGORIES]);
    expect(settings?.categories.find((c) => c.category === 'stats')).toEqual({
      category: 'stats',
      audience: 'guild',
      isDefault: true,
      grants: [],
    });
    expect(settings?.categories.find((c) => c.category === 'inventory')).toMatchObject({
      audience: 'private',
      isDefault: true,
    });
    expect(settings?.categories.find((c) => c.category === 'equipment')).toEqual({
      category: 'equipment',
      audience: 'selected',
      isDefault: false,
      grants: [
        { userId: contributor.id, name: 'contributor' },
        { userId: member.id, name: 'Member' },
      ],
    });
    expect(settings?.contributors.map((c) => [c.name, c.role, c.blocked])).toEqual([
      ['Owner', 'owner', false],
      ['Blocked', 'contributor', true],
      ['contributor', 'contributor', false],
    ]);
    expect(settings?.contributors[0]).toMatchObject({ image: 'https://cdn.example/o.png' });
  });

  it('lets contributors and admins read, and nobody else', async () => {
    const account = await sharedAccount();
    expect((await getSharingSettings(t.db, contributor.viewer, account.publicId))?.canManage).toBe(
      false,
    );
    expect((await getSharingSettings(t.db, admin.viewer, account.publicId))?.canManage).toBe(true);
    for (const viewer of [member.viewer, blocked.viewer, inGrace.viewer]) {
      expect(await getSharingSettings(t.db, viewer, account.publicId)).toBeNull();
    }
    expect(await getSharingSettings(t.db, owner.viewer, 'missing')).toBeNull();
  });

  it('hides a hidden account from everyone but admins', async () => {
    const account = await sharedAccount({ status: 'hidden' });
    expect(await getSharingSettings(t.db, owner.viewer, account.publicId)).toBeNull();
    expect(await getSharingSettings(t.db, contributor.viewer, account.publicId)).toBeNull();
    expect(await getSharingSettings(t.db, admin.viewer, account.publicId)).not.toBeNull();
  });
});

describe('setAudience', () => {
  it('changes who sees a category, and audits it once', async () => {
    const account = await sharedAccount();
    await seedEvent(t.db, account.id, { type: 'loot' });
    expect(await listFeed(t.db, member.viewer, { accountPublicId: account.publicId })).toHaveLength(
      1,
    );

    await setAudience(t.db, owner.viewer, account.publicId, 'events', 'private');
    await setAudience(t.db, owner.viewer, account.publicId, 'events', 'private');

    expect(await listFeed(t.db, member.viewer, { accountPublicId: account.publicId })).toEqual([]);
    const settings = await getSharingSettings(t.db, owner.viewer, account.publicId);
    expect(settings?.categories.find((c) => c.category === 'events')).toMatchObject({
      audience: 'private',
      isDefault: false,
    });
    expect(await auditRows(account.publicId)).toEqual([
      {
        actorUserId: owner.id,
        action: 'sharing.audience_changed',
        targetType: 'osrs_account',
        targetId: account.publicId,
        meta: { category: 'events', from: 'guild', to: 'private', asAdmin: false },
      },
    ]);
  });

  it('stores an explicit choice even when it equals the default', async () => {
    const account = await sharedAccount();
    await setAudience(t.db, owner.viewer, account.publicId, 'stats', 'guild');
    const settings = await getSharingSettings(t.db, owner.viewer, account.publicId);
    expect(settings?.categories.find((c) => c.category === 'stats')?.isDefault).toBe(false);
    expect(await auditRows(account.publicId)).toHaveLength(1);
  });

  it('lets an admin override, flagged in the audit entry', async () => {
    const account = await sharedAccount();
    await setAudience(t.db, admin.viewer, account.publicId, 'location_live', 'guild');
    const [row] = await auditRows(account.publicId);
    expect(row).toMatchObject({ actorUserId: admin.id, meta: { asAdmin: true, to: 'guild' } });
  });

  it('refuses contributors, members and blocked users (forbidden)', async () => {
    const account = await sharedAccount();
    for (const viewer of [contributor.viewer, member.viewer, blocked.viewer]) {
      await expectRefused(
        setAudience(t.db, viewer, account.publicId, 'stats', 'private'),
        'forbidden',
      );
    }
    expect(await auditRows(account.publicId)).toEqual([]);
  });

  it('answers not_found for missing, invisible and (to non-admins) hidden accounts', async () => {
    await expectRefused(
      setAudience(t.db, owner.viewer, 'missing', 'stats', 'private'),
      'not_found',
    );
    const hidden = await sharedAccount({ status: 'hidden' });
    await expectRefused(
      setAudience(t.db, owner.viewer, hidden.publicId, 'stats', 'private'),
      'not_found',
    );
    const secret = await sharedAccount();
    for (const c of ['stats', 'events', 'activity'] as const) {
      await seedSharing(t.db, secret.id, c, 'private');
    }
    await expectRefused(
      setAudience(t.db, member.viewer, secret.publicId, 'stats', 'guild'),
      'not_found',
    );
    await expectRefused(
      setAudience(t.db, inGrace.viewer, secret.publicId, 'stats', 'guild'),
      'not_found',
    );
  });

  it('rejects unknown categories and audiences (invalid)', async () => {
    const account = await sharedAccount();
    await expectRefused(
      setAudience(t.db, owner.viewer, account.publicId, 'nope' as 'stats', 'guild'),
      'invalid',
    );
    await expectRefused(
      setAudience(t.db, owner.viewer, account.publicId, 'stats', 'everyone' as 'guild'),
      'invalid',
    );
    await expectRefused(
      setAudience(t.db, owner.viewer, account.publicId, 'toString' as 'stats', 'guild'),
      'invalid',
    );
  });
});

describe('addGrant / removeGrant', () => {
  it('grants and revokes a category for one member, audited once each', async () => {
    const account = await sharedAccount();
    await setAudience(t.db, owner.viewer, account.publicId, 'inventory', 'selected');
    await addGrant(t.db, owner.viewer, account.publicId, 'inventory', member.id);
    await addGrant(t.db, owner.viewer, account.publicId, 'inventory', member.id);
    const grants = await t.db
      .select()
      .from(accountShareGrants)
      .where(eq(accountShareGrants.accountId, account.id));
    expect(grants.map((g) => [g.category, g.granteeUserId])).toEqual([['inventory', member.id]]);

    await removeGrant(t.db, owner.viewer, account.publicId, 'inventory', member.id);
    await removeGrant(t.db, owner.viewer, account.publicId, 'inventory', member.id);
    const actions = (await auditRows(account.publicId)).map((r) => [r.action, r.meta]);
    expect(actions).toEqual([
      [
        'sharing.audience_changed',
        { category: 'inventory', from: 'private', to: 'selected', asAdmin: false },
      ],
      ['sharing.grant_added', { category: 'inventory', granteeUserId: member.id, asAdmin: false }],
      [
        'sharing.grant_removed',
        { category: 'inventory', granteeUserId: member.id, asAdmin: false },
      ],
    ]);
  });

  it('requires an active grantee, but can revoke a grant from a user in grace', async () => {
    const account = await sharedAccount();
    await expectRefused(
      addGrant(t.db, owner.viewer, account.publicId, 'inventory', inGrace.id),
      'invalid',
    );
    await expectRefused(
      addGrant(t.db, owner.viewer, account.publicId, 'inventory', 'no-such-user'),
      'invalid',
    );
    await expectRefused(addGrant(t.db, owner.viewer, account.publicId, 'inventory', ''), 'invalid');
    await seedGrant(t.db, account.id, 'inventory', inGrace.id);
    await removeGrant(t.db, owner.viewer, account.publicId, 'inventory', inGrace.id);
    expect((await auditRows(account.publicId)).map((r) => r.action)).toEqual([
      'sharing.grant_removed',
    ]);
  });

  it('refuses non-owners', async () => {
    const account = await sharedAccount();
    await expectRefused(
      addGrant(t.db, contributor.viewer, account.publicId, 'inventory', member.id),
      'forbidden',
    );
    await expectRefused(
      removeGrant(t.db, member.viewer, account.publicId, 'inventory', member.id),
      'forbidden',
    );
    await expectRefused(
      addGrant(t.db, owner.viewer, account.publicId, 'bogus' as 'stats', member.id),
      'invalid',
    );
  });
});

describe('transferOwnership', () => {
  it('makes a contributor the owner; the old owner stays a contributor', async () => {
    const account = await sharedAccount();
    await transferOwnership(t.db, owner.viewer, account.publicId, contributor.id);
    expect((await accountRow(account.id))?.ownerUserId).toBe(contributor.id);
    const roles = Object.fromEntries((await linksOf(account.id)).map((l) => [l.userId, l.role]));
    expect(roles).toEqual({
      [owner.id]: 'contributor',
      [contributor.id]: 'owner',
      [blocked.id]: 'contributor',
    });
    const settings = await getSharingSettings(t.db, owner.viewer, account.publicId);
    expect(settings?.canManage).toBe(false);
    expect(await auditRows(account.publicId)).toEqual([
      expect.objectContaining({
        actorUserId: owner.id,
        action: 'account.ownership_transferred',
        meta: {
          from: owner.id,
          to: contributor.id,
          reason: 'manual',
          unhidden: false,
          asAdmin: false,
        },
      }),
    ]);
    // The old owner can't change anything any more; the new one can.
    await expectRefused(
      setAudience(t.db, owner.viewer, account.publicId, 'stats', 'private'),
      'forbidden',
    );
    await setAudience(t.db, contributor.viewer, account.publicId, 'stats', 'private');
  });

  it('only accepts active, non-blocked contributors who are not the owner', async () => {
    const account = await sharedAccount();
    const graceContributor = await seedUser(t.db, { status: 'grace' });
    await seedLink(t.db, account.id, graceContributor.id);
    for (const target of [blocked.id, member.id, graceContributor.id, owner.id, 'nobody']) {
      await expectRefused(
        transferOwnership(t.db, owner.viewer, account.publicId, target),
        'invalid',
      );
    }
    await expectRefused(
      transferOwnership(t.db, contributor.viewer, account.publicId, contributor.id),
      'forbidden',
    );
    expect((await accountRow(account.id))?.ownerUserId).toBe(owner.id);
    expect(await auditRows(account.publicId)).toEqual([]);
  });

  it('lets an admin transfer a hidden account, which becomes visible again', async () => {
    const account = await sharedAccount({ status: 'hidden' });
    await transferOwnership(t.db, admin.viewer, account.publicId, contributor.id);
    expect(await accountRow(account.id)).toEqual({
      ownerUserId: contributor.id,
      status: 'active',
      hiddenAt: null,
    });
    const [row] = await auditRows(account.publicId);
    expect(row?.meta).toMatchObject({ unhidden: true, asAdmin: true });
    expect(await getSharingSettings(t.db, contributor.viewer, account.publicId)).not.toBeNull();
  });
});

describe('claimOwnership', () => {
  async function unclaimed(): Promise<SeededAccount> {
    const account = await seedAccount(t.db, { name: 'Unclaimed', owner: null });
    await seedLink(t.db, account.id, contributor.id);
    await seedLink(t.db, account.id, member.id);
    await seedLink(t.db, account.id, blocked.id, { blocked: true });
    return account;
  }

  it('lets a contributor claim an account without an owner', async () => {
    const account = await unclaimed();
    await claimOwnership(t.db, contributor.viewer, account.publicId);
    expect((await accountRow(account.id))?.ownerUserId).toBe(contributor.id);
    const roles = Object.fromEntries((await linksOf(account.id)).map((l) => [l.userId, l.role]));
    expect(roles[contributor.id]).toBe('owner');
    expect(roles[member.id]).toBe('contributor');
    expect(await auditRows(account.publicId)).toEqual([
      expect.objectContaining({
        actorUserId: contributor.id,
        action: 'account.ownership_claimed',
        meta: { unhidden: false, asAdmin: false },
      }),
    ]);
  });

  it('records an admin who claims as a contributor as not acting as admin', async () => {
    const account = await unclaimed();
    await seedLink(t.db, account.id, admin.id);
    await claimOwnership(t.db, admin.viewer, account.publicId);
    const [row] = await auditRows(account.publicId);
    expect(row).toMatchObject({
      actorUserId: admin.id,
      action: 'account.ownership_claimed',
      meta: { asAdmin: false },
    });
  });

  it('refuses non-contributors, blocked contributors and owned accounts', async () => {
    const account = await unclaimed();
    await expectRefused(claimOwnership(t.db, admin.viewer, account.publicId), 'forbidden');
    await expectRefused(claimOwnership(t.db, blocked.viewer, account.publicId), 'forbidden');
    await expectRefused(claimOwnership(t.db, inGrace.viewer, account.publicId), 'not_found');
    const owned = await sharedAccount();
    await expectRefused(claimOwnership(t.db, contributor.viewer, owned.publicId), 'invalid');
    await expectRefused(claimOwnership(t.db, owner.viewer, owned.publicId), 'invalid');
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const account = await unclaimed();
    const results = await Promise.allSettled([
      claimOwnership(t.db, contributor.viewer, account.publicId),
      claimOwnership(t.db, member.viewer, account.publicId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid' });
    expect(await auditRows(account.publicId)).toHaveLength(1);
  });
});

describe('setContributorBlocked', () => {
  it('blocks and unblocks a contributor, audited once per change', async () => {
    const account = await sharedAccount();
    const linkOf = async () => {
      const [row] = await t.db
        .select({ blocked: accountLinks.blocked, blockedAt: accountLinks.blockedAt })
        .from(accountLinks)
        .where(
          and(eq(accountLinks.accountId, account.id), eq(accountLinks.userId, contributor.id)),
        );
      return row;
    };
    await setContributorBlocked(t.db, owner.viewer, account.publicId, contributor.id, true);
    await setContributorBlocked(t.db, owner.viewer, account.publicId, contributor.id, true);
    expect(await linkOf()).toEqual({ blocked: true, blockedAt: expect.any(Date) });
    // A blocked contributor loses the contributor view.
    expect(await getSharingSettings(t.db, contributor.viewer, account.publicId)).toBeNull();

    await setContributorBlocked(t.db, owner.viewer, account.publicId, contributor.id, false);
    expect(await linkOf()).toEqual({ blocked: false, blockedAt: null });
    expect((await auditRows(account.publicId)).map((r) => [r.action, r.meta])).toEqual([
      ['account.contributor_blocked', { userId: contributor.id, asAdmin: false }],
      ['account.contributor_unblocked', { userId: contributor.id, asAdmin: false }],
    ]);
  });

  it("refuses to block the owner or someone who isn't linked, and non-owners", async () => {
    const account = await sharedAccount();
    await expectRefused(
      setContributorBlocked(t.db, owner.viewer, account.publicId, owner.id, true),
      'invalid',
    );
    await expectRefused(
      setContributorBlocked(t.db, admin.viewer, account.publicId, owner.id, true),
      'invalid',
    );
    await expectRefused(
      setContributorBlocked(t.db, owner.viewer, account.publicId, member.id, true),
      'invalid',
    );
    await expectRefused(
      setContributorBlocked(t.db, contributor.viewer, account.publicId, blocked.id, false),
      'forbidden',
    );
  });
});

describe('removeContributor', () => {
  it("deletes a contributor's link", async () => {
    const account = await sharedAccount();
    await removeContributor(t.db, owner.viewer, account.publicId, contributor.id);
    expect((await linksOf(account.id)).map((l) => l.userId).sort()).toEqual(
      [owner.id, blocked.id].sort(),
    );
    expect(await auditRows(account.publicId)).toEqual([
      expect.objectContaining({
        action: 'account.contributor_removed',
        meta: { userId: contributor.id, asAdmin: false },
      }),
    ]);
  });

  it('keeps the owner, blocked contributors (the block would go with the link) and refuses others', async () => {
    const account = await sharedAccount();
    await expectRefused(
      removeContributor(t.db, owner.viewer, account.publicId, owner.id),
      'invalid',
    );
    await expectRefused(
      removeContributor(t.db, owner.viewer, account.publicId, blocked.id),
      'invalid',
    );
    await expectRefused(
      removeContributor(t.db, owner.viewer, account.publicId, member.id),
      'invalid',
    );
    await expectRefused(
      removeContributor(t.db, contributor.viewer, account.publicId, contributor.id),
      'forbidden',
    );
    expect(await linksOf(account.id)).toHaveLength(3);
  });
});

describe('listActiveMembers', () => {
  it('lists active users by name, without users in grace', async () => {
    const members = await listActiveMembers(t.db);
    const names = members.map((m) => m.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
    expect(names).toContain('contributor');
    expect(names).not.toContain('Grace');
    expect(members.find((m) => m.userId === owner.id)).toEqual({
      userId: owner.id,
      name: 'Owner',
      image: 'https://cdn.example/o.png',
    });
  });
});
