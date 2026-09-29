/** Injectable clock (ms). */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface LimitResult {
  ok: boolean;
  /**
   * Whole seconds to wait (≥ 1) when !ok; 0 when ok. Integer: the plugin rejects "3.5" (PLUGIN-5).
   * Capped at Number.MAX_SAFE_INTEGER, so String() always gives plain digits (never "1e+21").
   */
  retryAfterSeconds: number;
}

const DEFAULT_MAX_KEYS = 10_000;
/** Float slack so that e.g. 0.2 s × 5/s refills a whole token and 2.0000000000000004 s ceils to 2. */
const EPSILON = 1e-9;

function allowed(): LimitResult {
  return { ok: true, retryAfterSeconds: 0 };
}

/** Rejection with a wait of `ms`, as whole seconds ≥ 1 (see PLUGIN-5: Retry-After must be an integer). */
function rejected(ms: number): LimitResult {
  return { ok: false, retryAfterSeconds: wholeSeconds(ms) };
}

/** ms as whole seconds in [1, MAX_SAFE_INTEGER]: huge waits from extreme options stay plain digits. */
function wholeSeconds(ms: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.ceil(ms / 1000 - EPSILON)));
}

function assertPositive(name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`${name} must be a positive number: ${value}`);
  }
}

function assertPositiveInt(name: string, value: number): void {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError(`${name} must be a positive integer: ${value}`);
  }
}

/**
 * Map bounded to `maxKeys` entries with least-recently-used eviction. A Map iterates in insertion
 * order, so re-inserting on use keeps the least recently used key first.
 */
class LruMap<V> {
  readonly #map = new Map<string, V>();
  readonly #maxKeys: number;

  constructor(maxKeys: number) {
    this.#maxKeys = maxKeys;
  }

  /** The value without changing its recency. */
  peek(key: string): V | undefined {
    return this.#map.get(key);
  }

  /** Inserts or replaces `key` as the most recently used, evicting the least recently used keys. */
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#maxKeys) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }

  /** Marks `key` as the most recently used (no-op when absent). */
  touch(key: string): void {
    const value = this.#map.get(key);
    if (value === undefined) return;
    this.#map.delete(key);
    this.#map.set(key, value);
  }

  delete(key: string): void {
    this.#map.delete(key);
  }
}

/**
 * Drops timestamps ≤ `cutoff` from the front of an ascending list (in place). Timestamps are kept
 * ascending by never recording one below the previous (see `monotonic`).
 */
function pruneBefore(times: number[], cutoff: number): void {
  let expired = 0;
  while (expired < times.length && (times[expired] ?? Infinity) <= cutoff) expired++;
  if (expired > 0) times.splice(0, expired);
}

/** `now`, or the last recorded time if the clock went backwards, so lists stay ascending. */
function monotonic(times: readonly number[], now: number): number {
  return Math.max(now, times.at(-1) ?? now);
}

/**
 * Token bucket per key: `capacity` tokens, refilled continuously at `refillPerSecond`. A new key starts
 * full. Keeps at most `maxKeys` keys (evicts the least recently used, which have usually refilled by
 * then; an evicted key comes back full).
 * Ingest uses capacity 30, 5/s per device (handoff §7.6).
 * `take` throws a RangeError for a cost that is negative, not finite or above capacity (it could never
 * succeed). A rejected take consumes nothing; retryAfterSeconds is when `cost` tokens will be there.
 * If the clock goes backwards, refilling pauses until it catches up (and retryAfterSeconds includes
 * that pause).
 */
