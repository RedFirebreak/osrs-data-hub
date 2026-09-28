import { notImplemented } from './todo';

/** Injectable clock (ms). */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface LimitResult {
  ok: boolean;
  /** Whole seconds to wait (≥ 1) when !ok; 0 when ok. Integer: the plugin rejects "3.5" (PLUGIN-5). */
  retryAfterSeconds: number;
}

/**
 * Token bucket per key: `capacity` tokens, refilled continuously at `refillPerSecond`. A new key starts
 * full. Keeps at most `maxKeys` keys (evicts the least recently used, which are full anyway).
 * Ingest uses capacity 30, 5/s per device (handoff §7.6).
 */
export class TokenBucketLimiter {
  constructor(opts: { capacity: number; refillPerSecond: number; clock?: Clock; maxKeys?: number }) {
    notImplemented('TokenBucketLimiter');
  }
  take(key: string, cost = 1): LimitResult {
    return notImplemented('TokenBucketLimiter.take');
  }
}

/**
 * Sliding-window counter per key: at most `limit` hits per `windowMs`. `hit` records an attempt and
 * reports whether it is allowed (a rejected hit is not counted). /pair: 10 per IP per 10 min, 60 per
 * minute globally (handoff §6.2.7). Bounded to `maxKeys` keys.
 */
export class WindowLimiter {
  constructor(opts: { limit: number; windowMs: number; clock?: Clock; maxKeys?: number }) {
    notImplemented('WindowLimiter');
  }
  hit(key: string): LimitResult {
    return notImplemented('WindowLimiter.hit');
  }
  /** Check without recording. */
  peek(key: string): LimitResult {
    return notImplemented('WindowLimiter.peek');
  }
}

/**
 * Temporary lockout after repeated failures: `maxFailures` failures within `windowMs` lock the key for
 * `lockMs`. recordSuccess clears the failures. /pair: 20 invalid codes per IP within 1 h → 15 min lock.
 */
export class FailureLockout {
  constructor(opts: { maxFailures: number; windowMs: number; lockMs: number; clock?: Clock; maxKeys?: number }) {
    notImplemented('FailureLockout');
  }
  /** Seconds remaining (integer ≥ 1) when locked, else 0. */
  lockedFor(key: string): number {
    return notImplemented('FailureLockout.lockedFor');
  }
  recordFailure(key: string): void {
    notImplemented('FailureLockout.recordFailure');
  }
  recordSuccess(key: string): void {
    notImplemented('FailureLockout.recordSuccess');
  }
}
