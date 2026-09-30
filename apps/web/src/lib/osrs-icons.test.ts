// Mirrors the osrs-icons reference client's tests (test/client.test.mjs there).
import { describe, expect, it } from 'vitest';
import {
  eventIconUrl,
  eventItemQuantity,
  itemIconUrl,
  parseStacks,
  skillIconUrl,
  slotIconUrl,
  stackedItemId,
  type IconStacks,
} from './osrs-icons';

const stacks: IconStacks = {
  995: [
    [2, 996],
    [3, 997],
    [4, 998],
    [5, 999],
    [25, 1000],
    [100, 1001],
    [250, 1002],
    [1000, 1003],
    [10000, 1004],
  ],
};
const base = 'https://icons.example';

describe('stackedItemId', () => {
  it('follows the highest breakpoint at or below the quantity', () => {
    expect(stackedItemId(stacks, 995, 1)).toBe(995);
    expect(stackedItemId(stacks, 995, 2)).toBe(996);
    expect(stackedItemId(stacks, 995, 24)).toBe(999);
    expect(stackedItemId(stacks, 995, 9999)).toBe(1003);
    expect(stackedItemId(stacks, 995, 10000)).toBe(1004);
    expect(stackedItemId(stacks, 995, 2_147_483_647)).toBe(1004);
  });

  it('keeps an id without a stack table, and copes with no tables at all', () => {
    expect(stackedItemId(stacks, 4151, 5)).toBe(4151);
    expect(stackedItemId({}, 995, 5)).toBe(995);
    expect(stackedItemId(null, 995, 5)).toBe(995);
  });

  it('does not depend on the rows being sorted', () => {
    const unsorted: IconStacks = {
      995: [
        [10000, 1004],
        [2, 996],
        [250, 1002],
      ],
    };
    expect(stackedItemId(unsorted, 995, 1)).toBe(995);
    expect(stackedItemId(unsorted, 995, 300)).toBe(1002);
    expect(stackedItemId(unsorted, 995, 250_000)).toBe(1004);
  });
});

describe('parseStacks', () => {
  it('keeps well-formed tables and drops the rest', () => {
    expect(
      parseStacks({
        995: [
          [2, 996],
          [3, 'x'],
        ],
        abc: [[2, 3]],
        4151: 'nope',
        617: [],
      }),
    ).toEqual({ 995: [[2, 996]] });
    expect(parseStacks(null)).toEqual({});
    expect(parseStacks([1, 2])).toEqual({});
  });
});

describe('icon URLs', () => {
  it('builds item URLs from the stacked id', () => {
    expect(itemIconUrl(base, stacks, 995, 1)).toBe(`${base}/items/995.webp`);
    expect(itemIconUrl(base, stacks, 995, 100)).toBe(`${base}/items/1001.webp`);
    expect(itemIconUrl(base, stacks, 995, 10_000)).toBe(`${base}/items/1004.webp`);
    expect(itemIconUrl(base, stacks, 4152)).toBe(`${base}/items/4152.webp`);
  });

  it('has no item icon without a base or a valid id', () => {
    expect(itemIconUrl(null, stacks, 4151)).toBeNull();
    expect(itemIconUrl(base, stacks, -1)).toBeNull();
    expect(itemIconUrl(base, stacks, null)).toBeNull();
    expect(itemIconUrl(base, stacks, 1.5)).toBeNull();
  });

  it('builds skill URLs, and none for Overall or Combat', () => {
    expect(skillIconUrl(base, 'Attack')).toBe(`${base}/skills/attack.png`);
    expect(skillIconUrl(base, 'sailing')).toBe(`${base}/skills/sailing.png`);
    expect(skillIconUrl(base, 'Overall')).toBeNull();
    expect(skillIconUrl(base, 'Combat')).toBeNull();
    expect(skillIconUrl(base, '')).toBeNull();
    expect(skillIconUrl(null, 'Attack')).toBeNull();
  });

  it('builds empty-slot URLs from the RuneLite slot name', () => {
    expect(slotIconUrl(base, 'AMULET')).toBe(`${base}/slots/amulet.png`);
    expect(slotIconUrl(base, 'GLOVES')).toBe(`${base}/slots/gloves.png`);
    expect(slotIconUrl(null, 'HEAD')).toBeNull();
    expect(slotIconUrl(base, '')).toBeNull();
  });
});

describe('eventIconUrl', () => {
  it('prefers the item, then the skill, else no icon', () => {
    expect(eventIconUrl(base, stacks, { itemId: 4151, skill: null })).toBe(
      `${base}/items/4151.webp`,
    );
    expect(eventIconUrl(base, stacks, { itemId: 4151, skill: 'Attack' })).toBe(
      `${base}/items/4151.webp`,
    );
    expect(eventIconUrl(base, stacks, { itemId: null, skill: 'Slayer' })).toBe(
      `${base}/skills/slayer.png`,
    );
    expect(eventIconUrl(base, stacks, { itemId: null, skill: null })).toBeNull();
    expect(eventIconUrl(null, stacks, { itemId: 4151, skill: 'Attack' })).toBeNull();
  });

  it("shows a loot drop's stack at its quantity", () => {
    const loot = (quantity: unknown, id = 995) => ({
      itemId: 995,
      skill: null,
      data: { data: { highestValueItem: { id, name: 'Coins', quantity } } },
    });
    expect(eventIconUrl(base, stacks, loot(50_000))).toBe(`${base}/items/1004.webp`);
    expect(eventItemQuantity(loot(250))).toBe(250);
    // Anything odd, or a highestValueItem that isn't the event's item, counts as one.
    expect(eventItemQuantity(loot('many'))).toBe(1);
    expect(eventItemQuantity(loot(0))).toBe(1);
    expect(eventItemQuantity(loot(250, 4151))).toBe(1);
    expect(eventItemQuantity({ itemId: 995, skill: null })).toBe(1);
  });
});
