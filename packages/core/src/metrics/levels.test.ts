import { describe, expect, it } from 'vitest';
import { levelForXp } from '../hiscores';
import { MAX_SKILL_XP, etaMs, levelProgress, xpForLevel } from './levels';

describe('xpForLevel', () => {
  it('follows the game curve', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(83);
    expect(xpForLevel(92)).toBe(6_517_253);
    expect(xpForLevel(99)).toBe(13_034_431);
    expect(xpForLevel(126)).toBe(188_884_740);
  });

  it('clamps levels outside 1…126', () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(200)).toBe(188_884_740);
  });

  it('is the inverse of levelForXp at every level start', () => {
    for (let level = 1; level <= 126; level++) expect(levelForXp(xpForLevel(level))).toBe(level);
  });
});

describe('levelProgress', () => {
  it('says how far into the level an amount is', () => {
    const p = levelProgress(xpForLevel(98) + (xpForLevel(99) - xpForLevel(98)) / 2);
    expect(p.level).toBe(98);
    expect(p.to).toBe(13_034_431);
    expect(p.share).toBeCloseTo(0.5, 5);
  });

  it('runs to 200M past the last virtual level, and stops there', () => {
    expect(levelProgress(190_000_000)).toMatchObject({ level: 126, to: MAX_SKILL_XP });
    expect(levelProgress(MAX_SKILL_XP)).toMatchObject({ to: null, share: 1 });
  });
});

describe('etaMs', () => {
  it('divides what remains by the pace', () => {
    expect(etaMs(100_000, 50_000)).toBe(2 * 3_600_000);
  });

  it('is 0 when nothing remains and null without a pace', () => {
    expect(etaMs(0, 0)).toBe(0);
    expect(etaMs(-5, 10)).toBe(0);
    expect(etaMs(10, 0)).toBeNull();
    expect(etaMs(10, Number.NaN)).toBeNull();
  });
});
