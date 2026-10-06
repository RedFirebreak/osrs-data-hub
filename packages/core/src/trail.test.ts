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
  it('is a move within what can be run in one tick', () => {
    expect(classifyStep(at(0, 3200, 3200), at(600, 3202, 3202))).toBe('move');
    // Lag: several tiles at once.
    expect(classifyStep(at(0, 3200, 3200), at(600, 3208, 3200))).toBe('move');
    // Two points of one tick (the closing point, a millisecond later).
    expect(classifyStep(at(0, 3200, 3200), at(1, 3201, 3200))).toBe('move');
  });

  it('is a teleport beyond that', () => {
    expect(classifyStep(at(0, 3200, 3200), at(600, 3209, 3200))).toBe('teleport');
    expect(classifyStep(at(0, 3222, 3218), at(2400, 2757, 3478))).toBe('teleport');
  });

  it('gives a point of plugin 1.6 one tick of reach, however long the player stood before it', () => {
    // 40 s on one tile, then 110 tiles away.
    expect(classifyStep(at(0, 3200, 3200), at(40_000, 3310, 3200))).toBe('teleport');
    // After the point a standing player keeps each minute, which has the plugin's own time.
    expect(classifyStep(at(60_651, 2600, 3300), at(111_092, 2750, 3300))).toBe('teleport');
    expect(classifyStep(at(0, 3200, 3200), at(40_000, 3209, 3200))).toBe('teleport');
    // Walking on after standing, and standing.
    expect(classifyStep(at(0, 3200, 3200), at(40_000, 3208, 3200))).toBe('move');
    expect(classifyStep(at(0, 3200, 3200), at(60_651, 3200, 3200))).toBe('move');
  });

  it('gives a minute sample of an older plugin the time since the point before', () => {
    // Dated on the whole minute: 100 ticks of running.
    expect(classifyStep(at(0, 3200, 3200), at(60_000, 3400, 3200))).toBe('move');
    expect(classifyStep(at(0, 3200, 3200), at(60_000, 3407, 3200))).toBe('teleport');
    expect(classifyStep(at(0, 3200, 3200), at(120_000, 3600, 3200))).toBe('move');
    // The first sample after a tile of plugin 1.6.
    expect(classifyStep(at(40_000, 3200, 3200), at(60_000, 3240, 3200))).toBe('move');
    expect(classifyStep(at(40_000, 3200, 3200), at(60_000, 3275, 3200))).toBe('teleport');
  });

  it('allows a boat twice the speed, when both points are on one', () => {
    expect(classifyStep(at(0, 3000, 3000, true), at(600, 3010, 3000, true))).toBe('move');
    expect(classifyStep(at(0, 3000, 3000, true), at(600, 3011, 3000, true))).toBe('teleport');
    expect(classifyStep(at(0, 3000, 3000), at(600, 3010, 3000, true))).toBe('teleport');
    expect(classifyStep(at(0, 3000, 3000, true), at(600, 3010, 3000))).toBe('teleport');
    // A minute sample on a boat: 100 ticks of sailing.
    expect(classifyStep(at(0, 3000, 3000, true), at(60_000, 3406, 3000, true))).toBe('move');
    expect(classifyStep(at(0, 3000, 3000, true), at(60_000, 3407, 3000, true))).toBe('teleport');
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

  it('is an instance step between two rooms of one instance built from copied rooms', () => {
    // The Gauntlet, the Corrupted Gauntlet and the Chambers of Xeric.
    expect(classifyStep(at(0, 1860, 5640), at(600, 1910, 5690))).toBe('instance');
    expect(classifyStep(at(0, 1930, 5640), at(600, 1975, 5690))).toBe('instance');
    expect(classifyStep(at(0, 3270, 5200), at(600, 3340, 5450))).toBe('instance');
    expect(classifyStep(at(0, 3210, 5700), at(600, 3300, 5130))).toBe('instance');
    // Inside one room.
    expect(classifyStep(at(0, 1860, 5640), at(600, 1861, 5641))).toBe('move');
    // Into and out of the instance.
    expect(classifyStep(at(0, 3030, 6120), at(3000, 1900, 5650))).toBe('teleport');
    expect(classifyStep(at(0, 1900, 5650), at(3000, 3030, 6120))).toBe('teleport');
    // From one instance to another.
    expect(classifyStep(at(0, 1860, 5640), at(600, 1930, 5640))).toBe('teleport');
    expect(classifyStep(at(0, 1860, 5640), at(600, 3270, 5200))).toBe('teleport');
    // The corners are in, one tile further is not.
    expect(classifyStep(at(0, 1856, 5632), at(600, 1919, 5695))).toBe('instance');
    expect(classifyStep(at(0, 1855, 5632), at(600, 1919, 5695))).toBe('teleport');
    expect(classifyStep(at(0, 1856, 5632), at(600, 1919, 5696))).toBe('teleport');
    // Between the regions of the Chambers of Xeric lies one that isn't theirs.
    expect(classifyStep(at(0, 3270, 5200), at(600, 3270, 5510))).toBe('teleport');
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
