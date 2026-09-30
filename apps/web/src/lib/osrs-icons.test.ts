// Mirrors the osrs-icons reference client's tests (test/client.test.mjs there).
import { describe, expect, it } from 'vitest';
import {
  eventIconUrl,
  iconsBase,
  itemIconUrl,
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
});

describe('iconsBase', () => {
  it('strips trailing slashes and whitespace, turns icons off when empty', () => {
    expect(iconsBase('https://icons.example/')).toBe(base);
    expect(iconsBase(' https://icons.example// ')).toBe(base);
    expect(iconsBase('')).toBeNull();
    expect(iconsBase('   ')).toBeNull();
    expect(iconsBase(undefined)).toBe('https://icons.scapekeeper.com');
    expect(iconsBase(null)).toBe('https://icons.scapekeeper.com');
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
    expect(itemIconUrl(iconsBase(''), stacks, 4151)).toBeNull();
    expect(itemIconUrl(base, stacks, -1)).toBeNull();
    expect(itemIconUrl(base, stacks, null)).toBeNull();
    expect(itemIconUrl(base, stacks, 1.5)).toBeNull();
  });

  it('builds skill URLs, and none for Overall', () => {
    expect(skillIconUrl(base, 'Attack')).toBe(`${base}/skills/attack.png`);
    expect(skillIconUrl(base, 'sailing')).toBe(`${base}/skills/sailing.png`);
    expect(skillIconUrl(base, 'Overall')).toBeNull();
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
});
