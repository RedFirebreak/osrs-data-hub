import { describe, expect, it } from 'vitest';
import {
  METRICS_BUCKET_MS,
  OTHER_ACTIVITY,
  buildSessions,
  calendarDays,
  filterSessions,
  heatValue,
  heatmap,
  quantile,
  rateOf,
  rateThroughSession,
  sessionRecords,
  sessionValue,
  summarizeSessions,
  timeByActivity,
  type BuildSessionsInput,
  type SessionMetrics,
} from './sessions';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const t = (iso: string) => Date.parse(iso);
const BASE = t('2026-10-05T18:00:00Z'); // a Monday

function input(partial: Partial<BuildSessionsInput>): BuildSessionsInput {
  return { spans: [], gains: [], drops: [], kills: [], lootActive: true, ...partial };
}

/** XP of `skill` in the bucket `minute` minutes after BASE. */
const xp = (minute: number, skill: string, amount: number, fromHiscores = false) => ({
  at: BASE + minute * MIN,
  skill,
  xp: amount,
  fromHiscores,
});

describe('buildSessions', () => {
  it('cuts a session into 5-minute buckets and marks the ones with XP or loot active', () => {
    const [s] = buildSessions(
      input({
        spans: [{ id: 'a', start: BASE + 2 * MIN, end: BASE + 23 * MIN }],
        gains: [xp(0, 'Attack', 100), xp(5, 'Attack', 50), xp(5, 'Strength', 70)],
        drops: [{ at: BASE + 16 * MIN, value: 1000, source: 'Zulrah' }],
      }),
    );
    expect(s!.buckets.map((b) => [b.at - BASE, b.onlineMs, b.active])).toEqual([
      [0, 3 * MIN, true],
      [5 * MIN, 5 * MIN, true],
      [10 * MIN, 5 * MIN, false],
      [15 * MIN, 5 * MIN, true],
      [20 * MIN, 3 * MIN, false],
    ]);
    expect(s).toMatchObject({
      onlineMs: 21 * MIN,
      activeMs: 13 * MIN,
      xp: 220,
      xpBySkill: { Attack: 150, Strength: 70 },
      gp: 1000,
      drops: 1,
      main: { kind: 'skill', name: 'Attack' },
    });
    expect(s!.buckets[3]!.activity).toBe('Zulrah');
    expect(s!.buckets[1]!.activity).toBe('Strength');
  });

  it('never counts XP the hiscores filled in, and loot only when the viewer reads events', () => {
    const [s] = buildSessions(
      input({
        spans: [{ id: 'a', start: BASE, end: BASE + 10 * MIN }],
        gains: [xp(0, 'Mining', 5000, true)],
        drops: [{ at: BASE + 6 * MIN, value: 10, source: null }],
        lootActive: false,
      }),
    );
    expect(s!.activeMs).toBe(0);
    expect(s!.xp).toBe(0);
    // The drop's value is still there for whoever can see it; it just doesn't make the bucket active.
    expect(s!.gp).toBe(10);
  });

  it('counts a bucket two touching sessions share once', () => {
    const sessions = buildSessions(
      input({
        spans: [
          { id: 'b', start: BASE + 7 * MIN, end: BASE + 15 * MIN },
          { id: 'a', start: BASE, end: BASE + 7 * MIN },
        ],
        gains: [xp(5, 'Attack', 100)],
      }),
    );
    expect(sessions.map((s) => [s.id, s.xp])).toEqual([
      ['a', 100],
      ['b', 0],
    ]);
  });

  it('gives a reading’s kills to the session that ended before it, and shares them when several did', () => {
    const sessions = buildSessions(
      input({
        spans: [
          { id: 'a', start: BASE, end: BASE + 30 * MIN },
          { id: 'b', start: BASE + 60 * MIN, end: BASE + 90 * MIN },
          { id: 'c', start: BASE + 120 * MIN, end: BASE + 150 * MIN },
        ],
        kills: [
          // Read 10 minutes after a: a's alone.
          { prevAt: BASE - 600 * MIN, at: BASE + 40 * MIN, activity: 'Zulrah', kills: 12 },
          // One reading after both b and c.
          { prevAt: BASE + 40 * MIN, at: BASE + 160 * MIN, activity: 'Vorkath', kills: 9 },
          // Mobile play: no session before it.
          { prevAt: BASE + 160 * MIN, at: BASE + 900 * MIN, activity: 'Zulrah', kills: 3 },
        ],
      }),
    );
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.a).toMatchObject({ kills: { Zulrah: 12 }, killsShared: false });
    expect(byId.a!.main).toEqual({ kind: 'boss', name: 'Zulrah' });
    expect(byId.b).toMatchObject({ kills: {}, killsShared: true });
    expect(byId.c).toMatchObject({ kills: { Vorkath: 9 }, killsShared: true });
  });

  it('leaves a daily reading’s kills out of an old session, though no change was stored since', () => {
    const sessions = buildSessions(
      input({
        spans: [{ id: 'a', start: BASE, end: BASE + 30 * MIN }],
        // The lookup after a found nothing new (no row); a day later the daily one found 3 kills.
        kills: [
          { prevAt: BASE - 600 * MIN, at: BASE + 30 * MIN + DAY, activity: 'Zulrah', kills: 3 },
        ],
      }),
    );
    expect(sessions[0]).toMatchObject({ kills: {}, killsShared: false, main: null });
  });
});

