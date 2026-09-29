import { describe, expect, it } from 'vitest';
import {
  FailureLockout,
  TokenBucketLimiter,
  WindowLimiter,
  systemClock,
  type Clock,
  type LimitResult,
} from './ratelimit';

class FakeClock implements Clock {
  t = 1_790_000_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Retry-After must be a whole number ≥ 1 when rejected (PLUGIN-5), 0 when ok. */
function expectWellFormed(r: LimitResult): void {
  expect(Number.isInteger(r.retryAfterSeconds)).toBe(true);
  if (r.ok) expect(r.retryAfterSeconds).toBe(0);
  else expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
}

describe('systemClock', () => {
  it('is Date.now', () => {
    const before = Date.now();
    const t = systemClock.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe('retryAfterSeconds', () => {
  /** What goes into the Retry-After header: digits only, or the plugin falls back to backoff (PLUGIN-5). */
  const header = (r: LimitResult) => String(r.retryAfterSeconds);

  it('stays a plain safe integer for absurdly long waits', () => {
    const tb = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1e-300,
      clock: new FakeClock(),
    });
    tb.take('k');
    const t = tb.take('k');
    expect(t.ok).toBe(false);
    expect(Number.isSafeInteger(t.retryAfterSeconds)).toBe(true);
    expect(header(t)).toMatch(/^[1-9][0-9]*$/);

    const wl = new WindowLimiter({ limit: 1, windowMs: 1e300, clock: new FakeClock() });
    wl.hit('k');
    const w = wl.hit('k');
    expect(Number.isSafeInteger(w.retryAfterSeconds)).toBe(true);
    expect(header(w)).toMatch(/^[1-9][0-9]*$/);
    expect(wl.peek('k')).toEqual(w);

    const fl = new FailureLockout({
      maxFailures: 1,
      windowMs: 1,
      lockMs: 1e300,
      clock: new FakeClock(),
    });
    fl.recordFailure('k');
    expect(Number.isSafeInteger(fl.lockedFor('k'))).toBe(true);
    expect(String(fl.lockedFor('k'))).toMatch(/^[1-9][0-9]*$/);
  });
});

describe('TokenBucketLimiter', () => {
  /** Ingest: capacity 30, 5/s per device (handoff §7.6). */
  function ingest(clock = new FakeClock(), maxKeys?: number) {
    return {
      clock,
      limiter: new TokenBucketLimiter({ capacity: 30, refillPerSecond: 5, clock, maxKeys }),
    };
  }

  it('starts a new key full and allows a burst of `capacity`', () => {
    const { limiter } = ingest();
    for (let i = 0; i < 30; i++)
      expect(limiter.take('dev')).toEqual({ ok: true, retryAfterSeconds: 0 });
    const r = limiter.take('dev');
    expect(r).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('refills continuously at refillPerSecond', () => {
    const { clock, limiter } = ingest();
    for (let i = 0; i < 30; i++) limiter.take('dev');
    clock.advance(199);
    expect(limiter.take('dev').ok).toBe(false);
    clock.advance(1);
    expect(limiter.take('dev').ok).toBe(true);
    expect(limiter.take('dev').ok).toBe(false);
    // 600 ms × 5/s = exactly 3 tokens (no float drift).
    clock.advance(600);
    expect(
      [limiter.take('dev'), limiter.take('dev'), limiter.take('dev'), limiter.take('dev')].map(
        (r) => r.ok,
      ),
    ).toEqual([true, true, true, false]);
  });

  it('sustains 5 requests per second', () => {
    const { clock, limiter } = ingest();
    for (let i = 0; i < 30; i++) limiter.take('dev');
    let allowed = 0;
    for (let ms = 0; ms < 10 * SEC; ms += 10) {
      clock.advance(10);
      if (limiter.take('dev').ok) allowed++;
    }
    expect(allowed).toBe(50);
  });

  it('never refills above capacity', () => {
    const { clock, limiter } = ingest();
    limiter.take('dev');
    clock.advance(HOUR);
    for (let i = 0; i < 30; i++) expect(limiter.take('dev').ok).toBe(true);
    expect(limiter.take('dev').ok).toBe(false);
  });

  it("doesn't consume tokens on a rejected take", () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, clock });
    limiter.take('k');
    limiter.take('k');
    for (let i = 0; i < 5; i++) expect(limiter.take('k').ok).toBe(false);
    clock.advance(SEC);
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(false);
  });

  it('reports whole seconds until enough tokens are back (ceil, ≥ 1)', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.1, clock });
    limiter.take('k');
    expect(limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 10 });
    clock.advance(2_500);
    expect(limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 8 }); // 7.5 s → 8
    clock.advance(7_499);
    expect(limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 1 }); // 1 ms → 1
    clock.advance(1);
    expect(limiter.take('k').ok).toBe(true);
  });

  it("doesn't round a float-noisy wait up by a whole second", () => {
    const clock = new FakeClock();
    // 0.2 tokens left and 0.4/s: (1 − 0.2) / 0.4 = 2.0000000000000004 in floats; the answer is 2.
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.4, clock });
    limiter.take('k');
    clock.advance(500);
    expect(limiter.take('k')).toEqual({ ok: false, retryAfterSeconds: 2 });
  });

  it('waiting retryAfterSeconds is always enough', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 0.7, clock });
    for (let step = 0; step < 200; step++) {
      const r = limiter.take('k');
      expectWellFormed(r);
      if (!r.ok) {
        clock.advance(r.retryAfterSeconds * SEC);
        expect(limiter.take('k').ok).toBe(true);
      }
      clock.advance((step * 37) % 900);
    }
  });

  it('supports a cost above 1', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 2, clock });
    expect(limiter.take('k', 7).ok).toBe(true);
    const r = limiter.take('k', 5); // 3 left, needs 2 more → 1 s
    expect(r).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take('k', 3).ok).toBe(true);
    expect(limiter.take('k', 10)).toEqual({ ok: false, retryAfterSeconds: 5 });
    expect(limiter.take('k', 0).ok).toBe(true);
  });

  it('rejects an impossible or invalid cost', () => {
    const { limiter } = ingest();
    for (const cost of [-1, 31, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => limiter.take('dev', cost)).toThrow(RangeError);
    }
    expect(limiter.take('dev', 30).ok).toBe(true);
  });

  it('keeps keys independent', () => {
    const { limiter } = ingest();
    for (let i = 0; i < 30; i++) limiter.take('a');
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  it("doesn't mint tokens when the clock goes backwards", () => {
    const { clock, limiter } = ingest();
    for (let i = 0; i < 30; i++) limiter.take('dev');
    clock.advance(-10 * SEC);
    const r = limiter.take('dev');
    expect(r.ok).toBe(false);
    expectWellFormed(r);
    clock.advance(10 * SEC);
    expect(limiter.take('dev').ok).toBe(false);
    clock.advance(200);
    expect(limiter.take('dev').ok).toBe(true);
  });

  it('counts the paused refill in retryAfterSeconds after the clock went backwards', () => {
    const { clock, limiter } = ingest();
    for (let i = 0; i < 30; i++) limiter.take('dev');
    clock.advance(-10 * SEC);
    // Refilling resumes in 10 s, then one token takes 0.2 s: 10.2 s → 11.
    const r = limiter.take('dev');
    expect(r).toEqual({ ok: false, retryAfterSeconds: 11 });
    clock.advance(10 * SEC);
    expect(limiter.take('dev')).toEqual({ ok: false, retryAfterSeconds: 1 });
    clock.advance(SEC);
    expect(limiter.take('dev').ok).toBe(true);
  });

  it('evicts the least recently used key beyond maxKeys (it comes back full)', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0.001,
      clock,
      maxKeys: 2,
    });
    limiter.take('a');
    limiter.take('b');
    expect(limiter.take('a').ok).toBe(false); // a is now the most recently used
    limiter.take('c'); // evicts b
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true); // back full; evicts c
    expect(limiter.take('c').ok).toBe(true);
  });

  it('stays bounded under many keys', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0.001,
      clock,
      maxKeys: 100,
    });
    for (let i = 0; i < 1_000; i++) limiter.take(`k${i}`);
    expect(limiter.take('k999').ok).toBe(false);
    expect(limiter.take('k900').ok).toBe(false);
    expect(limiter.take('k0').ok).toBe(true);
    expect(limiter.take('k899').ok).toBe(true);
  });

  it('defaults to the system clock and 10 000 keys', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    for (let i = 0; i < 9_999; i++) limiter.take(`k${i}`);
    expect(limiter.take('a').ok).toBe(false); // still tracked
    limiter.take('one-more'); // 10 001st key evicts k0, not a
    expect(limiter.take('k0').ok).toBe(true);
  });

  it('validates its options', () => {
    const bad = [
      { capacity: 0, refillPerSecond: 1 },
      { capacity: -1, refillPerSecond: 1 },
      { capacity: Number.NaN, refillPerSecond: 1 },
      { capacity: 1, refillPerSecond: 0 },
      { capacity: 1, refillPerSecond: Number.POSITIVE_INFINITY },
      { capacity: 1, refillPerSecond: 1, maxKeys: 0 },
      { capacity: 1, refillPerSecond: 1, maxKeys: 1.5 },
    ];
    for (const opts of bad) expect(() => new TokenBucketLimiter(opts)).toThrow(RangeError);
  });
});

