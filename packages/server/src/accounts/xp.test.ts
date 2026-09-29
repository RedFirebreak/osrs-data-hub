import { xpSamples } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedLatestState,
  seedSharing,
  seedUser,
  seedXp,
  refreshXpAggregates,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from './test-support';
import { MAX_SERIES_POINTS, getGains, getXpSeries, pickResolution } from './xp';

const NOW = new Date('2026-09-28T12:00:00Z');
const at = (iso: string) => new Date(iso);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
/** Attack history with known buckets around the 10:00 hour; Sailing first seen at 11:20. */
let main: SeededAccount;
/** First seen today at 11:00. */
let fresh: SeededAccount;
/** latest_state lower than the samples (can't happen; must clamp to 0). */
let dropped: SeededAccount;
/** Stats private. */
let secret: SeededAccount;

beforeAll(async () => {
  t = await createTestDatabase('accounts-xp');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);

  main = await seedAccount(t.db, { owner: owner.id });
  await seedXp(t.db, main.id, [
    ['Attack', '2026-09-20T10:00:00Z', 1000],
    ['Attack', '2026-09-28T09:10:00Z', 1500],
    ['Attack', '2026-09-28T09:55:00Z', 1800],
    ['Attack', '2026-09-28T10:00:00Z', 2000],
    ['Attack', '2026-09-28T10:25:00Z', 2300],
    ['Attack', '2026-09-28T10:40:00Z', 2600],
    ['Attack', '2026-09-28T11:50:00Z', 3000],
    ['Defence', '2026-09-20T10:00:00Z', 50],
    ['Sailing', '2026-09-28T11:20:00Z', 100],
    ['Sailing', '2026-09-28T11:45:00Z', 250],
    ['Overall', '2026-09-20T10:00:00Z', 1050],
    ['Overall', '2026-09-28T09:55:00Z', 1850],
    ['Overall', '2026-09-28T10:25:00Z', 2350],
    ['Overall', '2026-09-28T11:50:00Z', 3300],
  ]);
  await seedLatestState(t.db, main.id, {
    lastSeen: NOW,
    skills: skillMap({ Attack: [3100, 50], Defence: [50, 5], Sailing: [300, 4] }),
    skillsUpdatedAt: NOW,
  });

  fresh = await seedAccount(t.db, { owner: owner.id });
  await seedXp(t.db, fresh.id, [
    ['Attack', '2026-09-28T11:00:00Z', 500],
    ['Attack', '2026-09-28T11:30:00Z', 700],
  ]);
  await seedLatestState(t.db, fresh.id, {
    lastSeen: NOW,
    skills: skillMap({ Attack: [800, 10] }),
    skillsUpdatedAt: NOW,
  });

  dropped = await seedAccount(t.db, { owner: owner.id });
  await seedXp(t.db, dropped.id, [['Attack', '2026-09-28T09:00:00Z', 5000]]);
  await seedLatestState(t.db, dropped.id, {
    lastSeen: NOW,
    skills: skillMap({ Attack: [4000, 40] }),
    skillsUpdatedAt: NOW,
  });

  secret = await seedAccount(t.db, { owner: owner.id });
  await seedSharing(t.db, secret.id, 'stats', 'private');
  await seedXp(t.db, secret.id, [['Attack', '2026-09-28T10:00:00Z', 10]]);
});

afterAll(async () => {
  await t.drop();
});

