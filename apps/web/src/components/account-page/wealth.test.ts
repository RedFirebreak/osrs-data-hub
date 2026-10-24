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
  it('leaves out a bank first read at the end', () => {
    expect(wealthDelta(day('2026-10-20', 80), day('2026-10-21', 1_090, 1_000))).toBe(10);
    expect(wealthDelta(day('2026-10-20', 1_080, 1_000), day('2026-10-21', 1_050, 1_000))).toBe(-30);
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

  it('counts the first bank value on the days before it was read, so the line does not jump', () => {
    const history = [day('2026-10-23', 80), day('2026-10-24', 1_090, 1_000)];
    const points = wealthPoints(history, { now, days: 2 });
    expect(points.map((p) => [p.value, p.bankAssumed, p.change])).toEqual([
      [1_080, true, null],
      [1_090, false, 10],
    ]);
  });
});

describe('summarizeWealth', () => {
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
