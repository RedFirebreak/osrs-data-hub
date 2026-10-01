/**
 * The account read routes: GET /api/app/accounts/[publicId]/{xp,locations}.
 * Auth (401), visibility and category gating (404, existence never leaks), query validation (400)
 * and the happy paths over seeded rows.
 */
import { CATEGORIES } from '@hub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getLocations } from './[publicId]/locations/route';
import { GET as getXp } from './[publicId]/xp/route';
import { accountSeeder, type AccountSeeder, type SeededAccount } from './test-seed';

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'accountroutes' });
  seed = accountSeeder(ctx.t.db);
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

type Handler = (
  request: Request,
  ctx: { params: Promise<{ publicId: string }> },
) => Promise<Response>;

function call(handler: Handler, publicId: string, query: string, cookie?: string) {
  const path = `/api/app/accounts/${publicId}/x${query}`;
  return handler(ctx.request(path, { cookie }), { params: Promise.resolve({ publicId }) });
}

async function signedIn(opts: Parameters<WebTestContext['seedUser']>[0] = {}) {
  const userId = await ctx.seedUser(opts);
  return { userId, cookie: await ctx.signIn(userId) };
}

const HOUR = 60 * 60 * 1000;

describe('GET /api/app/accounts/[publicId]/xp', () => {
  let owner: { userId: string; cookie: string };
  let account: SeededAccount;

  beforeAll(async () => {
    owner = await signedIn();
    account = await seed.account({ owner: owner.userId, name: 'Xp Owner' });
    await seed.xp(account.id, [
      ['Attack', '2026-09-20T10:00:00Z', 1_000],
      ['Attack', '2026-09-22T10:00:00Z', 2_000],
      ['Attack', '2026-09-25T10:05:00Z', 5_000],
      ['Overall', '2026-09-22T10:00:00Z', 50_000],
    ]);
  });

  it('401 without a session', async () => {
    const res = await call(getXp, account.publicId, '');
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('unauthorized');
  });

  it('returns the series with the value in effect at the range start (last value per bucket)', async () => {
    const res = await call(
      getXp,
      account.publicId,
      '?skills=Attack,Overall&from=2026-09-21T00:00:00Z&to=2026-09-26T00:00:00Z&resolution=5m',
      owner.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      resolution: string;
      series: { skill: string; points: [string, number][] }[];
    };
    expect(body.resolution).toBe('5m');
    expect(body.series.map((s) => s.skill)).toEqual(['Attack', 'Overall']);
    expect(body.series[0]?.points).toEqual([
      ['2026-09-21T00:00:00.000Z', 1_000],
      ['2026-09-22T10:00:00.000Z', 2_000],
      ['2026-09-25T10:05:00.000Z', 5_000],
    ]);
    expect(body.series[1]?.points).toEqual([['2026-09-22T10:00:00.000Z', 50_000]]);
  });

  it('defaults to Overall, the last 30 days and auto resolution', async () => {
    const res = await call(getXp, account.publicId, '', owner.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolution: string; series: { skill: string }[] };
    expect(body.resolution).toBe('1h');
    expect(body.series.map((s) => s.skill)).toEqual(['Overall']);
  });

  it('leaves unknown skill names out', async () => {
    const res = await call(getXp, account.publicId, '?skills=Attack,Dancing', owner.cookie);
    const body = (await res.json()) as { series: { skill: string }[] };
    expect(body.series.map((s) => s.skill)).toEqual(['Attack']);
  });

  it('400 with field errors for a malformed query', async () => {
    const cases: [string, string][] = [
      ['?from=yesterday', 'from'],
      ['?to=2026-09-29', 'to'],
      ['?resolution=1m', 'resolution'],
      ['?skills=Attack,,Overall', 'skills.1'],
      ['?skills=Attack;DROP', 'skills.0'],
      ['?from=2026-09-29T00:00:00Z&to=2026-09-28T00:00:00Z', 'from'],
      [`?skills=${Array.from({ length: 31 }, () => 'Attack').join(',')}`, 'skills'],
    ];
    for (const [query, path] of cases) {
      const res = await call(getXp, account.publicId, query, owner.cookie);
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('invalid_request');
      expect(
        body.error.details?.map((d) => d.path),
        query,
      ).toContain(path);
    }
  });

  it('404 for an unknown account, an account the viewer cannot see, and without stats', async () => {
    const stranger = await signedIn();
    expect((await call(getXp, 'NoSuchAccount1', '', stranger.cookie)).status).toBe(404);

    const hidden = await seed.account({ owner: owner.userId });
    for (const category of CATEGORIES) {
      await seed.sharing(hidden.id, category, 'private');
    }
    const res = await call(getXp, hidden.publicId, '', stranger.cookie);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');

    // Visible (events shared with the guild), but stats private.
    const noStats = await seed.account({ owner: owner.userId });
    await seed.sharing(noStats.id, 'stats', 'private');
    expect((await call(getXp, noStats.publicId, '', stranger.cookie)).status).toBe(404);
    // The owner still sees it.
    expect((await call(getXp, noStats.publicId, '', owner.cookie)).status).toBe(200);
  });

  it('a guild member sees default-shared stats; a member in grace gets 401', async () => {
    const member = await signedIn();
    expect((await call(getXp, account.publicId, '', member.cookie)).status).toBe(200);
    const inGrace = await signedIn({ status: 'grace' });
    expect((await call(getXp, account.publicId, '', inGrace.cookie)).status).toBe(401);
  });
});

