import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESENCE_TIMEOUT_S,
  IN_GAME_STATES,
  MIN_PRESENCE_TIMEOUT_S,
  isOnline,
  presenceTimeoutSeconds,
} from './presence';

describe('presenceTimeoutSeconds', () => {
  it('is floor(tickDelay × 3.1 × 0.6)', () => {
    expect(presenceTimeoutSeconds(100)).toBe(186);
    expect(presenceTimeoutSeconds(50)).toBe(93);
    expect(presenceTimeoutSeconds(33)).toBe(61);
    expect(presenceTimeoutSeconds(1000)).toBe(1860);
    expect(presenceTimeoutSeconds(101)).toBe(187);
  });

  it('agrees with the float formula ha-osrs-data uses', () => {
    for (let t = 33; t <= 5000; t++) {
      expect(presenceTimeoutSeconds(t)).toBe(Math.floor(t * 3.1 * 0.6));
    }
  });

  it('never goes below 60 s', () => {
    expect(presenceTimeoutSeconds(1)).toBe(MIN_PRESENCE_TIMEOUT_S);
    expect(presenceTimeoutSeconds(32)).toBe(60);
    expect(presenceTimeoutSeconds(0.5)).toBe(60);
  });

  it('is 25 minutes when tickDelay is unknown', () => {
    expect(presenceTimeoutSeconds(0)).toBe(DEFAULT_PRESENCE_TIMEOUT_S);
    expect(presenceTimeoutSeconds(0)).toBe(1500);
    expect(presenceTimeoutSeconds(null)).toBe(1500);
    expect(presenceTimeoutSeconds(undefined)).toBe(1500);
    expect(presenceTimeoutSeconds(-5)).toBe(1500);
    expect(presenceTimeoutSeconds(Number.NaN)).toBe(1500);
    expect(presenceTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(1500);
  });
});

describe('isOnline', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it('is online in every in-game state within the timeout', () => {
    for (const gameState of IN_GAME_STATES) {
      expect(isOnline({ gameState, lastSeen: ago(10), tickDelay: 100 }, now)).toBe(true);
    }
  });

  it('is offline on the login screen, an unknown state or no state', () => {
    for (const gameState of ['LOGIN_SCREEN', 'LOGIN_SCREEN_AUTHENTICATOR', 'LOGGING_IN', 'STARTING', 'UNKNOWN', null]) {
      expect(isOnline({ gameState, lastSeen: ago(1), tickDelay: 100 }, now)).toBe(false);
    }
  });

  it('is offline without a lastSeen', () => {
    expect(isOnline({ gameState: 'LOGGED_IN', lastSeen: null, tickDelay: 100 }, now)).toBe(false);
  });

  it('expires after the timeout (younger than, so the boundary is offline)', () => {
    const s = (lastSeen: Date) => ({ gameState: 'LOGGED_IN', lastSeen, tickDelay: 100 });
    expect(isOnline(s(ago(185.999)), now)).toBe(true);
    expect(isOnline(s(ago(186)), now)).toBe(false);
    expect(isOnline(s(ago(187)), now)).toBe(false);
  });

  it('uses 25 minutes for tickDelay 0/null', () => {
    const s = (lastSeen: Date, tickDelay: number | null) => ({ gameState: 'LOGGED_IN', lastSeen, tickDelay });
    expect(isOnline(s(ago(1499), 0), now)).toBe(true);
    expect(isOnline(s(ago(1500), 0), now)).toBe(false);
    expect(isOnline(s(ago(1499), null), now)).toBe(true);
  });

  it('uses the 60 s floor for a tiny send rate', () => {
    const s = (lastSeen: Date) => ({ gameState: 'LOGGED_IN', lastSeen, tickDelay: 1 });
    expect(isOnline(s(ago(59)), now)).toBe(true);
    expect(isOnline(s(ago(60)), now)).toBe(false);
  });

  it('treats a lastSeen in the future as online', () => {
    expect(isOnline({ gameState: 'HOPPING', lastSeen: ago(-30), tickDelay: 100 }, now)).toBe(true);
  });
});
