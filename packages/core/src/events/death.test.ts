import { describe, expect, it } from 'vitest';

import { GRAVE_FEE_CAP, deathOutcome, graveFee, inWilderness } from './death';

const item = (gePrice: number, quantity = 1) => ({
  name: 'x',
  id: 1,
  gePrice,
  haPrice: 0,
  quantity,
});

describe('graveFee', () => {
  it('charges per item by its own value', () => {
    expect(graveFee([item(99_999, 100), item(1, 25_000)])).toBe(0);
    expect(graveFee([item(100_000)])).toBe(1_000);
    expect(graveFee([item(1_000_000, 2)])).toBe(20_000);
    expect(graveFee([item(10_000_000), item(250_000, 3)])).toBe(103_000);
  });

  it('is capped at 500K', () => {
    expect(graveFee(Array.from({ length: 12 }, () => item(50_000_000)))).toBe(GRAVE_FEE_CAP);
  });

  it('is null for anything that is not a list of items', () => {
    expect(graveFee(undefined)).toBeNull();
    expect(graveFee([{ gePrice: 1.5, quantity: 1 }])).toBeNull();
    expect(graveFee([])).toBe(0);
  });
});

describe('inWilderness', () => {
  it('knows the surface and the dungeons', () => {
    expect(inWilderness({ x: 3068, y: 3858, plane: 0 })).toBe(true);
    expect(inWilderness({ x: 3100, y: 3523, plane: 0 })).toBe(true);
    expect(inWilderness({ x: 3100, y: 3520, plane: 0 })).toBe(false); // Edgeville side of the ditch
    expect(inWilderness({ x: 3222, y: 3218, plane: 0 })).toBe(false); // Lumbridge
    expect(inWilderness({ x: 3040, y: 10300, plane: 0 })).toBe(true); // Revenant caves
    expect(inWilderness({ x: 2272, y: 4062, plane: 0 })).toBe(false); // Vorkath
    expect(inWilderness(undefined)).toBe(false);
  });
});

describe('deathOutcome', () => {
  it('safe and exceptional deaths lose nothing', () => {
    expect(deathOutcome({ danger: 'SAFE', valueLost: 5 }, 5)).toEqual({ kind: 'safe' });
    expect(deathOutcome({ danger: 'exceptional' }, null)).toEqual({ kind: 'safe' });
  });

  it('a player killer means the items are gone, wherever the location went', () => {
    expect(
      deathOutcome({ danger: 'DANGEROUS', killerName: 'Lynx Titan', valueLost: 9 }, null),
    ).toEqual({ kind: 'lost', value: 9 });
  });

  it('an NPC outside the Wilderness leaves a grave', () => {
    const d = {
      danger: 'DANGEROUS',
      killerName: 'Yama',
      killerNpcId: 14176,
      lostItems: [item(150_000_000)],
      location: { x: 1500, y: 10080, plane: 0 },
    };
    expect(deathOutcome(d, 150_000_000)).toEqual({ kind: 'grave', fee: 100_000 });
  });
});
