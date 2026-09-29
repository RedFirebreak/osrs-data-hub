/**
 * World types on which the plugin sends nothing by default (opt-in "Special world data"); payloads
 * carrying any of them only update live fields. Same set as the plugin's WorldUtils.java:29.
 */
export const SPECIAL_WORLD_TYPES: ReadonlySet<string> = new Set([
  'SEASONAL',
  'DEADMAN',
  'TOURNAMENT_WORLD',
  'BETA_WORLD',
  'QUEST_SPEEDRUNNING',
  'NOSAVE_MODE',
  'PVP_ARENA',
]);

/** True when worldTypes intersects SPECIAL_WORLD_TYPES. Undefined/empty → false. */
export function isSpecialWorld(worldTypes: readonly string[] | null | undefined): boolean {
  return worldTypes?.some((t) => SPECIAL_WORLD_TYPES.has(t)) ?? false;
}
