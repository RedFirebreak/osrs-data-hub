/**
 * Pure display helpers for the account page's gear, inventory, vitals and sessions. Client- and
 * server-safe (type-only imports), unit-tested.
 *
 * Item facts (PLUGIN-11): inventory items are one entry per occupied slot as sent (five sharks are
 * five entries of quantity 1; only stackables carry a quantity above 1). From plugin 1.5.1 each
 * carries `inventorySlot` (0..27), so the grid puts it where it is in game; older plugins send no
 * slot and the grid shows those items in the order sent. Equipment items are one per slot with
 * `equipmentSlot`. `gePrice` is per unit: an entry's value is gePrice × quantity.
 */
import type { ItemData } from '@hub/core';
import type { SessionEndReason } from '@hub/db';

/** Inventory size in OSRS. */
export const INVENTORY_SLOTS = 28;

/** RuneLite EquipmentInventorySlot names the plugin sends, with display labels. */
export const EQUIPMENT_SLOT_LABELS: Readonly<Record<string, string>> = {
  HEAD: 'Head',
  CAPE: 'Cape',
  AMULET: 'Neck',
  AMMO: 'Ammo',
  WEAPON: 'Weapon',
  BODY: 'Body',
  SHIELD: 'Shield',
  LEGS: 'Legs',
  GLOVES: 'Hands',
  BOOTS: 'Feet',
  RING: 'Ring',
};

/** The worn-equipment screen: 5 rows × 3 columns of slots (null = no slot there). */
export const EQUIPMENT_GRID: readonly (readonly (string | null)[])[] = [
  [null, 'HEAD', null],
  ['CAPE', 'AMULET', 'AMMO'],
  ['WEAPON', 'BODY', 'SHIELD'],
  [null, 'LEGS', null],
  ['GLOVES', 'BOOTS', 'RING'],
];

export function slotLabel(slot: string): string {
  return EQUIPMENT_SLOT_LABELS[slot] ?? titleCase(slot);
}