function sessionsFixture(): SessionMetrics[] {
  return buildSessions(
    input({
      spans: [
        // Monday 18:00–19:00 UTC, active the first half only.
        { id: 'mon', start: BASE, end: BASE + 60 * MIN },
        // Saturday 10:00–10:30 UTC, all active.
        {
          id: 'sat',
          start: t('2026-10-10T10:00:00Z'),
          end: t('2026-10-10T10:30:00Z'),
        },
      ],
      gains: [
        ...[0, 5, 10, 15, 20, 25].map((m) => xp(m, 'Fishing', 1000)),
        ...[0, 5, 10, 15, 20, 25].map((m) => ({
          at: t('2026-10-10T10:00:00Z') + m * MIN,
          skill: 'Woodcutting',
          xp: 2000,
          fromHiscores: false,
        })),
      ],
      kills: [
        {
          prevAt: BASE - MIN,
          at: t('2026-10-10T10:45:00Z'),
          activity: 'Zulrah',
          kills: 6,
        },
      ],
    }),
  );
}

describe('measures', () => {
  it('sums the selected skills or bosses, the loot, or the active time', () => {
    const [mon, sat] = sessionsFixture();
    expect(sessionValue(mon!, { measure: 'xp' })).toBe(6000);
    expect(sessionValue(mon!, { measure: 'xp', skills: new Set(['Attack']) })).toBe(0);
    expect(sessionValue(sat!, { measure: 'kills' })).toBe(6);
    expect(sessionValue(sat!, { measure: 'kills', bosses: new Set(['Vorkath']) })).toBe(0);
    expect(sessionValue(mon!, { measure: 'active' })).toBe(30 * MIN);
  });

  it('gives rates per hour, and the active share for active time', () => {
    expect(rateOf({ measure: 'xp' }, 6000, 30 * MIN)).toBe(12_000);
    expect(rateOf({ measure: 'active' }, 30 * MIN, 60 * MIN)).toBe(0.5);
    expect(rateOf({ measure: 'gp' }, 5, 0)).toBeNull();
  });

  it('summarizes sessions and finds the records', () => {
    const sessions = sessionsFixture();
    expect(summarizeSessions(sessions, { measure: 'xp' })).toEqual({
      sessions: 2,
      onlineMs: 90 * MIN,
      activeMs: 60 * MIN,
      value: 18_000,
    });
    expect(sessionRecords(sessions)).toEqual({
      mostXp: 'sat',
      mostGp: null,
      mostKills: 'sat',
      longest: 'mon',
    });
  });
});