describe('GET /api/app/accounts/[publicId]/locations', () => {
  let owner: { userId: string; cookie: string };
  let member: { userId: string; cookie: string };
  let account: SeededAccount;
  const now = Date.now();

  beforeAll(async () => {
    owner = await signedIn();
    member = await signedIn();
    account = await seed.account({ owner: owner.userId, name: 'History' });
    await seed.location(account.id, new Date(now - 10 * 60 * 1000), {
      x: 3222,
      y: 3218,
      world: 302,
    });
    await seed.location(account.id, new Date(now - 20 * 24 * HOUR), { x: 3100, y: 3100 });
  });

  it('401 without a session', async () => {
    expect((await call(getLocations, account.publicId, '')).status).toBe(401);
  });

  it('the trail of the last 30 days by default, oldest first', async () => {
    const res = await call(getLocations, account.publicId, '', owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { from: string; to: string; points: unknown[] };
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(30 * 24 * HOUR);
    expect(body.points).toMatchObject([
      { x: 3100, y: 3100 },
      { x: 3222, y: 3218, plane: 0, world: 302, onBoat: false },
    ]);

    const narrow = await call(
      getLocations,
      account.publicId,
      `?from=${new Date(now - HOUR).toISOString()}`,
      owner.cookie,
    );
    expect(((await narrow.json()) as { points: unknown[] }).points).toHaveLength(1);
  });

  it('is gated by location_history: private is 404 for a member, not for the owner', async () => {
    expect((await call(getLocations, account.publicId, '', member.cookie)).status).toBe(200);
    await seed.sharing(account.id, 'location_history', 'private');
    const res = await call(getLocations, account.publicId, '', member.cookie);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
    expect((await call(getLocations, account.publicId, '', owner.cookie)).status).toBe(200);
  });

  it("follows the owner's sharing: selected grants", async () => {
    const shared = await seed.account({ owner: owner.userId });
    await seed.sharing(shared.id, 'location_history', 'selected');
    await seed.grant(shared.id, 'location_history', member.userId);
    const other = await signedIn();
    expect((await call(getLocations, shared.publicId, '', member.cookie)).status).toBe(200);
    expect((await call(getLocations, shared.publicId, '', other.cookie)).status).toBe(404);
  });

  it('a contributor sees every category; a hidden account is 404 for all but admins', async () => {
    const contributor = await signedIn();
    const admin = await signedIn({ isAdmin: true });
    const acc = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
    await seed.sharing(acc.id, 'location_history', 'private');
    expect((await call(getLocations, acc.publicId, '', contributor.cookie)).status).toBe(200);

    const hidden = await seed.account({ owner: owner.userId, status: 'hidden' });
    expect((await call(getLocations, hidden.publicId, '', owner.cookie)).status).toBe(404);
    expect((await call(getLocations, hidden.publicId, '', admin.cookie)).status).toBe(200);
  });

  it('400 for a malformed or inverted range', async () => {
    for (const query of [
      '?from=1',
      '?to=not-a-date',
      '?from=2026-09-29T00:00:00Z&to=2026-09-01T00:00:00Z',
    ]) {
      const res = await call(getLocations, account.publicId, query, owner.cookie);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_request');
    }
  });

  it('404 for a public id that is too long to exist', async () => {
    const res = await call(getLocations, 'x'.repeat(100), '', owner.cookie);
    expect(res.status).toBe(404);
  });

  it('404, not a database error, for a public id that cannot exist (NUL byte, other characters)', async () => {
    // Next decodes `%00` in the path into a NUL character, which Postgres refuses as a parameter
    // (22021); such an id matches no account, so it is the same 404 as any unknown id.
    for (const publicId of ['abc\u0000def', 'a b', 'Zézima', '../x']) {
      for (const handler of [getXp, getLocations]) {
        const res = await call(handler, publicId, '', owner.cookie);
        expect(res.status, JSON.stringify(publicId)).toBe(404);
        expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
      }
    }
  });
});
