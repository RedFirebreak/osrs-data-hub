/**
 * The public API's read models over data written by the real ingest pipeline from the plugin
 * fixtures: /me, /accounts, /accounts/{id}, /snapshot, XP, gains, histories and leaderboards.
 */
import { type Db } from '@hub/db';
import { osrsAccounts } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSharing } from '../accounts/test-support';
import {
  createHarness,
  newHash,
  realTotalLevel,
  wire,
  type Harness,
  type SeededDevice,
  type Wire,
} from '../ingest/test-support';
import { updateUserSettings } from '../settings/user-settings';
import { apiGetAccount, apiListAccounts, type ApiAccountDetail } from './accounts';
import { ApiError } from './errors';
import { apiEquipmentHistory, apiLocations, apiSessions, apiWealth } from './history';
import { apiLeaderboardGains } from './leaderboards';
import { apiMe } from './me';
import { SNAPSHOT_SINCE_OVERLAP_MS, apiSnapshot, etagMatches } from './snapshot';
import { makeKey, present, type TestKey } from './test-support';
import { apiGains, apiXp, apiXpMulti } from './xp';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** snapshot-normal's tickDelay is 100: presence times out after floor(100 × 1.86) s (D-28). */
const PRESENCE_TIMEOUT_MS = 186 * SEC;
const ATTACK_GAIN = 5_000;

let t: TestDatabase;
let h: Harness;
let ownerId: string;
let ironId: string;
let memberId: string;
let ownerDevice: SeededDevice;
let normal: Wire;
let t0: number;
/** The time most tests read at: just after Zezima's second snapshot. */
let NOW: Date;
let zezima: string;
let iron: string;
let bare: string;
let ownerKey: TestKey;
let memberKey: TestKey;
let statsKey: TestKey;
let mapKey: TestKey;

async function publicIdOf(hash: string): Promise<string> {
  const [row] = await t.db
    .select({ publicId: osrsAccounts.publicId })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, hash));
  if (!row) throw new Error('account missing');
  return row.publicId;
}

async function send(device: SeededDevice, body: Wire, at: number): Promise<void> {
  body.timestamp = at - SEC;
  expect((await h.send(device, body, { at })).status).toBe(200);
}

beforeAll(async () => {
  t = await createTestDatabase('api-read-models');
  h = createHarness(t);
  ownerId = await h.seedUser();
  memberId = await h.seedUser();
  ironId = await h.seedUser();
  ownerDevice = await h.seedDevice(ownerId);
  const ironDevice = await h.seedDevice(ironId);

  const hash = newHash();
  normal = wire('snapshot-normal', { hash });
  t0 = normal.timestamp as number;
  await send(ownerDevice, normal, t0 + SEC);
  zezima = await publicIdOf(hash);

  const death = wire('event-death-dangerous', { freshEventIds: true });
  await send(ironDevice, death, t0 + 10 * MIN);
  iron = await publicIdOf(death.player?.accountHash as string);
  // Iron Mira keeps her live location private (the default is guild, D-82).
  const [ironRow] = await t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.publicId, iron));
  if (!ironRow) throw new Error('account missing');
  await seedSharing(t.db, ironRow.id, 'location_live', 'private');

  const bareHash = newHash();
  await send(
    ownerDevice,
    wire('snapshot-no-sections', { hash: bareHash, name: 'Bare Bones' }),
    t0 + 20 * MIN,
  );
  bare = await publicIdOf(bareHash);

  const later = wire('snapshot-normal', { hash });
  const attack = later.player?.stats?.skills.Attack;
  if (!attack) throw new Error('fixture without Attack');
  attack.xp += ATTACK_GAIN;
  await send(ownerDevice, later, t0 + HOUR + SEC);
  NOW = new Date(t0 + HOUR + 2 * SEC);

  await updateUserSettings(t.db, ownerId, { timezone: 'Pacific/Kiritimati' });
  ownerKey = await makeKey(t.db, ownerId, { name: 'owner' }, NOW);
  memberKey = await makeKey(t.db, memberId, { name: 'member' }, NOW);
  statsKey = await makeKey(t.db, memberId, { name: 'stats', categories: ['stats'] }, NOW);
  mapKey = await makeKey(
    t.db,
    ownerId,
    { name: 'map', categories: ['activity', 'location_live'] },
    NOW,
  );
});

