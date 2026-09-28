import { notImplemented } from '../todo';
import type { ParsedPayload } from '../payload/types';
import type { PrevState, SnapshotContext, SnapshotPlan } from './types';

/**
 * Decides everything a payload's snapshot writes (handoff §7.1 steps 9–13), purely:
 *
 * - special = isSpecialWorld(player.worldTypes). stale = isStaleSnapshot(prev, deviceId, payloadTs).
 * - stale → latestPatch null, no derived writes; session.extend true only if state is in-game.
 * - special (and not stale) → latestPatch has ONLY world/worldTypes/specialWorld=true/worldUpdatedAt;
 *   no XP, equipment, location or wealth; session handled as normal.
 * - normal → latestPatch sets sourceDeviceId/sourceTs(payloadTs) and, for each PRESENT section only,
 *   its columns plus its *UpdatedAt = recv (world/worldTypes/specialWorld=false, health, prayer,
 *   spellbook, location, skills, inventory, equipment). Missing sections are absent from the patch.
 * - XP: for each skill in player.skills whose xp differs from prev (or prev lacks it) → write
 *   {skill, xp, level}. If any skill's xp is LOWER than prev → xpGuardTripped, xpGuardSkill, no writes,
 *   and `skills`/`skillsUpdatedAt` are left out of latestPatch. Overall: merged = {...prev, ...new};
 *   when overallXp(merged) differs from overallXp(prev skills) (or no prev) → write {skill:'Overall',
 *   xp, level: totalLevel(merged)}.
 * - equipmentChange: when player.equipment is present and its slot→id map (equipmentSlot → id, items
 *   without a slot keyed by index) differs from prev.equipment's (or prev is null) → the new list.
 * - locationSample: when location present → {ts: floorTo(recv, 1 min), x, y, plane,
 *   onBoat: isOnBoat ?? false, world: player.world ?? prev.world ?? null}.
 * - wealth: when BOTH inventory and equipment are present → {day: utcDay(recv), value: carriedValue}.
 * - session: open = state === 'LOGGED_IN'; extend = state in IN_GAME_STATES; world = player.world ?? null.
 */
export function planSnapshot(
  prev: PrevState | null,
  payload: ParsedPayload,
  ctx: SnapshotContext,
): SnapshotPlan {
  return notImplemented('planSnapshot');
}
