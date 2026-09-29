/**
 * XP charts for ranges whose raw samples the retention policy already dropped. Its own database:
 * dropping chunks affects every account in it. Times are relative to the real clock, because
 * retention is (drop_chunks and the policy use the database's now()).
 */
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  refreshXpAggregates,
  seedAccount,
  seedLatestState,
  seedUser,
  seedXp,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from './test-support';
import { getGains, getXpSeries } from './xp';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** UTC midnight 900 days ago: far outside a 365-day raw retention. */
const OLD = Math.floor((Date.now() - 900 * DAY) / DAY) * DAY;
/** UTC midnight two days ago: inside it. */
const RECENT = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

let t: TestDatabase;
let owner: SeededUser;
let account: SeededAccount;

beforeAll(async () => {
  t = await createTestDatabase('accounts-xp-retention');
  owner = await seedUser(t.db);
  account = await seedAccount(t.db, { owner: owner.id });
  await seedXp(t.db, account.id, [
    ['Attack', iso(OLD + 10 * HOUR + 5 * MIN), 100],
    ['Attack', iso(OLD + 11 * HOUR + 10 * MIN), 200],
    ['Attack', iso(OLD + DAY + 9 * HOUR), 300],
    ['Attack', iso(RECENT + 10 * HOUR), 1000],
    ['Attack', iso(RECENT + 10 * HOUR + 30 * MIN), 1100],
  ]);
  await seedLatestState(t.db, account.id, {
    lastSeen: new Date(RECENT + 11 * HOUR),
    skills: skillMap({ Attack: [1100, 10] }),
    skillsUpdatedAt: new Date(RECENT + 11 * HOUR),
  });
  await refreshXpAggregates(t.db);
  // What the worker sets up (policies.ts), paused so it can't run during the test; then what it
  // does: drop the raw chunks older than a year. xp_hourly and xp_daily keep that history (TSDB-1).
  await t.db.execute(sql`
    SELECT alter_job(add_retention_policy('xp_samples', drop_after => interval '365 days'),
                     scheduled => false)`);
  await t.db.execute(
    sql`SELECT drop_chunks('xp_samples', older_than => now() - interval '365 days')`,
  );
});

afterAll(async () => {
  await t.drop();
});

describe('getXpSeries beyond the raw retention', () => {
  const oldRange = { from: new Date(OLD), to: new Date(OLD + 2 * DAY) };
  const hourly = [
    [iso(OLD + 10 * HOUR), 100],
    [iso(OLD + 11 * HOUR), 200],
    [iso(OLD + DAY + 9 * HOUR), 300],
  ];

  it('reads xp_hourly for a short range whose raw samples are gone (auto)', async () => {
    const r = await getXpSeries(t.db, owner.viewer, account.publicId, {
      skills: ['Attack'],
      ...oldRange,
      resolution: 'auto',
    });
    expect(r).toEqual({ resolution: '1h', series: [{ skill: 'Attack', points: hourly }] });
  });

  it('coarsens an explicit 5m request there too', async () => {
    const r = await getXpSeries(t.db, owner.viewer, account.publicId, {
      skills: ['Attack'],
      ...oldRange,
      resolution: '5m',
    });
    expect(r?.resolution).toBe('1h');
    expect(r?.series[0]?.points).toEqual(hourly);
  });

  it('keeps 5m inside the retention window', async () => {
    const r = await getXpSeries(t.db, owner.viewer, account.publicId, {
      skills: ['Attack'],
      from: new Date(RECENT),
      to: new Date(RECENT + DAY),
      resolution: 'auto',
    });
    expect(r).toEqual({
      resolution: '5m',
      series: [
        {
          skill: 'Attack',
          points: [
            [iso(RECENT), 300],
            [iso(RECENT + 10 * HOUR), 1000],
            [iso(RECENT + 10 * HOUR + 30 * MIN), 1100],
          ],
        },
      ],
    });
  });

  it('still finds the baseline of old gains in xp_hourly', async () => {
    const gains = await getGains(t.db, account.id, { from: new Date(OLD + 12 * HOUR) });
    expect(gains.get('Attack')).toBe(1100 - 200);
  });
});
