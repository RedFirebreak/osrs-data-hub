import { describe, expect, it } from 'vitest';
import {
  API_RATE_LIMIT,
  FAILED_AUTH_LIMIT,
  checkApiRate,
  checkAuthFailures,
  createApiLimits,
  rateHeaders,
  recordAuthFailure,
} from './limits';

const SEC = 1_000;

function setup() {
  const clock = {
    t: 1_790_000_000_000,
    now() {
      return this.t;
    },
  };
  return { clock, limits: createApiLimits({ clock }) };
}

describe('checkApiRate', () => {
  it('allows 120 requests per key per sliding minute, with the X-RateLimit headers', () => {
    const { clock, limits } = setup();
    const first = checkApiRate(limits, 'key-a', { snapshot: false });
    expect(first).toEqual({
      ok: true,
      headers: {
        'X-RateLimit-Limit': '120',
        'X-RateLimit-Remaining': '119',
        'X-RateLimit-Reset': '60',
      },
      retryAfterSeconds: 0,
    });
    clock.t += 20 * SEC;
    for (let i = 1; i < API_RATE_LIMIT - 1; i++) checkApiRate(limits, 'key-a', { snapshot: false });
    const last = checkApiRate(limits, 'key-a', { snapshot: false });
    expect(last.ok).toBe(true);
    expect(last.headers['X-RateLimit-Remaining']).toBe('0');
    expect(last.headers['X-RateLimit-Reset']).toBe('40');

    const refused = checkApiRate(limits, 'key-a', { snapshot: false });
    expect(refused).toEqual({
      ok: false,
      headers: {
        'X-RateLimit-Limit': '120',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '40',
      },
      retryAfterSeconds: 40,
      limit: 'key',
    });
    // Other keys are independent.
    expect(checkApiRate(limits, 'key-b', { snapshot: false }).ok).toBe(true);

    // The first request expires 60 s after it was made: one slot comes back.
    clock.t += 40 * SEC;
    const again = checkApiRate(limits, 'key-a', { snapshot: false });
    expect(again.ok).toBe(true);
    expect(again.headers['X-RateLimit-Remaining']).toBe('0');
    expect(again.headers['X-RateLimit-Reset']).toBe('20');
  });

  it('allows one /snapshot per key per second on top of the minute', () => {
    const { clock, limits } = setup();
    expect(checkApiRate(limits, 'k', { snapshot: true }).ok).toBe(true);
    const second = checkApiRate(limits, 'k', { snapshot: true });
    expect(second.ok).toBe(false);
    expect(second.limit).toBe('snapshot');
    expect(second.retryAfterSeconds).toBe(1);
    // Refused requests don't count towards the minute; other endpoints stay open.
    expect(second.headers['X-RateLimit-Remaining']).toBe('119');
    expect(checkApiRate(limits, 'k', { snapshot: false }).headers['X-RateLimit-Remaining']).toBe(
      '118',
    );
    clock.t += SEC;
    expect(checkApiRate(limits, 'k', { snapshot: true }).ok).toBe(true);
    expect(checkApiRate(limits, 'other', { snapshot: true }).ok).toBe(true);
  });

  it('refuses a snapshot when the minute is used up, without using up the second', () => {
    const { clock, limits } = setup();
    for (let i = 0; i < API_RATE_LIMIT; i++) checkApiRate(limits, 'k', { snapshot: false });
    const refused = checkApiRate(limits, 'k', { snapshot: true });
    expect(refused.ok).toBe(false);
    expect(refused.limit).toBe('key');
    expect(refused.retryAfterSeconds).toBe(60);
    clock.t += 60 * SEC;
    expect(checkApiRate(limits, 'k', { snapshot: true }).ok).toBe(true);
  });

  it('reports headers without counting (rateHeaders)', () => {
    const { limits } = setup();
    expect(rateHeaders(limits, 'fresh')).toEqual({
      'X-RateLimit-Limit': '120',
      'X-RateLimit-Remaining': '120',
      'X-RateLimit-Reset': '0',
    });
    checkApiRate(limits, 'fresh', { snapshot: false });
    expect(rateHeaders(limits, 'fresh')['X-RateLimit-Remaining']).toBe('119');
    expect(rateHeaders(limits, 'fresh')['X-RateLimit-Remaining']).toBe('119');
  });
});

describe('a limit per key (D-88)', () => {
  it('judges the key by its own limit and reports it in the headers', () => {
    const { clock, limits } = setup();
    for (let i = 0; i < 600; i++) {
      const r = checkApiRate(limits, 'service', { snapshot: false, limit: 600 });
      expect(r.ok, String(i)).toBe(true);
      expect(r.headers['X-RateLimit-Limit']).toBe('600');
    }
    const refused = checkApiRate(limits, 'service', { snapshot: false, limit: 600 });
    expect(refused).toMatchObject({
      ok: false,
      limit: 'key',
      retryAfterSeconds: 60,
      headers: { 'X-RateLimit-Limit': '600', 'X-RateLimit-Remaining': '0' },
    });
    expect(rateHeaders(limits, 'service', 600)['X-RateLimit-Limit']).toBe('600');
    // A user key on the same limiter keeps the default.
    expect(checkApiRate(limits, 'user', { snapshot: false }).headers['X-RateLimit-Limit']).toBe(
      String(API_RATE_LIMIT),
    );
    clock.t += 60 * SEC;
    expect(checkApiRate(limits, 'service', { snapshot: false, limit: 600 }).ok).toBe(true);
  });
});

describe('failed authentications per IP', () => {
  it('refuses an IP after 30 failures a minute, before any database work', () => {
    const { clock, limits } = setup();
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      expect(checkAuthFailures(limits, '203.0.113.7').ok).toBe(true);
      recordAuthFailure(limits, '203.0.113.7');
    }
    const blocked = checkAuthFailures(limits, '203.0.113.7');
    expect(blocked).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(checkAuthFailures(limits, '203.0.113.8').ok).toBe(true);
    clock.t += 60 * SEC;
    expect(checkAuthFailures(limits, '203.0.113.7').ok).toBe(true);
  });

  it('keys IPv6 clients by their /64, and clients without an address together', () => {
    const { limits } = setup();
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) recordAuthFailure(limits, `2001:db8:1:2::${i + 1}`);
    expect(checkAuthFailures(limits, '2001:db8:1:2:ffff::1').ok).toBe(false);
    expect(checkAuthFailures(limits, '2001:db8:1:3::1').ok).toBe(true);
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) recordAuthFailure(limits, null);
    expect(checkAuthFailures(limits, '').ok).toBe(false);
    expect(checkAuthFailures(limits, undefined).ok).toBe(false);
  });
});
