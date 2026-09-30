import { CATEGORIES, sha256Hex } from '@hub/core';
import { apiKeys, auditLog, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAccount, seedSharing, seedUser, type SeededUser } from '../accounts/test-support';
import { offboardUser, restoreUser } from '../offboarding/offboard';
import {
  API_KEY_PREFIX,
  LAST_USED_RESOLUTION_MS,
  MAX_ACTIVE_KEYS,
  ApiKeyError,
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiAuthFailure,
} from './keys';
import { makeKey } from './test-support';

let t: TestDatabase;
let alice: SeededUser;
let bob: SeededUser;
let aliceAccount: { id: number; publicId: string; name: string };
let bobPrivate: { id: number; publicId: string; name: string };
let bobGuild: { id: number; publicId: string; name: string };

const NOW = new Date('2026-09-28T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KEY_FORMAT = /^ohub_([0-9A-Za-z]{10})_([0-9A-Za-z]{43})$/;

beforeAll(async () => {
  t = await createTestDatabase('api-keys');
  alice = await seedUser(t.db, { name: 'Alice' });
  bob = await seedUser(t.db, { name: 'Bob' });
  aliceAccount = await seedAccount(t.db, { name: 'Alice Main', owner: alice.id });
  bobGuild = await seedAccount(t.db, { name: 'Bob Guild', owner: bob.id });
  bobPrivate = await seedAccount(t.db, { name: 'Bob Private', owner: bob.id });
  for (const c of CATEGORIES) await seedSharing(t.db, bobPrivate.id, c, 'private');
});

afterAll(async () => {
  await t.drop();
});

const valid = { name: 'Home Assistant', categories: ['stats'], accountScope: 'all_visible' };

async function refused(userId: string, input: unknown): Promise<ApiKeyError> {
  const err = await createApiKey(t.db, userId, input, NOW).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiKeyError);
  return err as ApiKeyError;
}

async function keyRow(id: string) {
  const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) throw new Error('key row missing');
  return row;
}

