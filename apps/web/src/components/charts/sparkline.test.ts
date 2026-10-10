import { describe, expect, it } from 'vitest';
import { sparklinePoints } from './sparkline';

describe('sparklinePoints', () => {
  it('scales the series into the box, low values at the bottom', () => {
    expect(
      sparklinePoints([
        [0, 0],
        [50, 100],
        [100, 200],
      ]),
    ).toBe('0,30 50,16 100,2');
  });

  it('draws a flat series as a line along the bottom, and nothing for a single point', () => {
    expect(
      sparklinePoints([
        [0, 5],
        [10, 5],
      ]),
    ).toBe('0,30 100,30');
    expect(sparklinePoints([[0, 5]])).toBe('');
    expect(sparklinePoints([])).toBe('');
  });
});
