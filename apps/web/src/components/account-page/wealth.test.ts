import { describe, expect, it } from 'vitest';
import { summarizeWealth, wealthDelta, wealthPoints } from './wealth';

const day = (d: string, lastValue: number, bankValue: number | null = null) => ({
  day: d,
  lastValue,
  maxValue: lastValue,
  bankValue,
});
const now = new Date('2026-10-24T15:00:00Z');

describe('wealthDelta', () => {
  it('is unknown across the first bank reading', () => {
    expect(wealthDelta(day('2026-10-20', 80), day('2026-10-21', 1_090, 1_000))).toBeNull();
    expect(wealthDelta(day('2026-10-20', 1_080, 1_000), day('2026-10-21', 1_050, 1_000))).toBe(-30);
    expect(wealthDelta(day('2026-10-20', 80), day('2026-10-21', 95))).toBe(15);
  });
});

describe('wealthPoints', () => {
  it('carries a day without play over, and changes from the day before the window', () => {
    const history = [day('2026-10-19', 100), day('2026-10-21', 130), day('2026-10-24', 90)];
    const points = wealthPoints(history, { now, days: 4 });
    expect(points.map((p) => [p.day, p.value, p.change])).toEqual([
      ['2026-10-21', 130, 30],
      ['2026-10-22', 130, 0],
      ['2026-10-23', 130, 0],
      ['2026-10-24', 90, -40],
    ]);
  });

  it('is empty before the first day with data', () => {
    const points = wealthPoints([day('2026-10-24', 50)], { now, days: 2 });
    expect(points.map((p) => [p.value, p.change])).toEqual([
      [null, null],
      [50, null],
    ]);
  });

  it('leaves the days before the first bank reading off, with no change across it', () => {
    // 2.7B of gear carried on the 22nd is in the bank when it is first read on the 24th.
    const history = [
      day('2026-10-22', 2_700_000_000),
      day('2026-10-24', 2_060_000_000, 2_050_000_000),
    ];
    const points = wealthPoints(history, { now, days: 3 });
    expect(points.map((p) => [p.value, p.change])).toEqual([
      [null, null],
      [null, null],
      [2_060_000_000, null],
    ]);
  });
});

describe('summarizeWealth', () => {
  it('measures the window from the first bank reading, and has no change for today', () => {
    const history = [
      day('2026-10-19', 2_700_000_000),
      day('2026-10-22', 2_060_000_000, 2_050_000_000),
      day('2026-10-24', 2_065_000_000, 2_050_000_000),
    ];
    const points = wealthPoints(history, { now, days: 4 });
    expect(summarizeWealth(history, points)).toMatchObject({ today: 5_000_000, window: 5_000_000 });
    const first = history
      .slice(0, 2)
      .map((d) => ({ ...d, day: d.day === '2026-10-22' ? '2026-10-24' : d.day }));
    expect(summarizeWealth(first, wealthPoints(first, { now, days: 4 }))).toMatchObject({
      today: null,
      window: null,
    });
  });

  it('has the latest wealth, today and the change over the window', () => {
    const history = [day('2026-10-19', 100), day('2026-10-21', 130), day('2026-10-24', 90)];
    const points = wealthPoints(history, { now, days: 4 });
    expect(summarizeWealth(history, points)).toEqual({
      latest: history[2],
      today: -40,
      window: -10,
    });
  });

  it('has no change without any data', () => {
    expect(summarizeWealth([], wealthPoints([], { now, days: 3 }))).toEqual({
      latest: null,
      today: null,
      window: null,
    });
  });
});