describe('createApiKey validation', () => {
  it.each([
    ['a missing body', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'key'],
    ['an unknown field', { ...valid, admin: true }],
    ['a missing name', { categories: ['stats'], accountScope: 'all_visible' }],
    ['an empty name', { ...valid, name: '' }],
    ['a blank name', { ...valid, name: ' \t\n ' }],
    ['a name of 65 characters', { ...valid, name: 'x'.repeat(65) }],
    ['a name that is not a string', { ...valid, name: 42 }],
    ['missing categories', { name: 'k', accountScope: 'all_visible' }],
    ['no categories', { ...valid, categories: [] }],
    ['an unknown category', { ...valid, categories: ['stats', 'admin'] }],
    ['categories that are not a list', { ...valid, categories: 'stats' }],
    ['a missing scope', { name: 'k', categories: ['stats'] }],
    ['an unknown scope', { ...valid, accountScope: 'everything' }],
    ['a list scope without accounts', { ...valid, accountScope: 'list' }],
    ['a list scope with an empty list', { ...valid, accountScope: 'list', accountPublicIds: [] }],
    ['accounts with the all_visible scope', { ...valid, accountPublicIds: ['abc'] }],
    ['a malformed account id', { ...valid, accountScope: 'list', accountPublicIds: ['a b'] }],
    ['a NUL in an account id', { ...valid, accountScope: 'list', accountPublicIds: ['a\u0000'] }],
    ['expiry 0 days', { ...valid, expiresInDays: 0 }],
    ['expiry 366 days', { ...valid, expiresInDays: 366 }],
    ['a fractional expiry', { ...valid, expiresInDays: 1.5 }],
    ['an expiry as a string', { ...valid, expiresInDays: '30' }],
  ])('refuses %s as invalid', async (_label, input) => {
    const err = await refused(alice.id, input);
    expect(err.code).toBe('invalid');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('names the offending field in the issues', async () => {
    const err = await refused(alice.id, { ...valid, accountScope: 'list' });
    expect(err.issues).toEqual([
      { path: 'accountPublicIds', message: 'required when accountScope is "list"' },
    ]);
    expect(err.message).toBe('accountPublicIds: required when accountScope is "list"');
    const name = await refused(alice.id, { ...valid, name: 'x'.repeat(65) });
    expect(name.issues.map((i) => i.path)).toEqual(['name']);
  });

  it('trims the name, turns control characters into spaces, and counts characters, not UTF-16 units', async () => {
    const { info } = await createApiKey(
      t.db,
      alice.id,
      { ...valid, name: '  HA\u0000bot\n ' },
      NOW,
    );
    expect(info.name).toBe('HA bot');
    const keys = '🔑'.repeat(64);
    expect((await createApiKey(t.db, alice.id, { ...valid, name: keys }, NOW)).info.name).toBe(
      keys,
    );
    expect((await refused(alice.id, { ...valid, name: `${keys}🔑` })).code).toBe('invalid');
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });

  it('deduplicates categories and keeps them in the canonical order', async () => {
    const { info } = await createApiKey(
      t.db,
      alice.id,
      { ...valid, categories: ['inventory', 'stats', 'inventory', 'activity'] },
      NOW,
    );
    expect(info.categories).toEqual(['stats', 'activity', 'inventory']);
    expect((await keyRow(info.id)).categories).toEqual(['stats', 'activity', 'inventory']);
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });

  it('accepts an account list of accounts the creator can see, deduplicated', async () => {
    const { info } = await createApiKey(
      t.db,
      alice.id,
      {
        ...valid,
        accountScope: 'list',
        accountPublicIds: [bobGuild.publicId, aliceAccount.publicId, bobGuild.publicId],
      },
      NOW,
    );
    expect(info.accountScope).toBe('list');
    expect(info.accounts).toEqual([
      { publicId: bobGuild.publicId, name: 'Bob Guild', visible: true },
      { publicId: aliceAccount.publicId, name: 'Alice Main', visible: true },
    ]);
    expect((await keyRow(info.id)).accountIds).toEqual([bobGuild.id, aliceAccount.id]);
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });

  it('refuses accounts the creator cannot see, unknown ones and hidden ones alike', async () => {
    const hidden = await seedAccount(t.db, { name: 'Hidden', owner: alice.id, status: 'hidden' });
    for (const id of [bobPrivate.publicId, 'nosuchaccount', hidden.publicId]) {
      const err = await refused(alice.id, {
        ...valid,
        accountScope: 'list',
        accountPublicIds: [aliceAccount.publicId, id],
      });
      expect(err.code).toBe('invalid');
      expect(err.message).toBe(`account not found: ${id}`);
      expect(err.issues[0]?.path).toBe('accountPublicIds');
    }
  });

  it('gives no admin override: an admin cannot list an account only admins can see', async () => {
    const admin = await seedUser(t.db, { isAdmin: true });
    const hidden = await seedAccount(t.db, { name: 'Hidden 2', owner: bob.id, status: 'hidden' });
    const err = await refused(admin.id, {
      ...valid,
      accountScope: 'list',
      accountPublicIds: [hidden.publicId],
    });
    expect(err.code).toBe('invalid');
  });

  it('refuses users who are not active, and users that do not exist', async () => {
    const grace = await seedUser(t.db, { status: 'grace' });
    expect((await refused(grace.id, valid)).code).toBe('invalid');
    expect((await refused('no-such-user', valid)).code).toBe('not_found');
  });

  it('sets the expiry from expiresInDays; null or omitted never expires', async () => {
    const week = await createApiKey(t.db, alice.id, { ...valid, expiresInDays: 7 }, NOW);
    expect(week.info.expiresAt).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    const max = await createApiKey(t.db, alice.id, { ...valid, expiresInDays: 365 }, NOW);
    expect(max.info.expiresAt).toBe(new Date(NOW.getTime() + 365 * DAY).toISOString());
    const never = await createApiKey(t.db, alice.id, { ...valid, expiresInDays: null }, NOW);
    expect(never.info.expiresAt).toBeNull();
    expect((await createApiKey(t.db, alice.id, valid, NOW)).info.expiresAt).toBeNull();
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });
});

describe('the key shown once', () => {
  it('has the ohub_<prefix>_<secret> format, and only sha256(secret) is stored', async () => {
    const { key, info } = await createApiKey(t.db, alice.id, valid, NOW);
    const [, prefix, secret] = KEY_FORMAT.exec(key) ?? [];
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toBe(info.prefix);
    const row = await keyRow(info.id);
    expect(row.prefix).toBe(prefix);
    expect(row.secretHash).toBe(sha256Hex(secret as string));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(info)).not.toContain(secret);
    expect(JSON.stringify(await listApiKeys(t.db, alice.id, NOW))).not.toMatch(
      new RegExp(`${secret}|${row.secretHash}`),
    );
    expect(info).toEqual({
      id: row.id,
      kind: 'user',
      name: 'Home Assistant',
      prefix,
      categories: ['stats'],
      accountScope: 'all_visible',
      accounts: null,
      rateLimitPerMinute: 120,
      expiresAt: null,
      createdAt: NOW.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      status: 'active',
    });
  });

  it('is different every time (random prefix and secret)', async () => {
    const a = await createApiKey(t.db, alice.id, valid, NOW);
    const b = await createApiKey(t.db, alice.id, valid, NOW);
    expect(a.key).not.toBe(b.key);
    expect(a.info.prefix).not.toBe(b.info.prefix);
    expect(a.key.slice(16)).not.toBe(b.key.slice(16));
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });

  it('is audited without the secret or its hash', async () => {
    const { key, info } = await createApiKey(
      t.db,
      alice.id,
      { ...valid, accountScope: 'list', accountPublicIds: [aliceAccount.publicId] },
      NOW,
    );
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'api_key.created'), eq(auditLog.targetId, info.id)));
    expect(entry).toMatchObject({ actorUserId: alice.id, targetType: 'api_key' });
    expect(entry?.meta).toEqual({
      prefix: info.prefix,
      name: 'Home Assistant',
      categories: ['stats'],
      accountScope: 'list',
      accountCount: 1,
      expiresAt: null,
    });
    const row = await keyRow(info.id);
    expect(JSON.stringify(entry)).not.toContain(key.slice(16));
    expect(JSON.stringify(entry)).not.toContain(row.secretHash);
    await t.db.delete(apiKeys).where(eq(apiKeys.userId, alice.id));
  });
});

