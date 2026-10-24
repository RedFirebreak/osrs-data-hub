/**
 * The icon CDN's URL contract (D-95): item, skill and empty-slot icons from the central osrs-icons
 * repository, served at `OSRS_ICONS_URL` (default https://icons.scapekeeper.com). Ported from its
 * reference client (clients/osrs-icons.mjs, whose tests osrs-icons.test.ts mirrors). Pure; client-
 * and server-safe. A 404 means "no icon": callers show the text they would show without icons.
 *
 *   itemIconUrl(base, stacks, 995, 250) // → `${base}/items/1002.webp` (the 250-coins pile)
 *   skillIconUrl(base, 'Attack')        // → `${base}/skills/attack.png`
 *   slotIconUrl(base, 'AMULET')         // → `${base}/slots/amulet.png`
 *   prayerIconUrl(base, 'PIETY')        // → `${base}/prayers/piety.png`
 *   hiscoreIconUrl(base, "Kree'Arra")   // → `${base}/hiscores/kreearra.png`
 */
import { highestValueItem } from '@hub/core';

/**
 * `/data/stacks.json`: per item id, the quantity breakpoints and the variant id whose picture shows
 * that many (`{"995": [[2, 996], …, [10000, 1004]]}`), sorted by breakpoint.
 */
export type IconStacks = Readonly<Record<string, readonly (readonly [number, number])[]>>;

/**
 * What the icon components need: the base URL (null = icons off) and the stack tables (null while
 * the browser is still loading them).
 */
export interface IconConfig {
  base: string | null;
  stacks: IconStacks | null;
}

/** Icons off: what components see outside an IconConfigProvider. */
export const NO_ICONS: IconConfig = { base: null, stacks: {} };

/** A parsed stacks.json, keeping only well-formed tables ([[breakpoint, id], …] of integers). */
export function parseStacks(json: unknown): IconStacks {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const out: Record<string, (readonly [number, number])[]> = {};
  for (const [id, table] of Object.entries(json)) {
    if (!/^\d+$/.test(id) || !Array.isArray(table)) continue;
    const rows = table.filter(
      (row): row is [number, number] =>
        Array.isArray(row) &&
        row.length === 2 &&
        Number.isInteger(row[0]) &&
        Number.isInteger(row[1]),
    );
    if (rows.length > 0) out[id] = rows.map(([q, v]) => [q, v] as const);
  }
  return out;
}

/**
 * The item id whose picture shows `quantity` of `itemId`: coins 995 × 250 → 1002. The variant of the
 * highest breakpoint at or below the quantity, whatever order a mirror lists the rows in.
 */
export function stackedItemId(stacks: IconStacks | null | undefined, itemId: number, quantity = 1) {
  const table = stacks && Object.hasOwn(stacks, itemId) ? stacks[itemId] : undefined;
  if (!Array.isArray(table)) return itemId;
  let id = itemId;
  let best = -Infinity;
  for (const [breakpoint, variant] of table) {
    if (quantity >= breakpoint && breakpoint > best) {
      best = breakpoint;
      id = variant;
    }
  }
  return id;
}

export function itemIconUrl(
  base: string | null,
  stacks: IconStacks | null | undefined,
  itemId: number | null | undefined,
  quantity = 1,
): string | null {
  if (!base || itemId === null || itemId === undefined || !Number.isInteger(itemId) || itemId < 0) {
    return null;
  }
  return `${base}/items/${stackedItemId(stacks, itemId, quantity)}.webp`;
}

/** Skills the CDN has no icon for: Overall, and Combat (a level-up event only). */
const NO_SKILL_ICON: ReadonlySet<string> = new Set(['', 'overall', 'combat']);

/** "Attack" / "attack" → /skills/attack.png. Overall and Combat have no icon. */
export function skillIconUrl(base: string | null, skill: string | null | undefined): string | null {
  if (!base || !skill) return null;
  const slug = skill.trim().toLowerCase();
  return NO_SKILL_ICON.has(slug) ? null : `${base}/skills/${encodeURIComponent(slug)}.png`;
}

/** RuneLite EquipmentInventorySlot name ("HEAD", "AMULET", …) → the empty-slot silhouette. */
export function slotIconUrl(base: string | null, slot: string | null | undefined): string | null {
  if (!base || !slot) return null;
  const slug = slot.trim().toLowerCase();
  return slug === '' ? null : `${base}/slots/${encodeURIComponent(slug)}.png`;
}

/**
 * RuneLite Prayer name ("PROTECT_FROM_MELEE", "RP_TRINITAS", …; D-119) → its lit prayer-book icon.
 * Anything that isn't a Prayer constant name has none.
 */
export function prayerIconUrl(
  base: string | null,
  prayer: string | null | undefined,
): string | null {
  if (!base || !prayer || !/^[A-Z0-9_]+$/.test(prayer)) return null;
  return `${base}/prayers/${prayer.toLowerCase()}.png`;
}

/**
 * A hiscores activity name ("Kree'Arra", "Clue Scrolls (all)", "LMS - Rank") → its slug on the CDN
 * ("kreearra", "clue_scrolls_all", "lms_rank"): lowercase, apostrophes dropped, every other run of
 * characters that aren't a-z or 0-9 one "_". osrs-icons' hiscoreSlug.
 */
export function hiscoreSlug(activity: string | null | undefined): string {
  return (activity ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The clue scroll item of each tier (the CDN's hiscores sprites stop at "Clue Scrolls (all)"). */
const CLUE_ITEMS: Readonly<Record<string, number>> = {
  clue_scrolls_beginner: 23182,
  clue_scrolls_easy: 2677,
  clue_scrolls_medium: 2801,
  clue_scrolls_hard: 2722,
  clue_scrolls_elite: 12073,
  clue_scrolls_master: 19835,
};

/**
 * A hiscores activity (a boss, "Clue Scrolls (all)", "LMS - Rank") → the sprite RuneLite's hiscore
 * panel draws for it (`/hiscores/{slug}.png`), or a clue tier's scroll item. A 404 means none.
 */
export function hiscoreIconUrl(
  base: string | null,
  activity: string | null | undefined,
): string | null {
  const slug = hiscoreSlug(activity);
  if (!base || !slug) return null;
  const clue = CLUE_ITEMS[slug];
  return clue === undefined ? `${base}/hiscores/${slug}.png` : `${base}/items/${clue}.webp`;
}

/** The event fields that pick its game icon (FeedEvent has them). */
export interface EventIconSource {
  itemId: number | null;
  skill: string | null;
  /** The stored event (FeedEvent.data): loot's `highestValueItem` gives the drop's quantity. */
  data?: unknown;
}

/** How many of `itemId` the event names: loot's highestValueItem stack, else 1. */
export function eventItemQuantity(event: EventIconSource): number {
  const { id, quantity } = highestValueItem(event.data);
  return id === event.itemId &&
    typeof quantity === 'number' &&
    Number.isInteger(quantity) &&
    quantity > 0
    ? quantity
    : 1;
}

/**
 * An event's game icon: the item it names (loot's most valuable drop at its stack size, a collection
 * log slot), else its skill (level-ups; none for Combat); null → the lucide icon.
 */
export function eventIconUrl(
  base: string | null,
  stacks: IconStacks | null | undefined,
  event: EventIconSource,
): string | null {
  return (
    itemIconUrl(base, stacks, event.itemId, eventItemQuantity(event)) ??
    skillIconUrl(base, event.skill)
  );
}
