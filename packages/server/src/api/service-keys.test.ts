/**
 * Service keys (D-88): admin-only creation and revocation (audited), no user, so no per-user limit
 * and immune to offboarding; authenticated into a guild-audience principal (D-89) that sees exactly
 * the `guild` categories; owner identity (D-90), the account hash for service keys only (D-91) and
 * the bulk limits (D-92).
 */
import { CATEGORIES } from '@hub/core';
import { apiKeys, auditLog, locationSamples, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedGrant,
  seedLatestState,
  seedSharing,
  seedUser,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { MAX_LOCATION_POINTS } from '../accounts/history';
import { AdminError } from '../admin/errors';
import { offboardUser } from '../offboarding/offboard';
import { MAX_BULK_ACCOUNTS, MAX_BULK_ACCOUNTS_SERVICE, loadApiAccounts } from './access';
import { apiGetAccount, apiListAccounts } from './accounts';
import { ApiError } from './errors';
import {
  MAX_LOCATION_POINTS_PER_RESPONSE,
  apiLocations,
  apiLocationsMulti,
  locationPointLimit,
} from './history';
import { authenticateApiKey, type ApiPrincipal } from './key-auth';
import { ApiKeyError, MAX_ACTIVE_KEYS, createApiKey, listApiKeys, revokeApiKey } from './keys';
import { MAX_KEY_RATE_LIMIT, SERVICE_KEY_RATE_LIMIT } from './limits';
import { apiMe } from './me';
import {
  createServiceKey,
  listServiceKeys,
  revokeServiceKey,
  type ServiceKeyInfo,
} from './service-keys';
import { apiSnapshot } from './snapshot';
import { makeKey, present } from './test-support';
import { apiXpMulti } from './xp';

let t: TestDatabase;
let admin: SeededUser;
let member: SeededUser;
let owner: SeededUser;
let contributor: SeededUser;
/** Owned by `owner`, contributed to by `contributor`, default sharing (guild for every category). */
let shared: SeededAccount;
/** Owned by `owner`, everything private. */
let hidden: SeededAccount;
/** Owned by `owner`, everything `selected` with a grant to `member`. */
let selected: SeededAccount;
/** No owner at all, default sharing. */
let orphan: SeededAccount;

const NOW = new Date('2026-09-30T12:00:00Z');
const KEY_FORMAT = /^ohub_([0-9A-Za-z]{10})_([0-9A-Za-z]{43})$/;
const valid = { name: 'Guild live map', categories: ['activity', 'location_live'] };

async function serviceKey(input: Record<string, unknown> = {}, actor = admin.viewer) {
  const created = await createServiceKey(t.db, { actor, input: { ...valid, ...input }, now: NOW });
  const auth = await authenticateApiKey(t.db, `Bearer ${created.key}`, NOW);
  if (!auth.ok) throw new Error(`service key refused: ${auth.reason}`);
  return { ...created, principal: auth.principal };
}

async function refused(input: unknown, actor = admin.viewer): Promise<unknown> {
  return createServiceKey(t.db, { actor, input, now: NOW }).catch((e: unknown) => e);
}

async function lastAudit(action: string) {
  const [row] = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row;
}

function visibleIds(principal: ApiPrincipal) {
  return loadApiAccounts(t.db, principal).then((list) =>
    list.map((e) => e.account.publicId).sort(),
  );
}

beforeAll(async () => {
  t = await createTestDatabase('api-service-keys');
  admin = await seedUser(t.db, { name: 'Ada Admin', isAdmin: true });
  member = await seedUser(t.db, { name: 'Molly Member' });
  owner = await seedUser(t.db, { name: 'Oscar Owner' });
  contributor = await seedUser(t.db, { name: 'Connie Contributor' });
  await t.db.update(users).set({ discordId: '100000000000000042' }).where(eq(users.id, owner.id));
  shared = await seedAccount(t.db, {
    name: 'Shared Main',
    owner: owner.id,
    contributors: [contributor.id],
  });
  hidden = await seedAccount(t.db, { name: 'Hidden Alt', owner: owner.id });
  for (const c of CATEGORIES) await seedSharing(t.db, hidden.id, c, 'private');
  selected = await seedAccount(t.db, { name: 'Selected Alt', owner: owner.id });
  for (const c of CATEGORIES) {
    await seedSharing(t.db, selected.id, c, 'selected');
    await seedGrant(t.db, selected.id, c, member.id);
  }
  orphan = await seedAccount(t.db, { name: 'Orphan', owner: null });
  for (const account of [shared, hidden, selected, orphan]) {
    await seedLatestState(t.db, account.id, {
      lastSeen: NOW,
      gameState: 'LOGGED_IN',
      world: 302,
      skills: skillMap({ Attack: [13_034_431, 99] }),
      skillsUpdatedAt: NOW,
      location: { x: 3164, y: 3487, plane: 0 },
      locationUpdatedAt: NOW,
    });
    await t.db
      .insert(locationSamples)
      .values([
        { accountId: account.id, ts: new Date(NOW.getTime() - 60_000), x: 1, y: 2, plane: 0 },
      ]);
  }
});

afterAll(async () => {
  await t.drop();
});

describe('createServiceKey', () => {
  it('creates a service key an admin sees once, with no user and its own rate limit', async () => {
    const { key, info } = await serviceKey({ rateLimitPerMinute: 1200, expiresInDays: 30 });
    expect(key).toMatch(KEY_FORMAT);
    expect(info).toMatchObject({
      kind: 'service',
      name: 'Guild live map',
      categories: ['activity', 'location_live'],
      accountScope: 'all_visible',
      accounts: null,
      rateLimitPerMinute: 1200,
      status: 'active',
      createdBy: { id: admin.id, name: 'Ada Admin' },
    });
    expect(info.expiresAt).toBe(new Date(NOW.getTime() + 30 * 24 * 3600_000).toISOString());
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, info.id));
    expect(row).toMatchObject({
      kind: 'service',
      userId: null,
      createdByUserId: admin.id,
      rateLimitPerMinute: 1200,
    });
    expect(row?.secretHash).not.toContain(key.split('_')[2]);
    const entry = await lastAudit('service_key.created');
    expect(entry).toMatchObject({
      actorUserId: admin.id,
      targetType: 'api_key',
      targetId: info.id,
      meta: {
        prefix: info.prefix,
        name: 'Guild live map',
        categories: ['activity', 'location_live'],
        rateLimitPerMinute: 1200,
      },
    });
    expect(JSON.stringify(entry?.meta)).not.toContain(key.split('_')[2]);
  });

  it(`defaults the rate limit to ${SERVICE_KEY_RATE_LIMIT} per minute`, async () => {
    const { info, principal } = await serviceKey();
    expect(info.rateLimitPerMinute).toBe(SERVICE_KEY_RATE_LIMIT);
    expect(principal.rateLimitPerMinute).toBe(SERVICE_KEY_RATE_LIMIT);
  });

  it('is refused for non-admins and inactive admins (forbidden)', async () => {
    const asMember = await refused(valid, member.viewer);
    expect(asMember).toBeInstanceOf(AdminError);
    expect((asMember as AdminError).code).toBe('forbidden');
    const asGraceAdmin = await refused(valid, { ...admin.viewer, status: 'grace' });
    expect((asGraceAdmin as AdminError).code).toBe('forbidden');
  });

  it.each([
    ['an empty name', { ...valid, name: '' }],
    ['no categories', { ...valid, categories: [] }],
    ['an unknown category', { ...valid, categories: ['admin'] }],
    ['an account scope (service keys have none)', { ...valid, accountScope: 'list' }],
    ['a rate limit of 0', { ...valid, rateLimitPerMinute: 0 }],
    [
      `a rate limit above ${MAX_KEY_RATE_LIMIT}`,
      { ...valid, rateLimitPerMinute: MAX_KEY_RATE_LIMIT + 1 },
    ],
    ['a fractional rate limit', { ...valid, rateLimitPerMinute: 10.5 }],
    ['an expiry of 0 days', { ...valid, expiresInDays: 0 }],
  ])('refuses %s as invalid', async (_label, input) => {
    const err = await refused(input);
    expect(err).toBeInstanceOf(ApiKeyError);
    expect((err as ApiKeyError).code).toBe('invalid');
  });

  it(`counts towards no user's limit of ${MAX_ACTIVE_KEYS} keys`, async () => {
    const busy = await seedUser(t.db, { name: 'Busy Admin', isAdmin: true });
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      await createApiKey(
        t.db,
        busy.id,
        { name: `k${i}`, categories: ['stats'], accountScope: 'all_visible' },
        NOW,
      );
    }
    await expect(
      createApiKey(
        t.db,
        busy.id,
        { name: 'one more', categories: ['stats'], accountScope: 'all_visible' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'limit' });
    // Service keys are still fine, and don't show up among the user's own keys.
    const { info } = await serviceKey({}, busy.viewer);
    expect(info.createdBy?.id).toBe(busy.id);
    expect((await listApiKeys(t.db, busy.id, NOW)).map((k) => k.id)).not.toContain(info.id);
  });
});