describe('WindowLimiter', () => {
  /** /pair: 10 per IP per 10 min (handoff §6.2.7). */
  function perIp(clock = new FakeClock()) {
    return { clock, limiter: new WindowLimiter({ limit: 10, windowMs: 10 * MIN, clock }) };
  }

  it('allows `limit` hits per window, then rejects until the oldest expires', () => {
    const { clock, limiter } = perIp();
    for (let i = 0; i < 10; i++)
      expect(limiter.hit('1.2.3.4')).toEqual({ ok: true, retryAfterSeconds: 0 });
    expect(limiter.hit('1.2.3.4')).toEqual({ ok: false, retryAfterSeconds: 600 });
    clock.advance(MIN);
    expect(limiter.hit('1.2.3.4')).toEqual({ ok: false, retryAfterSeconds: 540 });
    clock.advance(9 * MIN);
    expect(limiter.hit('1.2.3.4').ok).toBe(true);
  });

  it('slides: each hit expires windowMs after it happened', () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 3, windowMs: MIN, clock });
    limiter.hit('k'); // t=0
    clock.advance(20 * SEC);
    limiter.hit('k'); // t=20
    clock.advance(20 * SEC);
    limiter.hit('k'); // t=40
    clock.advance(10 * SEC);
    expect(limiter.hit('k')).toEqual({ ok: false, retryAfterSeconds: 10 }); // t=50, t=0 expires at 60
    clock.advance(10 * SEC);
    expect(limiter.hit('k').ok).toBe(true); // t=60
    expect(limiter.hit('k')).toEqual({ ok: false, retryAfterSeconds: 20 }); // t=20 expires at 80
  });

  it('counts a hit for exactly windowMs', () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 1, windowMs: 10 * SEC, clock });
    limiter.hit('k');
    clock.advance(10 * SEC - 1);
    expect(limiter.hit('k')).toEqual({ ok: false, retryAfterSeconds: 1 });
    clock.advance(1);
    expect(limiter.hit('k').ok).toBe(true);
  });

  it("doesn't count rejected hits", () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 1, windowMs: 10 * SEC, clock });
    limiter.hit('k');
    for (let i = 0; i < 9; i++) {
      clock.advance(SEC);
      expect(limiter.hit('k').ok).toBe(false);
    }
    clock.advance(SEC);
    expect(limiter.hit('k').ok).toBe(true);
  });

  it('rounds retryAfterSeconds up to whole seconds', () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 1, windowMs: 1_500, clock });
    limiter.hit('k');
    clock.advance(1);
    expect(limiter.hit('k').retryAfterSeconds).toBe(2); // 1.499 s
    clock.advance(1_000);
    expect(limiter.hit('k').retryAfterSeconds).toBe(1); // 0.499 s
    clock.advance(498);
    expect(limiter.hit('k').retryAfterSeconds).toBe(1); // 1 ms
  });

  it('works as the global /pair limit (60 per minute)', () => {
    const clock = new FakeClock();
    const global = new WindowLimiter({ limit: 60, windowMs: MIN, clock });
    for (let i = 0; i < 60; i++) {
      clock.advance(500);
      expect(global.hit('global').ok).toBe(true);
    }
    const r = global.hit('global');
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBe(31); // first hit at +0.5 s expires at +60.5 s; now +30 s → 30.5 s
  });

  it('keeps keys independent', () => {
    const { limiter } = perIp();
    for (let i = 0; i < 10; i++) limiter.hit('a');
    expect(limiter.hit('a').ok).toBe(false);
    expect(limiter.hit('b').ok).toBe(true);
  });

  describe('peek', () => {
    it('checks without recording', () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 1, windowMs: 10 * SEC, clock });
      expect(limiter.peek('k')).toEqual({ ok: true, retryAfterSeconds: 0 });
      expect(limiter.peek('k').ok).toBe(true);
      expect(limiter.hit('k').ok).toBe(true);
      clock.advance(4 * SEC);
      expect(limiter.peek('k')).toEqual({ ok: false, retryAfterSeconds: 6 });
      expect(limiter.hit('k')).toEqual({ ok: false, retryAfterSeconds: 6 });
      clock.advance(6 * SEC);
      expect(limiter.peek('k').ok).toBe(true);
      expect(limiter.hit('k').ok).toBe(true);
    });

    it('agrees with hit about expired hits', () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 2, windowMs: 10 * SEC, clock });
      limiter.hit('k');
      clock.advance(5 * SEC);
      limiter.hit('k');
      expect(limiter.peek('k')).toEqual({ ok: false, retryAfterSeconds: 5 });
      clock.advance(5 * SEC);
      expect(limiter.peek('k').ok).toBe(true);
    });

    it("doesn't add a key (or evict one)", () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 1, windowMs: 10 * SEC, clock, maxKeys: 1 });
      limiter.hit('a');
      for (let i = 0; i < 5; i++) expect(limiter.peek(`other${i}`).ok).toBe(true);
      expect(limiter.hit('a').ok).toBe(false);
    });
  });

  describe('usage', () => {
    it('reports the counted hits, what remains and when the oldest expires, without recording', () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 3, windowMs: 60 * SEC, clock });
      expect(limiter.usage('k')).toEqual({ limit: 3, count: 0, remaining: 3, resetMs: 0 });
      limiter.hit('k');
      clock.advance(10 * SEC);
      limiter.hit('k');
      expect(limiter.usage('k')).toEqual({ limit: 3, count: 2, remaining: 1, resetMs: 50 * SEC });
      expect(limiter.usage('k').count).toBe(2);
      limiter.hit('k');
      limiter.hit('k'); // rejected, not counted
      expect(limiter.usage('k')).toEqual({ limit: 3, count: 3, remaining: 0, resetMs: 50 * SEC });
      clock.advance(50 * SEC);
      expect(limiter.usage('k')).toEqual({ limit: 3, count: 2, remaining: 1, resetMs: 10 * SEC });
    });

    it('agrees with peek about when a key at its limit may hit again', () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 2, windowMs: 10 * SEC, clock });
      limiter.hit('k');
      clock.advance(2_500);
      limiter.hit('k');
      const peek = limiter.peek('k');
      expect(peek.ok).toBe(false);
      expect(Math.ceil(limiter.usage('k').resetMs / SEC)).toBe(peek.retryAfterSeconds);
    });

    it("doesn't add a key (or evict one)", () => {
      const clock = new FakeClock();
      const limiter = new WindowLimiter({ limit: 1, windowMs: 10 * SEC, clock, maxKeys: 1 });
      limiter.hit('a');
      for (let i = 0; i < 5; i++) expect(limiter.usage(`other${i}`).count).toBe(0);
      expect(limiter.hit('a').ok).toBe(false);
    });
  });

  it('evicts the least recently hit key beyond maxKeys', () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 1, windowMs: HOUR, clock, maxKeys: 2 });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.hit('a').ok).toBe(false); // a rejected but still the most recently hit
    limiter.hit('c'); // evicts b
    expect(limiter.hit('a').ok).toBe(false);
    expect(limiter.hit('b').ok).toBe(true);
  });

  it("peeking doesn't protect a key from eviction", () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 1, windowMs: HOUR, clock, maxKeys: 2 });
    limiter.hit('a');
    limiter.hit('b');
    limiter.peek('a');
    limiter.hit('c'); // evicts a
    expect(limiter.hit('a').ok).toBe(true);
  });

  it('stays rejected (and well-formed) when the clock goes backwards', () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ limit: 2, windowMs: 10 * SEC, clock });
    limiter.hit('k');
    clock.advance(-5 * SEC);
    expect(limiter.hit('k').ok).toBe(true);
    const r = limiter.hit('k');
    expect(r.ok).toBe(false);
    expectWellFormed(r);
    expect(r.retryAfterSeconds).toBe(15);
    clock.advance(15 * SEC);
    expect(limiter.hit('k').ok).toBe(true);
  });

  it('defaults to the system clock', () => {
    const limiter = new WindowLimiter({ limit: 1, windowMs: HOUR });
    expect(limiter.hit('k').ok).toBe(true);
    const r = limiter.hit('k');
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(3_590);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(3_600);
  });

  it('validates its options', () => {
    const bad = [
      { limit: 0, windowMs: 1 },
      { limit: 1.5, windowMs: 1 },
      { limit: 1, windowMs: 0 },
      { limit: 1, windowMs: Number.NaN },
      { limit: 1, windowMs: 1, maxKeys: 0 },
    ];
    for (const opts of bad) expect(() => new WindowLimiter(opts)).toThrow(RangeError);
  });
});

