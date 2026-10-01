/**
 * The snake_case shapes the export (D-79) and the public API share (D-77): explicit mappers from the
 * read models, one set for both, so Download my data and /api/v1 can't name the same thing
 * differently. The web layer builds its responses from these (apps/web lib/api-v1/wire.ts) and
 * checks each result type against its response schema there. Never a generic key converter: skill
 * names, equipment slots and the plugin's event `data` are data and pass through unchanged.
 */
import type {
  ApiEquipment,
  ApiInventory,
  ApiLocation,
  ApiPresence,
  ApiSkills,
  ApiVitals,
} from '../api/state';
import type { ApiItem, ApiSection } from '../api/types';
import type { FeedEvent } from '../feed';

type Section<W> = ({ shared: true; updated_at: string } & W) | { shared: false; updated_at: null };

/** An ApiSection in the wire format. */
export function wireSection<T extends object, W extends object>(
  s: ApiSection<T>,
  map: (data: T) => W,
): Section<W> {
  if (!s.shared) return { shared: false, updated_at: null };
  return { shared: true, updated_at: s.updatedAt, ...map(s as T) };
}

export function wireItem(item: ApiItem) {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    ge_price: item.gePrice,
    ha_price: item.haPrice,
    equipment_slot: item.equipmentSlot,
    inventory_slot: item.inventorySlot,
  };
}

export function wireItems(items: ApiEquipment | ApiInventory) {
  return { items: items.items.map(wireItem), value: items.value };
}

/** Skill names are data: `skill` is copied as the plugin spells it. */
export function wireSkills(skills: ApiSkills) {
  return {
    total_level: skills.totalLevel,
    overall_xp: skills.overallXp,
    skills: skills.skills.map((s) => ({
      skill: s.skill,
      level: s.level,
      real_level: s.realLevel,
      xp: s.xp,
    })),
  };
}

export function wirePresence(p: ApiPresence) {
  return {
    online: p.online,
    world: p.world,
    special_world: p.specialWorld,
    game_state: p.gameState,
    last_seen: p.lastSeen,
  };
}

export function wireVitals(v: ApiVitals) {
  return { hp: v.hp, prayer: v.prayer, spellbook: v.spellbook };
}

export function wireLocation(l: ApiLocation) {
  return { x: l.x, y: l.y, plane: l.plane, is_on_boat: l.isOnBoat, stale: l.stale };
}

/** One day of carried wealth (the API's `days`, the export's `wealth_days`). */
export function wireWealthDay(d: { day: string; lastValue: number; maxValue: number }) {
  return { day: d.day, last_value: d.lastValue, max_value: d.maxValue };
}

/**
 * The stored event is always an object (the plugin's event from the raw payload, D-31); anything
 * else would be a storage bug, sent as an empty object rather than breaking the documented type.
 */
function eventData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * An event as GET /api/v1/events names it, without the account: the export nests its events under
 * their account, and the API adds its own `account` reference.
 */
export function wireEvent(e: Omit<FeedEvent, 'seq' | 'account' | 'icon'>) {
  return {
    id: e.id,
    type: e.type,
    occurred_at: e.occurredAt,
    received_at: e.receivedAt,
    value_gp: e.valueGp,
    item_id: e.itemId,
    npc_id: e.npcId,
    skill: e.skill,
    level: e.level,
    tier: e.tier,
    points: e.points,
    special_world: e.specialWorld,
    data: eventData(e.data),
    title: e.title,
    line: e.line,
  };
}
