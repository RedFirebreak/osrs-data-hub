import { describe, expect, it } from 'vitest';
import { dayOnlyLabel, localDate } from './dates';

describe('dayOnlyLabel (D-50 day-only stamps)', () => {
  const now = '2026-09-29T21:30:00Z';

  it('says today / yesterday for the local calendar day of the stamp', () => {
    // The read model's stamp is local midnight in the viewer's zone.
    expect(dayOnlyLabel('2026-09-29T00:00:00Z', now, 'UTC')).toEqual({
      day: '2026-09-29',
      text: 'today',
    });
    expect(dayOnlyLabel('2026-09-28T00:00:00Z', now, 'UTC')?.text).toBe('yesterday');
    // Tokyo: 21:30Z is already the 30th; its midnight of the 30th is 15:00Z on the 29th.
    expect(dayOnlyLabel('2026-09-29T15:00:00Z', now, 'Asia/Tokyo')).toEqual({
      day: '2026-09-30',
      text: 'today',
    });
  });

  it('gives an older day as a date, with the year only when it differs', () => {
    expect(dayOnlyLabel('2026-08-20T00:00:00Z', now, 'UTC')?.text).toBe('on 20 Aug');
    expect(dayOnlyLabel('2025-12-31T00:00:00Z', now, 'UTC')?.text).toBe('on 31 Dec 2025');
  });

  it('counts calendar days across a DST change (a 23-hour day)', () => {
    // Europe/Amsterdam springs forward on 2026-03-29; local midnight of the 29th is 23:00Z on the 28th.
    const stamp = '2026-03-28T23:00:00+00:00';
    expect(dayOnlyLabel(stamp, '2026-03-30T00:30:00+02:00', 'Europe/Amsterdam')?.text).toBe(
      'yesterday',
    );
  });

  it('is null for an invalid date; an unknown zone falls back to UTC', () => {
    expect(dayOnlyLabel('nope', now, 'UTC')).toBeNull();
    expect(dayOnlyLabel('2026-09-29T00:00:00Z', now, 'Mars/Olympus')?.text).toBe('today');
  });
});

describe('localDate', () => {
  it('is the calendar date in the zone', () => {
    expect(localDate(new Date('2026-09-29T22:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-30');
  });

  it('formats the local calendar date, UTC for unknown zones', () => {
    const at = new Date('2026-09-29T23:30:00.000Z');
    expect(localDate(at, 'UTC')).toBe('2026-09-29');
    expect(localDate(at, 'Asia/Tokyo')).toBe('2026-09-30');
    expect(localDate(at, 'Mars/Olympus')).toBe('2026-09-29');
  });
});
