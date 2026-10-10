/**
 * The OSRS level curve, for Metrics' "time to next level" and goals (D-109). Pure.
 *
 *   xpForLevel(L) = ⌊ Σ_{n=1}^{L−1} ⌊n + 300 · 2^(n/7)⌋ / 4 ⌋
 *
 * which gives 83 XP for level 2, 13,034,431 for 99 and 188,884,740 for 126 (the last virtual level).
 * XP is capped at 200M per skill. The level of an XP amount is @hub/core levelForXp (hiscores.ts).
 */
import { levelForXp } from '../hiscores';

/** The highest virtual level (the game shows 99; the hub's skills table shows the virtual one, D-44). */
export const MAX_VIRTUAL_LEVEL = 126;
/** No skill goes past this. */
export const MAX_SKILL_XP = 200_000_000;

const XP_TABLE: readonly number[] = (() => {
  const table = [0, 0]; // index = level; level 1 starts at 0
  let points = 0;
  for (let level = 1; level < MAX_VIRTUAL_LEVEL; level++) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

/** The XP a level starts at (1 → 0, 99 → 13,034,431); levels outside 1…126 are clamped. */
export function xpForLevel(level: number): number {
  const l = Math.min(MAX_VIRTUAL_LEVEL, Math.max(1, Math.floor(level)));
  return XP_TABLE[l]!;
}

export interface LevelProgress {
  /** The current virtual level. */
  level: number;
  /** XP where this level started. */
  from: number;
  /** XP of the next level, or 200M past the last virtual level; null once at 200M. */
  to: number | null;
  /** 0…1 of the way from `from` to `to` (1 at 200M). */
  share: number;
}

/** Where `xp` stands between its level and the next one. */
export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp);
  const from = xpForLevel(level);
  const to =
    xp >= MAX_SKILL_XP ? null : level >= MAX_VIRTUAL_LEVEL ? MAX_SKILL_XP : xpForLevel(level + 1);
  const share = to === null ? 1 : Math.min(1, Math.max(0, (xp - from) / (to - from)));
  return { level, from, to, share };
}

/**
 * How long reaching `remaining` more takes at `perHour`, in milliseconds: 0 when nothing remains,
 * null when there is no pace (0 or less, or not a number).
 */
export function etaMs(remaining: number, perHour: number): number | null {
  if (!(remaining > 0)) return 0;
  if (!Number.isFinite(perHour) || perHour <= 0) return null;
  return (remaining / perHour) * 3_600_000;
}
