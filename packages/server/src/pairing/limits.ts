/**
 * Rate limits on the unauthenticated POST /api/osrs-data/pair (handoff §6.2.7, lesson §3.6.5). The code
 * space is only 100k, so guessing is throttled three ways: per client, globally, and a lockout after
 * repeated invalid codes. In memory in the single web process (D-5); the caller keeps one PairLimits
 * on globalThis (D-37).
 */
import { FailureLockout, WindowLimiter, type Clock } from '@hub/core';

export interface PairLimits {
  perIp: WindowLimiter;
  global: WindowLimiter;
  lockout: FailureLockout;
}

const MINUTE_MS = 60_000;

/**
 * 10 attempts per client per 10 minutes, 60 per minute over all clients, and 20 invalid codes from
 * one client within an hour lock it out for 15 minutes. `clock` is for tests.
 */
export function createPairLimits(opts: { clock?: Clock } = {}): PairLimits {
  const { clock } = opts;
  return {
    perIp: new WindowLimiter({ limit: 10, windowMs: 10 * MINUTE_MS, clock }),
    global: new WindowLimiter({ limit: 60, windowMs: MINUTE_MS, clock }),
    lockout: new FailureLockout({
      maxFailures: 20,
      windowMs: 60 * MINUTE_MS,
      lockMs: 15 * MINUTE_MS,
      clock,
    }),
  };
}
