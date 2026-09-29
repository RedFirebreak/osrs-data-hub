import { DEFAULT_TOAST_FILTER } from '@hub/core';
import { userSettings } from '@hub/db';
import type { UserSettings } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET, PATCH } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appsettings' });
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function patch(cookie: string | undefined, body: unknown, opts: { origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  return PATCH(
    ctx.request('/api/app/settings', {
      method: 'PATCH',
      cookie,
      json: body,
      headers,
      sameOrigin: opts.origin === undefined,
    }),
  );
}

describe('GET /api/app/settings', () => {
  it('401 without a session', async () => {
    const res = await GET(ctx.request('/api/app/settings'));
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('unauthorized');
  });

  it('returns the defaults for a user who never saved settings', async () => {
    const { cookie } = await signedIn();
    const res = await GET(ctx.request('/api/app/settings', { cookie }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      settings: { toast: DEFAULT_TOAST_FILTER, timezone: 'UTC' },
    });
  });

  it('401 for a user in grace (offboarded)', async () => {
    const userId = await ctx.seedUser({ status: 'grace' });
    const cookie = await ctx.signIn(userId);
    const res = await GET(ctx.request('/api/app/settings', { cookie }));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/app/settings', () => {
  it('saves a partial change and GET returns it', async () => {
    const { userId, cookie } = await signedIn();
    const res = await patch(cookie, {
      toastsEnabled: true,
      toastTypes: ['loot', 'level_up', 'loot'],
      toastMinLootValue: 1_000_000,
      toastOwnAccountsOnly: true,
      timezone: 'europe/amsterdam',
    });
    expect(res.status).toBe(200);
    const expected: UserSettings = {
      toast: {
        enabled: true,
        types: ['loot', 'level_up'],
        minLootValue: 1_000_000,
        ownAccountsOnly: true,
      },
      timezone: 'Europe/Amsterdam',
    };
    expect(await res.json()).toEqual({ settings: expected });

    const again = await GET(ctx.request('/api/app/settings', { cookie }));
    expect(await again.json()).toEqual({ settings: expected });

    // Only the fields present change.
    const second = await patch(cookie, { toastsEnabled: false, toastTypes: null });
    expect(((await second.json()) as { settings: UserSettings }).settings).toEqual({
      ...expected,
      toast: { ...expected.toast, enabled: false, types: null },
    });
    const rows = await ctx.t.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("changes only the signed-in user's settings", async () => {
    const a = await signedIn();
    const b = await signedIn();
    expect((await patch(a.cookie, { toastMinLootValue: 5 })).status).toBe(200);
    const res = await GET(ctx.request('/api/app/settings', { cookie: b.cookie }));
    expect(((await res.json()) as { settings: UserSettings }).settings.toast.minLootValue).toBe(0);
  });

  it('400 with field errors for invalid values, and stores nothing', async () => {
    const { userId, cookie } = await signedIn();
    const res = await patch(cookie, {
      toastsEnabled: 'yes',
      toastTypes: ['loot', 'levelUp'],
      toastMinLootValue: -1,
      timezone: 'Mars/Olympus',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_request');
    const paths = (body.error.details ?? []).map((d) => d.path).sort();
    expect(paths).toEqual(['timezone', 'toastMinLootValue', 'toastTypes.1', 'toastsEnabled']);
    const rows = await ctx.t.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('400 for unknown keys and for bodies that are not an object', async () => {
    const { cookie } = await signedIn();
    const unknown = await patch(cookie, { toastsEnabled: true, theme: 'dark' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ErrorBody).error.code).toBe('invalid_request');
    for (const body of [null, [], 'x']) {
      expect((await patch(cookie, body)).status).toBe(400);
    }
  });

  it('400 invalid_json for a body that is not JSON', async () => {
    const { cookie } = await signedIn();
    const res = await PATCH(
      ctx.request('/api/app/settings', {
        method: 'PATCH',
        cookie,
        body: '{"toastsEnabled":',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_json');
  });

  it('403 bad_origin from another origin or without an Origin, even when signed in', async () => {
    const { userId, cookie } = await signedIn();
    const foreign = await patch(cookie, { toastsEnabled: false }, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
    const missing = await patch(cookie, { toastsEnabled: false }, { origin: null });
    expect(missing.status).toBe(403);
    const rows = await ctx.t.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('accepts a same-origin fetch that sends Sec-Fetch-Site instead of Origin', async () => {
    const { cookie } = await signedIn();
    const res = await PATCH(
      ctx.request('/api/app/settings', {
        method: 'PATCH',
        cookie,
        json: { timezone: 'UTC' },
        sameOrigin: false,
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('401 without a session (same origin)', async () => {
    const res = await patch(undefined, { toastsEnabled: false });
    expect(res.status).toBe(401);
  });
});
