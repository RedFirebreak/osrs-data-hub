import { describe, expect, it } from 'vitest';
import { deletedNotice, parseDeletedAt } from './deleted-notice';

describe('parseDeletedAt', () => {
  it('reads what Date#toISOString gives, shorter times and plain dates', () => {
    expect(parseDeletedAt('2026-10-06T14:05:09.123Z')).toEqual({
      at: new Date('2026-10-06T14:05:09.123Z'),
      dateOnly: false,
    });
    expect(parseDeletedAt('2026-10-06T14:05:09Z')?.at).toEqual(new Date('2026-10-06T14:05:09Z'));
    expect(parseDeletedAt('2026-10-06T14:05Z')?.at).toEqual(new Date('2026-10-06T14:05:00Z'));
    expect(parseDeletedAt('2026-10-06T14:05:09.5Z')?.at).toEqual(
      new Date('2026-10-06T14:05:09.500Z'),
    );
    expect(parseDeletedAt('2026-10-06')).toEqual({
      at: new Date('2026-10-06T00:00:00Z'),
      dateOnly: true,
    });
    expect(parseDeletedAt(['2026-10-06', 'x'])?.dateOnly).toBe(true);
  });

  it('refuses anything else instead of guessing or rolling over', () => {
    for (const bad of [
      '',
      'soon',
      '2026-02-30',
      '2026-13-01',
      '2026-10-06T24:00Z',
      '2026-10-06T14:60Z',
      '2026-10-06T14:05:09',
      '2026-10-06T14:05:09+02:00',
      '2026-10-06t14:05:09z',
      '2026-10-06T14:05.123Z',
      ' 2026-10-06',
      '2026-10-06T14:05:09.1234Z',
      '<script>alert(1)</script>',
      '1791295509123',
      undefined,
      null,
      42,
      [],
    ]) {
      expect(parseDeletedAt(bad), String(bad)).toBeNull();
    }
  });
});

describe('deletedNotice', () => {
  it('is null without the parameter', () => {
    expect(deletedNotice(undefined)).toBeNull();
  });

  it('gives the date and time in UTC, saying so', () => {
    expect(deletedNotice('2026-10-06T14:05:09.123Z')).toEqual({
      when: { label: '6 October 2026, 14:05 UTC', dateTime: '2026-10-06T14:05:09.123Z' },
    });
    expect(deletedNotice('2026-10-06')).toEqual({
      when: { label: '6 October 2026', dateTime: '2026-10-06' },
    });
  });

  it('keeps the notice but drops a date it cannot read', () => {
    expect(deletedNotice('next tuesday')).toEqual({ when: null });
    expect(deletedNotice('')).toEqual({ when: null });
  });
});
