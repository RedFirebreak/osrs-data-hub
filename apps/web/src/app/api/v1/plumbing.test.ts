/**
 * The /api/v1 plumbing every endpoint shares (withApiKey, cors.ts, the catch-all): CORS on every
 * response and the preflight, bearer-only authentication with one 401 for every failure, the
 * failed-authentication limit per IP (answered before any database access), the per-key limits with
 * their headers, the 1/s /snapshot limit, and the hub_api_* metrics they record.
 */
import { users, type DbHandle } from '@hub/db';
import { API_RATE_LIMIT, FAILED_AUTH_LIMIT, getMetrics, revokeApiKey } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiLimits, setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import * as catchAll from './[[...rest]]/route';
import * as accountRoute from './accounts/[id]/route';
import * as equipmentRoute from './accounts/[id]/equipment-history/route';
import * as gainsRoute from './accounts/[id]/gains/route';
import * as locationsRoute from './accounts/[id]/locations/route';
import * as sessionsRoute from './accounts/[id]/sessions/route';
import * as wealthRoute from './accounts/[id]/wealth/route';
import * as accountXpRoute from './accounts/[id]/xp/route';
import * as accountsRoute from './accounts/route';
import * as eventsRoute from './events/route';
import * as leaderboardRoute from './leaderboards/gains/route';
import * as meRoute from './me/route';
import * as openapiRoute from './openapi.json/route';
import * as snapshotRoute from './snapshot/route';
import {
  ACCOUNT_404,
  RANDOM_ID,
  expectCors,
  freshLimits,
  idParams,
  makeKey,
  v1Request,
  type TestKey,
} from './test-support';
import * as xpRoute from './xp/route';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

const g = globalThis as unknown as { __hubDb?: DbHandle };

