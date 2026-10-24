/**
 * Gear history as trips (D-121): the `equipment_changes` log grouped into the stretches of play a
 * player wears one kit for, so a PvM trip of swaps reads as one entry with the gear brought for it
 * instead of a row per swap. Pure: the log is the input, the clock is a parameter.
 *
 * A trip is a run of changes where
 * - each change comes less than TRIP_GAP_MS after the one before it, and
 * - each set worn has at least TRIP_MIN_SHARED items in common with what the trip has used so far
 *   (a melee/ranged switch keeps its gloves, boots and ring; a skilling outfit after a boss doesn't).
 * A set with nothing on (everything banked) belongs to the trip it ends and starts no trip of its own.
 *
 * Its kit is every item worn during the trip, by slot, the longest worn first: the gear brought.
 */
import type { ItemData } from './payload/types';

/** A pause this long without a change ends a trip. */
export const TRIP_GAP_MS = 20 * 60_000;
/** Items a set must have in common with the trip so far to belong to it. */
export const TRIP_MIN_SHARED = 2;

/** The worn-equipment slots in the game's order (RuneLite EquipmentInventorySlot names). */
export const EQUIPMENT_SLOT_ORDER: readonly string[] = [
  'HEAD',
  'CAPE',
  'AMULET',
  'AMMO',
  'WEAPON',
  'BODY',
  'SHIELD',
  'LEGS',
  'GLOVES',
  'BOOTS',
  'RING',
];

/** One row of the equipment log: the whole set worn from `changedAt` on. */
export interface GearChangeInput {
  changedAt: string;
  items: readonly ItemData[];
}

export interface KitSlot {
  slot: string;
  /** Items worn in the slot during the trip, the longest worn first. */
  items: ItemData[];
}

export interface GearTrip {
  /** The first change of the trip. */
  startedAt: string;
  /** The last change of the trip. */
  endedAt: string;
  /** Changes of gear during the trip (the first one counts when it swapped from the set before). */
  swaps: number;
  /** Different full sets worn during the trip. */
  setups: number;
  /** Slots in the game's order; slots never filled are left out. */
  kit: KitSlot[];
}

type SlotMap = Map<string, ItemData>;

function slotMap(items: readonly ItemData[]): SlotMap {
  const out: SlotMap = new Map();
  for (const item of items) {
    if (typeof item.equipmentSlot === 'string' && item.equipmentSlot && Number.isFinite(item.id)) {
      out.set(item.equipmentSlot, item);
    }
  }
  return out;
}

function sharedCount(set: SlotMap, ids: ReadonlySet<number>): number {
  let n = 0;
  for (const item of set.values()) if (ids.has(item.id)) n += 1;
  return n;
}

function setKey(set: SlotMap): string {
  return [...set.entries()]
    .map(([slot, item]) => `${slot}:${item.id}`)
    .sort()
    .join(',');
}

function slotRank(slot: string): number {
  const i = EQUIPMENT_SLOT_ORDER.indexOf(slot);
  return i === -1 ? EQUIPMENT_SLOT_ORDER.length : i;
}

interface OpenTrip {
  startedAt: string;
  endedAt: string;
  swaps: number;
  ids: Set<number>;
  setups: Set<string>;
  /** slot → item id → [item, ms worn, first seen order] */
  worn: Map<string, Map<number, { item: ItemData; ms: number; order: number }>>;
  seen: number;
}

function wear(trip: OpenTrip, set: SlotMap, ms: number): void {
  if (set.size === 0) return;
  trip.setups.add(setKey(set));
  for (const [slot, item] of set) {
    trip.ids.add(item.id);
    let bySlot = trip.worn.get(slot);
    if (!bySlot) {
      bySlot = new Map();
      trip.worn.set(slot, bySlot);
    }
    const entry = bySlot.get(item.id);
    if (entry) entry.ms += ms;
    else bySlot.set(item.id, { item, ms, order: trip.seen++ });
  }
}

function close(trip: OpenTrip): GearTrip {
  const kit = [...trip.worn.entries()]
    .sort(([a], [b]) => slotRank(a) - slotRank(b) || a.localeCompare(b))
    .map(([slot, items]) => ({
      slot,
      items: [...items.values()]
        .sort((a, b) => b.ms - a.ms || a.order - b.order)
        .map((e) => e.item),
    }));
  return {
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    swaps: trip.swaps,
    setups: trip.setups.size,
    kit,
  };
}

/**
 * The log as trips, newest first. `changes` may come in any order (the history reads newest first);
 * `now` closes the time the last set was worn. Time worn per set is counted up to TRIP_GAP_MS, so a
 * set kept for hours doesn't drown out the swaps of the trip it ends.
 */
export function gearTrips(changes: readonly GearChangeInput[], now: Date = new Date()): GearTrip[] {
  const rows = changes
    .map((c) => ({ at: Date.parse(c.changedAt), changedAt: c.changedAt, set: slotMap(c.items) }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  const trips: GearTrip[] = [];
  let trip: OpenTrip | null = null;
  let previous: { at: number; set: SlotMap } | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const nextAt = i + 1 < rows.length ? rows[i + 1]!.at : now.getTime();
    const ms = Math.max(0, Math.min(nextAt - row.at, TRIP_GAP_MS));
    const afterGap = previous !== null && row.at - previous.at >= TRIP_GAP_MS;
    const newOutfit =
      trip !== null &&
      trip.ids.size > 0 &&
      row.set.size > TRIP_MIN_SHARED &&
      sharedCount(row.set, trip.ids) < TRIP_MIN_SHARED;
    if (afterGap && row.set.size === 0) {
      // Everything taken off long after the last swap: the trip had ended already.
      previous = { at: row.at, set: row.set };
      continue;
    }

    if (trip === null || afterGap || newOutfit) {
      if (trip !== null) trips.push(close(trip));
      trip = {
        startedAt: row.changedAt,
        endedAt: row.changedAt,
        swaps: 0,
        ids: new Set(),
        setups: new Set(),
        worn: new Map(),
        seen: 0,
      };
      // A swap from the set worn before the trip: that set came along, so it is part of the kit.
      if (
        previous !== null &&
        previous.set.size > 0 &&
        row.set.size > 0 &&
        sharedCount(row.set, new Set([...previous.set.values()].map((it) => it.id))) >=
          TRIP_MIN_SHARED
      ) {
        wear(trip, previous.set, 0);
        trip.swaps = 1;
      }
    } else {
      trip.swaps += 1;
      trip.endedAt = row.changedAt;
    }
    wear(trip, row.set, ms);
    previous = { at: row.at, set: row.set };
  }
  if (trip !== null) trips.push(close(trip));
  return trips.reverse();
}
