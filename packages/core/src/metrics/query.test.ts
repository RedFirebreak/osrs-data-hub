import { describe, expect, it } from 'vitest';
import { bossKey, isSameBoss } from './bosses';
import { comparisonStepMs, cumulativeSeries, periodComparison } from './comparison';
import {
  DEFAULT_METRICS_QUERY,
  hasSessionFilter,
  metricsSearch,
  parseMetricsQuery,
  parseRangeBound,
} from './query';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('parseMetricsQuery', () => {
  it('reads every filter', () => {
    const q = parseMetricsQuery(
      new URLSearchParams(
        'range=custom&from=2026-09-01&to=2026-09-30&compare=1&measure=kills&bosses=Zulrah,Vorkath' +
          '&skills=Attack&min=30&days=4,0,4&hours=18-24&activity=Zulrah' +
          '&session=0192F1E8-0000-7000-8000-000000000001',
      ),
    );
    expect(q).toEqual({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      session: '0192f1e8-0000-7000-8000-000000000001',
      compare: true,
      measure: 'kills',
      skills: ['Attack'],
      bosses: ['Zulrah', 'Vorkath'],
      minMinutes: 30,
      weekdays: [0, 4],
      hours: { from: 18, to: 0 },
      activity: 'Zulrah',
    });
    expect(hasSessionFilter(q)).toBe(true);
  });

  it('falls back to the defaults for anything malformed', () => {
    const q = parseMetricsQuery({
      range: 'forever',
      measure: 'vibes',
      min: '-3',
      days: 'mon,9',
      hours: '7-7',
      session: "1' or 1=1",
      skills: '<script>,Attack,Attack',
      activity: 'x'.repeat(200),
    });
    expect(q).toEqual({ ...DEFAULT_METRICS_QUERY, skills: ['Attack'] });
    expect(hasSessionFilter(q)).toBe(false);
  });

  it('drops a custom range without both bounds', () => {
    expect(parseMetricsQuery({ range: 'custom', from: '2026-09-01' }).range).toBe('30d');
  });

  it('accepts instants as bounds (a brush on a time axis)', () => {
    expect(parseRangeBound('2026-09-01T10:00:00.000Z')).toBe('2026-09-01T10:00:00.000Z');
    expect(parseRangeBound('2026-13-45')).toBeNull();
    expect(parseRangeBound('soon')).toBeNull();
  });
});

describe('metricsSearch', () => {
  it('writes only what differs from the defaults and round-trips', () => {
    expect(metricsSearch(DEFAULT_METRICS_QUERY)).toBe('');
    const q = {
      ...DEFAULT_METRICS_QUERY,
      range: 'custom' as const,
      from: '2026-09-01',
      to: '2026-09-07',
      measure: 'gp' as const,
      weekdays: [5, 6],
      hours: { from: 22, to: 2 },
    };
    const search = metricsSearch(q);
    expect(search).toBe(
      'range=custom&from=2026-09-01&to=2026-09-07&measure=gp&days=5%2C6&hours=22-2',
    );
    expect(parseMetricsQuery(new URLSearchParams(search))).toEqual(q);
  });
});

describe('periodComparison', () => {
  it('steps by hour, day or week with the span', () => {
    expect(comparisonStepMs(DAY)).toBe(HOUR);
    expect(comparisonStepMs(30 * DAY)).toBe(DAY);
    expect(comparisonStepMs(365 * DAY)).toBe(7 * DAY);
    expect(comparisonStepMs(DAY, DAY)).toBe(DAY);
  });

  it('accumulates each period from its own start', () => {
    const from = Date.parse('2026-10-01T00:00:00Z');
    const points = [
      { at: from - 2 * DAY + HOUR, value: 5 },
      { at: from + HOUR, value: 10 },
      { at: from + DAY + HOUR, value: 20 },
    ];
    expect(cumulativeSeries(points, from, from + 2 * DAY, DAY)).toEqual([
      [0, 0],
      [DAY, 10],
      [2 * DAY, 30],
    ]);
    const result = periodComparison(points, { from, to: from + 2 * DAY }, { compare: true });
    expect(result.stepMs).toBe(HOUR);
    expect(result.current.at(-1)).toEqual([2 * DAY, 30]);
    expect(result.previous?.at(-1)).toEqual([2 * DAY, 5]);
  });

  it('stops the current line at now', () => {
    const from = Date.parse('2026-10-01T00:00:00Z');
    const result = periodComparison(
      [],
      { from, to: from + DAY, now: from + 3 * HOUR },
      {
        compare: false,
      },
    );
    expect(result.current.at(-1)).toEqual([3 * HOUR, 0]);
    expect(result.previous).toBeNull();
  });
});

describe('bossKey', () => {
  it('matches hiscores names to loot sources', () => {
    expect(bossKey("Kree'Arra")).toBe('kreearra');
    expect(isSameBoss("Kree'Arra", "Kree'arra")).toBe(true);
    expect(isSameBoss('The Corrupted Gauntlet', 'Corrupted Gauntlet')).toBe(true);
    expect(isSameBoss('Zulrah', 'Vorkath')).toBe(false);
    expect(isSameBoss('Zulrah', null)).toBe(false);
    expect(isSameBoss('!!', '??')).toBe(false);
  });
});
