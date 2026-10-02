import { describe, expect, it } from 'vitest';
import { classifyStep, trailSteps, type TrailTile } from './trail';

const T0 = Date.parse('2026-10-02T12:00:00Z');
const at = (ms: number, x: number, y: number, onBoat = false): TrailTile => ({
  ts: new Date(T0 + ms),
  x,
  y,
  onBoat,
});

describe('classifyStep', () => {
  it('is a move within what can be run in the time between the points', () => {
    expect(classifyStep(at(0, 3200, 3200), at(600, 3202, 3202))).toBe('move');
    // Lag: several tiles at once.
    expect(classifyStep(at(0, 3200, 3200), at(600, 3208, 3200))).toBe('move');
    // A minute sample of an older plugin: 100 ticks of running.
    expect(classifyStep(at(0, 3200, 3200), at(60_000, 3400, 3200))).toBe('move');
    // Two points of one tick (the closing point, a millisecond later).
    expect(classifyStep(at(0, 3200, 3200), at(1, 3201, 3200))).toBe('move');
  });

  it('is a teleport beyond that', () => {
    expect(classifyStep(at(0, 3200, 3200), at(600, 3209, 3200))).toBe('teleport');
    expect(classifyStep(at(0, 3222, 3218), at(2400, 2757, 3478))).toBe('teleport');
    expect(classifyStep(at(0, 3200, 3200), at(60_000, 3407, 3200))).toBe('teleport');
  });

  it('allows a boat twice the speed, when both points are on one', () => {
    const far = [3000 + 4 * 10 + 6, 3000] as const;
    expect(classifyStep(at(0, 3000, 3000, true), at(6000, ...far, true))).toBe('move');
    expect(classifyStep(at(0, 3000, 3000), at(6000, ...far, true))).toBe('teleport');
    expect(classifyStep(at(0, 3000, 3000, true), at(6000, ...far))).toBe('teleport');
  });

  it('is an entrance when the points are within reach once the underground is shifted back', () => {
    expect(classifyStep(at(0, 3097, 3468), at(1200, 3096, 9867))).toBe('entrance');
    expect(classifyStep(at(0, 3096, 9867), at(1200, 3097, 3468))).toBe('entrance');
    // Underground somewhere else entirely.
    expect(classifyStep(at(0, 3097, 3468), at(1200, 2800, 9867))).toBe('teleport');
  });

  it('is a house step between two rooms of a player-owned house', () => {
    expect(classifyStep(at(0, 1860, 7040), at(600, 2100, 7110))).toBe('house');
    // Inside one room.
    expect(classifyStep(at(0, 1860, 7040), at(600, 1861, 7041))).toBe('move');
    // Into and out of the house.
    expect(classifyStep(at(0, 2954, 3224), at(3000, 1900, 7100))).toBe('teleport');
    expect(classifyStep(at(0, 1900, 7100), at(3000, 2954, 3224))).toBe('teleport');
    // The corners are in, one tile further is not.
    expect(classifyStep(at(0, 1852, 7036), at(600, 2115, 7116))).toBe('house');
    expect(classifyStep(at(0, 1851, 7036), at(600, 2115, 7116))).toBe('teleport');
    expect(classifyStep(at(0, 1852, 7036), at(600, 2115, 7117))).toBe('teleport');
  });

  it('is a gap after more than five minutes, wherever the points are', () => {
    expect(classifyStep(at(0, 3200, 3200), at(300_000, 3200, 3200))).toBe('move');
    expect(classifyStep(at(0, 3200, 3200), at(300_001, 3200, 3200))).toBe('gap');
    expect(classifyStep(at(0, 3200, 3200), at(3_600_000, 1200, 3200))).toBe('gap');
  });
});

describe('trailSteps', () => {
  const trail = [at(0, 3200, 3200), at(600, 3202, 3200), at(3000, 2757, 3478)];

  it('gives the step that led to each point, and null for the first', () => {
    expect(trailSteps(trail)).toEqual([null, 'move', 'teleport']);
    expect(trailSteps([])).toEqual([]);
  });

  it('judges the first point from the one before the trail', () => {
    expect(trailSteps(trail, at(-600, 3198, 3200))).toEqual(['move', 'move', 'teleport']);
  });
});
