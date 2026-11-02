/**
 * GET /accounts/{id}/day (M8, D-138) over data written by the real ingest pipeline: which sections a
 * key gets, the dates it may ask for, the local day in the key creator's time zone, and the trail
 * summed up as named places.
 */
import { osrsAccounts } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  newHash,
  wire,
  type Harness,
  type SeededDevice,
  type Wire,
} from '../ingest/test-support';
import { updateUserSettings } from '../settings/user-settings';
import { DAY_MAX_DAYS, apiDay, dayRange, placeStays, placesOf } from './day';
import { ApiError } from './errors';
import { makeKey, present, type TestKey } from './test-support';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ATTACK_GAIN = 5_000;

let t: TestDatabase;
let h: Harness;
let t0: number;
let NOW: Date;
let zezima: string;
let walker: string;
let ownerKey: TestKey;
let serviceLikeKey: TestKey;
let statsKey: TestKey;
let noneKey: TestKey;

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

type TrailPoint = { x: number; y: number; plane: number; timestamp: number };

beforeAll(async () => {
  t = await createTestDatabase('api-day');
  h = createHarness(t);
  const ownerId = await h.seedUser();
  const memberId = await h.seedUser();
  const device = await h.seedDevice(ownerId);

  const hash = newHash();
  const first = wire('snapshot-normal', { hash });
  t0 = first.timestamp as number;
  await send(device, first, t0 + SEC);
  zezima = await publicIdOf(hash);
  const later = wire('snapshot-normal', { hash });
  const attack = later.player?.stats?.skills.Attack;
  if (!attack) throw new Error('fixture without Attack');
  attack.xp += ATTACK_GAIN;
  await send(device, later, t0 + HOUR + SEC);

  // A second account walks a trail, and gets a drop and a collection log slot.
  const walkHash = newHash();
  const trail = wire('snapshot-location-trail', { hash: walkHash, name: 'Walker' });
  const offset = t0 + 2 * HOUR - (trail.timestamp as number);
  for (const p of (trail.player as { locationTrail: TrailPoint[] }).locationTrail)
    p.timestamp += offset;
  await send(device, trail, t0 + 2 * HOUR + SEC);
  walker = await publicIdOf(walkHash);
  for (const name of ['event-loot', 'event-collectionlog'] as const) {
    const body = wire(name, { hash: walkHash, name: 'Walker', freshEventIds: true });
    await send(device, body, t0 + 2 * HOUR + 10 * SEC);
  }
  NOW = new Date(t0 + 3 * HOUR);

  // The owner lives in UTC+14: t0 (13:33 UTC) is already the next local date there.
  await updateUserSettings(t.db, ownerId, { timezone: 'Pacific/Kiritimati' });
  ownerKey = await makeKey(t.db, ownerId, { name: 'owner' }, NOW);
  serviceLikeKey = await makeKey(t.db, memberId, { name: 'member' }, NOW);
  statsKey = await makeKey(t.db, memberId, { name: 'stats', categories: ['stats'] }, NOW);
  noneKey = await makeKey(t.db, memberId, { name: 'live', categories: ['location_live'] }, NOW);
});

afterAll(async () => {
  await t.drop();
});

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const localDate = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));

describe('dayRange', () => {
  it('defaults to today and takes one date or a range', () => {
    expect(dayRange({}, '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-02' });
    expect(dayRange({ date: '2026-11-01' }, '2026-11-02')).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(dayRange({ from: '2026-10-27', to: '2026-11-02' }, '2026-11-02')).toEqual({
      from: '2026-10-27',
      to: '2026-11-02',
    });
  });

  it('refuses bad dates, mixed forms and ranges over the limit', () => {
    const bad: Parameters<typeof dayRange>[0][] = [
      { date: '2026-11-1' },
      { date: 'yesterday' },
      { date: '2026-13-01' },
      { date: '2026-11-01', from: '2026-11-01', to: '2026-11-01' },
      { from: '2026-11-01' },
      { from: '2026-11-02', to: '2026-11-01' },
      { from: '2026-10-26', to: '2026-11-02' },
    ];
    for (const params of bad) {
      expect(() => dayRange(params, '2026-11-02'), JSON.stringify(params)).toThrow(ApiError);
    }
    expect(DAY_MAX_DAYS).toBe(7);
  });
});

