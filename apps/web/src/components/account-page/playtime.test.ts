import { HOUR_MS } from '@hub/core';
import { describe, expect, it } from 'vitest';
import { playtimeByDay } from './playtime';

function session(start: string, hours: number) {
  return { startedAt: start, durationMs: hours * HOUR_MS };
}

describe('playtimeByDay', () => {
  it('sums sessions per UTC day, oldest first, today included', () => {
    const days = playtimeByDay(
      [session('2026-09-29T08:00:00.000Z', 2), session('2026-09-27T10:00:00.000Z', 1)],
      { now: new Date('2026-09-29T12:00:00.000Z'), days: 3, timezone: 'UTC' },
    );
    expect(days).toEqual([
      { day: '2026-09-27', ms: HOUR_MS },
      { day: '2026-09-28', ms: 0 },
      { day: '2026-09-29', ms: 2 * HOUR_MS },
    ]);
  });

  it('splits a session at local midnight in the viewer time zone', () => {
    // 21:00–01:00 UTC is 23:00–03:00 in Amsterdam (CEST, UTC+2): 1 h on the 28th, 3 h on the 29th.
    const days = playtimeByDay([session('2026-09-28T21:00:00.000Z', 4)], {
      now: new Date('2026-09-29T12:00:00.000Z'),
      days: 2,
      timezone: 'Europe/Amsterdam',
    });
    expect(days).toEqual([
      { day: '2026-09-28', ms: HOUR_MS },
      { day: '2026-09-29', ms: 3 * HOUR_MS },
    ]);
  });

  it('follows a DST change: the 25-hour day holds 25 hours of play', () => {
    // Europe/Amsterdam falls back on 2026-10-25 (03:00 CEST → 02:00 CET).
    const days = playtimeByDay([session('2026-10-24T22:00:00.000Z', 25)], {
      now: new Date('2026-10-25T23:30:00.000Z'),
      days: 2,
      timezone: 'Europe/Amsterdam',
    });
    expect(days).toEqual([
      { day: '2026-10-25', ms: 25 * HOUR_MS },
      { day: '2026-10-26', ms: 0 },
    ]);
  });

  it('ignores invalid sessions and returns nothing for zero days', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(
      playtimeByDay([session('nope', 1), { startedAt: '2026-09-29T10:00:00Z', durationMs: -5 }], {
        now,
        days: 1,
        timezone: 'UTC',
      }),
    ).toEqual([{ day: '2026-09-29', ms: 0 }]);
    expect(playtimeByDay([], { now, days: 0, timezone: 'UTC' })).toEqual([]);
  });
});
