/**
 * The page-side session helpers (getViewer, requireUser, requireAdmin) with next/headers stubbed the
 * way a Server Component render sees it: the request's headers, and a cookie store whose set() throws
 * (Next only lets Server Actions and Route Handlers write cookies).
 */
import { session } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuth } from './auth';
import { getViewer, requireAdmin, requireApiUser, requireUser } from './session';
import { withTestDb, type WebTestContext } from './test-utils';

const page = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(page.headers),
  cookies: () =>
    Promise.resolve({
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      set: () => {
        throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
      },
    }),
}));

const DAY = 24 * 60 * 60 * 1000;

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'sessionpages' });
});
beforeEach(() => {
  page.headers = new Headers();
  vi.restoreAllMocks();
});
afterAll(() => ctx.cleanup());

/** What redirect()/notFound() threw, as "redirect:<path>" / "not-found", or the error itself. */
async function outcome<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      return `redirect:${digest.split(';')[2]}`;
    }
    if (typeof digest === 'string' && digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) {
      return 'not-found';
    }
    throw err;
  }
}

async function signedInPage(opts: Parameters<WebTestContext['seedUser']>[0] = {}) {
  const userId = await ctx.seedUser(opts);
  page.headers = new Headers({ cookie: await ctx.signIn(userId) });
  return userId;
}

describe('page session helpers', () => {
  it('requireUser returns the active user; redirects signed-out and grace users to /login', async () => {
    const userId = await signedInPage({ name: 'Zezima' });
    const current = await requireUser();
    expect(current.user).toMatchObject({ id: userId, name: 'Zezima', status: 'active' });

    page.headers = new Headers();
    expect(await outcome(requireUser)).toBe('redirect:/login');

    await signedInPage({ status: 'grace' });
    expect(await outcome(requireUser)).toBe('redirect:/login');
    // getViewer still reports the grace user, so the login page can tell them apart.
    expect((await getViewer())?.viewer.status).toBe('grace');
  });

  it('requireAdmin: notFound() for a non-admin, the user for an admin', async () => {
    await signedInPage();
    expect(await outcome(requireAdmin)).toBe('not-found');
    const adminId = await signedInPage({ isAdmin: true });
    expect((await requireAdmin()).user.id).toBe(adminId);
  });

  it('never extends the session from a page render, where the cookie cannot be renewed', async () => {
    const userId = await signedInPage();
    // Signed in two days ago: past Better Auth's updateAge (1 day), so a read would refresh it.
    const expiresAt = new Date(Date.now() + 5 * DAY);
    await ctx.t.db
      .update(session)
      .set({ expiresAt, updatedAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(session.userId, userId));
    const stored = async () =>
      (await ctx.t.db.select().from(session).where(eq(session.userId, userId)))[0]!.expiresAt;

    expect((await getViewer())?.user.id).toBe(userId);
    expect((await requireUser()).user.id).toBe(userId);
    // Extending the row here would leave the browser's cookie on its old Max-Age: the cookie would
    // expire 7 days after sign-in while the database thinks the session was renewed.
    expect((await stored()).getTime()).toBe(expiresAt.getTime());

    // A route handler may: Next adds the renewed cookie to its response.
    await requireApiUser(ctx.request('/api/live/stream', { cookie: page.headers.get('cookie')! }));
    expect((await stored()).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
  });

  it('a database failure is an error for requireUser, not a redirect to /login', async () => {
    await signedInPage();
    const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(getAuth().api, 'getSession').mockRejectedValue(outage);
    await expect(outcome(requireUser)).rejects.toBe(outage);
    await expect(outcome(requireAdmin)).rejects.toBe(outage);
    // Pages that only want to know "who, if anyone" still get null.
    expect(await getViewer()).toBeNull();
  });
});
