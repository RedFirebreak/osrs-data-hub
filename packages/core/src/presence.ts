/**
 * Game states that count as "in game" for presence: a StatChanged send can happen while LOADING or
 * HOPPING, and CONNECTION_LOST usually recovers (PLUGIN-1). LOGIN_SCREEN* and a missing state do not.
 */
export const IN_GAME_STATES: ReadonlySet<string> = new Set([
  'LOGGED_IN',
  'LOADING',
  'HOPPING',
  'CONNECTION_LOST',
]);

/** Timeout used when tickDelay is 0/unknown (same as ha-osrs-data). */
export const DEFAULT_PRESENCE_TIMEOUT_S = 25 * 60;
/** Lower bound so a tiny sendRate doesn't make presence flap (hub decision, D-28). */
export const MIN_PRESENCE_TIMEOUT_S = 60;

/**
 * floor(tickDelay × 3.1 × 0.6) seconds, at least 60; 25 minutes when tickDelay is 0/null (or negative
 * or not finite, which the plugin never sends).
 */
export function presenceTimeoutSeconds(tickDelay: number | null | undefined): number {
  if (!tickDelay || !Number.isFinite(tickDelay) || tickDelay < 0) return DEFAULT_PRESENCE_TIMEOUT_S;
  // 3.1 × 0.6 = 1.86, in integer arithmetic so the floor is exact for any integer tickDelay.
  return Math.max(MIN_PRESENCE_TIMEOUT_S, Math.floor((tickDelay * 186) / 100));
}

/**
 * Online when the last known game state is in IN_GAME_STATES and lastSeen is within the timeout
 * (now − lastSeen < presenceTimeoutSeconds(tickDelay), i.e. "younger than", handoff §7.6).
 */
export function isOnline(
  s: { gameState: string | null; lastSeen: Date | null; tickDelay: number | null },
  now: Date,
): boolean {
  if (s.gameState === null || !IN_GAME_STATES.has(s.gameState) || s.lastSeen === null) return false;
  return now.getTime() - s.lastSeen.getTime() < presenceTimeoutSeconds(s.tickDelay) * 1000;
}
