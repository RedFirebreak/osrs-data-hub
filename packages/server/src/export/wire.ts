/**
 * The export's snake_case shapes (D-77, D-79): explicit mappers from the read models, with the
 * public API's field names wherever the concept is the same (apps/web lib/api-v1/wire.ts). Never a
 * generic key converter: skill names, equipment slots and the plugin's event `data` are data and
 * pass through unchanged.
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

/** An ApiSection in the export's (the API's) wire format. */
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

/** An event as GET /api/v1/events names it, without the account (the export nests it). */
export function wireEvent(e: FeedEvent) {
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
    data: e.data,
    title: e.title,
    line: e.line,
  };
}
