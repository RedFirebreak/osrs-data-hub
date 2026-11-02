/** Place names (D-138): the same answers as ha-osrs-map's regions.js, which this was ported from. */
import { describe, expect, it } from 'vitest';
import { regionId } from '../trail';
import { REGION_NAMES, REGION_NAMES_SOURCE, inInstanceSpace, regionName } from './index';

const names = new Map([
  [12850, 'Lumbridge'],
  [12598, 'Grand Exchange'],
]);
const name = (x: number, y: number) => regionName(x, y, names);

describe('regionName', () => {
  it('names a place, a neighbour, the Wilderness and instances', () => {
    expect(name(3222, 3218)).toBe('Lumbridge');
    expect(name(3222 + 64, 3218)).toBe('Near Lumbridge');
    expect(name(3100, 3530)).toBe('Wilderness (level 2)');
    expect(name(3100, 3960)).toBe('Wilderness (level 56)');
    expect(name(9000, 5000)).toBe('An instance');
    expect(name(1000, 1000)).toBeNull();
  });

  it('starts the Wilderness north of the ditch, and leaves the Ferox Enclave out', () => {
    expect(String(name(3100, 3521))).not.toMatch(/Wilderness/);
    expect(name(3100, 3523)).toBe('Wilderness (level 1)');
    expect(name(3137, 3623)).toBe('Ferox Enclave');
    expect(name(3160, 3623)).toBe('Wilderness (level 13)');
  });

  it('gives the Wilderness dungeons the level of the surface, and the lairs their own', () => {
    expect(name(3110, 9952)).toBe('Wilderness (level 5)');
    expect(String(name(3110, 9921))).not.toMatch(/Wilderness/);
    expect(name(3200, 10100)).toBe('Wilderness (level 23)');
    expect(name(3040, 10330)).toBe('Wilderness (level 52)');
    expect(name(3359, 10329)).toBe('Wilderness (level 40)'); // Callisto's Den
    expect(name(3360, 10270)).toBe('Wilderness (level 30-42)'); // Escape Caves
    expect(name(1632, 11550)).toBe('Wilderness (level 29)'); // Web Chasm
  });

  it('reads the names RuneLite gives', () => {
    expect(regionName(3222, 3218)).toBe('Lumbridge');
    expect(regionName(3164, 3487)).toBe('Grand Exchange');
    expect(REGION_NAMES.size).toBeGreaterThan(500);
    expect(REGION_NAMES_SOURCE).toMatch(/RuneLite.*BSD-2-Clause/);
  });
});

describe('inInstanceSpace', () => {
  it('starts at x 6400', () => {
    expect(inInstanceSpace(6399)).toBe(false);
    expect(inInstanceSpace(6400)).toBe(true);
    expect(regionId({ x: 3222, y: 3218 })).toBe(12850);
  });
});
