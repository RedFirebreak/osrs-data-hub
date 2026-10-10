/**
 * Each skill's own colour: the one place the hub is not black and white. A bar, a chart line or a
 * gain number in a skill's colour says which skill it is before the label is read.
 *
 * Two values per skill, one per theme, each at least 4.5:1 against that theme's card and muted
 * surfaces (WCAG AA for text; skill-colors.test.ts checks every pair), so the colour may carry
 * small text as well as marks. Pure and client-safe.
 *
 *   <li className="skill-tint" style={skillTint('Firemaking')}>      // then `bg-(--skill)`
 *   skillColor('Firemaking', dark)                                    // a chart series
 */
import type { CSSProperties } from 'react';

export interface ThemedColor {
  light: string;
  dark: string;
}

// prettier-ignore
export const SKILL_COLORS: Readonly<Record<string, ThemedColor>> = {
  Attack:       { light: '#b5483a', dark: '#d0776c' },
  Hitpoints:    { light: '#d12e25', dark: '#e46b64' },
  Mining:       { light: '#3a7592', dark: '#7fb3cc' },
  Strength:     { light: '#247b5c', dark: '#2fa37a' },
  Agility:      { light: '#5265d1', dark: '#7a89db' },
  Smithing:     { light: '#726d5a', dark: '#9a947f' },
  Defence:      { light: '#3d68d0', dark: '#7f9be0' },
  Herblore:     { light: '#2f7b41', dark: '#3fa356' },
  Fishing:      { light: '#2271ab', dark: '#5aa6de' },
  Ranged:       { light: '#4c772f', dark: '#6fae45' },
  Thieving:     { light: '#9a51b0', dark: '#b27cc3' },
  Cooking:      { light: '#994cbd', dark: '#b379ce' },
  Prayer:       { light: '#786e38', dark: '#d9d2ae' },
  Crafting:     { light: '#8c683e', dark: '#b58a58' },
  Firemaking:   { light: '#a85a0b', dark: '#f08a24' },
  Magic:        { light: '#3662ed', dark: '#698af1' },
  Fletching:    { light: '#1d7a75', dark: '#27a39c' },
  Woodcutting:  { light: '#49793f', dark: '#5f9e52' },
  Runecraft:    { light: '#846b18', dark: '#dcb840' },
  Slayer:       { light: '#6d6d83', dark: '#a3a3b3' },
  Farming:      { light: '#407b37', dark: '#62b356' },
  Construction: { light: '#856a41', dark: '#bfa57c' },
  Hunter:       { light: '#7c6e49', dark: '#9f8d5e' },
  Sailing:      { light: '#207986', dark: '#2fb1c4' },
};

/** Overall, and a skill the game adds before this table knows it: the neutral text grey. */
export const NEUTRAL_SKILL_COLOR: ThemedColor = { light: '#525252', dark: '#a3a3a3' };

const BY_LOWERCASE: ReadonlyMap<string, ThemedColor> = new Map(
  Object.entries(SKILL_COLORS).map(([skill, color]) => [skill.toLowerCase(), color]),
);

/** The colour pair of a skill, whatever its capitalisation; neutral for anything unknown. */
export function skillColors(skill: string): ThemedColor {
  return BY_LOWERCASE.get(skill.trim().toLowerCase()) ?? NEUTRAL_SKILL_COLOR;
}

/** One theme's colour of a skill, for code that knows the theme (the charts). */
export function skillColor(skill: string, dark: boolean): string {
  const pair = skillColors(skill);
  return dark ? pair.dark : pair.light;
}

/**
 * Inline custom properties for an element with the `skill-tint` class (globals.css), which resolves
 * `--skill` to the current theme's value: server components can't know the theme.
 */
export function skillTint(skill: string): CSSProperties {
  const pair = skillColors(skill);
  return { '--skill-light': pair.light, '--skill-dark': pair.dark } as CSSProperties;
}