describe('apiDay', () => {
  it("answers today in the key creator's time zone, with every section the key can read", async () => {
    const day = present(await apiDay(t.db, ownerKey.principal, zezima, {}, NOW));
    const today = localDate(NOW.getTime(), 'Pacific/Kiritimati');
    expect(day.account).toEqual({ id: zezima, name: 'Zezima' });
    expect(day.timezone).toBe('Pacific/Kiritimati');
    expect(day.dates).toEqual({ from: today, to: today });
    // Local midnight in UTC+14 is 10:00 UTC the day before.
    expect(day.from).toBe(new Date(Date.parse(`${today}T00:00:00Z`) - 14 * HOUR).toISOString());
    expect(day.to).toBe(NOW.toISOString());
    expect(day.sessions?.count).toBe(1);
    expect(day.gains).toEqual({
      total: ATTACK_GAIN,
      skills: [{ skill: 'Attack', xp: ATTACK_GAIN }],
    });
    expect(day.events).toMatchObject({ count: 0, truncated: false });
    expect(day.places?.list[0]).toMatchObject({ name: 'Grand Exchange' });
  });

  it('leaves out the sections the key cannot read, and the account when it reads none', async () => {
    const day = present(await apiDay(t.db, statsKey.principal, zezima, {}, NOW));
    expect(Object.keys(day).sort()).toEqual([
      'account',
      'dates',
      'from',
      'gains',
      'timezone',
      'to',
    ]);
    expect(await apiDay(t.db, noneKey.principal, zezima, {}, NOW)).toBeNull();
  });

  it('uses the time zone of the key creator, UTC without settings', async () => {
    const day = present(await apiDay(t.db, serviceLikeKey.principal, zezima, {}, NOW));
    expect(day.timezone).toBe('UTC');
    expect(day.dates.from).toBe(localDate(NOW.getTime(), 'UTC'));
  });

  it('sums the events and the places of a day', async () => {
    const day = present(await apiDay(t.db, ownerKey.principal, walker, {}, NOW));
    expect(day.events?.count).toBe(2);
    expect(day.events?.byType).toMatchObject({ loot: 1, collection_log: 1 });
    expect(day.events?.collectionLog).toHaveLength(1);
    expect(day.places?.stays).toBeGreaterThan(0);
    expect(day.places?.list.reduce((n, p) => n + p.ms, 0)).toBeGreaterThan(0);
  });

  it('answers an earlier date, and refuses a date that has not started', async () => {
    const yesterday = localDate(NOW.getTime() - 86_400_000, 'Pacific/Kiritimati');
    const day = present(await apiDay(t.db, ownerKey.principal, zezima, { date: yesterday }, NOW));
    expect(day.sessions?.count).toBe(0);
    expect(day.gains?.total).toBe(0);
    const tomorrow = localDate(NOW.getTime() + 86_400_000, 'Pacific/Kiritimati');
    const err = await refusal(apiDay(t.db, ownerKey.principal, zezima, { date: tomorrow }, NOW));
    expect(err.code).toBe('invalid');
  });
});

describe('placeStays', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 12, m)).toISOString();
  const p = (m: number, region: string | null, via: string | null = 'move', x = 3200) => ({
    at: at(m),
    x,
    y: 3200,
    plane: 0,
    via: via as never,
    region,
  });

  it('ends a stay when the place changes, and at its last point before a gap', () => {
    const stays = placeStays([
      p(0, 'Lumbridge', null),
      p(5, 'Lumbridge'),
      p(10, 'Varrock', 'teleport'),
      p(20, 'Varrock'),
      p(60, 'Varrock', 'gap'),
      p(70, 'Lumbridge', 'teleport'),
    ]);
    expect(stays.map((s) => [s.name, s.ms / MIN, s.arrivedBy])).toEqual([
      ['Lumbridge', 10, null],
      ['Varrock', 10, 'teleport'],
      ['Varrock', 10, 'gap'],
      ['Lumbridge', 0, 'teleport'],
    ]);
    expect(placesOf(stays)).toEqual([
      { name: 'Varrock', region: expect.any(Number) as unknown, ms: 20 * MIN, visits: 2 },
      { name: 'Lumbridge', region: expect.any(Number) as unknown, ms: 10 * MIN, visits: 2 },
    ]);
  });

  it('names an unnamed place by its region', () => {
    const [stay] = placeStays([p(0, null, null, 6400)]);
    expect(stay?.name).toBe(`Region ${stay?.region}`);
  });
});
