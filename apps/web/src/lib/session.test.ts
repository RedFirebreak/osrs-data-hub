import { createDb, session, users, type DbHandle } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as authGET, POST as authPOST } from '@/app/api/auth/[...all]/route';
import { CLIENT_IP_HEADER, getAuth } from './auth';
import { ApiError, handleApi, json } from './http';
import { getApiUser, requireApiUser } from './session';
import { withTestDb, type WebTestContext } from './test-utils';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'session' });
});
afterAll(() => ctx.cleanup());

describe('requireApiUser', () => {
  it('throws 401 without a cookie', async () => {
    await expect(requireApiUser(ctx.request('/api/app/x'))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('returns the user and a fresh viewer for a signed-in cookie (signIn helper)', async () => {
    const userId = await ctx.seedUser({ name: 'Zezima' });
    const cookie = await ctx.signIn(userId);
    const current = await requireApiUser(ctx.request('/api/app/x', { cookie }));
    expect(current.user).toMatchObject({ id: userId, name: 'Zezima', isAdmin: false });
    expect(current.viewer).toEqual({ userId, status: 'active', isAdmin: false });

    // Promoted meanwhile: the admin flag comes from the users table, not the session.
    await ctx.t.db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    const again = await requireApiUser(ctx.request('/api/app/x', { cookie }));
    expect(again.viewer.isAdmin).toBe(true);
  });

  it('refuses a cookie with a forged signature', async () => {
    const userId = await ctx.seedUser();
    const cookie = await ctx.signIn(userId);
    const [name, value = ''] = cookie.split('=');
    const token = decodeURIComponent(value).split('.')[0] ?? '';
    const forged = `${name}=${encodeURIComponent(`${token}.${'A'.repeat(43)}=`)}`;
    await expect(requireApiUser(ctx.request('/x', { cookie: forged }))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('refuses a user in grace even while a session row still exists', async () => {
    const userId = await ctx.seedUser({ status: 'grace' });
    const cookie = await ctx.signIn(userId);
    await expect(requireApiUser(ctx.request('/x', { cookie }))).rejects.toMatchObject({
      status: 401,
    });
    expect(await getApiUser(ctx.request('/x', { cookie }))).toBeNull();
  });

  it('stops working as soon as the session row is deleted (no cookie cache, AUTH-8)', async () => {
    const userId = await ctx.seedUser();
    const cookie = await ctx.signIn(userId);
    expect(await getApiUser(ctx.request('/x', { cookie }))).not.toBeNull();
    await ctx.t.db.delete(session).where(eq(session.userId, userId));
    expect(await getApiUser(ctx.request('/x', { cookie }))).toBeNull();
  });

  it('a database outage during the session lookup is 503 + Retry-After, not 500 or 401', async () => {
    const userId = await ctx.seedUser();
    const cookie = await ctx.signIn(userId);
    const g = globalThis as unknown as { __hubDb?: DbHandle; __hubAuth?: unknown };
    const testDb = g.__hubDb;
    const testAuth = g.__hubAuth;
    // Nothing listens on port 1: every query fails to connect. Better Auth's own error log is muted.
    const down = createDb('postgres://hub:hub@127.0.0.1:1/nope');
    const mute = vi.spyOn(console, 'error').mockImplementation(() => {});
    g.__hubDb = down;
    delete g.__hubAuth;
    try {
      const res = await handleApi(async () => {
        await requireApiUser(ctx.request('/api/app/x', { cookie }));
        return json(200, {});
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    } finally {
      mute.mockRestore();
      g.__hubDb = testDb;
      g.__hubAuth = testAuth;
      await down.pool.end().catch(() => {});
    }
  });

  it('answers 401 JSON through handleApi', async () => {
    const res = await handleApi(async () => {
      await requireApiUser(ctx.request('/x'));
      return json(200, {});
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) as string },
    });
  });
});

describe('/api/auth/[...all]', () => {
  it('serves get-session for the signed-in cookie', async () => {
    const userId = await ctx.seedUser({ name: 'Lynx Titan' });
    const cookie = await ctx.signIn(userId);
    const res = await authGET(ctx.request('/api/auth/get-session', { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; name: string } };
    expect(body.user).toMatchObject({ id: userId, name: 'Lynx Titan' });
  });

  it("refuses a cookie-carrying POST from another origin (Better Auth's CSRF check)", async () => {
    const userId = await ctx.seedUser();
    const cookie = await ctx.signIn(userId);
    const signOut = (headers: Record<string, string>, sameOrigin: boolean) =>
      authPOST(
        ctx.request('/api/auth/sign-out', {
          method: 'POST',
          cookie,
          headers,
          sameOrigin,
          json: {},
        }),
      );
    expect((await signOut({ origin: 'https://evil.example.com' }, false)).status).toBe(403);
    expect((await signOut({}, false)).status).toBe(403);
    expect(await getApiUser(ctx.request('/x', { cookie }))).not.toBeNull();

    const res = await signOut({}, true);
    expect(res.status).toBe(200);
    expect(await getApiUser(ctx.request('/x', { cookie }))).toBeNull();
  });

  it('overwrites a client-sent client-IP header with the X-Forwarded-For rule (D-42)', async () => {
    const auth = getAuth();
    const seen: (string | null)[] = [];
    const spy = vi.spyOn(auth, 'handler').mockImplementation((request: Request) => {
      seen.push(request.headers.get(CLIENT_IP_HEADER));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    try {
      await authGET(
        ctx.request('/api/auth/get-session', {
          headers: { [CLIENT_IP_HEADER]: '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.5' },
        }),
      );
      // No X-Forwarded-For: the spoofed header is removed, not kept.
      await authGET(
        ctx.request('/api/auth/get-session', { headers: { [CLIENT_IP_HEADER]: '6.6.6.6' } }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['203.0.113.5', null]);
  });
});