let ctx: WebTestContext;
let userId: string;
let key: TestKey;
let clock: { advance(ms: number): void };

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1plumbing' });
  userId = await ctx.seedUser();
  key = await makeKey(ctx, userId);
});
beforeEach(() => {
  clock = freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

const me = (opts: Parameters<typeof v1Request>[2] = {}) => meRoute.GET(v1Request(ctx, '/me', opts));

describe('CORS', () => {
  it('is on a 200, with no-store and the rate-limit headers, and never allows credentials', async () => {
    const res = await me({ key: key.key });
    expect(res.status).toBe(200);
    expectCors(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-ratelimit-limit')).toBe(String(API_RATE_LIMIT));
    expect(res.headers.get('x-ratelimit-remaining')).toBe(String(API_RATE_LIMIT - 1));
    expect(res.headers.get('x-ratelimit-reset')).toMatch(/^\d+$/);
  });

  it('is on a 401, a 404 and a 429', async () => {
    const unauthorized = await me();
    expect(unauthorized.status).toBe(401);
    expectCors(unauthorized);

    const missing = await accountRoute.GET(
      v1Request(ctx, `/accounts/${RANDOM_ID}`, { key: key.key }),
      idParams(RANDOM_ID),
    );
    expect(missing.status).toBe(404);
    expectCors(missing);
    expect(await missing.json()).toEqual(ACCOUNT_404);
    // An authenticated error still carries the key's rate-limit state.
    expect(missing.headers.get('x-ratelimit-remaining')).toBe(String(API_RATE_LIMIT - 1));

    for (let i = 0; i < API_RATE_LIMIT; i++) getApiLimits().perKey.hit(key.info.id);
    const limited = await me({ key: key.key });
    expect(limited.status).toBe(429);
    expectCors(limited);
  });

  it('answers OPTIONS on every v1 route with 204, the preflight headers, no auth and no body', async () => {
    const routes = [
      meRoute,
      accountsRoute,
      accountRoute,
      accountXpRoute,
      gainsRoute,
      sessionsRoute,
      equipmentRoute,
      wealthRoute,
      locationsRoute,
      snapshotRoute,
      xpRoute,
      eventsRoute,
      leaderboardRoute,
      openapiRoute,
      catchAll,
    ];
    for (const route of routes) {
      const res = route.OPTIONS();
      expect(res.status).toBe(204);
      expectCors(res);
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe(
        'Authorization, If-None-Match, Content-Type',
      );
      expect(res.headers.get('access-control-max-age')).toBe('600');
      expect(await res.text()).toBe('');
    }
  });

  it('answers unknown v1 paths with a JSON 404 and CORS (not an HTML page)', async () => {
    for (const handler of [catchAll.GET, catchAll.POST, catchAll.DELETE]) {
      const res = await handler();
      expect(res.status).toBe(404);
      expectCors(res);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });
});

describe('authentication', () => {
  it('ignores cookies: a signed-in browser without a key gets 401', async () => {
    const cookie = await ctx.signIn(userId);
    const res = await meRoute.GET(
      ctx.request('/api/v1/me', { cookie, headers: { 'x-forwarded-for': '192.0.2.20' } }),
    );
    expect(res.status).toBe(401);
  });

  it('answers every refused key with the same 401 body and WWW-Authenticate: Bearer', async () => {
    const revoked = await makeKey(ctx, userId, { name: 'revoked' });
    await revokeApiKey(ctx.t.db, { userId, keyId: revoked.info.id });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const expired = await makeKey(ctx, userId, { name: 'expired', expiresInDays: 1 }, twoDaysAgo);
    const leaverId = await ctx.seedUser();
    const leaver = await makeKey(ctx, leaverId, { name: 'leaver' });
    await ctx.t.db.update(users).set({ status: 'grace' }).where(eq(users.id, leaverId));

    const wrongSecret = `ohub_${key.info.prefix}_${'x'.repeat(43)}`;
    const unknownPrefix = `ohub_${'Q'.repeat(10)}_${key.key.slice(-43)}`;
    const cases: [string, Record<string, string>][] = [
      ['missing', {}],
      ['malformed', { authorization: 'Bearer not-a-key' }],
      ['wrong scheme', { authorization: `Basic ${key.key}` }],
      ['unknown prefix', { authorization: `Bearer ${unknownPrefix}` }],
      ['wrong secret', { authorization: `Bearer ${wrongSecret}` }],
      ['revoked', { authorization: `Bearer ${revoked.key}` }],
      ['expired', { authorization: `Bearer ${expired.key}` }],
      ['inactive creator', { authorization: `Bearer ${leaver.key}` }],
    ];
    const bodies = new Set<string>();
    for (const [label, headers] of cases) {
      const res = await me({ headers, ip: '192.0.2.21' });
      expect(res.status, label).toBe(401);
      expect(res.headers.get('www-authenticate'), label).toBe('Bearer');
      expect(res.headers.get('x-ratelimit-limit'), label).toBeNull();
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const [body] = [...bodies];
    expect(JSON.parse(body ?? '')).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) as string },
    });
  });

  it('accepts the scheme name in any case', async () => {
    const res = await me({ headers: { authorization: `bEaReR ${key.key}` } });
    expect(res.status).toBe(200);
  });
});

describe('failed-authentication limit per client IP', () => {
  const bad = { authorization: `Bearer ohub_${'Q'.repeat(10)}_${'q'.repeat(43)}` };

  it(`answers 429 after ${FAILED_AUTH_LIMIT} failures, before touching the database`, async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) {
      expect((await me({ headers: bad, ip })).status).toBe(401);
    }
    const limited = await me({ key: key.key, ip });
    expect(limited.status).toBe(429);
    expectCors(limited);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    // Any database access would now throw (→ 500): the limit is checked first.
    const real = g.__hubDb;
    g.__hubDb = {
      db: new Proxy(
        {},
        {
          get() {
            throw new Error('the database was touched');
          },
        },
      ) as DbHandle['db'],
      pool: real?.pool as DbHandle['pool'],
    };
    try {
      expect((await me({ key: key.key, ip })).status).toBe(429);
    } finally {
      g.__hubDb = real;
    }

    // Other clients aren't affected, and the window passes.
    expect((await me({ key: key.key, ip: '198.51.100.8' })).status).toBe(200);
    clock.advance(61_000);
    expect((await me({ key: key.key, ip })).status).toBe(200);
  });

  it('does not count requests without any Authorization header', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < FAILED_AUTH_LIMIT + 5; i++) {
      expect((await me({ ip })).status).toBe(401);
    }
    expect((await me({ key: key.key, ip })).status).toBe(200);
  });

  it('shares one bucket for requests without a client IP', async () => {
    const noIp = () => meRoute.GET(ctx.request('/api/v1/me', { headers: bad, sameOrigin: false }));
    for (let i = 0; i < FAILED_AUTH_LIMIT; i++) expect((await noIp()).status).toBe(401);
    expect((await noIp()).status).toBe(429);
  });
});

describe('per-key limits', () => {
  it(`answers 429 with an integer Retry-After once ${API_RATE_LIMIT} requests are used`, async () => {
    for (let i = 0; i < API_RATE_LIMIT - 1; i++) getApiLimits().perKey.hit(key.info.id);
    const last = await me({ key: key.key });
    expect(last.status).toBe(200);
    expect(last.headers.get('x-ratelimit-remaining')).toBe('0');

    const limited = await me({ key: key.key });
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get('x-ratelimit-limit')).toBe(String(API_RATE_LIMIT));
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('x-ratelimit-reset')).toBe(retryAfter);

    // Other keys have their own budget.
    const other = await makeKey(ctx, userId, { name: 'other' });
    expect((await me({ key: other.key })).status).toBe(200);

    clock.advance(61_000);
    expect((await me({ key: key.key })).status).toBe(200);
  });

  it('limits /snapshot to one request per second per key', async () => {
    const snapshot = () => snapshotRoute.GET(v1Request(ctx, '/snapshot', { key: key.key }));
    expect((await snapshot()).status).toBe(200);
    const limited = await snapshot();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expectCors(limited);
    // A refused snapshot doesn't use up the minute: only the first request was counted.
    expect(limited.headers.get('x-ratelimit-remaining')).toBe(String(API_RATE_LIMIT - 1));
    // Other endpoints aren't held back by it.
    expect((await me({ key: key.key })).status).toBe(200);
    clock.advance(1_000);
    expect((await snapshot()).status).toBe(200);
  });
});