describe('the active key limit', () => {
  it(`allows ${MAX_ACTIVE_KEYS} active keys, then refuses with 'limit' until one is revoked or expires`, async () => {
    const carol = await seedUser(t.db);
    const expiring = await createApiKey(t.db, carol.id, { ...valid, expiresInDays: 1 }, NOW);
    const ids = [expiring.info.id];
    for (let i = 1; i < MAX_ACTIVE_KEYS; i++) {
      ids.push((await createApiKey(t.db, carol.id, valid, NOW)).info.id);
    }
    const err = await refused(carol.id, valid);
    expect(err.code).toBe('limit');

    // An expired key no longer counts.
    const later = new Date(NOW.getTime() + 2 * DAY);
    await createApiKey(t.db, carol.id, valid, later);
    expect(
      (await createApiKey(t.db, carol.id, valid, later).catch((e: unknown) => e)) as ApiKeyError,
    ).toMatchObject({ code: 'limit' });

    // Nor does a revoked one.
    expect(await revokeApiKey(t.db, { userId: carol.id, keyId: ids[1] as string })).toBe(true);
    await createApiKey(t.db, carol.id, valid, later);
    expect(await listApiKeys(t.db, carol.id, later)).toHaveLength(MAX_ACTIVE_KEYS + 2);
  });

  it('holds when two creations race (the creator row is locked first)', async () => {
    const dave = await seedUser(t.db);
    for (let i = 0; i < MAX_ACTIVE_KEYS - 1; i++) await createApiKey(t.db, dave.id, valid, NOW);
    const results = await Promise.allSettled([
      createApiKey(t.db, dave.id, valid, NOW),
      createApiKey(t.db, dave.id, valid, NOW),
      createApiKey(t.db, dave.id, valid, NOW),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'limit' });
    }
  });
});

