import { describe, expect, it } from 'vitest';
import { periodStarts, startOfLocalDay } from './periods';

const iso = (d: Date) => d.toISOString();
const start = (now: string, tz: string) => iso(startOfLocalDay(new Date(now), tz));

describe('startOfLocalDay', () => {
  it('is UTC midnight in UTC, and an instant at midnight is its own day start', () => {
    expect(start('2026-09-28T12:34:56.789Z', 'UTC')).toBe('2026-09-28T00:00:00.000Z');
    expect(start('2026-09-28T00:00:00.000Z', 'UTC')).toBe('2026-09-28T00:00:00.000Z');
    expect(start('2026-09-27T23:59:59.999Z', 'UTC')).toBe('2026-09-27T00:00:00.000Z');
  });

  it('handles whole, half and quarter hour offsets on both sides of UTC', () => {
    expect(start('2026-09-28T12:00:00Z', 'Europe/Amsterdam')).toBe('2026-09-27T22:00:00.000Z');
    expect(start('2026-09-28T12:00:00Z', 'Asia/Kolkata')).toBe('2026-09-27T18:30:00.000Z');
    expect(start('2026-09-28T12:00:00Z', 'Asia/Kathmandu')).toBe('2026-09-27T18:15:00.000Z');
    expect(start('2026-09-28T12:00:00Z', 'America/New_York')).toBe('2026-09-28T04:00:00.000Z');
    // +14: it is already the 29th there.
    expect(start('2026-09-28T12:00:00Z', 'Pacific/Kiritimati')).toBe('2026-09-28T10:00:00.000Z');
    // −11: 01:00 on the 28th.
    expect(start('2026-09-28T12:00:00Z', 'Pacific/Pago_Pago')).toBe('2026-09-28T11:00:00.000Z');
  });

  it('uses the offset in effect at midnight on DST days (transition after midnight)', () => {
    // Amsterdam springs forward at 02:00 and falls back at 03:00: midnight keeps the old offset.
    expect(start('2026-03-29T12:00:00Z', 'Europe/Amsterdam')).toBe('2026-03-28T23:00:00.000Z');
    expect(start('2026-10-25T12:00:00Z', 'Europe/Amsterdam')).toBe('2026-10-24T22:00:00.000Z');
    // Right at local midnight, and in the hour that repeats.
    expect(start('2026-03-28T23:00:00Z', 'Europe/Amsterdam')).toBe('2026-03-28T23:00:00.000Z');
    expect(start('2026-10-25T00:30:00Z', 'Europe/Amsterdam')).toBe('2026-10-24T22:00:00.000Z');
  });

  it('starts the day at the transition when midnight does not exist', () => {
    // Santiago: 2026-09-06 00:00 → 01:00 (−04 → −03); Havana: 2026-03-08 00:00 → 01:00.
    expect(start('2026-09-06T15:00:00Z', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
    expect(start('2026-03-08T16:00:00Z', 'America/Havana')).toBe('2026-03-08T05:00:00.000Z');
  });

  it('takes the first midnight when it happens twice', () => {
    // Havana 2026-11-01: 01:00 −04 → 00:00 −05, so 00:00–00:59 happens twice.
    expect(start('2026-11-01T17:00:00Z', 'America/Havana')).toBe('2026-11-01T04:00:00.000Z');
    expect(start('2026-11-01T05:30:00Z', 'America/Havana')).toBe('2026-11-01T04:00:00.000Z');
  });

  it('handles a fall-back across midnight into the previous day', () => {
    // Santiago 2026-04-05 00:00 −03 → 2026-04-04 23:00 −04: the 4th ends twice, the 5th starts once.
    expect(start('2026-04-05T15:00:00Z', 'America/Santiago')).toBe('2026-04-05T04:00:00.000Z');
    expect(start('2026-04-05T03:30:00Z', 'America/Santiago')).toBe('2026-04-04T03:00:00.000Z');
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(start('2026-09-28T12:00:00Z', 'Mars/Olympus_Mons')).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('periodStarts', () => {
  it('uses local midnight for today and rolling windows for the rest', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    expect(periodStarts(now, 'Europe/Amsterdam')).toEqual({
      today: new Date('2026-09-27T22:00:00Z'),
      week: new Date('2026-09-21T12:00:00Z'),
      month: new Date('2026-08-29T12:00:00Z'),
      year: new Date('2025-09-28T12:00:00Z'),
    });
  });

  it('defaults to UTC', () => {
    expect(periodStarts(new Date('2026-09-28T12:00:00Z')).today).toEqual(
      new Date('2026-09-28T00:00:00Z'),
    );
  });
});
