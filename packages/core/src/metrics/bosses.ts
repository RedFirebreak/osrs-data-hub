/**
 * Matching a hiscores activity to the loot the plugin reports (D-108). The hiscores write
 * "Kree'Arra" and "The Corrupted Gauntlet", the plugin's loot source "Kree'arra" and "Corrupted
 * Gauntlet": a name is compared by its letters and digits only, without case and without a leading
 * "The". Pure.
 */

/** The comparable form of a boss or loot source name ("The Kree'Arra" → "kreearra"). */
export function bossKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whether a loot source names the hiscores activity. */
export function isSameBoss(activity: string, source: string | null | undefined): boolean {
  if (!source) return false;
  const key = bossKey(activity);
  return key !== '' && key === bossKey(source);
}
