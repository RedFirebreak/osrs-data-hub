import { describe, expect, it } from 'vitest';
import { formatPlaytime, summarizePlaytime } from './playtime-card';

const MIN = 60_000;

describe('formatPlaytime', () => {
  it('writes minutes, hours and minutes, then whole hours from 100h', () => {
    expect(formatPlaytime(0)).toBe('0m');
    expect(formatPlaytime(-5)).toBe('0m');
    expect(formatPlaytime(42 * MIN + 59_000)).toBe('42m');
    expect(formatPlaytime(185 * MIN)).toBe('3h 05m');
    expect(formatPlaytime(99 * 60 * MIN + 59 * MIN)).toBe('99h 59m');
    expect(formatPlaytime(312 * 60 * MIN + 30 * MIN)).toBe('312h');
    expect(formatPlaytime(1234 * 60 * MIN)).toBe('1,234h');
  });
});

describe('summarizePlaytime', () => {
  it('takes today from the last day and counts the days with any play', () => {
    expect(
      summarizePlaytime([
        { day: '2026-10-22', ms: 30 * MIN },
        { day: '2026-10-23', ms: 0 },
        { day: '2026-10-24', ms: 90 * MIN },
      ]),
    ).toEqual({ todayMs: 90 * MIN, totalMs: 120 * MIN, daysPlayed: 2 });
    expect(summarizePlaytime([])).toEqual({ todayMs: 0, totalMs: 0, daysPlayed: 0 });
  });
});
