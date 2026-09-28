export const OVERALL = 'Overall';

/** RuneLite Skill.values() order (the plugin's send order). Not authoritative: new skills can appear. */
// prettier-ignore
export const KNOWN_SKILLS = [
  'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking',
  'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining',
  'Herblore', 'Agility', 'Thieving', 'Slayer', 'Farming', 'Runecraft', 'Hunter', 'Construction',
  'Sailing',
] as const;

/** In-game skill-tab grid order (3 columns), for display. Unknown skills go last. */
// prettier-ignore
export const SKILL_GRID_ORDER = [
  'Attack', 'Hitpoints', 'Mining', 'Strength', 'Agility', 'Smithing', 'Defence', 'Herblore',
  'Fishing', 'Ranged', 'Thieving', 'Cooking', 'Prayer', 'Crafting', 'Firemaking', 'Magic',
  'Fletching', 'Woodcutting', 'Runecraft', 'Slayer', 'Farming', 'Construction', 'Hunter',
  'Sailing',
] as const;

export const MAX_REAL_LEVEL = 99;

/** Real level from a (possibly virtual) level: min(level, 99). */
export function realLevel(level: number): number {
  return Math.min(level, MAX_REAL_LEVEL);
}

/** Total level = Σ min(level, 99) over the given skills (never includes Overall). */
export function totalLevel(skills: Record<string, { level: number }>): number {
  let total = 0;
  for (const [name, { level }] of Object.entries(skills)) {
    if (name !== OVERALL) total += realLevel(level);
  }
  return total;
}

/** Overall XP = Σ xp over the given skills (excluding an "Overall" key if present). */
export function overallXp(skills: Record<string, { xp: number }>): number {
  let total = 0;
  for (const [name, { xp }] of Object.entries(skills)) {
    if (name !== OVERALL) total += xp;
  }
  return total;
}

const GRID_RANK: ReadonlyMap<string, number> = new Map(
  SKILL_GRID_ORDER.map((name, i) => [name, i]),
);

/** Overall → -1, known skills → their grid index, unknown → Infinity (ties broken by name). */
function displayRank(name: string): number {
  if (name === OVERALL) return -1;
  return GRID_RANK.get(name) ?? Number.POSITIVE_INFINITY;
}

/** Sorts skill names by SKILL_GRID_ORDER, unknown names last alphabetically, "Overall" first. */
export function sortSkillsForDisplay(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const ra = displayRank(a);
    const rb = displayRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