/** A metric's values keyed by the given labels' values ("a|b"). The registry is the process's. */
async function valuesBy(
  metric: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
  labels: string[],
  metricName?: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of (await metric.get()).values) {
    if (metricName !== undefined && (v as { metricName?: string }).metricName !== metricName) {
      continue;
    }
    out[labels.map((l) => String(v.labels[l])).join('|')] = v.value;
  }
  return out;
}

/** What `run` added to a metric, by label values (unchanged entries left out). */
async function added(
  read: () => Promise<Record<string, number>>,
  run: () => Promise<unknown>,
): Promise<Record<string, number>> {
  const before = await read();
  await run();
  const after = await read();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    if (v !== (before[k] ?? 0)) out[k] = v - (before[k] ?? 0);
  }
  return out;
}

describe('metrics (D-83)', () => {
  const requests = () => valuesBy(getMetrics().apiRequests, ['group', 'status']);

  it('counts every request by route group and status, and times it', async () => {
    const timed = () =>
      valuesBy(getMetrics().apiLatency, ['group'], 'hub_api_request_duration_seconds_count');
    const run = async () => {
      expect((await me({ key: key.key })).status).toBe(200);
      const account = accountRoute.GET(
        v1Request(ctx, `/accounts/${RANDOM_ID}`, { key: key.key }),
        idParams(RANDOM_ID),
      );
      expect((await account).status).toBe(404);
      expect((await snapshotRoute.GET(v1Request(ctx, '/snapshot', { key: key.key }))).status).toBe(
        200,
      );
      expect((await xpRoute.GET(v1Request(ctx, '/xp?accounts=x'))).status).toBe(401);
      expect((await openapiRoute.GET()).status).toBe(200);
      expect((await catchAll.GET()).status).toBe(404);
    };
    let latency: Record<string, number> = {};
    const counted = await added(requests, async () => {
      latency = await added(timed, run);
    });

    expect(counted).toEqual({
      'me|200': 1,
      'accounts|404': 1,
      'snapshot|200': 1,
      'xp|401': 1,
      'openapi|200': 1,
      'unknown|404': 1,
    });
    expect(latency).toEqual({ me: 1, accounts: 1, snapshot: 1, xp: 1, openapi: 1, unknown: 1 });
  });

  it('counts refused keys by reason, never with the key', async () => {
    const failures = () => valuesBy(getMetrics().apiAuthFailures, ['reason']);
    const wrongSecret = `ohub_${key.info.prefix}_${'x'.repeat(43)}`;
    const counted = await added(failures, async () => {
      await me({ ip: '192.0.2.31' });
      await me({ headers: { authorization: 'Bearer not-a-key' }, ip: '192.0.2.31' });
      await me({ headers: { authorization: `Bearer ${wrongSecret}` }, ip: '192.0.2.31' });
    });
    expect(counted).toEqual({ missing: 1, malformed: 1, unknown: 1 });
    const text = await getMetrics().registry.metrics();
    expect(text).not.toContain(key.info.prefix);
  });

  it('counts 429s by the limit that refused them', async () => {
    const limited = () => valuesBy(getMetrics().apiRateLimited, ['limit']);
    const bad = { authorization: `Bearer ohub_${'Q'.repeat(10)}_${'q'.repeat(43)}` };
    const counted = await added(limited, async () => {
      // /snapshot twice in a second.
      await snapshotRoute.GET(v1Request(ctx, '/snapshot', { key: key.key }));
      expect((await snapshotRoute.GET(v1Request(ctx, '/snapshot', { key: key.key }))).status).toBe(
        429,
      );
      // The per-key minute.
      for (let i = 0; i < API_RATE_LIMIT; i++) getApiLimits().perKey.hit(key.info.id);
      expect((await me({ key: key.key })).status).toBe(429);
      // The failed-authentication limit of one IP.
      const ip = '198.51.100.30';
      for (let i = 0; i < FAILED_AUTH_LIMIT; i++) await me({ headers: bad, ip });
      expect((await me({ headers: bad, ip })).status).toBe(429);
    });
    expect(counted).toEqual({ snapshot: 1, key: 1, auth_ip: 1 });
  });
});
