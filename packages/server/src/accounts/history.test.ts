import { equipmentChanges, locationSamples, playSessions, wealthDaily } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_LOCATION_SAMPLES,
  getEquipmentHistory,
  getLocationHistory,
  getSessions,
  getWealthHistory,
} from './history';
import {
  seedAccount,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from './test-support';

const NOW = new Date('2026-09-28T12:00:00Z');
const RANGE = { from: new Date('2026-09-01T00:00:00Z'), to: NOW };
const d = (iso: string) => new Date(iso);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let account: SeededAccount;

beforeAll(async () => {
  t = await createTestDatabase('accounts-history');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  account = await seedAccount(t.db, { owner: owner.id });
  // Kept from the guild (every category is guild by default, D-96); activity stays on the default.
  for (const category of ['equipment', 'inventory', 'location_history'] as const) {
    await seedSharing(t.db, account.id, category, 'private');
  }

  await t.db.insert(playSessions).values([
    {
      accountId: account.id,
      startedAt: d('2026-08-01T00:00:00Z'),
      lastSeenAt: d('2026-08-01T02:00:00Z'),
      endedAt: d('2026-08-01T02:00:00Z'),
      endReason: 'timeout',
    },
    {
      accountId: account.id,
      startedAt: d('2026-08-31T23:00:00Z'),
      lastSeenAt: d('2026-09-01T00:50:00Z'),
      endedAt: d('2026-09-01T01:00:00Z'),
      endReason: 'shutdown',
      worlds: [330],
    },
    {
      accountId: account.id,
      startedAt: d('2026-09-10T10:00:00Z'),
      lastSeenAt: d('2026-09-10T10:59:00Z'),
      endedAt: d('2026-09-10T11:00:00Z'),
      endReason: 'logout',
      worlds: [302, 303],
    },
    {
      accountId: account.id,
      startedAt: d('2026-09-28T10:00:00Z'),
      lastSeenAt: d('2026-09-28T11:30:00Z'),
    },
  ]);

  const whip = [{ id: 4151, gePrice: 1, quantity: 1, equipmentSlot: 'WEAPON' }];
  await t.db.insert(equipmentChanges).values([
    { accountId: account.id, changedAt: d('2026-08-01T00:00:00Z'), equipment: [] },
    { accountId: account.id, changedAt: d('2026-09-10T00:00:00Z'), equipment: whip },
    { accountId: account.id, changedAt: d('2026-09-20T00:00:00Z'), equipment: [] },
  ]);

  await t.db.insert(wealthDaily).values([
    { accountId: account.id, day: '2026-08-31', lastValue: 1, maxValue: 2 },
    { accountId: account.id, day: '2026-09-01', lastValue: 3, maxValue: 4 },
    { accountId: account.id, day: '2026-09-15', lastValue: 5, maxValue: 6 },
  ]);

  await t.db.insert(locationSamples).values([
    { accountId: account.id, ts: d('2026-08-31T23:59:00Z'), x: 1, y: 1, plane: 0 },
    { accountId: account.id, ts: d('2026-09-02T00:00:00Z'), x: 2, y: 2, plane: 0, world: 302 },
    { accountId: account.id, ts: d('2026-09-01T00:00:00Z'), x: 3, y: 3, plane: 1, onBoat: true },
  ]);
});

afterAll(async () => {
  await t.drop();
});

describe('getSessions', () => {
  it('returns sessions overlapping the range, newest first, open ones included', async () => {
    const sessions = await getSessions(t.db, owner.viewer, account.publicId, RANGE);
    expect(
      sessions?.map((s) => [s.startedAt, s.endedAt, s.durationMs, s.worlds, s.endReason]),
    ).toEqual([
      ['2026-09-28T10:00:00.000Z', null, 90 * 60_000, [], null],
      ['2026-09-10T10:00:00.000Z', '2026-09-10T11:00:00.000Z', 60 * 60_000, [302, 303], 'logout'],
      ['2026-08-31T23:00:00.000Z', '2026-09-01T01:00:00.000Z', 120 * 60_000, [330], 'shutdown'],
    ]);
    expect(sessions?.[0]?.lastSeenAt).toBe('2026-09-28T11:30:00.000Z');
  });

  it('is available to guild members by default (activity) and null for unknown accounts', async () => {
    expect(await getSessions(t.db, member.viewer, account.publicId, RANGE)).toHaveLength(3);
    expect(await getSessions(t.db, member.viewer, 'unknown', RANGE)).toBeNull();
  });

  it('rejects invalid dates', async () => {
    await expect(
      getSessions(t.db, owner.viewer, account.publicId, { from: d('nope'), to: NOW }),
    ).rejects.toThrow(RangeError);
  });
});

describe('getEquipmentHistory', () => {
  it('returns changes in the range, newest first', async () => {
    const changes = await getEquipmentHistory(t.db, owner.viewer, account.publicId, RANGE);
    expect(changes).toEqual([
      { changedAt: '2026-09-20T00:00:00.000Z', items: [] },
      {
        changedAt: '2026-09-10T00:00:00.000Z',
        items: [{ id: 4151, gePrice: 1, quantity: 1, equipmentSlot: 'WEAPON' }],
      },
    ]);
    expect(await getEquipmentHistory(t.db, member.viewer, account.publicId, RANGE)).toBeNull();
  });
});

describe('getWealthHistory', () => {
  it('returns the UTC days of the range, oldest first', async () => {
    const days = await getWealthHistory(t.db, owner.viewer, account.publicId, {
      from: d('2026-09-01T05:00:00Z'),
      to: NOW,
    });
    expect(days).toEqual([
      { day: '2026-09-01', lastValue: 3, maxValue: 4 },
      { day: '2026-09-15', lastValue: 5, maxValue: 6 },
    ]);
    expect(await getWealthHistory(t.db, member.viewer, account.publicId, RANGE)).toBeNull();
  });
});

describe('getLocationHistory', () => {
  it('returns the trail in the range, oldest first', async () => {
    const trail = await getLocationHistory(t.db, owner.viewer, account.publicId, RANGE);
    expect(trail).toEqual([
      { ts: '2026-09-01T00:00:00.000Z', x: 3, y: 3, plane: 1, world: null, onBoat: true },
      { ts: '2026-09-02T00:00:00.000Z', x: 2, y: 2, plane: 0, world: 302, onBoat: false },
    ]);
  });

  it('needs location_history (not location_live)', async () => {
    await seedSharing(t.db, account.id, 'location_live', 'guild');
    expect(await getLocationHistory(t.db, member.viewer, account.publicId, RANGE)).toBeNull();
    await seedSharing(t.db, account.id, 'location_history', 'guild');
    expect(await getLocationHistory(t.db, member.viewer, account.publicId, RANGE)).toHaveLength(2);
  });

  it('returns the newest samples when there are too many', async () => {
    const busy = await seedAccount(t.db, { owner: owner.id });
    const count = MAX_LOCATION_SAMPLES + 10;
    await t.db.execute(sql`
      INSERT INTO location_samples (account_id, ts, x, y, plane)
      SELECT ${busy.id}, '2026-09-01T00:00:00Z'::timestamptz + g * interval '1 minute', g, 0, 0
      FROM generate_series(1, ${count}) g`);
    const trail = await getLocationHistory(t.db, owner.viewer, busy.publicId, {
      from: d('2026-01-01T00:00:00Z'),
      to: d('2027-01-01T00:00:00Z'),
    });
    expect(trail).toHaveLength(MAX_LOCATION_SAMPLES);
    expect(trail?.[0]?.x).toBe(11);
    expect(trail?.at(-1)?.x).toBe(count);
  });
});