describe('listServiceKeys and revokeServiceKey', () => {
  it('lists every service key newest first with its creator, and revokes with one audit entry', async () => {
    const first = await serviceKey({ name: 'List one' });
    const second = await serviceKey({ name: 'List two' });
    const listed = await listServiceKeys(t.db, NOW);
    const ids = listed.map((k) => k.id);
    expect(ids.indexOf(second.info.id)).toBeLessThan(ids.indexOf(first.info.id));
    expect(listed.every((k: ServiceKeyInfo) => k.kind === 'service')).toBe(true);
    expect(listed.find((k) => k.id === first.info.id)?.createdBy).toEqual({
      id: admin.id,
      name: 'Ada Admin',
    });

    expect(
      await revokeServiceKey(t.db, { actor: admin.viewer, keyId: first.info.id, now: NOW }),
    ).toBe(true);
    expect(
      await revokeServiceKey(t.db, { actor: admin.viewer, keyId: first.info.id, now: NOW }),
    ).toBe(true);
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.targetId, first.info.id));
    expect(entries.filter((e) => e.action === 'service_key.revoked')).toHaveLength(1);
    expect(entries.find((e) => e.action === 'service_key.revoked')?.meta).toEqual({
      prefix: first.info.prefix,
      name: 'List one',
    });
    const auth = await authenticateApiKey(t.db, `Bearer ${first.key}`, NOW);
    expect(auth).toEqual({ ok: false, reason: 'revoked' });
    expect((await listServiceKeys(t.db, NOW)).find((k) => k.id === first.info.id)?.status).toBe(
      'revoked',
    );
  });

  it('answers false for unknown ids, non-uuids and user keys; refuses non-admins', async () => {
    const userKey = await makeKey(t.db, member.id, {}, NOW);
    expect(await revokeServiceKey(t.db, { actor: admin.viewer, keyId: userKey.info.id })).toBe(
      false,
    );
    expect(await revokeServiceKey(t.db, { actor: admin.viewer, keyId: 'nope' })).toBe(false);
    expect(
      await revokeServiceKey(t.db, {
        actor: admin.viewer,
        keyId: '00000000-0000-7000-8000-000000000000',
      }),
    ).toBe(false);
    // And the user-key path never touches a service key, not even its creator's.
    const { info } = await serviceKey();
    expect(await revokeApiKey(t.db, { userId: admin.id, keyId: info.id })).toBe(false);
    await expect(
      revokeServiceKey(t.db, { actor: member.viewer, keyId: info.id }),
    ).rejects.toBeInstanceOf(AdminError);
    expect((await authenticateApiKey(t.db, `Bearer ${(await serviceKey()).key}`, NOW)).ok).toBe(
      true,
    );
  });
});

