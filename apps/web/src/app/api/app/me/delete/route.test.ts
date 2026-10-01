/**
 * POST /api/app/me/delete (D-78): the Origin check, session auth, strict body, the confirmation
 * word, and what a successful request does: the user in grace for 7 days, their sessions gone and
 * Better Auth's cookies expired in the response.
 */
import { auditLog, devices, session, users } from '@hub/db';
import { SELF_DELETE_UNDO_DAYS } from '@hub/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getFeed } from '@/app/api/app/feed/route';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { POST } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appmedelete' });
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function post(
  cookie: string | undefined,
  body: unknown,
  opts: { origin?: string; raw?: string } = {},
): Promise<Response> {
  return POST(
    ctx.request('/api/app/me/delete', {
      method: 'POST',
      cookie,
      ...(opts.raw === undefined ? { json: body } : { body: opts.raw }),
      headers: opts.origin ? { origin: opts.origin } : {},
      sameOrigin: opts.origin === undefined,
    }),
  );
}

async function userRow(id: string) {
  const [row] = await ctx.t.db.select().from(users).where(eq(users.id, id));
  return row;
}

describe('POST /api/app/me/delete', () => {
  it('refuses another origin (403) before anything else', async () => {
    const { userId, cookie } = await signedIn();
    const res = await post(cookie, { confirm: 'delete' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe('bad_origin');
    expect((await userRow(userId))?.status).toBe('active');
  });

  it('answers 401 when signed out', async () => {
    const res = await post(undefined, { confirm: 'delete' });
    expect(res.status).toBe(401);
  });

  it('refuses a body that is not exactly { confirm: string } (400)', async () => {
    const { userId, cookie } = await signedIn();
    for (const body of [{}, { confirm: 1 }, { confirm: 'delete', extra: true }, null]) {
      const res = await post(cookie, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_request');
    }
    const bad = await post(cookie, undefined, { raw: '{"confirm":' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.code).toBe('invalid_json');
    expect((await userRow(userId))?.status).toBe('active');
  });

  it('refuses the wrong word with a message the page can show (400)', async () => {
    const { userId, cookie } = await signedIn();
    const res = await post(cookie, { confirm: 'yes please' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'invalid', message: 'Type "delete" to confirm.' },
    });
    expect((await userRow(userId))?.status).toBe('active');
  });

  it('starts the 7-day deletion, signs the user out and expires the session cookie', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId);
    const before = Date.now();

    const res = await post(cookie, { confirm: ' DELETE ' });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { graceUntil } = (await res.json()) as { graceUntil: string };
    const until = Date.parse(graceUntil);
    const week = SELF_DELETE_UNDO_DAYS * 86_400_000;
    expect(until).toBeGreaterThanOrEqual(before + week);
    expect(until).toBeLessThanOrEqual(Date.now() + week);
    expect(await userRow(userId)).toMatchObject({ status: 'grace', offboardReason: 'self_delete' });
    expect((await userRow(userId))?.graceUntil?.toISOString()).toBe(graceUntil);
    const [dev] = await ctx.t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(dev?.revokedReason).toBe('offboarding');
    expect(await ctx.t.db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    const [entry] = await ctx.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.offboarded'), eq(auditLog.targetId, userId)));
    expect(entry).toMatchObject({ actorUserId: userId, meta: { reason: 'self_delete' } });

    // The session cookie (http origin: no __Secure- prefix) and its companions are expired.
    const cookieName = cookie.slice(0, cookie.indexOf('='));
    const set = res.headers.getSetCookie();
    const expired = set.find((c) => c.startsWith(`${cookieName}=;`));
    expect(expired).toBeDefined();
    expect(expired).toContain('Max-Age=0');
    expect(expired).toContain('Path=/');
    expect(expired).toContain('HttpOnly');
    expect(expired).toContain('SameSite=Lax');
    expect(expired).not.toContain('Secure');
    expect(set.every((c) => c.includes('Max-Age=0'))).toBe(true);

    // The old cookie no longer works.
    const again = await getFeed(ctx.request('/api/app/feed', { cookie }));
    expect(again.status).toBe(401);
    expect((await post(cookie, { confirm: 'delete' })).status).toBe(401);
  });

  // Last: it replaces this file's hub with an https one (afterAll cleans that up).
  it('marks the expired cookie Secure, with the __Secure- name, on an https hub', async () => {
    await ctx.cleanup();
    ctx = await withTestDb({ label: 'appmedeletehttps', env: { APP_URL: 'https://hub.example' } });
    const userId = await ctx.seedUser();
    const cookie = await ctx.signIn(userId);
    expect(cookie.startsWith('__Secure-')).toBe(true);
    const res = await post(cookie, { confirm: 'delete' });
    expect(res.status).toBe(200);
    const name = cookie.slice(0, cookie.indexOf('='));
    const expired = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=;`));
    expect(expired).toContain('; Secure');
    expect(expired).toContain('SameSite=Lax');
  });
});
