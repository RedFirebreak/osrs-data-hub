import { carriedValue } from '../events/values';
import type { ItemData, Location, ParsedPayload, PlayerSnapshot } from '../payload/types';
import { IN_GAME_STATES } from '../presence';
import { OVERALL, overallXp, totalLevel } from '../skills';
import {
  EVENT_CLAMP_MS,
  LOCATION_BUCKET_MS,
  floorTo,
  isPlausibleClock,
  isStaleSnapshot,
  utcDay,
} from '../time';
import { isSpecialWorld } from '../worlds';
import type {
  LatestStatePatch,
  LocationWrite,
  PrevState,
  SnapshotContext,
  SnapshotPlan,
  XpWrite,
} from './types';

/**
 * Decides everything a payload's snapshot writes (handoff §7.1 steps 9–13), purely:
 *
 * - special = isSpecialWorld(player.worldTypes). stale = isStaleSnapshot(prev, deviceId, payloadTs).
 * - stale → latestPatch null, no derived writes except the trail points of a 1.6 plugin on a normal
 *   world (planTrail, without the closing point); session.open false, session.extend true only if
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
 * - locationPoints: with a locationTrail (plugin 1.6) → planTrail's rows; without one, when location
 *   is present → the one sample {ts: floorTo(recv, 1 min), x, y, plane, onBoat: isOnBoat ?? false,
 *   world: player.world ?? prev.world ?? null}.
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
    locationPoints: [],
    wealth: null,
    session: { open: false, extend: inGame, world },
    latestPatch: null,
  };
  if (stale) {
    // Once a snapshot is answered 200 the plugin never sends its trail points again, so one that
    // lost the race still has points to keep.
    if (!special) plan.locationPoints = planTrail(prev, payload, ctx.recv, false);
    return plan;
  }

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
  }
  if (player.locationTrail !== undefined) {
    plan.locationPoints = planTrail(prev, payload, ctx.recv, true);
  } else if (player.location !== undefined) {
    const sample = floorTo(ctx.recv, LOCATION_BUCKET_MS);
    plan.locationPoints = [toWrite(player.location, sample, player.world ?? prev?.world ?? null)];
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

/**
 * The location_samples rows of a 1.6 payload (D-102); [] for a payload without a trail.
 *
 * - The payload's own time is its root timestamp, else its newest point, else recv. When that is a
 *   plausible clock (isPlausibleClock) every point keeps the plugin's timestamp, so the same payload
 *   arriving twice gives the same rows. Otherwise the trail is moved as a whole so the payload's time
 *   lands on recv.
 * - Points after the payload's time or more than 15 minutes before it are dropped; the rest is
 *   ordered by time with one point per timestamp.
 * - `closing` (a snapshot that is applied): `location` is added at the payload's time when the trail
 *   doesn't end there. With no point left that means: it isn't where the account was last seen, or
 *   this is the first payload of a new receive-minute, so a player standing still keeps one point a
 *   minute.
 */
function planTrail(
  prev: PrevState | null,
  payload: ParsedPayload,
  recv: Date,
  closing: boolean,
): LocationWrite[] {
  const player: PlayerSnapshot = payload.player ?? {};
  const trail = player.locationTrail;
  if (trail === undefined) return [];
  const world = player.world ?? prev?.world ?? null;
  const recvMs = recv.getTime();

  const own = payload.timestamp ?? trail.reduce((max, p) => Math.max(max, p.timestamp), -Infinity);
  const reference = Number.isFinite(own) ? own : recvMs;
  const plausible = isPlausibleClock(reference, recv);
  const end = plausible ? reference : recvMs;

  const byTime = new Map<number, LocationWrite>();
  for (const point of trail) {
    const ms = plausible ? point.timestamp : Math.round(recvMs - (reference - point.timestamp));
    if (ms > end || ms < end - EVENT_CLAMP_MS || byTime.has(ms)) continue;
    byTime.set(ms, toWrite(point, new Date(ms), world));
  }
  const points = [...byTime.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const location = player.location;
  if (!closing || location === undefined) return points;
  const last = points.at(-1);
  if (last !== undefined) {
    if (!sameTile(last, location)) {
      points.push(toWrite(location, new Date(Math.max(end, last.ts.getTime() + 1)), world));
    }
    return points;
  }
  const seen = prev?.location ?? null;
  const seenAt = prev?.locationUpdatedAt ?? null;
  const newMinute =
    seenAt === null ||
    floorTo(recv, LOCATION_BUCKET_MS).getTime() > floorTo(seenAt, LOCATION_BUCKET_MS).getTime();
  if (seen === null || newMinute || !sameTile(toWrite(seen, recv, world), location)) {
    points.push(toWrite(location, new Date(end), world));
  }
  return points;
}

function toWrite(at: Location, ts: Date, world: number | null): LocationWrite {
  return { ts, x: at.x, y: at.y, plane: at.plane, onBoat: at.isOnBoat ?? false, world };
}

/** Same tile, plane and boat state: what the plugin calls not having moved. */
function sameTile(a: LocationWrite, b: Location): boolean {
  return a.x === b.x && a.y === b.y && a.plane === b.plane && a.onBoat === (b.isOnBoat ?? false);
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