describe('getGains', () => {
  it('uses the last bucket that ended by an hour boundary (xp_hourly) as the baseline', async () => {
    const gains = await getGains(t.db, main.id, { from: at('2026-09-28T10:00:00Z') });
    // xp_at(10:00) = the 09:55 bucket (1800); the 10:00 bucket counts as gained after 10:00.
    expect(gains.get('Attack')).toBe(3100 - 1800);
    expect(gains.get('Defence')).toBe(0);
  });

  it('reads the partial hour from xp_samples when `from` is off the hour', async () => {
    const half = await getGains(t.db, main.id, { from: at('2026-09-28T10:30:00Z') });
    expect(half.get('Attack')).toBe(3100 - 2300);
    // 10:27: the 10:25 bucket ends at 10:30, after `from`, so 10:00's value is the baseline.
    const odd = await getGains(t.db, main.id, { from: at('2026-09-28T10:27:00Z') });
    expect(odd.get('Attack')).toBe(3100 - 2000);
  });

  it('computes gains between two times with `to`', async () => {
    const gains = await getGains(t.db, main.id, {
      from: at('2026-09-28T09:00:00Z'),
      to: at('2026-09-28T10:30:00Z'),
    });
    // xp_at(10:30) = 2300, xp_at(09:00) = 1000 (the week-old sample).
    expect(gains.get('Attack')).toBe(1300);
    // Sailing had no sample by 10:30: no end value, so no gain entry.
    expect(gains.has('Sailing')).toBe(false);
  });

  it('includes the derived Overall from latest_state.skills', async () => {
    const gains = await getGains(t.db, main.id, { from: at('2026-09-28T10:00:00Z') });
    // now = 3100 + 50 + 300; baseline = the Overall sample at 09:55.
    expect(gains.get('Overall')).toBe(3450 - 1850);
  });

  it("uses a skill's earliest sample when there is none before `from`", async () => {
    const gains = await getGains(t.db, main.id, { from: at('2026-09-28T10:00:00Z') });
    expect(gains.get('Sailing')).toBe(300 - 100);
    const today = await getGains(t.db, fresh.id, { from: at('2026-09-28T00:00:00Z') });
    expect(today.get('Attack')).toBe(800 - 500);
  });

  it('clamps negative results to 0', async () => {
    const gains = await getGains(t.db, dropped.id, { from: at('2026-09-28T10:00:00Z') });
    expect(gains.get('Attack')).toBe(0);
  });

  it('is empty for an account that never sent stats', async () => {
    const gains = await getGains(t.db, secret.id, { from: at('2026-09-28T00:00:00Z') });
    expect(gains.size).toBe(0);
  });

  it('rejects an invalid date', async () => {
    await expect(getGains(t.db, main.id, { from: new Date(Number.NaN) })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('getXpSeries', () => {
  it('picks 5m for short ranges and carries the value in effect at the start', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack'],
      from: at('2026-09-28T10:30:00Z'),
      to: NOW,
      resolution: 'auto',
    });
    expect(r).toEqual({
      resolution: '5m',
      series: [
        {
          skill: 'Attack',
          points: [
            ['2026-09-28T10:30:00.000Z', 2300],
            ['2026-09-28T10:40:00.000Z', 2600],
            ['2026-09-28T11:50:00.000Z', 3000],
          ],
        },
      ],
    });
  });

  it('adds no carried point when a bucket starts exactly at the range start', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack'],
      from: at('2026-09-28T10:25:00Z'),
      to: NOW,
      resolution: '5m',
    });
    expect(r?.series[0]?.points[0]).toEqual(['2026-09-28T10:25:00.000Z', 2300]);
    expect(r?.series[0]?.points).toHaveLength(3);
  });

  it('includes the bucket that straddles `from` (the range starts at `from` floored)', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack'],
      from: at('2026-09-28T10:27:00Z'),
      to: at('2026-09-28T10:45:00Z'),
      resolution: '5m',
    });
    expect(r?.series[0]?.points).toEqual([
      ['2026-09-28T10:25:00.000Z', 2300],
      ['2026-09-28T10:40:00.000Z', 2600],
    ]);
  });

  it('reads xp_hourly at 1h with the last value per hour', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack', 'Overall'],
      from: at('2026-09-27T12:00:00Z'),
      to: NOW,
      resolution: '1h',
    });
    expect(r?.resolution).toBe('1h');
    expect(r?.series[0]).toEqual({
      skill: 'Attack',
      points: [
        ['2026-09-27T12:00:00.000Z', 1000],
        ['2026-09-28T09:00:00.000Z', 1800],
        ['2026-09-28T10:00:00.000Z', 2600],
        ['2026-09-28T11:00:00.000Z', 3000],
      ],
    });
    expect(r?.series[1]?.skill).toBe('Overall');
    expect(r?.series[1]?.points.at(-1)).toEqual(['2026-09-28T11:00:00.000Z', 3300]);
  });

  it('reads xp_daily (UTC days) for long ranges; nothing to carry before the first sample', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack'],
      from: at('2026-01-01T00:00:00Z'),
      to: NOW,
      resolution: 'auto',
    });
    expect(r).toEqual({
      resolution: '1d',
      series: [
        {
          skill: 'Attack',
          points: [
            ['2026-09-20T00:00:00.000Z', 1000],
            ['2026-09-28T00:00:00.000Z', 3000],
          ],
        },
      ],
    });
  });

  it('keeps request order, drops duplicates and unknown skills, and returns empty series', async () => {
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Defence', 'Nope', 'Attack', 'Defence', 'Farming'],
      from: at('2026-09-28T11:00:00Z'),
      to: NOW,
      resolution: 'auto',
    });
    expect(r?.series.map((s) => s.skill)).toEqual(['Defence', 'Attack', 'Farming']);
    expect(r?.series[0]?.points).toEqual([['2026-09-28T11:00:00.000Z', 50]]);
    expect(r?.series[2]?.points).toEqual([]);
  });

  it('is null without the stats category, and for accounts the viewer cannot see', async () => {
    const opts = { skills: ['Attack'], from: at('2026-09-28T00:00:00Z'), to: NOW } as const;
    expect(
      await getXpSeries(t.db, member.viewer, secret.publicId, { ...opts, resolution: 'auto' }),
    ).toBeNull();
    expect(
      await getXpSeries(t.db, owner.viewer, secret.publicId, { ...opts, resolution: 'auto' }),
    ).not.toBeNull();
    expect(
      await getXpSeries(t.db, member.viewer, 'doesnotexist', { ...opts, resolution: 'auto' }),
    ).toBeNull();
    // Stats default to guild: any active member sees them.
    expect(
      await getXpSeries(t.db, member.viewer, main.publicId, { ...opts, resolution: 'auto' }),
    ).not.toBeNull();
  });
});

