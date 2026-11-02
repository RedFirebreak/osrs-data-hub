/**
 * The items of a loot or PK loot event as the hub indexes them for `item=` on /api/v1/events
 * (D-136, the `loot_items` table). Migration 0019 applied the same rules in SQL to the events stored
 * before it; keep the two in step.
 */
import { isRecord } from '../guards';
import { storedEventData } from './stored';

/** At most this many items of one event are indexed (the plugin sends one entry per stack). */
export const MAX_LOOT_ITEMS = 64;
/** Item names are cut to this many characters. */
export const MAX_LOOT_ITEM_NAME = 100;

export interface LootItemRow {
  /** Position in the plugin's `items`. */
  idx: number;
  itemId: number | null;
  /** Trimmed, cut and lower-cased. */
  name: string;
  quantity: number | null;
}

/** The event types whose items are indexed (stored names). */
export const LOOT_ITEM_EVENT_TYPES: readonly string[] = ['loot', 'pk_loot'];

/**
 * The indexed items of a stored event (`events.data`: {type, data, …}) of `type`: for loot and PK
 * loot, each of the first MAX_LOOT_ITEMS entries of `data.items` that is an object with a non-blank
 * string `name`; [] for any other type or shape. An id or quantity is kept only when it is a whole
 * number from 0 to 999,999,999 (the migration's `^[0-9]{1,9}$`), else null.
 */
export function lootItemRows(type: string, stored: unknown): LootItemRow[] {
  if (!LOOT_ITEM_EVENT_TYPES.includes(type)) return [];
  const items = storedEventData(stored).items;
  if (!Array.isArray(items)) return [];
  const out: LootItemRow[] = [];
  items.slice(0, MAX_LOOT_ITEMS).forEach((item: unknown, idx) => {
    if (!isRecord(item) || typeof item.name !== 'string') return;
    const name = item.name.trim().slice(0, MAX_LOOT_ITEM_NAME).toLowerCase();
    if (name === '') return;
    out.push({ idx, itemId: smallWhole(item.id), name, quantity: smallWhole(item.quantity) });
  });
  return out;
}

function smallWhole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999_999_999
    ? value
    : null;
}
