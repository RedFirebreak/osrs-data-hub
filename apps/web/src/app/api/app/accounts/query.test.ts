import { DAY_MS } from '@hub/core';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTORY_DAYS, parseFeedQuery, parseHistoryRange, parseXpQuery } from './query';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const url = (q: string) => `http://hub.test/api/x${q}`;

describe('parseHistoryRange', () => {
  it('defaults to the 30 days before now', () => {
    const r = parseHistoryRange(url(''), NOW);
    expect(r.to).toEqual(NOW);
    expect(NOW.getTime() - r.from.getTime()).toBe(DEFAULT_HISTORY_DAYS * DAY_MS);
  });

  it('takes ISO instants with Z or an offset; from defaults relative to to', () => {
    const r = parseHistoryRange(url('?to=2026-09-10T02:00:00%2B02:00'), NOW);
    expect(r.to.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(r.from.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    const both = parseHistoryRange(url('?from=2026-09-01T00:00:00Z&to=2026-09-01T00:00:00Z'), NOW);
    expect(both.from).toEqual(both.to);
  });

  it('refuses dates without a time, garbage and inverted ranges', () => {
    for (const q of [
      '?from=2026-09-01',
      '?to=now',
      '?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z',
    ]) {
      expect(() => parseHistoryRange(url(q), NOW), q).toThrow(ZodError);
    }
  });
});

describe('parseXpQuery', () => {
  it('defaults to Overall, auto and the last 30 days', () => {
    const q = parseXpQuery(url(''), NOW);
    expect(q.skills).toEqual(['Overall']);
    expect(q.resolution).toBe('auto');
    expect(q.to).toEqual(NOW);
  });

  it('trims and de-duplicates skills', () => {
    expect(parseXpQuery(url('?skills=Attack, Attack ,Overall'), NOW).skills).toEqual([
      'Attack',
      'Overall',
    ]);
  });

  it('accepts every resolution and refuses others', () => {
    for (const r of ['auto', '5m', '1h', '1d']) {
      expect(parseXpQuery(url(`?resolution=${r}`), NOW).resolution).toBe(r);
    }
    expect(() => parseXpQuery(url('?resolution=1w'), NOW)).toThrow(ZodError);
    expect(() => parseXpQuery(url('?skills='), NOW)).toThrow(ZodError);
  });
});

describe('parseFeedQuery', () => {
  it('is empty without parameters and parses each one', () => {
    expect(parseFeedQuery(url(''))).toEqual({});
    expect(
      parseFeedQuery(url('?account=AbC123&types=loot,level_up,loot&before=42&limit=20')),
    ).toEqual({
      accountPublicId: 'AbC123',
      types: ['loot', 'level_up'],
      beforeSeq: 42,
      limit: 20,
    });
  });

  it('keeps unknown (camelCase) plugin types and treats an empty list as all types', () => {
    expect(parseFeedQuery(url('?types=questComplete')).types).toEqual(['questComplete']);
    expect(parseFeedQuery(url('?types=')).types).toBeUndefined();
  });

  it('refuses out-of-range cursors and limits', () => {
    for (const q of [
      '?before=0',
      '?before=99999999999999999',
      '?limit=0',
      '?limit=500',
      '?types=a b',
    ]) {
      expect(() => parseFeedQuery(url(q)), q).toThrow(ZodError);
    }
  });
});
