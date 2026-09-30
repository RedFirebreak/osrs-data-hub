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

/** The event fields that pick its game icon (FeedEvent has them). */
export interface EventIconSource {
  itemId: number | null;
  skill: string | null;
  /** The stored event (FeedEvent.data): loot's `highestValueItem` gives the drop's quantity. */
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How many of `itemId` the event names: loot's highestValueItem stack, else 1. */
export function eventItemQuantity(event: EventIconSource): number {
  const envelope = isRecord(event.data) ? event.data : {};
  const d = isRecord(envelope.data) ? envelope.data : {};
  const top = isRecord(d.highestValueItem) ? d.highestValueItem : {};
  const { id, quantity } = top;
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
