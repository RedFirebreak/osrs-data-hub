import { describe, expect, it } from 'vitest';
import { XP_RANGES, isXpRange, rangeWindow, xpQuery } from './ranges';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('rangeWindow', () => {
  it('maps each preset to a window ending now', () => {
    const spans = Object.fromEntries(
      XP_RANGES.filter((r) => r !== 'all').map((r) => {
        const w = rangeWindow(r, NOW);
        expect(w.to).toEqual(NOW);
        return [r, NOW.getTime() - w.from.getTime()];
      }),
    );
    expect(spans).toEqual({
      '24h': DAY,
      '7d': 7 * DAY,
      '30d': 30 * DAY,
      '90d': 90 * DAY,
      '1y': 365 * DAY,
    });
  });

  it("'all' starts at the account's first-seen time", () => {
    const w = rangeWindow('all', NOW, '2024-01-15T08:00:00.000Z');
    expect(w.from.toISOString()).toBe('2024-01-15T08:00:00.000Z');
    expect(w.to).toEqual(NOW);
    expect(rangeWindow('all', NOW, new Date('2025-01-01T00:00:00Z')).from.toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    );
  });

  it("'all' without a usable first-seen time goes ten years back", () => {
    for (const firstSeen of [undefined, null, 'not a date']) {
      const w = rangeWindow('all', NOW, firstSeen);
      expect(NOW.getTime() - w.from.getTime()).toBe(10 * 365 * DAY);
    }
  });

  it('never starts after it ends (a first-seen time in the future)', () => {
    const w = rangeWindow('all', NOW, '2030-01-01T00:00:00.000Z');
    expect(w.from).toEqual(NOW);
    expect(w.to).toEqual(NOW);
  });
});

describe('isXpRange', () => {
  it('accepts the presets only', () => {
    expect(XP_RANGES.every(isXpRange)).toBe(true);
    for (const v of ['1d', '', 'ALL', null, 7]) expect(isXpRange(v)).toBe(false);
  });
});

describe('xpQuery', () => {
  it('builds the XP route query with resolution auto', () => {
    const q = new URLSearchParams(xpQuery('Attack', rangeWindow('7d', NOW)));
    expect(Object.fromEntries(q)).toEqual({
      skills: 'Attack',
      from: '2026-09-22T12:00:00.000Z',
      to: '2026-09-29T12:00:00.000Z',
      resolution: 'auto',
    });
  });
});