describe('a service key’s access (D-89)', () => {
  it('authenticates into a guild-audience principal without a user', async () => {
    const { principal, info } = await serviceKey();
    expect(principal).toEqual({
      keyId: info.id,
      kind: 'service',
      userId: null,
      viewer: { kind: 'guild_audience' },
      categories: new Set(['activity', 'location_live']),
      accountIds: null,
      rateLimitPerMinute: SERVICE_KEY_RATE_LIMIT,
    });
  });

  it('sees guild accounts and never private or selected ones, whatever the grants say', async () => {
    const { principal } = await serviceKey({ categories: [...CATEGORIES] });
    expect(await visibleIds(principal)).toEqual([orphan.publicId, shared.publicId].sort());
    const detail = present(await apiGetAccount(t.db, principal, shared.publicId, NOW));
    expect(detail.categories).toEqual([...CATEGORIES]);
    expect(await apiGetAccount(t.db, principal, hidden.publicId, NOW)).toBeNull();
    expect(await apiGetAccount(t.db, principal, selected.publicId, NOW)).toBeNull();
    // The member with grants sees the selected account; the service key still doesn't.
    const memberKey = await makeKey(t.db, member.id, {}, NOW);
    expect(await visibleIds(memberKey.principal)).toContain(selected.publicId);
  });

  it('follows a sharing change on the next request, and hides hidden accounts', async () => {
    const { principal } = await serviceKey({ categories: [...CATEGORIES] });
    const account = await seedAccount(t.db, { name: 'Flip Flop', owner: owner.id });
    expect(await visibleIds(principal)).toContain(account.publicId);
    for (const c of CATEGORIES) await seedSharing(t.db, account.id, c, 'private');
    expect(await visibleIds(principal)).not.toContain(account.publicId);
  });

  it('keeps working after the admin who created it is offboarded, even with reason admin', async () => {
    const creator = await seedUser(t.db, { name: 'Leaving Admin', isAdmin: true });
    const { key, info } = await serviceKey({}, creator.viewer);
    await offboardUser(t.db, { userId: creator.id, reason: 'admin', graceDays: 30, now: NOW });
    const auth = await authenticateApiKey(t.db, `Bearer ${key}`, NOW);
    expect(auth.ok).toBe(true);
    // The creator's own user keys are revoked; the service key isn't, and still names them.
    expect((await listServiceKeys(t.db, NOW)).find((k) => k.id === info.id)).toMatchObject({
      status: 'active',
      createdBy: { id: creator.id },
    });
    // Once the creator is deleted, the key still works and just loses its creator.
    await t.db.delete(users).where(eq(users.id, creator.id));
    expect((await authenticateApiKey(t.db, `Bearer ${key}`, NOW)).ok).toBe(true);
    expect((await listServiceKeys(t.db, NOW)).find((k) => k.id === info.id)?.createdBy).toBeNull();
  });

  it('reports itself on /me with user null and its kind', async () => {
    const { principal, info } = await serviceKey({ rateLimitPerMinute: 900 });
    const me = await apiMe(t.db, principal);
    expect(me).toEqual({
      key: {
        id: info.id,
        kind: 'service',
        name: 'Guild live map',
        prefix: info.prefix,
        categories: ['activity', 'location_live'],
        accountScope: 'all_visible',
        rateLimitPerMinute: 900,
        expiresAt: null,
      },
      user: null,
      visibleAccounts: 2,
    });
    const userKey = await makeKey(t.db, member.id, {}, NOW);
    expect((await apiMe(t.db, userKey.principal)).key).toMatchObject({
      kind: 'user',
      rateLimitPerMinute: 120,
    });
  });
});

