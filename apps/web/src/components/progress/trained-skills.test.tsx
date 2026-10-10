import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { skillTileLabel } from '@/components/account-page/skills-panel';
import { TrainedSkills, mostTrained } from './trained-skills';

const skills = [
  { skill: 'Overall', gained: 900, level: 1500 },
  { skill: 'Magic', gained: 300, level: 86 },
  { skill: 'Attack', gained: 600, level: 104 },
  { skill: 'Cooking', gained: 0, level: 70 },
  { skill: 'Agility', gained: 300, level: 71 },
];

describe('mostTrained', () => {
  it('keeps the skills with a gain, most first, without Overall', () => {
    expect(mostTrained(skills).map((s) => s.skill)).toEqual(['Attack', 'Agility', 'Magic']);
    expect(mostTrained(skills, 1).map((s) => s.skill)).toEqual(['Attack']);
  });
});

describe('TrainedSkills', () => {
  it("links each skill to its progress, with its gain and the game's level", () => {
    const html = renderToStaticMarkup(
      <TrainedSkills publicId="abc123def456" skills={skills} period="in the last 7 days" />,
    );
    expect(html).toContain('aria-label="Skills trained in the last 7 days"');
    expect(html).toContain('href="/progress/abc123def456/skills/attack"');
    expect(html).toContain('+600');
    // A virtual 104 is level 99 in the game.
    expect(html).toContain('level 99');
    expect(html).not.toContain('Cooking');
    // The most trained skill fills its bar; the others in proportion.
    expect(html).toContain('width:100%');
    expect(html).toContain('width:50%');
  });
});

describe('skillTileLabel', () => {
  const gains = { day: 0, week: 0, month: 0, year: 0 };

  it('says the level, the way to the next one and the week', () => {
    expect(
      skillTileLabel({
        skill: 'Magic',
        level: 2,
        realLevel: 2,
        xp: 83,
        gains: { ...gains, week: 1234 },
      }),
    ).toBe('Magic, level 2, 0% of the way to 3, 1,234 XP gained in 7 days');
  });

  it('names a virtual level, and 200M', () => {
    expect(
      skillTileLabel({ skill: 'Strength', level: 110, realLevel: 99, xp: 40_000_000, gains }),
    ).toBe('Strength, level 99, virtual level 110, 31% of the way to 111');
    expect(
      skillTileLabel({ skill: 'Slayer', level: 126, realLevel: 99, xp: 200_000_000, gains }),
    ).toBe('Slayer, level 99, virtual level 126, at 200M XP');
  });
});
