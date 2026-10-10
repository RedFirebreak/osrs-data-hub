import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRESS_QUERY,
  deepDiveRange,
  parseProgressQuery,
  progressMetricsQuery,
  progressSearch,
} from './progress';

describe('parseProgressQuery', () => {
  it('reads the range and the measure, from an object or URLSearchParams', () => {
    expect(parseProgressQuery({ range: '30d', measure: 'gp' })).toEqual({
      range: '30d',
      measure: 'gp',
    });
    expect(parseProgressQuery(new URLSearchParams('range=1y&measure=kills'))).toEqual({
      range: '1y',
      measure: 'kills',
    });
    expect(parseProgressQuery({ range: ['90d', '1d'] }).range).toBe('90d');
  });

  it('falls back to the defaults for anything it does not know', () => {
    expect(parseProgressQuery({})).toEqual(DEFAULT_PROGRESS_QUERY);
    expect(parseProgressQuery({ range: 'forever', measure: 'luck' })).toEqual(
      DEFAULT_PROGRESS_QUERY,
    );
    // Deep dive's ranges are not Progress's.
    expect(parseProgressQuery({ range: 'today' }).range).toBe('7d');
  });

  it("offers 'all' only where the page says so", () => {
    expect(parseProgressQuery({ range: 'all' }).range).toBe('7d');
    expect(parseProgressQuery({ range: 'all' }, { all: true }).range).toBe('all');
  });
});

describe('progressSearch', () => {
  it('writes only what differs from the defaults', () => {
    expect(progressSearch(DEFAULT_PROGRESS_QUERY)).toBe('');
    expect(progressSearch({ range: '30d', measure: 'xp' })).toBe('range=30d');
    expect(progressSearch({ range: '7d', measure: 'active' })).toBe('measure=active');
    expect(progressSearch({ range: '1d', measure: 'gp' })).toBe('range=1d&measure=gp');
  });

  it('round-trips through the parser', () => {
    const query = { range: '90d', measure: 'kills' } as const;
    expect(parseProgressQuery(new URLSearchParams(progressSearch(query)))).toEqual(query);
  });
});

describe('progressMetricsQuery', () => {
  const now = new Date('2026-10-10T12:00:00Z');

  it('uses the rolling presets', () => {
    expect(progressMetricsQuery({ range: '30d', measure: 'gp' }, now)).toMatchObject({
      range: '30d',
      measure: 'gp',
      from: null,
      to: null,
      skills: [],
      compare: false,
    });
  });

  it('makes "1D" the last 24 hours, not since midnight', () => {
    expect(progressMetricsQuery({ range: '1d', measure: 'xp' }, now)).toMatchObject({
      range: 'custom',
      from: '2026-10-09T12:00:00.000Z',
      to: '2026-10-10T12:00:00.000Z',
    });
  });

  it('narrows XP to one skill, and reads a year for "all"', () => {
    expect(progressMetricsQuery({ range: 'all', measure: 'xp' }, now, 'Firemaking')).toMatchObject({
      range: '1y',
      skills: ['Firemaking'],
    });
  });
});

describe('deepDiveRange', () => {
  it('hands Deep dive its closest range', () => {
    expect(deepDiveRange('1d')).toBe('today');
    expect(deepDiveRange('7d')).toBe('7d');
    expect(deepDiveRange('all')).toBe('1y');
  });
});