describe('owner identity (D-90) and the account hash (D-91)', () => {
  it('names the active owner with their Discord id on accounts and snapshots, never contributors', async () => {
    const { principal } = await serviceKey({ categories: [...CATEGORIES] });
    const list = await apiListAccounts(t.db, principal, {}, NOW);
    const listed = list.find((a) => a.id === shared.publicId);
    expect(listed?.owner).toEqual({ name: 'Oscar Owner', discordId: '100000000000000042' });
    expect(list.find((a) => a.id === orphan.publicId)?.owner).toBeNull();
    expect(JSON.stringify(list)).not.toContain('Connie');
    const snapshot = await apiSnapshot(t.db, principal, {}, NOW);
    expect(snapshot.accounts.find((a) => a.id === shared.publicId)?.owner).toEqual({
      name: 'Oscar Owner',
      discordId: '100000000000000042',
    });
    const detail = present(await apiGetAccount(t.db, principal, shared.publicId, NOW));
    expect(detail.owner).toEqual({ name: 'Oscar Owner', discordId: '100000000000000042' });
    // A user key sees the same owner (the guild page shows it to every member, D-68).
    const userKey = await makeKey(t.db, member.id, {}, NOW);
    const forMember = await apiListAccounts(t.db, userKey.principal, {}, NOW);
    expect(forMember.find((a) => a.id === shared.publicId)?.owner).toEqual({
      name: 'Oscar Owner',
      discordId: '100000000000000042',
    });
  });

  it('drops the owner once they are in grace', async () => {
    const leaving = await seedUser(t.db, { name: 'Leaving Owner' });
    const account = await seedAccount(t.db, { name: 'Left Behind', owner: leaving.id });
    await seedLatestState(t.db, account.id, { lastSeen: NOW });
    const { principal } = await serviceKey({ categories: [...CATEGORIES] });
    const before = await apiListAccounts(t.db, principal, { ids: [account.publicId] }, NOW);
    expect(before[0]?.owner).toEqual({ name: 'Leaving Owner', discordId: null });
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, leaving.id));
    const after = await apiListAccounts(t.db, principal, { ids: [account.publicId] }, NOW);
    expect(after.map((a) => a.owner)).toEqual([null]);
  });

  it('gives the account hash to service keys only', async () => {
    const { principal } = await serviceKey({ categories: [...CATEGORIES] });
    const [row] = await t.db.select({ hash: users.id }).from(users).where(eq(users.id, owner.id));
    expect(row).toBeTruthy();
    const list = await apiListAccounts(t.db, principal, { ids: [shared.publicId] }, NOW);
    expect(list[0]?.accountHash).toMatch(/^[0-9a-f-]{36}$/);
    const snapshot = await apiSnapshot(t.db, principal, {}, NOW);
    expect(snapshot.accounts.find((a) => a.id === shared.publicId)?.accountHash).toBe(
      list[0]?.accountHash,
    );
    const detail = present(await apiGetAccount(t.db, principal, shared.publicId, NOW));
    expect(detail.accountHash).toBe(list[0]?.accountHash);

    const userKey = await makeKey(t.db, owner.id, {}, NOW);
    const forOwner = await apiListAccounts(
      t.db,
      userKey.principal,
      { ids: [shared.publicId] },
      NOW,
    );
    expect(forOwner[0]).not.toHaveProperty('accountHash');
    expect(
      present(await apiGetAccount(t.db, userKey.principal, shared.publicId, NOW)),
    ).not.toHaveProperty('accountHash');
    expect(
      (await apiSnapshot(t.db, userKey.principal, {}, NOW)).accounts.find(
        (a) => a.id === shared.publicId,
      ),
    ).not.toHaveProperty('accountHash');
  });
});

