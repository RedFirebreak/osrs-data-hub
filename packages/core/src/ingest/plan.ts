import { carriedValue } from '../events/values';
import type { ItemData, ParsedPayload, PlayerSnapshot } from '../payload/types';
import { IN_GAME_STATES } from '../presence';
import { OVERALL, overallXp, totalLevel } from '../skills';
import { LOCATION_BUCKET_MS, floorTo, isStaleSnapshot, utcDay } from '../time';
import { isSpecialWorld } from '../worlds';
import type { LatestStatePatch, PrevState, SnapshotContext, SnapshotPlan, XpWrite } from './types';

/**
 * Decides everything a payload's snapshot writes (handoff §7.1 steps 9–13), purely:
 *
 * - special = isSpecialWorld(player.worldTypes). stale = isStaleSnapshot(prev, deviceId, payloadTs).
 * - stale → latestPatch null, no derived writes; session.open false, session.extend true only if
 *   state is in-game.
 * - special (and not stale) → latestPatch has ONLY world/worldTypes/specialWorld=true/worldUpdatedAt;
 *   no XP, equipment, location or wealth; session handled as normal (D-45).
 * - normal → latestPatch sets sourceDeviceId/sourceTs(payloadTs) and, for each PRESENT section only,
 *   its columns plus its *UpdatedAt = recv (world/worldTypes/specialWorld=false, health, prayer,
 *   spellbook, location, skills, inventory, equipment). Missing sections are absent from the patch.
 *   world and worldTypes are separate sections: specialWorld=false is set only with worldTypes, and
 *   worldUpdatedAt with either. `skills` is the payload's map as sent (not merged with prev).
 * - XP: for each skill in player.skills whose xp differs from prev (or prev lacks it) → write
 *   {skill, xp, level}. If any skill's xp is LOWER than prev → xpGuardTripped, xpGuardSkill, and the
 *   whole snapshot is treated like a special-world one (D-24): it is most likely a world type we don't
 *   know or another character (PLUGIN-8), so latestPatch has ONLY world/worldTypes/worldUpdatedAt
 *   (specialWorld and sourceTs untouched) and there are no XP, equipment, location or wealth writes.
 *   Overall: merged = {...prev, ...new}; when overallXp(merged) differs from overallXp(prev skills)
 *   (or there are no prev skills and at least one skill was written) → write {skill:'Overall', xp,
 *   level: totalLevel(merged)}. A sent "Overall" entry is never written as a skill (it is derived).
 * - equipmentChange: when player.equipment is present and its slot→id map (equipmentSlot → id, items
 *   without a slot keyed by index) differs from prev.equipment's (or prev/prev.equipment is null) →
 *   the new list. A quantity change alone (ammo being used up) is not a change.
 * - locationSample: when location present → {ts: floorTo(recv, 1 min), x, y, plane,
 *   onBoat: isOnBoat ?? false, world: player.world ?? prev.world ?? null}.
 * - wealth: when BOTH inventory and equipment are present → {day: utcDay(recv), value: carriedValue}.
 * - session: open = state === 'LOGGED_IN'; extend = state in IN_GAME_STATES; world = player.world ?? null.
 * - A payload without a usable player (null) is planned as a player with no sections.
 */
