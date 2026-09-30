/**
 * The icon CDN's URL contract (D-95): item, skill and empty-slot icons from the central osrs-icons
 * repository, served at `OSRS_ICONS_URL` (default https://icons.scapekeeper.com). Ported from its
 * reference client (clients/osrs-icons.mjs, whose tests osrs-icons.test.ts mirrors). Pure; client-
 * and server-safe. A 404 means "no icon": callers show the text they would show without icons.
 *
 *   itemIconUrl(base, stacks, 995, 250) // → `${base}/items/1002.webp` (the 250-coins pile)
 *   skillIconUrl(base, 'Attack')        // → `${base}/skills/attack.png`
 *   slotIconUrl(base, 'AMULET')         // → `${base}/slots/amulet.png`
 */

export const DEFAULT_ICONS_URL = 'https://icons.scapekeeper.com';

/**
 * `/data/stacks.json`: per item id, the quantity breakpoints and the variant id whose picture shows
 * that many (`{"995": [[2, 996], …, [10000, 1004]]}`), sorted by breakpoint.
 */
export type IconStacks = Readonly<Record<string, readonly (readonly [number, number])[]>>;

/** What the icon components need: the base URL (null = icons off) and the stack tables. */
export interface IconConfig {
  base: string | null;
  stacks: IconStacks;
}

/** Icons off: what components see outside an IconConfigProvider. */
export const NO_ICONS: IconConfig = { base: null, stacks: {} };

/** Normalises a configured base URL; null when icons are turned off (an empty value). */
export function iconsBase(
  configured: string | null | undefined = DEFAULT_ICONS_URL,
): string | null {
  const base = (configured ?? DEFAULT_ICONS_URL).trim().replace(/\/+$/, '');
  return base === '' ? null : base;
}

/** The item id whose picture shows `quantity` of `itemId`: coins 995 × 250 → 1002. */
export function stackedItemId(stacks: IconStacks | null | undefined, itemId: number, quantity = 1) {
  const table = stacks && Object.hasOwn(stacks, itemId) ? stacks[itemId] : undefined;
  if (!Array.isArray(table)) return itemId;
  let id = itemId;
  for (const [breakpoint, variant] of table) {
    if (quantity >= breakpoint) id = variant;
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

/** "Attack" / "attack" → /skills/attack.png. Overall has no icon. */
export function skillIconUrl(base: string | null, skill: string | null | undefined): string | null {
  if (!base || !skill) return null;
  const slug = skill.trim().toLowerCase();
  return slug === '' || slug === 'overall'
    ? null
    : `${base}/skills/${encodeURIComponent(slug)}.png`;
}

/** RuneLite EquipmentInventorySlot name ("HEAD", "AMULET", …) → the empty-slot silhouette. */
export function slotIconUrl(base: string | null, slot: string | null | undefined): string | null {
  if (!base || !slot) return null;
  const slug = slot.trim().toLowerCase();
  return slug === '' ? null : `${base}/slots/${encodeURIComponent(slug)}.png`;
}

/** The event fields that pick its game icon (FeedEvent has them). */
export interface EventIconSource {
  itemId: number | null;
  skill: string | null;
}

/**
 * An event's game icon: the item it names (loot's most valuable drop, a collection log slot), else
 * its skill (level-ups; "Combat" has no icon and 404s into the fallback); null → the lucide icon.
 */
export function eventIconUrl(
  base: string | null,
  stacks: IconStacks | null | undefined,
  event: EventIconSource,
): string | null {
  return itemIconUrl(base, stacks, event.itemId) ?? skillIconUrl(base, event.skill);
}
