/**
 * Response shapes shared by several public API read models (handoff §13). Every field is camelCase
 * here; the web layer maps them to the wire format. Timestamps are ISO-8601 UTC strings, ids are
 * public ids (D-46, D-71).
 */
import type { ItemData } from '@hub/core';

/** An account as the API names it: its public id and current display name. */
export interface ApiAccountRef {
  id: string;
  name: string;
}

/**
 * An account's owner as the guild page shows them to every member (D-68, D-90): display name and
 * Discord user id, for a consumer that links hub accounts to people. Never a contributor.
 */
export interface ApiOwner {
  name: string;
  /** The owner's Discord user id; null for a user without one. */
  discordId: string | null;
}

/** A meter (HP, prayer): the current value (boosted, so it can exceed max) and the maximum. */
export interface ApiMeter {
  current: number;
  max: number;
}

/** An item as the plugin sent it (inventory: one entry per occupied slot, not merged; equipment: by slot). */
export interface ApiItem {
  id: number;
  /** null when the plugin didn't send a name. */
  name: string | null;
  quantity: number;
  /** Per-unit Grand Exchange price. */
  gePrice: number;
  /** Per-unit high-alchemy value; null when not sent. */
  haPrice: number | null;
  /** Equipment slot (HEAD, CAPE, WEAPON, …) on equipment items; null on inventory items. */
  equipmentSlot: string | null;
  /**
   * Inventory slot 0..27 (left to right, then top to bottom) on inventory items from plugin 1.5.1;
   * null from older plugins and on equipment items.
   */
  inventorySlot: number | null;
}

/**
 * One section of an account's current state (GET /accounts/{id}), in one of two states:
 * - `{ shared: true, updatedAt, …data }`: the data, and when the hub last received the section;
 * - `{ shared: false, updatedAt: null }`: the key may read the category, but the plugin never sent
 *   the section (the player filters it in the plugin, D-4): "not shared", never an empty value.
 * A section of a category the key can't read on the account is OMITTED from the response (the key
 * doesn't have it), which is different from `shared: false` (the player doesn't send it).
 */
export type ApiSection<T> =
  ({ shared: true; updatedAt: string } & T) | { shared: false; updatedAt: null };

/** Items as stored → the API's item shape; entries that aren't item objects are skipped. */
export function toApiItems(items: unknown): ApiItem[] {
  if (!Array.isArray(items)) return [];
  const out: ApiItem[] = [];
  for (const raw of items as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Partial<ItemData>;
    if (typeof item.id !== 'number') continue;
    out.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name : null,
      quantity: typeof item.quantity === 'number' ? item.quantity : 0,
      gePrice: typeof item.gePrice === 'number' ? item.gePrice : 0,
      haPrice: typeof item.haPrice === 'number' ? item.haPrice : null,
      equipmentSlot: typeof item.equipmentSlot === 'string' ? item.equipmentSlot : null,
      inventorySlot: Number.isInteger(item.inventorySlot) ? item.inventorySlot! : null,
    });
  }
  return out;
}
