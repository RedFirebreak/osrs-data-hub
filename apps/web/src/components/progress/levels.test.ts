import { xpForLevel } from '@hub/core';
import { describe, expect, it } from 'vitest';
import { levelsGained, totalLevelsGained } from './levels';

describe('levels gained', () => {
  it('counts the levels crossed by the XP gained', () => {
    // From the start of 50 to the start of 53.
    expect(levelsGained(xpForLevel(53), xpForLevel(53) - xpForLevel(50))).toBe(3);
    // One XP short of the next level is no level.
    expect(levelsGained(xpForLevel(51) - 1, 10)).toBe(0);
    expect(levelsGained(xpForLevel(51), 1)).toBe(1);
  });

  it('counts nothing past 99, and nothing without a gain', () => {
    expect(levelsGained(xpForLevel(105), xpForLevel(105) - xpForLevel(98))).toBe(1);
    expect(levelsGained(xpForLevel(110), 5_000_000)).toBe(0);
    expect(levelsGained(1_000, 0)).toBe(0);
    // More gained than there is (a first reading): from level 1.
    expect(levelsGained(xpForLevel(10), 999_999)).toBe(9);
  });

  it('adds the skills up and leaves Overall out', () => {
    expect(
      totalLevelsGained([
        { skill: 'Overall', xp: 5_000_000, gained: 4_000_000 },
        { skill: 'Attack', xp: xpForLevel(60), gained: xpForLevel(60) - xpForLevel(58) },
        { skill: 'Magic', xp: xpForLevel(2), gained: 83 },
        { skill: 'Cooking', xp: 500, gained: 0 },
      ]),
    ).toBe(3);
  });
});
