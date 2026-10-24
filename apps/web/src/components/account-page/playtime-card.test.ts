import { describe, expect, it } from 'vitest';
import { barLabel } from './playtime-bars';
import { formatPlaytime, sessionsPerDay, summarizePlaytime } from './playtime-card';
import { deepDiveDayHref, sharingHref } from '@/lib/routes';

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

describe('sessionsPerDay', () => {
  it('counts a session on every local day it ran on', () => {
    const sessions = [
      { startedAt: '2026-10-22T20:00:00Z', durationMs: 60 * MIN }, // 22:00–23:00 in Amsterdam
      { startedAt: '2026-10-22T21:30:00Z', durationMs: 90 * MIN }, // 23:30–01:00: both days
      { startedAt: 'not a date', durationMs: MIN },
    ];
    expect(
      sessionsPerDay(sessions, ['2026-10-21', '2026-10-22', '2026-10-23'], 'Europe/Amsterdam'),
    ).toEqual([0, 2, 1]);
  });
});

describe('the bars', () => {
  it('say the day, the time and the sessions, and open the day in the deep dive', () => {
    const bar = { day: '2026-10-20', ms: 1, label: 'Tue 20 Oct', href: null };
    expect(barLabel({ ...bar, sessions: 0, played: null })).toBe('Tue 20 Oct: not played');
    expect(barLabel({ ...bar, sessions: 1, played: '10h 20m' })).toBe(
      'Tue 20 Oct: 10h 20m in 1 session. Opens the day in Deep dive',
    );
    expect(deepDiveDayHref('AbC', '2026-10-20')).toBe(
      '/progress/AbC/deep-dive?range=custom&from=2026-10-20&to=2026-10-20',
    );
    expect(sharingHref('AbC')).toBe('/settings?account=AbC#sharing');
  });
});