describe('filterSessions', () => {
  const sessions = sessionsFixture();
  const ids = (list: SessionMetrics[]) => list.map((s) => s.id);

  it('filters by length, local weekday and hour, and main activity', () => {
    expect(ids(filterSessions(sessions, { minMs: 45 * MIN }, 'UTC'))).toEqual(['mon']);
    expect(ids(filterSessions(sessions, { weekdays: new Set([5, 6]) }, 'UTC'))).toEqual(['sat']);
    expect(ids(filterSessions(sessions, { hours: { from: 17, to: 23 } }, 'UTC'))).toEqual(['mon']);
    expect(ids(filterSessions(sessions, { activity: 'Zulrah' }, 'UTC'))).toEqual(['sat']);
    expect(ids(filterSessions(sessions, {}, 'UTC'))).toEqual(['mon', 'sat']);
  });

  it('wraps an hour window past midnight and reads hours in the viewer’s zone', () => {
    // Monday 18:00 UTC is Tuesday 03:00 in Tokyo.
    expect(ids(filterSessions(sessions, { hours: { from: 22, to: 4 } }, 'Asia/Tokyo'))).toEqual([
      'mon',
    ]);
    expect(ids(filterSessions(sessions, { weekdays: new Set([1]) }, 'Asia/Tokyo'))).toEqual([
      'mon',
    ]);
  });
});

describe('heatmap', () => {
  it('puts online and active time and the measure in each local weekday × hour cell', () => {
    const cells = heatmap(sessionsFixture(), { measure: 'xp' }, 'UTC');
    expect(cells).toHaveLength(7 * 24);
    const mon18 = cells[0 * 24 + 18]!;
    expect(mon18).toMatchObject({
      onlineMs: 60 * MIN,
      activeMs: 30 * MIN,
      value: 6000,
      sessions: 1,
    });
    expect(heatValue(mon18, { measure: 'xp' })).toBe(12_000);
    expect(heatValue(mon18, { measure: 'active' })).toBe(30);
    expect(heatValue(cells[0]!, { measure: 'xp' })).toBeNull();
  });

  it('spreads a session’s kills over its active buckets', () => {
    const cells = heatmap(sessionsFixture(), { measure: 'kills' }, 'UTC');
    expect(cells[5 * 24 + 10]!.value).toBeCloseTo(6, 10);
  });
});

describe('rateThroughSession', () => {
  it('gives the median and middle half per step of the sessions that lasted it', () => {
    const steps = rateThroughSession(sessionsFixture(), { measure: 'xp' });
    expect(steps).toEqual([
      { minute: 0, sessions: 2, p25: 15_000, median: 18_000, p75: 21_000 },
      { minute: 30, sessions: 1, p25: 0, median: 0, p75: 0 },
    ]);
  });

  it('has nothing for kills, which aren’t known within a session', () => {
    expect(rateThroughSession(sessionsFixture(), { measure: 'kills' })).toEqual([]);
  });

  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('timeByActivity', () => {
  it('stacks active time per activity per local day and folds the rest into Other', () => {
    const result = timeByActivity(sessionsFixture(), 'UTC', 1);
    expect(result.days).toEqual(calendarDays(['2026-10-05', '2026-10-10']));
    expect(result.days).toHaveLength(6);
    expect(result.series.map((s) => s.name)).toEqual(['Fishing', OTHER_ACTIVITY]);
    expect(result.series[0]!.ms[0]).toBe(30 * MIN);
    expect(result.series[1]!.ms[5]).toBe(30 * MIN);
  });

  it('is empty without sessions', () => {
    expect(timeByActivity([], 'UTC')).toEqual({ days: [], series: [] });
  });
});

it('uses the 5-minute bucket of xp_samples', () => {
  expect(METRICS_BUCKET_MS).toBe(5 * MIN);
});
