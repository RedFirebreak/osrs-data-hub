/**
 * What a death cost (D-123). The plugin's `valueLost` is the GE value of everything it would not keep on
 * an unsafe death, wherever that happened. Outside the Wilderness and PvP nothing of that is lost: it
 * waits in the player's grave and costs a reclaim fee. Only a death to another player, or one in the
 * Wilderness, really loses it.
 */
import { isRecord } from '../guards';

/** How a death ended for the items that weren't kept. */
export type DeathOutcome =
  /** Danger SAFE or EXCEPTIONAL (minigames, raids, Inferno…): nothing leaves the player. */
  | { kind: 'safe' }
  /** Killed by a player, or died in the Wilderness: the items are gone. */
  | { kind: 'lost'; value: number | null }
  /** Anywhere else: the items wait in the grave; `fee` is the most it costs to take them back. */
  | { kind: 'grave'; fee: number | null };

/** Fee per item from a grave, by the item's own value (wiki "Grave", 2026-10). */
const GRAVE_FEE_TIERS: readonly { min: number; fee: number }[] = [
  { min: 10_000_000, fee: 100_000 },
  { min: 1_000_000, fee: 10_000 },
  { min: 100_000, fee: 1_000 },
];
/** The most a grave costs to reclaim, whatever is in it. */
export const GRAVE_FEE_CAP = 500_000;

/**
 * The most it costs to reclaim `items` from a grave: per item 1K from 100K, 10K from 1M, 100K from 10M
 * (by GE price), capped at 500K. Ironmen pay half and Death's Coffer may pay it, so this is an upper
 * bound. Null when the list is missing or holds anything that isn't an item with an integer gePrice and
 * quantity.
 */
export function graveFee(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  let total = 0;
  for (const item of items) {
    if (!isRecord(item) || !Number.isInteger(item.gePrice) || !Number.isInteger(item.quantity)) {
      return null;
    }
    const price = item.gePrice as number;
    const quantity = Math.max(item.quantity as number, 0);
    const tier = GRAVE_FEE_TIERS.find((t) => price >= t.min);
    if (tier !== undefined) total += tier.fee * quantity;
    if (total >= GRAVE_FEE_CAP) return GRAVE_FEE_CAP;
  }
  return total;
}

/**
 * Whether a tile is in the Wilderness: the surface from the ditch (y 3523) to the north edge, x 2944
 * to 3391, and the dungeons under it (y 9918 to 10367). Close enough for telling a PvP death from a
 * grave; a few edge areas (the Wilderness of the Ferox enclave) are counted in.
 */
export function inWilderness(location: unknown): boolean {
  if (!isRecord(location)) return false;
  const { x, y } = location;
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  if (x < 2944 || x > 3391) return false;
  return (y >= 3523 && y <= 3967) || (y >= 9918 && y <= 10367);
}

/**
 * The outcome of a stored death (`d` is the plugin's death data, `valueGp` the event's column).
 *
 * - danger SAFE or EXCEPTIONAL → safe.
 * - Killed by a player → lost. The plugin names a player killer only in the Wilderness or on a PvP
 *   world, and a player killer has no `killerNpcId`.
 * - Died in the Wilderness (by `location`) → lost.
 * - Otherwise → grave, with graveFee of the lost items. Data whose location was removed for the
 *   viewer reads as a grave unless a player killed them.
 */
export function deathOutcome(d: Record<string, unknown>, valueGp: number | null): DeathOutcome {
  const danger = typeof d.danger === 'string' ? d.danger.trim().toUpperCase() : null;
  if (danger === 'SAFE' || danger === 'EXCEPTIONAL') return { kind: 'safe' };
  const value =
    valueGp ??
    (typeof d.valueLost === 'number' && Number.isFinite(d.valueLost) ? d.valueLost : null);
  const killer = typeof d.killerName === 'string' ? d.killerName.trim() : '';
  const byPlayer = killer !== '' && killer !== '?' && d.killerNpcId == null;
  if (byPlayer || inWilderness(d.location)) return { kind: 'lost', value };
  return { kind: 'grave', fee: graveFee(d.lostItems) };
}
