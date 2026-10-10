/**
 * Levels gained over a period, from the XP now and the XP gained: the game's own levels, so nothing
 * past 99 counts (PLUGIN-9). Pure and client-safe.
 */
import { OVERALL, levelForXp, realLevel } from '@hub/core';

/** Real levels a skill gained by earning `gained` XP up to `xp`. */
export function levelsGained(xp: number, gained: number): number {
  if (!(gained > 0)) return 0;
  return realLevel(levelForXp(xp)) - realLevel(levelForXp(Math.max(0, xp - gained)));
}

/** Real levels gained over all skills (Overall itself is a sum, not a skill). */
export function totalLevelsGained(
  skills: readonly { skill: string; xp: number; gained: number }[],
): number {
  let total = 0;
  for (const s of skills) if (s.skill !== OVERALL) total += levelsGained(s.xp, s.gained);
  return total;
}
