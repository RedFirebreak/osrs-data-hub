import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_SKILLS,
  MAX_REAL_LEVEL,
  OVERALL,
  SKILL_GRID_ORDER,
  overallXp,
  realLevel,
  sortSkillsForDisplay,
  totalLevel,
} from './skills';

type Skills = Record<string, { xp: number; level: number }>;
const fixtureSkills = () =>
  fixtureJson<{ player: { stats: { skills: Skills } } }>('snapshot-normal').player.stats.skills;

describe('realLevel', () => {
  it('caps virtual levels at 99', () => {
    expect(realLevel(1)).toBe(1);
    expect(realLevel(98)).toBe(98);
    expect(realLevel(99)).toBe(99);
    expect(realLevel(100)).toBe(MAX_REAL_LEVEL);
    expect(realLevel(126)).toBe(99);
    expect(realLevel(127)).toBe(99);
  });
});

describe('totalLevel', () => {
  it('sums real levels, not the virtual ones the plugin sends', () => {
    // Critic C9: the fixture's level field sums to 2459, the real total is 2372.
    const skills = fixtureSkills();
    expect(Object.values(skills).reduce((s, v) => s + v.level, 0)).toBe(2459);
    expect(totalLevel(skills)).toBe(2372);
  });

  it('ignores an Overall entry', () => {
    expect(totalLevel({ Attack: { level: 50 }, [OVERALL]: { level: 2000 } })).toBe(50);
  });

  it('is 0 for no skills', () => {
    expect(totalLevel({})).toBe(0);
  });

  it('counts unknown (new) skills too', () => {
    expect(totalLevel({ Attack: { level: 120 }, Necromancy: { level: 10 } })).toBe(109);
  });
});

describe('overallXp', () => {
  it('sums xp over the skills', () => {
    const skills = fixtureSkills();
    const expected = Object.values(skills).reduce((s, v) => s + v.xp, 0);
    expect(overallXp(skills)).toBe(expected);
  });

  it('excludes an Overall entry', () => {
    expect(overallXp({ Attack: { xp: 100 }, Defence: { xp: 50 }, [OVERALL]: { xp: 999 } })).toBe(150);
  });

  it('goes beyond 2^31 without overflow (24 × 200M)', () => {
    const maxed = Object.fromEntries(KNOWN_SKILLS.map((s) => [s, { xp: 200_000_000 }]));
    expect(overallXp(maxed)).toBe(4_800_000_000);
  });

  it('is 0 for no skills', () => {
    expect(overallXp({})).toBe(0);
  });
});

describe('sortSkillsForDisplay', () => {
  it('puts Overall first and follows the skill-tab grid', () => {
    const shuffled = [...KNOWN_SKILLS].reverse();
    expect(sortSkillsForDisplay([...shuffled, OVERALL])).toEqual([OVERALL, ...SKILL_GRID_ORDER]);
  });

  it('puts unknown skills last, alphabetically', () => {
    expect(sortSkillsForDisplay(['Zeta', 'Attack', 'Alpha', OVERALL, 'Sailing'])).toEqual([
      OVERALL,
      'Attack',
      'Sailing',
      'Alpha',
      'Zeta',
    ]);
  });

  it('does not mutate its input and keeps duplicates', () => {
    const input = ['Magic', 'Attack', 'Magic'];
    const copy = [...input];
    expect(sortSkillsForDisplay(input)).toEqual(['Attack', 'Magic', 'Magic']);
    expect(input).toEqual(copy);
  });

  it('handles an empty list', () => {
    expect(sortSkillsForDisplay([])).toEqual([]);
  });

  it('lists the same skills in both orders', () => {
    expect([...SKILL_GRID_ORDER].sort()).toEqual([...KNOWN_SKILLS].sort());
  });
});
