import { describe, expect, it } from 'vitest';
import { gearTrips, TRIP_GAP_MS, type GearChangeInput } from './gear-trips';
import type { ItemData } from './payload/types';

const item = (id: number, name: string, slot: string): ItemData => ({
  id,
  name,
  gePrice: 0,
  quantity: 1,
  equipmentSlot: slot,
});

const MASORI_MASK = item(1, 'Masori mask (f)', 'HEAD');
const OATH_HELM = item(2, 'Oathplate helm', 'HEAD');
const QUIVER = item(3, "Blessed dizana's quiver", 'CAPE');
const BLOOD_FURY = item(4, 'Amulet of blood fury', 'AMULET');
const ANGUISH = item(5, 'Necklace of anguish', 'AMULET');
const SOULREAPER = item(6, 'Soulreaper axe', 'WEAPON');
const BLOWPIPE = item(7, 'Blazing blowpipe', 'WEAPON');
const OATH_CHEST = item(8, 'Oathplate chest', 'BODY');
const MASORI_BODY = item(9, 'Masori body (f)', 'BODY');
const MASORI_CHAPS = item(10, 'Masori chaps (f)', 'LEGS');
const OATH_LEGS = item(11, 'Oathplate legs', 'LEGS');
const VAMBS = item(12, 'Zaryte vambraces', 'GLOVES');
const BOOTS = item(13, 'Avernic treads', 'BOOTS');
const RING = item(14, 'Lightbearer', 'RING');
const ROD = item(20, 'Pearl fly fishing rod', 'WEAPON');
const ANGLER_HAT = item(21, 'Angler hat', 'HEAD');
const ANGLER_TOP = item(22, 'Angler top', 'BODY');
const ANGLER_WADERS = item(23, 'Angler waders', 'LEGS');

const BASE = [QUIVER, VAMBS, BOOTS, RING];
const MELEE = [OATH_HELM, BLOOD_FURY, SOULREAPER, OATH_CHEST, OATH_LEGS, ...BASE];
const RANGED = [MASORI_MASK, ANGUISH, BLOWPIPE, MASORI_BODY, MASORI_CHAPS, ...BASE];

const T0 = Date.parse('2026-10-24T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const change = (minutes: number, items: ItemData[]): GearChangeInput => ({
  changedAt: at(minutes),
  items,
});
const names = (items: readonly ItemData[]) => items.map((i) => i.name);

describe('gearTrips', () => {
  it('is empty for no changes', () => {
    expect(gearTrips([])).toEqual([]);
  });

  it('folds melee/ranged switches and back into one trip with the kit brought', () => {
    const log = [
      change(0, MELEE),
      change(1, RANGED),
      change(2, MELEE),
      change(3, RANGED),
      change(5, MELEE),
    ];
    const trips = gearTrips([...log].reverse(), new Date(T0 + 6 * 60_000));
    expect(trips).toHaveLength(1);
    const [trip] = trips;
    expect(trip!.startedAt).toBe(at(0));
    expect(trip!.endedAt).toBe(at(5));
    expect(trip!.swaps).toBe(4);
    expect(trip!.setups).toBe(2);
    expect(trip!.kit.map((s) => s.slot)).toEqual([
      'HEAD',
      'CAPE',
      'AMULET',
      'WEAPON',
      'BODY',
      'LEGS',
      'GLOVES',
      'BOOTS',
      'RING',
    ]);
    // Melee was worn 4 minutes, ranged 3: melee first in each slot.
    expect(names(trip!.kit[0]!.items)).toEqual(['Oathplate helm', 'Masori mask (f)']);
    expect(names(trip!.kit[3]!.items)).toEqual(['Soulreaper axe', 'Blazing blowpipe']);
    expect(names(trip!.kit[1]!.items)).toEqual(["Blessed dizana's quiver"]);
  });

  it('starts a new trip after a pause without changes', () => {
    const trips = gearTrips([change(0, MELEE), change(1, RANGED), change(60, MELEE)]);
    expect(trips).toHaveLength(2);
    // The newest first; it swapped from the ranged set worn before it, so that came along.
    expect(trips[0]!.startedAt).toBe(at(60));
    expect(trips[0]!.swaps).toBe(1);
    expect(names(trips[0]!.kit[0]!.items)).toContain('Masori mask (f)');
    expect(trips[1]!.swaps).toBe(1);
  });

  it('starts a new trip for a different outfit even without a pause', () => {
    const trips = gearTrips([
      change(0, MELEE),
      change(2, RANGED),
      change(5, [ANGLER_HAT, ANGLER_TOP, ANGLER_WADERS, ROD, RING]),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0]!.swaps).toBe(0);
    expect(trips[0]!.kit.map((s) => s.slot)).toEqual(['HEAD', 'WEAPON', 'BODY', 'LEGS', 'RING']);
    expect(trips[1]!.setups).toBe(2);
  });

  it('keeps a single-piece swap in the trip', () => {
    const trips = gearTrips([change(0, MELEE), change(1, [...MELEE.slice(1), MASORI_MASK])]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.swaps).toBe(1);
  });

  it('keeps taking everything off in the trip, and ignores it long after', () => {
    const banked = gearTrips([change(0, MELEE), change(1, RANGED), change(2, [])]);
    expect(banked).toHaveLength(1);
    expect(banked[0]!.swaps).toBe(2);
    expect(banked[0]!.endedAt).toBe(at(2));

    const later = gearTrips([change(0, MELEE), change(1, RANGED), change(90, [])]);
    expect(later).toHaveLength(1);
    expect(later[0]!.endedAt).toBe(at(1));
  });

  it('caps the time a set counts at the trip gap', () => {
    // Ranged worn 25 minutes in swaps, then melee put on and kept for five hours: melee counts 21
    // minutes (1 + the 20-minute cap), so ranged is still listed first.
    const trips = gearTrips(
      [change(0, RANGED), change(15, MELEE), change(16, RANGED), change(26, MELEE)],
      new Date(T0 + 5 * 60 * 60_000),
    );
    expect(trips).toHaveLength(1);
    expect(names(trips[0]!.kit[0]!.items)).toEqual(['Masori mask (f)', 'Oathplate helm']);
    expect(TRIP_GAP_MS).toBe(20 * 60_000);
  });

  it('ignores rows without a time and items without a slot', () => {
    const trips = gearTrips([
      { changedAt: 'nonsense', items: MELEE },
      change(0, [...RANGED, { id: 99, gePrice: 0, quantity: 1 }]),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.kit.flatMap((s) => s.items).some((i) => i.id === 99)).toBe(false);
  });
});
