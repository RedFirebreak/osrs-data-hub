import { describe, expect, it } from 'vitest';
import { RecentMinuteCounts } from './recent-counts';

const at = (iso: string) => new Date(iso);

describe('RecentMinuteCounts', () => {
  it('counts per minute and key, zero-filled, oldest first', () => {
    const c = new RecentMinuteCounts(60);
    c.add('401', at('2026-09-29T19:18:05Z'));
    c.add('401', at('2026-09-29T19:18:59.999Z'));
    c.add('429', at('2026-09-29T19:20:00Z'));
    const series = c.series(at('2026-09-29T19:20:30Z'), 3);
    expect(series).toEqual([
      { minute: at('2026-09-29T19:18:00Z'), total: 2, byKey: { '401': 2 } },
      { minute: at('2026-09-29T19:19:00Z'), total: 0, byKey: {} },
      { minute: at('2026-09-29T19:20:00Z'), total: 1, byKey: { '429': 1 } },
    ]);
  });

  it('forgets minutes that left the window, and caps the series at it', () => {
    const c = new RecentMinuteCounts(60);
    c.add('401', at('2026-09-29T18:00:00Z'));
    c.add('401', at('2026-09-29T19:10:00Z'));
    const series = c.series(at('2026-09-29T19:10:00Z'), 500);
    expect(series).toHaveLength(60);
    expect(series.reduce((sum, m) => sum + m.total, 0)).toBe(1);
    // The old minute is gone from memory too, not just outside the series.
    expect(c.series(at('2026-09-29T18:30:00Z'), 60).reduce((s, m) => s + m.total, 0)).toBe(0);
  });

  it('ignores an invalid time', () => {
    const c = new RecentMinuteCounts(60);
    c.add('401', new Date(Number.NaN));
    expect(c.series(at('2026-09-29T19:10:00Z'), 60).every((m) => m.total === 0)).toBe(true);
  });
});