describe('listApiKeys', () => {
  it('lists the user’s keys newest first with their status, and never another user’s', async () => {
    const erin = await seedUser(t.db);
    const first = await createApiKey(t.db, erin.id, { ...valid, name: 'first' }, NOW);
    const second = await createApiKey(
      t.db,
      erin.id,
      { ...valid, name: 'second', expiresInDays: 1 },
      new Date(NOW.getTime() + MIN),
    );
    const third = await createApiKey(
      t.db,
      erin.id,
      { ...valid, name: 'third' },
      new Date(NOW.getTime() + 2 * MIN),
    );
    await revokeApiKey(t.db, { userId: erin.id, keyId: third.info.id });
    await createApiKey(t.db, bob.id, { ...valid, name: 'bob' }, NOW);

    const later = new Date(NOW.getTime() + 2 * DAY);
    const list = await listApiKeys(t.db, erin.id, later);
    expect(list.map((k) => [k.name, k.status])).toEqual([
      ['third', 'revoked'],
      ['second', 'expired'],
      ['first', 'active'],
    ]);
    expect(list[0]?.revokedAt).not.toBeNull();
    expect(list.map((k) => k.id)).toEqual([third.info.id, second.info.id, first.info.id]);
  });

  it('keeps listing accounts the creator can no longer see, flagged, and drops deleted ones', async () => {
    const frank = await seedUser(t.db);
    const shared = await seedAccount(t.db, { name: 'Shared', owner: bob.id });
    const gone = await seedAccount(t.db, { name: 'Gone', owner: bob.id });
    const { info } = await createApiKey(
      t.db,
      frank.id,
      { ...valid, accountScope: 'list', accountPublicIds: [shared.publicId, gone.publicId] },
      NOW,
    );
    for (const c of CATEGORIES) await seedSharing(t.db, shared.id, c, 'private');
    await t.db.execute(sql`DELETE FROM osrs_accounts WHERE id = ${gone.id}`);
    const [listed] = await listApiKeys(t.db, frank.id, NOW);
    expect(listed?.id).toBe(info.id);
    expect(listed?.accounts).toEqual([
      // No longer visible to frank: listed, but without its (possibly renamed) name.
      { publicId: shared.publicId, name: null, visible: false },
    ]);
  });
});

describe('revokeApiKey', () => {
  it('revokes the user’s own key once, idempotently, with one audit entry', async () => {
    const { info } = await createApiKey(t.db, alice.id, valid, NOW);
    expect(await revokeApiKey(t.db, { userId: alice.id, keyId: info.id, now: NOW })).toBe(true);
    const revokedAt = (await keyRow(info.id)).revokedAt;
    expect(revokedAt?.toISOString()).toBe(NOW.toISOString());
    expect(
      await revokeApiKey(t.db, {
        userId: alice.id,
        keyId: info.id,
        now: new Date(NOW.getTime() + DAY),
      }),
    ).toBe(true);
    expect((await keyRow(info.id)).revokedAt?.toISOString()).toBe(NOW.toISOString());
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'api_key.revoked'), eq(auditLog.targetId, info.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: alice.id,
      meta: { ownerUserId: alice.id, prefix: info.prefix, asAdmin: false },
    });
  });

  it('refuses someone else’s key (false), unless as admin', async () => {
    const { info } = await createApiKey(t.db, bob.id, valid, NOW);
    expect(await revokeApiKey(t.db, { userId: alice.id, keyId: info.id })).toBe(false);
    expect((await keyRow(info.id)).revokedAt).toBeNull();
    expect(await revokeApiKey(t.db, { userId: alice.id, keyId: info.id, asAdmin: true })).toBe(
      true,
    );
    expect((await keyRow(info.id)).revokedAt).not.toBeNull();
  });

  it('answers false for unknown ids and ids that are not uuids', async () => {
    for (const keyId of ['00000000-0000-7000-8000-000000000000', 'nope', 'x\u0000']) {
      expect(await revokeApiKey(t.db, { userId: alice.id, keyId })).toBe(false);
    }
  });
});

