/**
 * The prayers the plugin reports as on (`player.activePrayers`, D-119): RuneLite `Prayer` constant
 * names such as PROTECT_FROM_MELEE, PIETY, ZEAL, and the Ruinous Powers as RP_TRINITAS. Pure.
 */

/** Ruinous Powers names whose in-game spelling has an apostrophe. */
const SPECIAL_LABELS: Readonly<Record<string, string>> = {
  RP_FUMUS_VOW: "Fumus' Vow",
  RP_UMBRA_VOW: "Umbra's Vow",
  RP_CRUORS_VOW: "Cruor's Vow",
  RP_GLACIES_VOW: "Glacies' Vow",
};

const LOWERCASE_WORDS = new Set(['of', 'from']);

/**
 * The name the prayer book shows: PROTECT_FROM_MISSILES → "Protect from Missiles", RP_TRINITAS →
 * "Trinitas". A name RuneLite adds later still reads well, by the same rule.
 */
export function prayerLabel(name: string): string {
  const special = SPECIAL_LABELS[name];
  if (special !== undefined) return special;
  return name
    .replace(/^RP_/, '')
    .split('_')
    .filter((word) => word !== '')
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i > 0 && LOWERCASE_WORDS.has(lower)
        ? lower
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Whether the prayer belongs to the Ruinous Powers book (RuneLite prefixes those with RP_). */
export function isRuinousPower(name: string): boolean {
  return name.startsWith('RP_');
}
