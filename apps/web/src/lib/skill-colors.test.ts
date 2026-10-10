import { KNOWN_SKILLS } from '@hub/core';
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_SKILL_COLOR,
  SKILL_COLORS,
  skillColor,
  skillColors,
  skillTint,
} from './skill-colors';

/** WCAG 2 relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// The surfaces a skill colour sits on (globals.css): the card and the muted tile, per theme.
const LIGHT_SURFACES = ['#ffffff', '#f5f5f5'];
const DARK_SURFACES = ['#171717', '#262626'];

describe('skill colours', () => {
  it('has a colour for every skill the hub knows', () => {
    expect(Object.keys(SKILL_COLORS).sort()).toEqual([...KNOWN_SKILLS].sort());
  });

  it('reads as text on every surface of its theme (4.5:1)', () => {
    for (const [skill, { light, dark }] of [
      ...Object.entries(SKILL_COLORS),
      ['neutral', NEUTRAL_SKILL_COLOR] as const,
    ]) {
      for (const surface of LIGHT_SURFACES) {
        expect(contrast(light, surface), `${skill} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of DARK_SURFACES) {
        expect(contrast(dark, surface), `${skill} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('finds a skill whatever its capitalisation, and is neutral for anything else', () => {
    expect(skillColors('firemaking')).toBe(SKILL_COLORS.Firemaking);
    expect(skillColors(' Firemaking ')).toBe(SKILL_COLORS.Firemaking);
    expect(skillColors('Overall')).toBe(NEUTRAL_SKILL_COLOR);
    expect(skillColors('Dungeoneering')).toBe(NEUTRAL_SKILL_COLOR);
    expect(skillColor('Firemaking', true)).toBe('#f08a24');
    expect(skillColor('Firemaking', false)).toBe('#a85a0b');
  });

  it('hands both theme values to the skill-tint class', () => {
    expect(skillTint('Magic')).toEqual({ '--skill-light': '#3662ed', '--skill-dark': '#698af1' });
  });
});