describe('authenticateApiKey', () => {
  async function reason(header: string | null, now = NOW): Promise<ApiAuthFailure | 'ok'> {
    const result = await authenticateApiKey(t.db, header, now);
    return result.ok ? 'ok' : result.reason;
  }

  it('authenticates a valid key into a principal', async () => {
    const { key, info } = await createApiKey(
      t.db,
      alice.id,
      { ...valid, categories: ['stats', 'events'] },
      NOW,
    );
    const result = await authenticateApiKey(t.db, `Bearer ${key}`, NOW);
    expect(result).toEqual({
      ok: true,
      principal: {
        keyId: info.id,
        kind: 'user',
        userId: alice.id,
        viewer: { userId: alice.id, status: 'active', isAdmin: false },
        categories: new Set(['stats', 'events']),
        accountIds: null,
        rateLimitPerMinute: 120,
      },
    });
    // The scheme name is case-insensitive; more than one space is allowed.
    expect(await reason(`bearer ${key}`)).toBe('ok');
    expect(await reason(`BEARER   ${key}`)).toBe('ok');
    expect(await reason(`Bearer ${key}  `)).toBe('ok');
  });

  it('carries an account list as internal ids', async () => {
    const { principal } = await makeKey(
      t.db,
      alice.id,
      { accountScope: 'list', accountPublicIds: [aliceAccount.publicId] },
      NOW,
    );
    expect(principal.accountIds).toEqual(new Set([aliceAccount.id]));
  });

  it('never makes an admin creator an admin', async () => {
    const admin = await seedUser(t.db, { isAdmin: true });
    const { principal } = await makeKey(t.db, admin.id, {}, NOW);
    expect(principal.viewer).toMatchObject({ userId: admin.id, isAdmin: false });
  });

  it('refuses a missing header as missing', async () => {
    expect(await reason(null)).toBe('missing');
    expect(await reason('')).toBe('missing');
    expect(await reason('   ')).toBe('missing');
  });

  it('refuses anything but Bearer ohub_<10>_<43> as malformed', async () => {
    const { key } = await createApiKey(t.db, alice.id, valid, NOW);
    const [, prefix, secret] = KEY_FORMAT.exec(key) ?? [];
    for (const header of [
      key,
      `Basic ${key}`,
      'Bearer',
      'Bearer ',
      `Bearer ${key}x`,
      `Bearer ${key.slice(0, -1)}`,
      `Bearer x${key}`,
      `Bearer ${key.toUpperCase()}`,
      `Bearer OHUB_${prefix}_${secret}`,
      `Bearer ohub_${prefix}${secret}`,
      `Bearer ohub_${prefix}_${secret?.slice(0, 42)}!`,
      `Bearer ${key} extra`,
      `Bearer\t${key}`,
      `Bearer ${'x'.repeat(600)}`,
    ]) {
      expect(await reason(header), header.slice(0, 40)).toBe('malformed');
    }
  });

  it('answers unknown for an unknown prefix and for a wrong secret alike', async () => {
    const { key } = await createApiKey(t.db, alice.id, valid, NOW);
    const [, prefix, secret] = KEY_FORMAT.exec(key) ?? [];
    const otherSecret = `${secret?.slice(0, 42)}${secret?.endsWith('A') ? 'B' : 'A'}`;
    expect(await reason(`Bearer ohub_${prefix}_${otherSecret}`)).toBe('unknown');
    expect(await reason(`Bearer ohub_AAAAAAAAAA_${secret}`)).toBe('unknown');
  });

  it('answers revoked and expired only for the right secret', async () => {
    const revoked = await createApiKey(t.db, alice.id, valid, NOW);
    await revokeApiKey(t.db, { userId: alice.id, keyId: revoked.info.id });
    expect(await reason(`Bearer ${revoked.key}`)).toBe('revoked');
    expect(
      await reason(`Bearer ${revoked.key.slice(0, -1)}${revoked.key.endsWith('A') ? 'B' : 'A'}`),
    ).toBe('unknown');

    const expiring = await createApiKey(t.db, alice.id, { ...valid, expiresInDays: 1 }, NOW);
    const expiry = NOW.getTime() + DAY;
    expect(await reason(`Bearer ${expiring.key}`, new Date(expiry - 1))).toBe('ok');
    expect(await reason(`Bearer ${expiring.key}`, new Date(expiry))).toBe('expired');
  });

  it('refuses the key of a creator who is not active (inactive_user)', async () => {
    const gina = await seedUser(t.db);
    const { key } = await createApiKey(t.db, gina.id, valid, NOW);
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, gina.id));
    expect(await reason(`Bearer ${key}`)).toBe('inactive_user');
    await t.db.update(users).set({ status: 'active' }).where(eq(users.id, gina.id));
    expect(await reason(`Bearer ${key}`)).toBe('ok');
  });

  it('keeps keys revoked when an offboarded user is restored', async () => {
    const hank = await seedUser(t.db);
    const { key, info } = await createApiKey(t.db, hank.id, valid, NOW);
    await offboardUser(t.db, { userId: hank.id, reason: 'left_guild', graceDays: 30, now: NOW });
    expect(await reason(`Bearer ${key}`)).toBe('revoked');
    await restoreUser(t.db, { userId: hank.id, now: NOW });
    expect(await reason(`Bearer ${key}`)).toBe('revoked');
    expect((await listApiKeys(t.db, hank.id, NOW)).map((k) => [k.id, k.status])).toEqual([
      [info.id, 'revoked'],
    ]);
  });
});