export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #clock: Clock;
  readonly #buckets: LruMap<{ tokens: number; at: number }>;

  constructor(opts: {
    capacity: number;
    refillPerSecond: number;
    clock?: Clock;
    maxKeys?: number;
  }) {
    assertPositive('capacity', opts.capacity);
    assertPositive('refillPerSecond', opts.refillPerSecond);
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    assertPositiveInt('maxKeys', maxKeys);
    this.#capacity = opts.capacity;
    this.#refillPerSecond = opts.refillPerSecond;
    this.#clock = opts.clock ?? systemClock;
    this.#buckets = new LruMap(maxKeys);
  }

  take(key: string, cost = 1): LimitResult {
    if (!(Number.isFinite(cost) && cost >= 0 && cost <= this.#capacity)) {
      throw new RangeError(`cost must be between 0 and capacity (${this.#capacity}): ${cost}`);
    }
    const now = this.#clock.now();
    const bucket = this.#buckets.peek(key);
    let tokens = this.#capacity;
    let at = now;
    if (bucket) {
      const elapsedMs = Math.max(0, now - bucket.at);
      // ms × rate / 1000 (not ms / 1000 × rate): exact for whole-ms inputs such as 600 ms × 5/s.
      tokens = Math.min(this.#capacity, bucket.tokens + (elapsedMs * this.#refillPerSecond) / 1000);
      at = Math.max(bucket.at, now);
    }
    if (tokens + EPSILON >= cost) {
      this.#buckets.set(key, { tokens: Math.max(0, tokens - cost), at });
      return allowed();
    }
    this.#buckets.set(key, { tokens, at });
    // at > now only after the clock went backwards: refilling resumes when it catches up.
    return rejected(at - now + ((cost - tokens) / this.#refillPerSecond) * 1000);
  }
}

/**
 * Sliding-window counter per key: at most `limit` hits per `windowMs`. `hit` records an attempt and
 * reports whether it is allowed (a rejected hit is not counted). /pair: 10 per IP per 10 min, 60 per
 * minute globally (handoff §6.2.7). Bounded to `maxKeys` keys (least recently hit evicted first).
 * A hit counts for exactly `windowMs`: one at t no longer counts at t + windowMs. When rejected,
 * retryAfterSeconds is when the oldest counted hit expires.
 */
export class WindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  /** Ascending hit times per key, at most `limit` of them. */
  readonly #hits: LruMap<number[]>;

  constructor(opts: { limit: number; windowMs: number; clock?: Clock; maxKeys?: number }) {
    assertPositiveInt('limit', opts.limit);
    assertPositive('windowMs', opts.windowMs);
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    assertPositiveInt('maxKeys', maxKeys);
    this.#limit = opts.limit;
    this.#windowMs = opts.windowMs;
    this.#clock = opts.clock ?? systemClock;
    this.#hits = new LruMap(maxKeys);
  }

  hit(key: string): LimitResult {
    const now = this.#clock.now();
    const hits = this.#hits.peek(key) ?? [];
    pruneBefore(hits, now - this.#windowMs);
    const result = this.#check(hits, now);
    if (result.ok) hits.push(monotonic(hits, now));
    // A rejected hit still makes the key recently used, so a hammering client isn't evicted first.
    this.#hits.set(key, hits);
    return result;
  }

  /** Check without recording. */
  peek(key: string): LimitResult {
    const now = this.#clock.now();
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.peek(key) ?? []).filter((t) => t > cutoff);
    return this.#check(hits, now);
  }

  /**
   * How much of the window `key` has used, without recording anything or changing the key's recency
   * (like peek): `count` hits are counted right now, `remaining` = limit − count (never below 0), and
   * `resetMs` is how long until the oldest counted hit expires, i.e. when `remaining` next goes up
   * (0 when nothing is counted). When the key is at its limit, `resetMs` rounded up to whole seconds
   * is peek's retryAfterSeconds. For X-RateLimit-* headers.
   */
  usage(key: string): { limit: number; count: number; remaining: number; resetMs: number } {
    const now = this.#clock.now();
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.peek(key) ?? []).filter((t) => t > cutoff);
    const oldest = hits[0];
    return {
      limit: this.#limit,
      count: hits.length,
      remaining: Math.max(0, this.#limit - hits.length),
      resetMs: oldest === undefined ? 0 : Math.max(0, oldest + this.#windowMs - now),
    };
  }

  /** `hits` must already be pruned to the window. */
  #check(hits: readonly number[], now: number): LimitResult {
    if (hits.length < this.#limit) return allowed();
    // The hit whose expiry brings the count back below the limit.
    const oldest = hits[hits.length - this.#limit] ?? now;
    return rejected(oldest + this.#windowMs - now);
  }
}

/**
 * Temporary lockout after repeated failures: `maxFailures` failures within `windowMs` lock the key for
 * `lockMs`. recordSuccess clears the failures. /pair: 20 invalid codes per IP within 1 h → 15 min lock.
 * Every failure that leaves ≥ maxFailures failures in the window (re)starts the lock, and failures stay
 * counted for the whole window: after a lock ends, one more failure within the window locks again.
 * recordSuccess doesn't lift an active lock. Bounded to `maxKeys` keys (least recently used evicted).
 */
export class FailureLockout {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #lockMs: number;
  readonly #clock: Clock;
  /** Ascending failure times (at most maxFailures) and the lock's end (0 = never locked). */
  readonly #state: LruMap<{ failures: number[]; lockedUntil: number }>;

  constructor(opts: {
    maxFailures: number;
    windowMs: number;
    lockMs: number;
    clock?: Clock;
    maxKeys?: number;
  }) {
    assertPositiveInt('maxFailures', opts.maxFailures);
    assertPositive('windowMs', opts.windowMs);
    assertPositive('lockMs', opts.lockMs);
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    assertPositiveInt('maxKeys', maxKeys);
    this.#maxFailures = opts.maxFailures;
    this.#windowMs = opts.windowMs;
    this.#lockMs = opts.lockMs;
    this.#clock = opts.clock ?? systemClock;
    this.#state = new LruMap(maxKeys);
  }

  /** Seconds remaining (integer ≥ 1) when locked, else 0. */
  lockedFor(key: string): number {
    const state = this.#state.peek(key);
    if (!state) return 0;
    this.#state.touch(key);
    const remainingMs = state.lockedUntil - this.#clock.now();
    return remainingMs > 0 ? wholeSeconds(remainingMs) : 0;
  }

  recordFailure(key: string): void {
    const now = this.#clock.now();
    const state = this.#state.peek(key) ?? { failures: [], lockedUntil: 0 };
    pruneBefore(state.failures, now - this.#windowMs);
    state.failures.push(monotonic(state.failures, now));
    const excess = state.failures.length - this.#maxFailures;
    if (excess > 0) state.failures.splice(0, excess);
    if (state.failures.length >= this.#maxFailures) {
      state.lockedUntil = Math.max(state.lockedUntil, now + this.#lockMs);
    }
    this.#state.set(key, state);
  }

  recordSuccess(key: string): void {
    const state = this.#state.peek(key);
    if (!state) return;
    if (state.lockedUntil > this.#clock.now()) state.failures = [];
    else this.#state.delete(key);
  }
}