export function planSnapshot(
  prev: PrevState | null,
  payload: ParsedPayload,
  ctx: SnapshotContext,
): SnapshotPlan {
  const player: PlayerSnapshot = payload.player ?? {};
  const special = isSpecialWorld(player.worldTypes);
  const stale = isStaleSnapshot(prev, ctx.deviceId, ctx.payloadTs);
  const inGame = payload.state !== null && IN_GAME_STATES.has(payload.state);
  const world = player.world ?? null;

  const plan: SnapshotPlan = {
    stale,
    special,
    xpWrites: [],
    xpGuardTripped: false,
    xpGuardSkill: null,
    equipmentChange: null,
    locationSample: null,
    wealth: null,
    session: { open: false, extend: inGame, world },
    latestPatch: null,
  };
  if (stale) return plan;

  plan.session.open = payload.state === 'LOGGED_IN';

  if (special) {
    const patch: LatestStatePatch = { specialWorld: true, worldUpdatedAt: ctx.recv };
    if (player.world !== undefined) patch.world = player.world;
    if (player.worldTypes !== undefined) patch.worldTypes = player.worldTypes;
    plan.latestPatch = patch;
    return plan;
  }

  if (player.skills !== undefined) {
    const xp = planXp(prev?.skills ?? null, player.skills);
    if (xp.guardSkill !== null) {
      plan.xpGuardTripped = true;
      plan.xpGuardSkill = xp.guardSkill;
      const guarded: LatestStatePatch = {};
      if (player.world !== undefined) guarded.world = player.world;
      if (player.worldTypes !== undefined) guarded.worldTypes = player.worldTypes;
      if (player.world !== undefined || player.worldTypes !== undefined)
        guarded.worldUpdatedAt = ctx.recv;
      plan.latestPatch = guarded;
      return plan;
    }
    plan.xpWrites = xp.writes;
  }

  const patch: LatestStatePatch = { sourceDeviceId: ctx.deviceId, sourceTs: ctx.payloadTs };
  const at = ctx.recv;
  if (player.world !== undefined) {
    patch.world = player.world;
    patch.worldUpdatedAt = at;
  }
  if (player.worldTypes !== undefined) {
    patch.worldTypes = player.worldTypes;
    patch.specialWorld = false;
    patch.worldUpdatedAt = at;
  }
  if (player.health !== undefined) {
    patch.hpCurrent = player.health.current;
    patch.hpMax = player.health.max;
    patch.healthUpdatedAt = at;
  }
  if (player.prayer !== undefined) {
    patch.prayerCurrent = player.prayer.current;
    patch.prayerMax = player.prayer.max;
    patch.prayerUpdatedAt = at;
  }
  if (player.spellbook !== undefined) {
    patch.spellbookId = player.spellbook.id;
    patch.spellbook = player.spellbook.name;
    patch.spellbookUpdatedAt = at;
  }
  if (player.location !== undefined) {
    patch.location = player.location;
    patch.locationUpdatedAt = at;
    plan.locationSample = {
      ts: floorTo(ctx.recv, LOCATION_BUCKET_MS),
      x: player.location.x,
      y: player.location.y,
      plane: player.location.plane,
      onBoat: player.location.isOnBoat ?? false,
      world: player.world ?? prev?.world ?? null,
    };
  }
  if (player.skills !== undefined) {
    patch.skills = player.skills;
    patch.skillsUpdatedAt = at;
  }
  if (player.inventory !== undefined) {
    patch.inventory = player.inventory;
    patch.inventoryUpdatedAt = at;
  }
  if (player.equipment !== undefined) {
    patch.equipment = player.equipment;
    patch.equipmentUpdatedAt = at;
    const before = prev?.equipment ?? null;
    if (before === null || !sameSlots(slotMap(before), slotMap(player.equipment))) {
      plan.equipmentChange = player.equipment;
    }
  }
  if (player.inventory !== undefined && player.equipment !== undefined) {
    plan.wealth = {
      day: utcDay(ctx.recv),
      value: carriedValue(player.inventory, player.equipment),
    };
  }

  plan.latestPatch = patch;
  return plan;
}

type Skills = Record<string, { xp: number; level: number }>;

/** Changed skills + Overall, or nothing with the name of the first skill whose XP dropped. */
function planXp(
  before: Skills | null,
  now: Skills,
): { writes: XpWrite[]; guardSkill: string | null } {
  const writes: XpWrite[] = [];
  for (const [skill, { xp, level }] of Object.entries(now)) {
    if (skill === OVERALL) continue; // the parser drops it; never let a sent "Overall" shadow ours
    const old = before !== null && Object.hasOwn(before, skill) ? before[skill] : undefined;
    if (old !== undefined && xp < old.xp) return { writes: [], guardSkill: skill };
    if (old === undefined || xp !== old.xp) writes.push({ skill, xp, level });
  }
  const merged: Skills = { ...before, ...now };
  const total = overallXp(merged);
  // Without prev, Overall is written whenever there is any skill (an empty map has nothing to sum).
  if (before === null ? writes.length > 0 : total !== overallXp(before)) {
    writes.push({ skill: OVERALL, xp: total, level: totalLevel(merged) });
  }
  return { writes, guardSkill: null };
}

/** equipmentSlot → item id; an item without a slot is keyed by its index ("#3"). */
function slotMap(items: readonly ItemData[]): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item, index) => map.set(item.equipmentSlot ?? `#${index}`, item.id));
  return map;
}

function sameSlots(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [slot, id] of a) {
    if (b.get(slot) !== id) return false;
  }
  return true;
}
