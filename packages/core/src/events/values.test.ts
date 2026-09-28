import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import { carriedValue, itemsValue } from './values';

interface Items {
  items: { gePrice: number; quantity: number }[];
}

describe('itemsValue', () => {
  it('sums gePrice × quantity', () => {
    expect(
      itemsValue([
        { id: 385, gePrice: 800, quantity: 5 },
        { id: 995, gePrice: 1, quantity: 25_000 },
      ]),
    ).toBe(29_000);
  });

  it('is 0 for an empty array and null for anything that is not an array', () => {
    expect(itemsValue([])).toBe(0);
    for (const v of [null, undefined, 0, 'items', {}, { items: [] }])
      expect(itemsValue(v)).toBeNull();
  });

  it('counts inventory entries per slot (4 sharks are 4 entries), as the plugin sends them', () => {
    const inv = fixtureJson<{ player: { inventory: Items } }>('snapshot-normal').player.inventory
      .items;
    expect(inv.filter((i) => i.gePrice === 1522)).toHaveLength(4);
    expect(itemsValue(inv)).toBe(18_502_335);
  });

  it('matches the plugin totals in the loot, pkLoot and death fixtures', () => {
    const loot = fixtureJson<{ events: { data: Items & { totalValue: number } }[] }>('event-loot')
      .events[0]!.data;
    expect(itemsValue(loot.items)).toBe(loot.totalValue);
    const pk = fixtureJson<{ events: { data: Items & { totalValue: number } }[] }>('event-pkloot')
      .events[0]!.data;
    expect(itemsValue(pk.items)).toBe(43_188);
    const death = fixtureJson<{ events: { data: { lostItems: unknown[]; valueLost: number } }[] }>(
      'event-death-dangerous',
    ).events[0]!.data;
    expect(itemsValue(death.lostItems)).toBe(death.valueLost);
  });

  it('computes in 64 bits: products beyond 2^31 are exact while they fit', () => {
    expect(itemsValue([{ gePrice: 1_000_000, quantity: 2_000_000 }])).toBe(2_000_000_000_000);
    expect(itemsValue([{ gePrice: 3_000_000_001, quantity: 3_000_001 }])).toBe(
      9_000_003_003_000_001,
    );
    // A long gePrice × an int stack beyond 2^53 is clamped, not rounded to a float.
    expect(itemsValue([{ gePrice: 2_000_000_000, quantity: 2_147_483_647 }])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('keeps an exact sum when a huge entry is offset by a negative one (BigInt, not floats)', () => {
    // 2^60 + 1 − 2^60: float arithmetic loses the 1 (2^60 + 1 rounds to 2^60); BigInt keeps it.
    const huge = 2 ** 60;
    const items = [
      { gePrice: huge, quantity: 1 },
      { gePrice: 1, quantity: 1 },
      { gePrice: -huge, quantity: 1 },
    ];
    expect(huge + 1 - huge).toBe(0);
    expect(itemsValue(items)).toBe(1);
  });

  it('clamps to [0, MAX_SAFE_INTEGER]', () => {
    expect(itemsValue([{ gePrice: Number.MAX_SAFE_INTEGER, quantity: 2 }])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(itemsValue([{ gePrice: 1e300, quantity: 1 }])).toBe(Number.MAX_SAFE_INTEGER);
    expect(itemsValue([{ gePrice: -500, quantity: 1 }])).toBe(0);
    // A negative entry still offsets the others before the clamp (the sum is clamped, not each entry).
    expect(
      itemsValue([
        { gePrice: 1000, quantity: 1 },
        { gePrice: -400, quantity: 1 },
      ]),
    ).toBe(600);
  });

  it('ignores entries that are not objects or lack finite integer gePrice/quantity', () => {
    expect(
      itemsValue([
        null,
        'Shark',
        42,
        [800, 5],
        { gePrice: '800', quantity: 5 },
        { gePrice: 800 },
        { quantity: 5 },
        { gePrice: Number.NaN, quantity: 1 },
        { gePrice: Number.POSITIVE_INFINITY, quantity: 1 },
        { gePrice: 1.5, quantity: 2 },
        { gePrice: 10, quantity: 0.5 },
        { gePrice: 10, quantity: 3 },
      ]),
    ).toBe(30);
  });

  it('never throws on hostile arrays', () => {
    const sparse: unknown[] = [];
    sparse[3] = { gePrice: 2, quantity: 2 };
    expect(itemsValue(sparse)).toBe(4);
    expect(itemsValue([Object.create(null) as object])).toBe(0);
  });
});

describe('carriedValue', () => {
  it('adds inventory and equipment (the snapshot fixture)', () => {
    const p = fixtureJson<{ player: { inventory: Items; equipment: Items } }>(
      'snapshot-normal',
    ).player;
    expect(carriedValue(p.inventory.items, p.equipment.items)).toBe(18_502_335 + 65_972_609);
  });

  it('counts a missing or invalid side as 0', () => {
    expect(carriedValue([{ gePrice: 5, quantity: 2 }], null)).toBe(10);
    expect(carriedValue(undefined, [{ gePrice: 5, quantity: 2 }])).toBe(10);
    expect(carriedValue('x', {})).toBe(0);
    expect(carriedValue([], [])).toBe(0);
  });

  it('clamps the sum to MAX_SAFE_INTEGER', () => {
    const big = [{ gePrice: Number.MAX_SAFE_INTEGER, quantity: 1 }];
    expect(carriedValue(big, big)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