describe('last_used_at', () => {
  it('is written on first use, then at most once a minute', async () => {
    const { key, info } = await createApiKey(t.db, alice.id, valid, NOW);
    expect((await keyRow(info.id)).lastUsedAt).toBeNull();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    await authenticateApiKey(t.db, `Bearer ${key}`, at(0));
    expect((await keyRow(info.id)).lastUsedAt?.toISOString()).toBe(at(0).toISOString());
    await authenticateApiKey(t.db, `Bearer ${key}`, at(30_000));
    await authenticateApiKey(t.db, `Bearer ${key}`, at(LAST_USED_RESOLUTION_MS - 1));
    expect((await keyRow(info.id)).lastUsedAt?.toISOString()).toBe(at(0).toISOString());
    await authenticateApiKey(t.db, `Bearer ${key}`, at(LAST_USED_RESOLUTION_MS + 1));
    expect((await keyRow(info.id)).lastUsedAt?.toISOString()).toBe(
      at(LAST_USED_RESOLUTION_MS + 1).toISOString(),
    );
    // Failed authentications never touch it.
    await authenticateApiKey(t.db, `Bearer ${key}`, at(DAY * 400));
    await revokeApiKey(t.db, { userId: alice.id, keyId: info.id });
    await authenticateApiKey(t.db, `Bearer ${key}`, at(DAY * 800));
    expect((await keyRow(info.id)).lastUsedAt?.toISOString()).toBe(at(DAY * 400).toISOString());
  });

  it('does not wait for a row another transaction holds, and never fails the request', async () => {
    const { key, info } = await createApiKey(t.db, alice.id, valid, NOW);
    const later = new Date(NOW.getTime() + 5 * MIN);
    let released!: () => void;
    const hold = new Promise<void>((resolve) => (released = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM api_keys WHERE id = ${info.id} FOR UPDATE`);
      locked();
      await hold;
    });
    await isLocked;
    const started = performance.now();
    const result = await authenticateApiKey(t.db, `Bearer ${key}`, later);
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    released();
    await holder;
    expect((await keyRow(info.id)).lastUsedAt).toBeNull();

    // A database error in the write is swallowed.
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') return () => Promise.reject(new Error('boom'));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    expect((await authenticateApiKey(failing, `Bearer ${key}`, later)).ok).toBe(true);
  });
});
