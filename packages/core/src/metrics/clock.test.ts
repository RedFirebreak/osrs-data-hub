import { describe, expect, it } from 'vitest';
import { LocalClockCache, localClock } from './clock';

const t = (iso: string) => Date.parse(iso);

describe('localClock', () => {
  it('reads weekday, hour and day in the zone (Monday = 0)', () => {
    // Monday 2026-10-05 23:30 UTC is Tuesday 01:30 in Amsterdam (CEST, +2).
    expect(localClock(t('2026-10-05T23:30:00Z'), 'Europe/Amsterdam')).toEqual({
      day: '2026-10-06',
      weekday: 1,
      hour: 1,
      minuteOfDay: 90,
    });
    expect(localClock(t('2026-10-05T23:30:00Z'), 'UTC')).toMatchObject({ weekday: 0, hour: 23 });
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(localClock(t('2026-10-11T12:00:00Z'), 'Not/AZone')).toMatchObject({
      day: '2026-10-11',
      weekday: 6,
      hour: 12,
    });
  });
});

describe('LocalClockCache', () => {
  it('agrees with localClock minute by minute, including a 45-minute offset zone and a DST change', () => {
    for (const zone of ['Europe/Amsterdam', 'Asia/Kathmandu', 'America/St_Johns', 'UTC']) {
      const cache = new LocalClockCache(zone);
      // Across the end of CEST (2026-10-25 01:00 UTC).
      for (let ms = t('2026-10-24T22:00:00Z'); ms < t('2026-10-25T04:00:00Z'); ms += 7 * 60_000) {
        expect(cache.at(ms)).toEqual(localClock(ms, zone));
      }
    }
  });
});