describe('bulk history (D-92)', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `Fake${String(i).padStart(8, '0')}`);

  it(`lets a service key name ${MAX_BULK_ACCOUNTS_SERVICE} accounts on /xp and a user key ${MAX_BULK_ACCOUNTS}`, async () => {
    const { principal } = await serviceKey({ categories: ['stats'] });
    const overService = await apiXpMulti(
      t.db,
      principal,
      { ids: ids(MAX_BULK_ACCOUNTS_SERVICE + 1) },
      NOW,
    ).catch((e: unknown) => e);
    expect(overService).toBeInstanceOf(ApiError);
    expect((overService as ApiError).code).toBe('invalid');
    // Within the limit, an unknown account is the 404, not the limit.
    const unknown = await apiXpMulti(
      t.db,
      principal,
      { ids: ids(MAX_BULK_ACCOUNTS_SERVICE) },
      NOW,
    ).catch((e: unknown) => e);
    expect((unknown as ApiError).code).toBe('not_found');
    const userKey = await makeKey(t.db, member.id, {}, NOW);
    const overUser = await apiXpMulti(
      t.db,
      userKey.principal,
      { ids: ids(MAX_BULK_ACCOUNTS + 1) },
      NOW,
    ).catch((e: unknown) => e);
    expect((overUser as ApiError).code).toBe('invalid');
    expect((overUser as ApiError).message).toContain(String(MAX_BULK_ACCOUNTS));
  });

  it('returns every account’s trail in one call, exactly as the per-account endpoint does', async () => {
    const ownerKey = await makeKey(t.db, owner.id, {}, NOW);
    const single = present(await apiLocations(t.db, ownerKey.principal, shared.publicId, {}, NOW));
    const multi = await apiLocationsMulti(
      t.db,
      ownerKey.principal,
      { ids: [hidden.publicId, shared.publicId] },
      NOW,
    );
    expect(multi.from).toBe(single.from);
    expect(multi.to).toBe(single.to);
    expect(multi.accounts.map((a) => a.account.id)).toEqual([hidden.publicId, shared.publicId]);
    expect(multi.accounts[1]?.points).toEqual(single.points);
    expect(single.points).toHaveLength(1);
    expect(single.truncated).toBe(false);
    expect(multi.accounts.map((a) => a.truncated)).toEqual([false, false]);
  });

  it('reads the last 24 hours of the trail by default, where the other histories read 30 days', async () => {
    const ownerKey = await makeKey(t.db, owner.id, {}, NOW);
    const day = 24 * 60 * 60 * 1000;
    const dayAgo = new Date(NOW.getTime() - day).toISOString();
    const single = present(await apiLocations(t.db, ownerKey.principal, shared.publicId, {}, NOW));
    expect([single.from, single.to]).toEqual([dayAgo, NOW.toISOString()]);
    const multi = await apiLocationsMulti(
      t.db,
      ownerKey.principal,
      { ids: [shared.publicId] },
      NOW,
    );
    expect([multi.from, multi.to]).toEqual([dayAgo, NOW.toISOString()]);
    // With `to` alone, the 24 hours before it.
    const to = new Date(NOW.getTime() - 3 * day);
    const earlier = present(
      await apiLocations(t.db, ownerKey.principal, shared.publicId, { to }, NOW),
    );
    expect(earlier.from).toBe(new Date(to.getTime() - day).toISOString());
    expect(earlier.points).toEqual([]);
  });

  it('caps a trail at 20,000 points, and a bulk response at 100,000 shared between its accounts', () => {
    expect(MAX_LOCATION_POINTS).toBe(20_000);
    expect(MAX_LOCATION_POINTS_PER_RESPONSE).toBe(100_000);
    expect([1, 5, 6, 8, 50].map(locationPointLimit)).toEqual([
      20_000, 20_000, 16_666, 12_500, 2_000,
    ]);
  });

  it('cuts a longer trail to its newest points and flags it, per account', async () => {
    const ownerKey = await makeKey(t.db, owner.id, {}, NOW);
    // 20,005 points ending two minutes ago, a game tick apart, on the account whose one seeded point
    // is a minute old: 20,006 in the last 24 hours.
    await t.db.execute(sql`
      INSERT INTO location_samples (account_id, ts, x, y, plane)
      SELECT ${selected.id}, ${NOW.toISOString()}::timestamptz - interval '2 minutes'
               - (20005 - g) * interval '600 milliseconds', g, 0, 0
      FROM generate_series(1, 20005) g`);
    const single = present(
      await apiLocations(t.db, ownerKey.principal, selected.publicId, {}, NOW),
    );
    expect(single.truncated).toBe(true);
    expect(single.points).toHaveLength(20_000);
    // Oldest first, the six oldest dropped; the seeded point (x 1) is the newest.
    expect(single.points[0]?.x).toBe(7);
    expect(single.points.at(-1)?.x).toBe(1);

    const multi = await apiLocationsMulti(
      t.db,
      ownerKey.principal,
      { ids: [shared.publicId, selected.publicId] },
      NOW,
    );
    expect(multi.accounts.map((a) => [a.points.length, a.truncated])).toEqual([
      [1, false],
      [20_000, true],
    ]);
    // The next page: everything up to the oldest point served.
    const older = present(
      await apiLocations(
        t.db,
        ownerKey.principal,
        selected.publicId,
        { to: new Date(single.points[0]!.at) },
        NOW,
      ),
    );
    expect(older.truncated).toBe(false);
    expect(older.points.map((p) => p.x)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is gated by location_history: a service key gets the one 404 for accounts that keep it private', async () => {
    // The account keeps its trail private (the default is guild, D-96), so the guild audience reads
    // no trail...
    await seedSharing(t.db, shared.id, 'location_history', 'private');
    const { principal } = await serviceKey({ categories: ['location_history'] });
    const closed = await apiLocationsMulti(t.db, principal, { ids: [shared.publicId] }, NOW).catch(
      (e: unknown) => e,
    );
    expect((closed as ApiError).code).toBe('not_found');
    // ...until the owner shares it with the guild.
    await seedSharing(t.db, shared.id, 'location_history', 'guild');
    const open = await apiLocationsMulti(t.db, principal, { ids: [shared.publicId] }, NOW);
    expect(open.accounts[0]?.points).toHaveLength(1);
    const bad = await apiLocationsMulti(t.db, principal, { ids: [] }, NOW).catch((e: unknown) => e);
    expect((bad as ApiError).code).toBe('invalid');
  });
});