describe('FailureLockout', () => {
  /** /pair: 20 invalid codes per IP within 1 h → 15 min lock. */
  function pair(clock = new FakeClock(), maxKeys?: number) {
    return {
      clock,
      lockout: new FailureLockout({
        maxFailures: 20,
        windowMs: HOUR,
        lockMs: 15 * MIN,
        clock,
        maxKeys,
      }),
    };
  }
  const fail = (l: FailureLockout, key: string, n: number) => {
    for (let i = 0; i < n; i++) l.recordFailure(key);
  };

  it('is not locked for an unknown key', () => {
    const { lockout } = pair();
    expect(lockout.lockedFor('1.2.3.4')).toBe(0);
  });

  it('locks on the maxFailures-th failure within the window', () => {
    const { lockout } = pair();
    fail(lockout, 'ip', 19);
    expect(lockout.lockedFor('ip')).toBe(0);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it('counts the lock down in whole seconds (ceil) and then unlocks', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 20);
    clock.advance(500);
    expect(lockout.lockedFor('ip')).toBe(900); // 899.5 s
    clock.advance(MIN - 500);
    expect(lockout.lockedFor('ip')).toBe(840);
    clock.advance(14 * MIN - 1);
    expect(lockout.lockedFor('ip')).toBe(1);
    clock.advance(1);
    expect(lockout.lockedFor('ip')).toBe(0);
  });

  it('only counts failures within the window', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 19);
    clock.advance(HOUR);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(0);
  });

  it('slides: failures spread over the window add up', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 10);
    clock.advance(30 * MIN);
    fail(lockout, 'ip', 9);
    expect(lockout.lockedFor('ip')).toBe(0);
    clock.advance(29 * MIN);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it('locks again on one more failure within the window after a lock ends', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 20);
    clock.advance(15 * MIN);
    expect(lockout.lockedFor('ip')).toBe(0);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it('starts fresh once the failures have left the window', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 20);
    clock.advance(HOUR);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(0);
    fail(lockout, 'ip', 18);
    expect(lockout.lockedFor('ip')).toBe(0);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it('restarts the lock on a failure while locked', () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 20);
    clock.advance(10 * MIN);
    expect(lockout.lockedFor('ip')).toBe(300);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it('recordSuccess clears the failures', () => {
    const { lockout } = pair();
    fail(lockout, 'ip', 19);
    lockout.recordSuccess('ip');
    fail(lockout, 'ip', 19);
    expect(lockout.lockedFor('ip')).toBe(0);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
  });

  it("recordSuccess doesn't lift an active lock, but the failures are gone after it", () => {
    const { clock, lockout } = pair();
    fail(lockout, 'ip', 20);
    lockout.recordSuccess('ip');
    expect(lockout.lockedFor('ip')).toBe(900);
    clock.advance(15 * MIN);
    expect(lockout.lockedFor('ip')).toBe(0);
    lockout.recordFailure('ip');
    expect(lockout.lockedFor('ip')).toBe(0);
  });

  it('recordSuccess on an unknown key is a no-op', () => {
    const { lockout } = pair();
    expect(() => lockout.recordSuccess('nobody')).not.toThrow();
    expect(lockout.lockedFor('nobody')).toBe(0);
  });

  it("lockedFor and recordSuccess don't add keys (so they can't evict a locked one)", () => {
    const clock = new FakeClock();
    const lockout = new FailureLockout({
      maxFailures: 1,
      windowMs: HOUR,
      lockMs: HOUR,
      clock,
      maxKeys: 1,
    });
    lockout.recordFailure('attacker');
    for (let i = 0; i < 5; i++) {
      expect(lockout.lockedFor(`probe${i}`)).toBe(0);
      lockout.recordSuccess(`probe${i}`);
    }
    expect(lockout.lockedFor('attacker')).toBe(3_600);
  });

  it('keeps keys independent', () => {
    const { lockout } = pair();
    fail(lockout, 'a', 20);
    fail(lockout, 'b', 19);
    expect(lockout.lockedFor('a')).toBe(900);
    expect(lockout.lockedFor('b')).toBe(0);
  });

  it('maxFailures 1 locks on the first failure', () => {
    const clock = new FakeClock();
    const lockout = new FailureLockout({ maxFailures: 1, windowMs: MIN, lockMs: 1_500, clock });
    lockout.recordFailure('k');
    expect(lockout.lockedFor('k')).toBe(2);
  });

  it('evicts the least recently used key beyond maxKeys', () => {
    const clock = new FakeClock();
    const lockout = new FailureLockout({
      maxFailures: 1,
      windowMs: HOUR,
      lockMs: HOUR,
      clock,
      maxKeys: 2,
    });
    lockout.recordFailure('a');
    lockout.recordFailure('b');
    expect(lockout.lockedFor('a')).toBe(3_600); // touches a
    lockout.recordFailure('c'); // evicts b
    expect(lockout.lockedFor('a')).toBe(3_600);
    expect(lockout.lockedFor('b')).toBe(0);
    expect(lockout.lockedFor('c')).toBe(3_600);
  });

  it('stays bounded under many keys', () => {
    const { lockout } = pair(new FakeClock(), 100);
    for (let i = 0; i < 1_000; i++) fail(lockout, `ip${i}`, 20);
    expect(lockout.lockedFor('ip999')).toBe(900);
    expect(lockout.lockedFor('ip900')).toBe(900);
    expect(lockout.lockedFor('ip0')).toBe(0);
  });

  it('defaults to the system clock', () => {
    const lockout = new FailureLockout({ maxFailures: 1, windowMs: HOUR, lockMs: 15 * MIN });
    lockout.recordFailure('k');
    const s = lockout.lockedFor('k');
    expect(s).toBeGreaterThan(895);
    expect(s).toBeLessThanOrEqual(900);
  });

  it('validates its options', () => {
    const bad = [
      { maxFailures: 0, windowMs: 1, lockMs: 1 },
      { maxFailures: 2.5, windowMs: 1, lockMs: 1 },
      { maxFailures: 1, windowMs: 0, lockMs: 1 },
      { maxFailures: 1, windowMs: 1, lockMs: 0 },
      { maxFailures: 1, windowMs: 1, lockMs: -5 },
      { maxFailures: 1, windowMs: 1, lockMs: 1, maxKeys: -1 },
    ];
    for (const opts of bad) expect(() => new FailureLockout(opts)).toThrow(RangeError);
  });
});
