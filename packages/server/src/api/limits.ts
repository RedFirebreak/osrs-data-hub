/**
 * Rate limits of the public API (handoff §13, D-72), in memory in the single web process (D-5): per
 * key 120 requests per sliding minute plus 1 per second on /snapshot, and failed key authentications
 * per client IP (30 per minute) so keys can't be guessed. The host keeps one ApiLimits on globalThis
 * (D-37, NEXT-3).
 */
import { WindowLimiter, type Clock, type LimitResult } from '@hub/core';
import { pairRateKey } from '../pairing/limits';

export const API_RATE_LIMIT = 120;
export const API_RATE_WINDOW_MS = 60_000;
export const SNAPSHOT_RATE_LIMIT = 1;
export const SNAPSHOT_RATE_WINDOW_MS = 1_000;
export const FAILED_AUTH_LIMIT = 30;
export const FAILED_AUTH_WINDOW_MS = 60_000;

export interface ApiLimits {
  /** Every authenticated request, per key id. */
  perKey: WindowLimiter;
  /** /snapshot requests, per key id. */
  snapshot: WindowLimiter;
  /** Failed authentications, per client IP (IPv6 by /64, as /pair). */
  failedAuthPerIp: WindowLimiter;
}

/** The three limiters (plain objects, so the host can keep them on globalThis). `clock` is for tests. */
export function createApiLimits(opts: { clock?: Clock } = {}): ApiLimits {
  const { clock } = opts;
  return {
    perKey: new WindowLimiter({ limit: API_RATE_LIMIT, windowMs: API_RATE_WINDOW_MS, clock }),
    snapshot: new WindowLimiter({
      limit: SNAPSHOT_RATE_LIMIT,
      windowMs: SNAPSHOT_RATE_WINDOW_MS,
      clock,
    }),
    failedAuthPerIp: new WindowLimiter({
      limit: FAILED_AUTH_LIMIT,
      windowMs: FAILED_AUTH_WINDOW_MS,
      clock,
    }),
  };
}

/** The X-RateLimit-* headers, as strings of whole numbers. */
export interface ApiRateHeaders {
  /** Requests per window (120). */
  'X-RateLimit-Limit': string;
  /** Requests left in the current sliding window, this one counted. */
  'X-RateLimit-Remaining': string;
  /**
   * Seconds until the oldest request counted in the window expires, i.e. until Remaining goes up
   * again (0 when nothing is counted). On a per-key 429 it equals Retry-After.
   */
  'X-RateLimit-Reset': string;
}

export interface ApiRateResult {
  ok: boolean;
  /** Always the per-key window's state, also on a rejection (send them on every response). */
  headers: ApiRateHeaders;
  /** Whole seconds ≥ 1 for Retry-After when !ok (PLUGIN-5: integers only); 0 when ok. */
  retryAfterSeconds: number;
}

/**
 * Counts one request of key `keyId` (`snapshot` for /snapshot) and says whether it may proceed. The
 * per-key window is checked first, then the snapshot limit; a request refused by either counts
 * towards neither (as /pair, D-59), so a client polling /snapshot too fast doesn't also use up its
 * minute.
 */
export function checkApiRate(
  limits: ApiLimits,
  keyId: string,
  opts: { snapshot: boolean },
): ApiRateResult {
  const minute = limits.perKey.peek(keyId);
  if (!minute.ok) return refused(limits, keyId, minute);
  if (opts.snapshot) {
    const second = limits.snapshot.hit(keyId);
    if (!second.ok) return refused(limits, keyId, second);
  }
  limits.perKey.hit(keyId);
  return { ok: true, headers: rateHeaders(limits, keyId), retryAfterSeconds: 0 };
}

function refused(limits: ApiLimits, keyId: string, result: LimitResult): ApiRateResult {
  return {
    ok: false,
    headers: rateHeaders(limits, keyId),
    retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
  };
}

/** The per-key window's X-RateLimit-* headers, without counting anything. */
export function rateHeaders(limits: ApiLimits, keyId: string): ApiRateHeaders {
  const usage = limits.perKey.usage(keyId);
  return {
    'X-RateLimit-Limit': String(usage.limit),
    'X-RateLimit-Remaining': String(usage.remaining),
    'X-RateLimit-Reset': String(Math.ceil(usage.resetMs / 1000)),
  };
}

/**
 * Whether a request from `ip` may try to authenticate at all: refused (with retryAfterSeconds) once
 * the IP has FAILED_AUTH_LIMIT failed attempts in the window. Checks without counting, so the host
 * can answer 429 before touching the database. A null or empty IP shares the key 'unknown'.
 */
export function checkAuthFailures(limits: ApiLimits, ip: string | null | undefined): LimitResult {
  return limits.failedAuthPerIp.peek(pairRateKey(ip));
}

/** Counts one failed authentication from `ip` (see checkAuthFailures). */
export function recordAuthFailure(limits: ApiLimits, ip: string | null | undefined): void {
  limits.failedAuthPerIp.hit(pairRateKey(ip));
}