/** "SOME_SLOT" / "lunar" → "Some slot" / "Lunar". */
function titleCase(text: string): string {
  const words = text.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The item's name, or "Item #<id>" when the plugin sent none. */
export function itemName(item: Pick<ItemData, 'id' | 'name'>): string {
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  return name || `Item #${item.id}`;
}

function finiteOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** gePrice × quantity of one entry (0 for missing or non-finite values, never negative). */
export function entryValue(item: Pick<ItemData, 'gePrice' | 'quantity'>): number {
  return Math.max(0, finiteOr0(item.gePrice) * finiteOr0(item.quantity));
}

/** Equipment items by slot; entries without a slot are left out, a repeated slot keeps the last. */
export function equipmentBySlot(items: readonly ItemData[]): Map<string, ItemData> {
  const out = new Map<string, ItemData>();
  for (const item of items) {
    if (typeof item.equipmentSlot === 'string' && item.equipmentSlot) {
      out.set(item.equipmentSlot, item);
    }
  }
  return out;
}

/** Slots the grid doesn't place (a slot name added to the game later), sorted. */
export function extraSlots(bySlot: ReadonlyMap<string, ItemData>): string[] {
  const placed = new Set(EQUIPMENT_GRID.flat().filter((s): s is string => s !== null));
  return [...bySlot.keys()].filter((s) => !placed.has(s)).sort();
}

export interface SlotChange {
  slot: string;
  before: ItemData | null;
  after: ItemData | null;
}

/**
 * What changed between two equipment snapshots, per slot: an item put on, taken off or swapped, or
 * a different quantity (ammo). Slots in the grid's order first, then any others alphabetically.
 * `older` null (the first change on record) lists every worn item as put on.
 */
export function equipmentDiff(
  older: readonly ItemData[] | null,
  newer: readonly ItemData[],
): SlotChange[] {
  const before = equipmentBySlot(older ?? []);
  const after = equipmentBySlot(newer);
  const order = EQUIPMENT_GRID.flat().filter((s): s is string => s !== null);
  const slots = new Set([...before.keys(), ...after.keys()]);
  const sorted = [
    ...order.filter((s) => slots.has(s)),
    ...[...slots].filter((s) => !order.includes(s)).sort(),
  ];
  const out: SlotChange[] = [];
  for (const slot of sorted) {
    const b = before.get(slot) ?? null;
    const a = after.get(slot) ?? null;
    if (b?.id === a?.id && finiteOr0(b?.quantity) === finiteOr0(a?.quantity)) continue;
    out.push({ slot, before: b, after: a });
  }
  return out;
}

/**
 * The inventory as a 28-slot grid (null = empty), in the game's order: left to right, then top to
 * bottom. An entry with an `inventorySlot` in range (plugin 1.5.1) goes to that slot; an entry
 * without one (older plugins), with one out of range, or whose slot another entry already took
 * fills the first free slots in the order sent. Entries that find no free slot are left out.
 */
export function inventorySlots(
  items: readonly ItemData[],
  size = INVENTORY_SLOTS,
): (ItemData | null)[] {
  const slots: (ItemData | null)[] = Array.from({ length: size }, () => null);
  const unplaced: ItemData[] = [];
  for (const item of items) {
    const slot = item.inventorySlot;
    if (
      typeof slot === 'number' &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < size &&
      !slots[slot]
    ) {
      slots[slot] = item;
    } else {
      unplaced.push(item);
    }
  }
  let free = 0;
  for (const item of unplaced) {
    while (free < size && slots[free]) free++;
    if (free === size) break;
    slots[free] = item;
  }
  return slots;
}

export interface MergedStack {
  id: number;
  name: string;
  /** Total quantity over every entry of the item. */
  quantity: number;
  /** How many inventory slots it takes. */
  slots: number;
  /** Σ gePrice × quantity over its entries. */
  value: number;
}

/**
 * The inventory merged by item id for display ("Shark × 5" instead of five slots), highest value
 * first, then by name. Only for display: stored and sent data stays one entry per slot (PLUGIN-11).
 */
export function mergeStacks(items: readonly ItemData[]): MergedStack[] {
  const byId = new Map<number, MergedStack>();
  for (const item of items) {
    if (typeof item.id !== 'number' || !Number.isFinite(item.id)) continue;
    const quantity = Math.max(0, finiteOr0(item.quantity));
    const existing = byId.get(item.id);
    if (existing) {
      existing.quantity += quantity;
      existing.slots += 1;
      existing.value += entryValue(item);
      if (existing.name.startsWith('Item #') && item.name) existing.name = itemName(item);
    } else {
      byId.set(item.id, {
        id: item.id,
        name: itemName(item),
        quantity,
        slots: 1,
        value: entryValue(item),
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.value - a.value || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

/** 1500 → "1.5K", 10_000_000 → "10M" (the in-game stack notation); below 100K the exact count. */
export function stackLabel(quantity: number): string {
  if (!Number.isFinite(quantity)) return '0';
  if (quantity >= 10_000_000) return `${Math.floor(quantity / 1_000_000)}M`;
  if (quantity >= 100_000) return `${Math.floor(quantity / 1_000)}K`;
  return String(Math.floor(quantity));
}

export interface MeterFill {
  /** Bar width, 0…100 (a boosted value past the maximum draws a full bar). */
  percent: number;
  /** Points above the maximum (brews, boosts), else 0. */
  boost: number;
}

/** The HP/prayer bar for a meter; `current` can exceed `max` (boosted), which is clamped visually. */
export function meterFill(current: number, max: number): MeterFill {
  const c = Math.max(0, finiteOr0(current));
  const m = Math.max(0, finiteOr0(max));
  if (m === 0) return { percent: c > 0 ? 100 : 0, boost: 0 };
  return { percent: Math.min(100, Math.round((c / m) * 1000) / 10), boost: Math.max(0, c - m) };
}

/** The plugin's spellbook name ("lunar", "standard", "ancient", "arceuus") for display. */
export function spellbookLabel(name: string): string {
  return titleCase(name);
}

const END_REASONS: Readonly<Record<SessionEndReason, string>> = {
  logout: 'Logged out',
  shutdown: 'Client closed',
  disabled: 'Plugin disabled',
  timeout: 'Timed out',
};

/** Why a session ended, for display; null → "In progress". */
export function sessionEndLabel(reason: SessionEndReason | null): string {
  return reason === null ? 'In progress' : (END_REASONS[reason] ?? titleCase(reason));
}
