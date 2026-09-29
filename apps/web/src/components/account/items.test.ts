import type { ItemData } from '@hub/core';
import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_GRID,
  equipmentBySlot,
  equipmentDiff,
  extraSlots,
  inventorySlots,
  itemName,
  meterFill,
  mergeStacks,
  sessionEndLabel,
  slotLabel,
  spellbookLabel,
  stackLabel,
} from './items';

const shark: ItemData = { id: 385, name: 'Shark', gePrice: 900, quantity: 1 };
const coins: ItemData = { id: 995, name: 'Coins', gePrice: 1, quantity: 250_000 };
const brew: ItemData = { id: 6685, name: 'Saradomin brew(4)', gePrice: 6_000, quantity: 1 };

describe('mergeStacks (inventory merged for display)', () => {
  it('merges one-entry-per-slot items by id, summing quantity, slots and value (PLUGIN-11)', () => {
    const stacks = mergeStacks([shark, shark, brew, shark, coins, shark, shark]);
    expect(stacks).toEqual([
      { id: 995, name: 'Coins', quantity: 250_000, slots: 1, value: 250_000 },
      { id: 6685, name: 'Saradomin brew(4)', quantity: 1, slots: 1, value: 6_000 },
      { id: 385, name: 'Shark', quantity: 5, slots: 5, value: 4_500 },
    ]);
  });

  it('orders equal values by name and survives missing names and odd numbers', () => {
    const stacks = mergeStacks([
      { id: 2, gePrice: 0, quantity: 1 },
      { id: 1, name: 'Bones', gePrice: 0, quantity: 1 },
      { id: 3, name: 'Junk', gePrice: Number.NaN, quantity: 2 },
      { id: 2, name: 'Ashes', gePrice: 0, quantity: 1 },
    ]);
    expect(stacks.map((s) => [s.name, s.quantity, s.value])).toEqual([
      ['Ashes', 2, 0],
      ['Bones', 1, 0],
      ['Junk', 2, 0],
    ]);
  });
});

describe('inventorySlots', () => {
  it('without slots (plugin before 1.5.1): pads to 28 in the order sent, never exceeds 28', () => {
    const slots = inventorySlots([shark, coins]);
    expect(slots).toHaveLength(28);
    expect(slots.slice(0, 3)).toEqual([shark, coins, null]);
    expect(inventorySlots(Array.from({ length: 30 }, () => shark))).toHaveLength(28);
  });

  it('places items at their inventorySlot, leaving gaps where the game has them', () => {
    const first = { ...coins, inventorySlot: 0 };
    const middle = { ...shark, inventorySlot: 13 };
    const last = { ...brew, inventorySlot: 27 };
    const slots = inventorySlots([last, first, middle]);
    expect(slots).toHaveLength(28);
    expect(slots[0]).toBe(first);
    expect(slots[13]).toBe(middle);
    expect(slots[27]).toBe(last);
    expect(slots.filter((s) => s !== null)).toHaveLength(3);
  });

  it('fills the first free slots with items whose slot is missing, out of range or taken', () => {
    const placed = { ...coins, inventorySlot: 0 };
    const taken = { ...brew, inventorySlot: 0 };
    const outOfRange = { ...shark, inventorySlot: 28 };
    const slots = inventorySlots([placed, shark, taken, outOfRange]);
    expect(slots.slice(0, 5)).toEqual([placed, shark, taken, outOfRange, null]);
  });

  it('never exceeds 28 when slotted items take every slot', () => {
    const full = Array.from({ length: 28 }, (_, i) => ({ ...shark, inventorySlot: i }));
    const slots = inventorySlots([...full, coins]);
    expect(slots).toEqual(full);
  });
});

describe('equipment', () => {
  const whip: ItemData = {
    id: 4151,
    name: 'Abyssal whip',
    gePrice: 1,
    quantity: 1,
    equipmentSlot: 'WEAPON',
  };
  const scim: ItemData = {
    id: 4587,
    name: 'Dragon scimitar',
    gePrice: 1,
    quantity: 1,
    equipmentSlot: 'WEAPON',
  };
  const helm: ItemData = {
    id: 10828,
    name: 'Helm of neitiznot',
    gePrice: 1,
    quantity: 1,
    equipmentSlot: 'HEAD',
  };
  const arrows = (quantity: number): ItemData => ({
    id: 11212,
    name: 'Dragon arrow',
    gePrice: 1,
    quantity,
    equipmentSlot: 'AMMO',
  });

  it('keys worn items by slot and finds slots the grid does not place', () => {
    const quiver: ItemData = { id: 1, gePrice: 0, quantity: 1, equipmentSlot: 'QUIVER' };
    const bySlot = equipmentBySlot([whip, helm, quiver, { id: 9, gePrice: 0, quantity: 1 }]);
    expect([...bySlot.keys()].sort()).toEqual(['HEAD', 'QUIVER', 'WEAPON']);
    expect(extraSlots(bySlot)).toEqual(['QUIVER']);
    expect(EQUIPMENT_GRID.flat().filter(Boolean)).toHaveLength(11);
  });

  it('diffs two sets by slot: swapped, put on, taken off and ammo counts', () => {
    expect(equipmentDiff([scim, helm, arrows(100)], [whip, arrows(80)])).toEqual([
      { slot: 'HEAD', before: helm, after: null },
      { slot: 'AMMO', before: arrows(100), after: arrows(80) },
      { slot: 'WEAPON', before: scim, after: whip },
    ]);
    expect(equipmentDiff([whip], [whip])).toEqual([]);
  });

  it('lists the whole set as put on when there is nothing older', () => {
    expect(equipmentDiff(null, [whip, helm]).map((d) => [d.slot, d.before, d.after?.id])).toEqual([
      ['HEAD', null, 10828],
      ['WEAPON', null, 4151],
    ]);
  });

  it('labels slots the way the game does', () => {
    expect(slotLabel('AMULET')).toBe('Neck');
    expect(slotLabel('GLOVES')).toBe('Hands');
    expect(slotLabel('NEW_SLOT')).toBe('New slot');
  });
});

describe('small labels', () => {
  it('names items, falling back to the id', () => {
    expect(itemName(shark)).toBe('Shark');
    expect(itemName({ id: 42, name: '  ' })).toBe('Item #42');
  });

  it('writes stacks the in-game way', () => {
    expect(stackLabel(99_999)).toBe('99999');
    expect(stackLabel(100_000)).toBe('100K');
    expect(stackLabel(12_345_678)).toBe('12M');
  });

  it('capitalises spellbooks and session end reasons', () => {
    expect(spellbookLabel('lunar')).toBe('Lunar');
    expect(sessionEndLabel('shutdown')).toBe('Client closed');
    expect(sessionEndLabel(null)).toBe('In progress');
  });
});

describe('meterFill', () => {
  it('fills proportionally and clamps a boosted value to a full bar', () => {
    expect(meterFill(50, 99)).toEqual({ percent: 50.5, boost: 0 });
    expect(meterFill(99, 99)).toEqual({ percent: 100, boost: 0 });
    expect(meterFill(115, 99)).toEqual({ percent: 100, boost: 16 });
  });

  it('never goes negative or divides by zero', () => {
    expect(meterFill(-5, 99)).toEqual({ percent: 0, boost: 0 });
    expect(meterFill(10, 0)).toEqual({ percent: 100, boost: 0 });
    expect(meterFill(0, 0)).toEqual({ percent: 0, boost: 0 });
  });
});
