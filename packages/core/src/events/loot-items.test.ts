import { describe, expect, it } from 'vitest';
import { MAX_LOOT_ITEMS, lootItemRows } from './loot-items';

const stored = (items: unknown) => ({ type: 'loot', data: { items }, eventId: 'e', timestamp: 0 });

describe('lootItemRows', () => {
  it('lists every item of a drop, lower-cased, with its position', () => {
    expect(
      lootItemRows(
        'loot',
        stored([
          { name: 'Big bones', id: 532, quantity: 1 },
          { name: ' Armadyl chestplate ', id: 11828, quantity: 1, gePrice: 35_236_970 },
        ]),
      ),
    ).toEqual([
      { idx: 0, itemId: 532, name: 'big bones', quantity: 1 },
      { idx: 1, itemId: 11828, name: 'armadyl chestplate', quantity: 1 },
    ]);
  });

  it('skips entries without a name and keeps positions', () => {
    expect(
      lootItemRows(
        'pk_loot',
        stored([{ id: 1 }, 'x', { name: '  ' }, { name: 'Rune dart', id: -1, quantity: 1.5 }]),
      ),
    ).toEqual([{ idx: 3, itemId: null, name: 'rune dart', quantity: null }]);
  });

  it('caps the items and cuts long names', () => {
    const many = Array.from({ length: 70 }, () => ({ name: 'x'.repeat(150), id: 1, quantity: 1 }));
    const rows = lootItemRows('loot', stored(many));
    expect(rows).toHaveLength(MAX_LOOT_ITEMS);
    expect(rows[0]!.name).toHaveLength(100);
  });

  it('is empty for other types and shapes', () => {
    expect(lootItemRows('death', stored([{ name: 'Shark' }]))).toEqual([]);
    expect(lootItemRows('loot', stored('nope'))).toEqual([]);
    expect(lootItemRows('loot', null)).toEqual([]);
  });
});