afterAll(async () => {
  await t.drop();
});

async function detail(key: TestKey, id: string, now = NOW): Promise<ApiAccountDetail> {
  return present(await apiGetAccount(t.db, key.principal, id, now));
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('apiMe', () => {
  it('describes the key, its creator and how many accounts it sees', async () => {
    const me = await apiMe(t.db, statsKey.principal);
    expect(me).toEqual({
      key: {
        id: statsKey.info.id,
        kind: 'user',
        name: 'stats',
        prefix: statsKey.info.prefix,
        categories: ['stats'],
        accountScope: 'all_visible',
        rateLimitPerMinute: 120,
        expiresAt: null,
      },
      user: { name: memberId },
      visibleAccounts: 3,
    });
  });
});

describe('apiListAccounts', () => {
  it('lists the visible accounts by name, with presence only for activity', async () => {
    const list = await apiListAccounts(t.db, memberKey.principal, {}, NOW);
    // Owners as the guild page shows them (D-89): the seeded users have no Discord id.
    const ownerOf = (name: string) => ({ name, discordId: null });
    expect(list).toEqual([
      {
        id: bare,
        name: 'Bare Bones',
        type: 0,
        typeLabel: 'Normal',
        owner: ownerOf(ownerId),
        online: false,
        world: 302,
        lastSeen: new Date(t0 + 20 * MIN).toISOString(),
      },
      {
        id: iron,
        name: 'Iron Mira',
        type: 1,
        typeLabel: 'Ironman',
        owner: ownerOf(ironId),
        online: false,
        world: 319,
        lastSeen: new Date(t0 + 10 * MIN).toISOString(),
      },
      {
        id: zezima,
        name: 'Zezima',
        type: 0,
        typeLabel: 'Normal',
        owner: ownerOf(ownerId),
        online: true,
        world: 302,
        lastSeen: new Date(t0 + HOUR + SEC).toISOString(),
      },
    ]);
    const statsOnly = await apiListAccounts(t.db, statsKey.principal, {}, NOW);
    expect(statsOnly.map((a) => [a.name, a.online, a.world, a.lastSeen])).toEqual([
      ['Bare Bones', null, null, null],
      ['Iron Mira', null, null, null],
      ['Zezima', null, null, null],
    ]);
  });

  it('selects by name (as the game compares them) or id, and filters on online', async () => {
    const names = async (params: Parameters<typeof apiListAccounts>[2]) =>
      (await apiListAccounts(t.db, memberKey.principal, params, NOW)).map((a) => a.name);
    expect(await names({ names: ['ZEZIMA'] })).toEqual(['Zezima']);
    expect(await names({ names: [' iron_mira '] })).toEqual(['Iron Mira']);
    expect(await names({ names: ['Nobody', 'bare-bones'] })).toEqual(['Bare Bones']);
    expect(await names({ ids: [iron, 'unknown1234', 'x\u0000'] })).toEqual(['Iron Mira']);
    expect(await names({ names: ['zezima'], ids: [iron] })).toEqual(['Iron Mira', 'Zezima']);
    expect(await names({ names: [], ids: [] })).toHaveLength(3);
    expect(await names({ online: true })).toEqual(['Zezima']);
    expect(await names({ online: false })).toEqual(['Bare Bones', 'Iron Mira']);
    // Without activity nothing is known to be online or offline.
    expect(await apiListAccounts(t.db, statsKey.principal, { online: false }, NOW)).toEqual([]);
    const tooMany = Array.from({ length: 101 }, (_, i) => `n${i}`);
    expect(
      (await refusal(apiListAccounts(t.db, memberKey.principal, { names: tooMany }))).code,
    ).toBe('invalid');
  });
});

describe('apiGetAccount', () => {
  it('returns every section to the owner’s key', async () => {
    const d = await detail(ownerKey, zezima);
    const updated = new Date(t0 + HOUR + SEC).toISOString();
    expect(d).toMatchObject({
      id: zezima,
      name: 'Zezima',
      type: 0,
      typeLabel: 'Normal',
      firstSeen: new Date(t0 + SEC).toISOString(),
      categories: [
        'stats',
        'events',
        'activity',
        'location_live',
        'location_history',
        'equipment',
        'inventory',
      ],
      presence: {
        shared: true,
        updatedAt: updated,
        online: true,
        world: 302,
        specialWorld: false,
        gameState: 'LOGGED_IN',
        lastSeen: updated,
      },
      vitals: {
        shared: true,
        updatedAt: updated,
        hp: { current: 99, max: 99 },
        prayer: { current: 99, max: 99 },
        spellbook: 'lunar',
      },
      location: {
        shared: true,
        updatedAt: updated,
        x: 3164,
        y: 3487,
        plane: 0,
        isOnBoat: false,
        stale: false,
      },
    });
    const skills = d.skills?.shared ? d.skills : null;
    expect(skills?.updatedAt).toBe(updated);
    expect(skills?.totalLevel).toBe(realTotalLevel(normal));
    expect(skills?.skills[0]).toMatchObject({ skill: 'Overall', level: 2372, realLevel: 2372 });
    const attack = skills?.skills.find((s) => s.skill === 'Attack');
    expect(attack).toEqual({
      skill: 'Attack',
      level: 108,
      realLevel: 99,
      xp: 34_512_847 + ATTACK_GAIN,
    });

    const inventory = d.inventory?.shared ? d.inventory : null;
    const sent = (normal.player?.inventory as { items: { gePrice: number; quantity: number }[] })
      .items;
    expect(inventory?.items).toHaveLength(sent.length);
    expect(inventory?.items[0]).toEqual({
      id: 995,
      name: 'Coins',
      quantity: 18_450_221,
      gePrice: 1,
      haPrice: 0,
      equipmentSlot: null,
      inventorySlot: null,
    });
    expect(inventory?.value).toBe(sent.reduce((sum, i) => sum + i.gePrice * i.quantity, 0));
    const equipment = d.equipment?.shared ? d.equipment : null;
    expect(equipment?.items[0]).toMatchObject({ name: 'Helm of Neitiznot', equipmentSlot: 'HEAD' });
    expect(equipment?.value).toBeGreaterThan(0);
  });

  it('says "not shared" for sections the plugin never sent', async () => {
    const d = await detail(ownerKey, bare);
    for (const key of ['location', 'equipment', 'inventory'] as const) {
      expect(d[key]).toEqual({ shared: false, updatedAt: null });
    }
    expect(d.skills?.shared).toBe(true);
  });

  it('marks the location stale after two minutes without one', async () => {
    const d = await detail(ownerKey, zezima, new Date(NOW.getTime() + 2 * MIN + SEC));
    expect(d.location).toMatchObject({ shared: true, stale: true, x: 3164 });
  });

  it('gives keys without activity only the day of sections sent with every update (D-50)', async () => {
    const d = await detail(statsKey, zezima);
    expect(Object.keys(d).sort()).toEqual(
      ['categories', 'firstSeen', 'id', 'name', 'owner', 'skills', 'type', 'typeLabel'].sort(),
    );
    expect(d.skills?.updatedAt).toBe('2026-09-21T00:00:00.000Z');
    // The member's key has activity, so the exact time.
    expect((await detail(memberKey, zezima)).skills?.updatedAt).toBe(
      new Date(t0 + HOUR + SEC).toISOString(),
    );
  });

  it('answers null for accounts the key cannot see', async () => {
    expect(await apiGetAccount(t.db, memberKey.principal, 'unknown1234', NOW)).toBeNull();
    // A member's defaults, live location included (D-82).
    expect((await detail(memberKey, zezima)).categories).toEqual([
      'stats',
      'events',
      'activity',
      'location_live',
    ]);
  });
});

describe('apiSnapshot', () => {
  it('returns every visible account’s compact state by category', async () => {
    const snap = await apiSnapshot(t.db, ownerKey.principal, {}, NOW);
    expect(snap.accounts.map((a) => a.name)).toEqual(['Bare Bones', 'Iron Mira', 'Zezima']);
    const z = snap.accounts[2];
    expect(z).toMatchObject({
      id: zezima,
      type: 0,
      typeLabel: 'Normal',
      online: true,
      world: 302,
      specialWorld: false,
      lastSeen: new Date(t0 + HOUR + SEC).toISOString(),
      hp: { current: 99, max: 99 },
      prayer: { current: 99, max: 99 },
      spellbook: 'lunar',
      location: {
        x: 3164,
        y: 3487,
        plane: 0,
        isOnBoat: false,
        stale: false,
        updatedAt: new Date(t0 + HOUR + SEC).toISOString(),
      },
    });
    expect(z?.skills?.totalLevel).toBe(2372);
    expect(z?.inventory?.items.length).toBeGreaterThan(0);
    // Iron Mira is someone else's: the owner's key sees only the guild categories there.
    expect(snap.accounts[1]).toEqual({
      id: iron,
      name: 'Iron Mira',
      type: 1,
      typeLabel: 'Ironman',
      owner: { name: ironId, discordId: null },
      categories: ['stats', 'events', 'activity'],
      online: false,
      world: 319,
      specialWorld: false,
      lastSeen: new Date(t0 + 10 * MIN).toISOString(),
      hp: expect.any(Object) as unknown,
      prayer: expect.any(Object) as unknown,
      spellbook: expect.any(String) as unknown,
      skills: expect.any(Object) as unknown,
    });
    expect(snap.accounts[0]?.location).toBeNull();
    expect(snap.accounts[0]?.inventory).toBeNull();
    expect(snap.lastModified).toBe(new Date(t0 + HOUR + SEC).toISOString());
    expect(snap.etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
  });

  it('gives the live map key only presence and location', async () => {
    const snap = await apiSnapshot(t.db, mapKey.principal, {}, NOW);
    const z = snap.accounts.find((a) => a.id === zezima);
    expect(Object.keys(z ?? {}).sort()).toEqual(
      [
        'categories',
        'hp',
        'id',
        'lastSeen',
        'location',
        'name',
        'online',
        'owner',
        'prayer',
        'specialWorld',
        'spellbook',
        'type',
        'typeLabel',
        'world',
      ].sort(),
    );
    // Iron Mira shares no live location with the owner: activity only.
    expect(snap.accounts.find((a) => a.id === iron)).not.toHaveProperty('location');
  });

  it('keeps its ETag while nothing changes, per key', async () => {
    const a = await apiSnapshot(t.db, memberKey.principal, {}, NOW);
    const b = await apiSnapshot(t.db, memberKey.principal, {}, new Date(NOW.getTime() + 30 * SEC));
    expect(b.etag).toBe(a.etag);
    expect(etagMatches(a.etag, b.etag)).toBe(true);
    // Another key sees the same data under another ETag.
    const other = await makeKey(t.db, memberId, { name: 'other' }, NOW);
    expect((await apiSnapshot(t.db, other.principal, {}, NOW)).etag).not.toBe(a.etag);
  });

  it('changes when presence times out, without any new data', async () => {
    const at = (ms: number) => new Date(t0 + HOUR + SEC + ms);
    const before = await apiSnapshot(t.db, mapKey.principal, {}, at(PRESENCE_TIMEOUT_MS - SEC));
    const after = await apiSnapshot(t.db, mapKey.principal, {}, at(PRESENCE_TIMEOUT_MS));
    expect(before.accounts.find((a) => a.id === zezima)?.online).toBe(true);
    expect(after.accounts.find((a) => a.id === zezima)?.online).toBe(false);
    expect(after.etag).not.toBe(before.etag);
  });

  it('with since, returns only the accounts that changed since (with an overlap)', async () => {
    const at = new Date(t0 + HOUR + 2 * SEC);
    const full = await apiSnapshot(t.db, mapKey.principal, {}, at);
    const since = new Date(full.lastModified as string);
    const changed = await apiSnapshot(t.db, mapKey.principal, { since }, at);
    expect(changed.accounts.map((a) => a.name)).toEqual(['Zezima']);
    expect(changed.lastModified).toBe(full.lastModified);
    expect(changed.etag).not.toBe(full.etag);
    // Past the overlap nothing has changed…
    const quiet = await apiSnapshot(
      t.db,
      mapKey.principal,
      { since: new Date(since.getTime() + SNAPSHOT_SINCE_OVERLAP_MS) },
      at,
    );
    expect(quiet.accounts).toEqual([]);
    // …until the location goes stale and presence times out: both count as changes.
    const later = new Date(t0 + HOUR + SEC + PRESENCE_TIMEOUT_MS);
    const flipped = await apiSnapshot(t.db, mapKey.principal, { since }, later);
    expect(flipped.accounts.map((a) => [a.name, a.online, a.location?.stale])).toEqual([
      ['Zezima', false, true],
    ]);
    expect(flipped.lastModified).toBe(later.toISOString());
  });

  it('always returns accounts whose last-seen time the key may not know (D-50)', async () => {
    const full = await apiSnapshot(t.db, statsKey.principal, {}, NOW);
    expect(full.lastModified).toBeNull();
    const since = await apiSnapshot(t.db, statsKey.principal, { since: NOW }, NOW);
    expect(since.accounts.map((a) => a.name)).toEqual(['Bare Bones', 'Iron Mira', 'Zezima']);
    expect(since.accounts[0]).toEqual({
      id: bare,
      name: 'Bare Bones',
      type: 0,
      typeLabel: 'Normal',
      owner: { name: ownerId, discordId: null },
      categories: ['stats'],
      skills: expect.any(Object) as unknown,
    });
  });

  it('runs the same few queries however many accounts it returns (no N+1)', async () => {
    const one = await makeKey(
      t.db,
      memberId,
      { accountScope: 'list', accountPublicIds: [zezima] },
      NOW,
    );
    const counted = countQueries(t.db);
    await apiSnapshot(counted.db, one.principal, {}, NOW);
    const forOne = counted.reset();
    await apiSnapshot(counted.db, memberKey.principal, {}, NOW);
    expect(counted.reset()).toBe(forOne);
    // Accounts, their access (4 tables), latest_state, and the owners (D-89).
    expect(forOne).toBeLessThanOrEqual(7);
  });

  it('refuses an invalid since', async () => {
    expect(
      (await refusal(apiSnapshot(t.db, memberKey.principal, { since: new Date(Number.NaN) }))).code,
    ).toBe('invalid');
  });
});

describe('etagMatches', () => {
  it('compares weakly, over lists, and accepts *', () => {
    const etag = 'W/"abc"';
    expect(etagMatches('W/"abc"', etag)).toBe(true);
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('"x", W/"abc"', etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('W/"abd"', etag)).toBe(false);
    expect(etagMatches('', etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
  });
});

describe('XP', () => {
  const attackXp = 34_512_847;

  it('returns an account’s series, with case-insensitive skill names', async () => {
    const series = present(
      await apiXp(
        t.db,
        memberKey.principal,
        zezima,
        {
          skills: ['attack', 'DEFENCE', 'Attack'],
          from: new Date(t0 - HOUR),
          to: NOW,
          resolution: '5m',
        },
        NOW,
      ),
    );
    expect(series.account).toEqual({ id: zezima, name: 'Zezima' });
    expect(series.resolution).toBe('5m');
    expect(series.from).toBe(new Date(t0 - HOUR).toISOString());
    expect(series.to).toBe(NOW.toISOString());
    expect(series.series.map((s) => s.skill)).toEqual(['Attack', 'Defence']);
    expect(series.series[0]?.points.map((p) => p[1])).toEqual([attackXp, attackXp + ATTACK_GAIN]);
    expect(series.series[1]?.points).toHaveLength(1);
  });

  it('defaults to Overall over the last 7 days at auto resolution', async () => {
    const series = present(await apiXp(t.db, memberKey.principal, zezima, {}, NOW));
    expect(series.resolution).toBe('5m');
    expect(series.from).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(series.series.map((s) => s.skill)).toEqual(['Overall']);
    const overall = series.series[0]?.points.map((p) => p[1]) ?? [];
    expect((overall[1] ?? 0) - (overall[0] ?? 0)).toBe(ATTACK_GAIN);
  });

  it('answers null without stats, and refuses bad parameters', async () => {
    expect(await apiXp(t.db, mapKey.principal, zezima, {}, NOW)).toBeNull();
    expect(await apiXp(t.db, memberKey.principal, 'unknown1234', {}, NOW)).toBeNull();
    for (const params of [
      { skills: ['Sailing2'] },
      { resolution: '10m' as never },
      { from: new Date(NOW.getTime() + MIN) },
      { to: new Date(Number.NaN) },
      { skills: Array.from({ length: 31 }, (_, i) => `s${i}`) },
    ]) {
      expect((await refusal(apiXp(t.db, memberKey.principal, zezima, params, NOW))).code).toBe(
        'invalid',
      );
    }
  });

  it('returns several accounts’ series in request order, or not_found for one it cannot read', async () => {
    const multi = await apiXpMulti(
      t.db,
      memberKey.principal,
      { ids: [iron, zezima], skills: ['Attack'], from: new Date(t0 - HOUR), to: NOW },
      NOW,
    );
    expect(multi.resolution).toBe('5m');
    expect(multi.accounts.map((a) => a.account.name)).toEqual(['Iron Mira', 'Zezima']);
    expect(multi.accounts[1]?.series[0]?.points).toHaveLength(2);
    const missing = await refusal(
      apiXpMulti(t.db, memberKey.principal, { ids: [zezima, 'unknown1234'] }, NOW),
    );
    expect(missing).toMatchObject({ code: 'not_found', message: 'account unknown1234 not found' });
    expect((await refusal(apiXpMulti(t.db, mapKey.principal, { ids: [zezima] }, NOW))).code).toBe(
      'not_found',
    );
    const eleven = Array.from({ length: 11 }, (_, i) => `acc${i}`);
    expect((await refusal(apiXpMulti(t.db, memberKey.principal, { ids: eleven }, NOW))).code).toBe(
      'invalid',
    );
    expect((await refusal(apiXpMulti(t.db, memberKey.principal, { ids: [] }, NOW))).code).toBe(
      'invalid',
    );
  });
});

describe('apiGains', () => {
  it('gives the gains of a period, "day" in the key creator’s time zone', async () => {
    const week = present(
      await apiGains(t.db, memberKey.principal, zezima, { period: 'week' }, NOW),
    );
    expect(week.period).toBe('week');
    expect(week.from).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(week.to).toBe(NOW.toISOString());
    expect(week.gains[0]).toEqual({ skill: 'Overall', xp: ATTACK_GAIN });
    expect(week.gains.find((g) => g.skill === 'Attack')?.xp).toBe(ATTACK_GAIN);
    expect(week.gains.find((g) => g.skill === 'Defence')?.xp).toBe(0);

    // The owner's time zone is Pacific/Kiritimati (UTC+14); the member has none (UTC).
    const ownerDay = present(await apiGains(t.db, ownerKey.principal, zezima, {}, NOW));
    expect(ownerDay).toMatchObject({ period: 'day', from: '2026-09-21T10:00:00.000Z' });
    const memberDay = present(await apiGains(t.db, memberKey.principal, zezima, {}, NOW));
    expect(memberDay.from).toBe('2026-09-21T00:00:00.000Z');
    expect(memberDay.gains[0]).toEqual({ skill: 'Overall', xp: ATTACK_GAIN });
  });

  it('gives the gains of an explicit range', async () => {
    const from = new Date(t0 + 30 * MIN);
    const open = present(await apiGains(t.db, memberKey.principal, zezima, { from }, NOW));
    expect(open).toMatchObject({ period: null, from: from.toISOString(), to: NOW.toISOString() });
    expect(open.gains[0]).toEqual({ skill: 'Overall', xp: ATTACK_GAIN });
    const closed = present(
      await apiGains(t.db, memberKey.principal, zezima, { from, to: new Date(t0 + 40 * MIN) }, NOW),
    );
    expect(closed.gains[0]).toEqual({ skill: 'Overall', xp: 0 });
  });

  it('answers null without stats, and refuses bad parameters', async () => {
    expect(await apiGains(t.db, mapKey.principal, zezima, {}, NOW)).toBeNull();
    for (const params of [
      { period: 'week' as const, from: new Date(t0) },
      { to: NOW },
      { period: 'decade' as never },
      { from: NOW, to: new Date(t0) },
      { from: new Date(Number.NaN) },
    ]) {
      expect((await refusal(apiGains(t.db, memberKey.principal, zezima, params, NOW))).code).toBe(
        'invalid',
      );
    }
  });
});

describe('histories', () => {
  it('returns sessions to keys with activity', async () => {
    const sessions = present(await apiSessions(t.db, memberKey.principal, zezima, {}, NOW));
    expect(sessions.account).toEqual({ id: zezima, name: 'Zezima' });
    expect(sessions.from).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
    expect(sessions.sessions.length).toBeGreaterThan(0);
    expect(sessions.sessions[0]).toMatchObject({
      startedAt: new Date(t0 + SEC).toISOString(),
      endedAt: null,
      worlds: [302],
      endReason: null,
    });
    expect(await apiSessions(t.db, statsKey.principal, zezima, {}, NOW)).toBeNull();
  });

  it('returns the equipment log, wealth and trail only to keys with those categories', async () => {
    const equipment = present(await apiEquipmentHistory(t.db, ownerKey.principal, zezima, {}, NOW));
    expect(equipment.changes.length).toBeGreaterThan(0);
    expect(equipment.changes[0]?.items[0]).toMatchObject({ equipmentSlot: 'HEAD' });
    const wealth = present(await apiWealth(t.db, ownerKey.principal, zezima, {}, NOW));
    expect(wealth.days).toEqual([
      {
        day: '2026-09-21',
        lastValue: expect.any(Number) as unknown,
        maxValue: expect.any(Number) as unknown,
      },
    ]);
    const trail = present(await apiLocations(t.db, ownerKey.principal, zezima, {}, NOW));
    expect(trail.points[0]).toEqual({
      at: new Date(Math.floor((t0 + SEC) / MIN) * MIN).toISOString(),
      x: 3164,
      y: 3487,
      plane: 0,
      world: 302,
      isOnBoat: false,
    });
    for (const key of [memberKey, mapKey]) {
      expect(await apiEquipmentHistory(t.db, key.principal, zezima, {}, NOW)).toBeNull();
      expect(await apiWealth(t.db, key.principal, zezima, {}, NOW)).toBeNull();
      expect(await apiLocations(t.db, key.principal, zezima, {}, NOW)).toBeNull();
    }
  });

  it('refuses a range that ends before it starts', async () => {
    const params = { from: NOW, to: new Date(t0) };
    expect((await refusal(apiSessions(t.db, memberKey.principal, zezima, params, NOW))).code).toBe(
      'invalid',
    );
  });
});

describe('apiLeaderboardGains', () => {
  it('ranks the accounts in scope whose stats the key reads', async () => {
    const boards = await apiLeaderboardGains(t.db, memberKey.principal, { period: 'week' }, NOW);
    expect(boards.period).toBe('week');
    expect(boards.from).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(boards.leaderboards.map((b) => b.skill)).toEqual(['Overall', 'Attack']);
    expect(boards.leaderboards[0]?.entries).toEqual([
      { rank: 1, account: { id: zezima, name: 'Zezima' }, gain: ATTACK_GAIN },
    ]);
    const attack = await apiLeaderboardGains(t.db, memberKey.principal, { skill: 'attack' }, NOW);
    expect(attack.period).toBe('day');
    expect(attack.leaderboards.map((b) => [b.skill, b.entries.length])).toEqual([['Attack', 1]]);
    const defence = await apiLeaderboardGains(t.db, memberKey.principal, { skill: 'Defence' }, NOW);
    expect(defence.leaderboards).toEqual([{ skill: 'Defence', entries: [] }]);
    // Outside the key's scope, or without stats: not on the board.
    const scoped = await makeKey(
      t.db,
      memberId,
      { accountScope: 'list', accountPublicIds: [iron] },
      NOW,
    );
    const none = await apiLeaderboardGains(t.db, scoped.principal, { period: 'week' }, NOW);
    expect(none.leaderboards).toEqual([]);
    expect(
      (await apiLeaderboardGains(t.db, mapKey.principal, { period: 'week' }, NOW)).leaderboards,
    ).toEqual([]);
  });

  it('refuses an unknown skill or period', async () => {
    expect(
      (await refusal(apiLeaderboardGains(t.db, memberKey.principal, { skill: 'Cooking2' }))).code,
    ).toBe('invalid');
    expect(
      (await refusal(apiLeaderboardGains(t.db, memberKey.principal, { period: 'year' as never })))
        .code,
    ).toBe('invalid');
  });
});

// Last: it changes the data every test above reads.
describe('apiSnapshot after another ingest', () => {
  it('changes its ETag and lastModified', async () => {
    const at = new Date(NOW.getTime() + 30 * SEC);
    const before = await apiSnapshot(t.db, memberKey.principal, {}, at);
    const body = wire('snapshot-normal', { hash: await hashOf(bare), name: 'Bare Bones' });
    await send(ownerDevice, body, at.getTime() - 10 * SEC);
    const after = await apiSnapshot(t.db, memberKey.principal, {}, at);
    expect(after.etag).not.toBe(before.etag);
    expect(etagMatches(before.etag, after.etag)).toBe(false);
    expect(after.lastModified).toBe(new Date(at.getTime() - 10 * SEC).toISOString());
    const since = await apiSnapshot(
      t.db,
      memberKey.principal,
      { since: new Date(before.lastModified as string) },
      at,
    );
    expect(since.accounts.map((a) => a.name)).toEqual(['Bare Bones', 'Zezima']);
  });
});

async function hashOf(publicId: string): Promise<string> {
  const [row] = await t.db
    .select({ hash: osrsAccounts.accountHash })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.publicId, publicId));
  if (!row) throw new Error('account missing');
  return row.hash;
}

/** `db`, counting the queries started through it (select and execute). */
function countQueries(db: Db): { db: Db; reset(): number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if ((prop === 'select' || prop === 'execute') && typeof value === 'function') {
        return (...args: unknown[]) => {
          n++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return {
    db: proxy,
    reset() {
      const count = n;
      n = 0;
      return count;
    },
  };
}
