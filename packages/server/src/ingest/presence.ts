/** Presence rules the ingest writes share (handoff §7.6, D-28, D-33). */
import { IN_GAME_STATES } from '@hub/core';

/**
 * latest_state.game_state after a clientShutdown: "a clientShutdown ends the session straight away"
 * (handoff §7.6). "Shutdown" and "Disabled" while logged in arrive with state LOGGED_IN (fixture
 * shutdown.json), a restart after a crash sends "Logout" with LOGIN_SCREEN, and "Disabled" on the
 * login screen has no state at all. Nothing follows a shutdown, so an in-game or missing state
 * becomes null (not in game) instead of keeping the account online for another tickDelay × 1.86 s;
 * a state that already isn't in game (LOGIN_SCREEN) is kept.
 */
export function gameStateAfterShutdown(state: string | null): string | null {
  return state !== null && !IN_GAME_STATES.has(state) ? state : null;
}