describe('pickResolution', () => {
  const from = at('2026-01-01T00:00:00Z');
  const plus = (ms: number) => new Date(from.getTime() + ms);
  const DAY = 86_400_000;

  it('auto: up to 7 days → 5m, up to 90 days → 1h, beyond → 1d', () => {
    expect(pickResolution(from, plus(7 * DAY), 'auto')).toBe('5m');
    expect(pickResolution(from, plus(7 * DAY + 1), 'auto')).toBe('1h');
    expect(pickResolution(from, plus(90 * DAY), 'auto')).toBe('1h');
    expect(pickResolution(from, plus(90 * DAY + 1), 'auto')).toBe('1d');
  });

  it('keeps an explicit resolution unless the range has too many buckets for it', () => {
    expect(pickResolution(from, plus(100 * DAY), '1h')).toBe('1h');
    expect(pickResolution(from, plus(DAY), '1d')).toBe('1d');
    // A year at 5 minutes is 105k buckets; at 1 hour still 8760 > MAX_SERIES_POINTS.
    expect(MAX_SERIES_POINTS).toBeLessThan(8760);
    expect(pickResolution(from, plus(365 * DAY), '5m')).toBe('1d');
    expect(pickResolution(from, plus(30 * DAY), '5m')).toBe('1h');
  });

  it('treats an unknown value as auto', () => {
    expect(pickResolution(from, plus(DAY), 'weekly' as 'auto')).toBe('5m');
  });
});

describe('with materialized aggregates', () => {
  /** Samples months ago, whose first raw hour is later "dropped by retention". */
  let old: SeededAccount;

  beforeAll(async () => {
    old = await seedAccount(t.db, { owner: owner.id });
    await seedXp(t.db, old.id, [
      ['Attack', '2026-06-01T10:10:00Z', 100],
      ['Attack', '2026-06-01T10:40:00Z', 200],
      ['Attack', '2026-06-01T11:10:00Z', 300],
      ['Attack', '2026-09-28T10:10:00Z', 400],
    ]);
    await seedLatestState(t.db, old.id, {
      lastSeen: NOW,
      skills: skillMap({ Attack: [450, 5] }),
      skillsUpdatedAt: NOW,
    });
    await refreshXpAggregates(t.db);
  });

  it('gives the same gains and series from materialized data', async () => {
    const gains = await getGains(t.db, main.id, { from: at('2026-09-28T10:00:00Z') });
    expect(gains.get('Attack')).toBe(1300);
    expect(gains.get('Sailing')).toBe(200);
    const r = await getXpSeries(t.db, owner.viewer, main.publicId, {
      skills: ['Attack'],
      from: at('2026-09-27T12:00:00Z'),
      to: NOW,
      resolution: '1h',
    });
    expect(r?.series[0]?.points).toHaveLength(4);
  });

  it('falls back to the first hourly value when the first raw hour is gone', async () => {
    const from = at('2026-05-01T00:00:00Z');
    expect((await getGains(t.db, old.id, { from })).get('Attack')).toBe(450 - 100);
    // Simulate raw retention dropping the first hour; xp_hourly keeps it (TSDB-1).
    await t.db
      .delete(xpSamples)
      .where(
        and(eq(xpSamples.accountId, old.id), lt(xpSamples.bucket, at('2026-06-01T11:00:00Z'))),
      );
    // The first raw sample is now 11:10 (300); the first hourly value (10:00 hour, 200) is earlier.
    expect((await getGains(t.db, old.id, { from })).get('Attack')).toBe(450 - 200);
    // xp_at(11:00) has no raw sample left before it: xp_hourly's 10:00 hour (200) answers.
    const window = await getGains(t.db, old.id, {
      from: at('2026-06-01T11:00:00Z'),
      to: at('2026-06-01T12:00:00Z'),
    });
    expect(window.get('Attack')).toBe(300 - 200);
  });

  it('reads the raw tier, so a late write into a materialized hour counts (TSDB-7)', async () => {
    // The 10:00 hour of today is materialized with 400; a late sample raises it to 440.
    await seedXp(t.db, old.id, [['Attack', '2026-09-28T10:15:00Z', 440]]);
    const gains = await getGains(t.db, old.id, { from: at('2026-09-28T11:00:00Z') });
    expect(gains.get('Attack')).toBe(450 - 440);
  });
});
