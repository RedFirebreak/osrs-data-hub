/**
 * Who is asking: the Better Auth session plus the viewer the permission resolver needs (handoff §10).
 *
 * Pages (server components) use requireUser()/requireAdmin(); route handlers use
 * requireApiUser(request), which answers 401 through handleApi (lib/http.ts). Status and admin flag
 * are read fresh from the users table (loadViewer) on every call: the worker offboards and demotes
 * users while their sessions may still exist, and sessions are database sessions without a cookie
 * cache, so a revoked session stops working at once (AUTH-8).
 *
 * Session renewal happens in route handlers only (AUTH-12). Better Auth extends a session older than
 * `updateAge` on read, in the database AND in the cookie, but a Server Component can't write cookies:
 * nextCookies swallows the failed cookies().set(), so a renewal from a page render would push the
 * database expiry out while the browser's cookie keeps its old Max-Age and still expires 7 days after
 * sign-in. Page reads therefore pass disableRefresh; requireApiUser renews, and Next adds the cookie to
 * that route's response (every signed-in page opens /api/live/stream, so active users are renewed).
 */
import { getConfig, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { loadViewer } from '@hub/server';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect, unstable_rethrow } from 'next/navigation';
import { cache } from 'react';
import { getAuth, type AuthSession } from './auth';
import { ApiError } from './http';

/** The signed-in user as pages and routes see it. */
export interface SessionUser {
  id: string;
  name: string;
  image: string | null;
  discordId: string | null;
  /** Fresh from the database (loadViewer). */
  isAdmin: boolean;
  /** Fresh from the database (loadViewer); only 'active' users get past requireUser/requireApiUser. */
  status: Viewer['status'];
}

export interface CurrentUser {
  user: SessionUser;
  viewer: Viewer;
}

/**
 * The Better Auth session for these request headers, or null (no/expired/revoked session).
 * `disableRefresh` skips extending the session's expiry, for checks made where no cookie can be set
 * (the live stream's heartbeat, long after its response headers went out).
 */
async function sessionFrom(h: Headers, disableRefresh = false): Promise<AuthSession | null> {
  return getAuth().api.getSession({ headers: h, query: { disableRefresh } });
}

/** Session + fresh viewer for these headers; null when signed out or the user no longer exists. */
async function currentUserFrom(h: Headers, disableRefresh = false): Promise<CurrentUser | null> {
  const session = await sessionFrom(h, disableRefresh);
  if (!session) return null;
  const viewer = await loadViewer(getDb().db, session.user.id);
  if (!viewer) return null;
  const u = session.user;
  return {
    user: {
      id: u.id,
      name: u.name,
      image: u.image ?? null,
      discordId: u.discordId ?? null,
      isAdmin: viewer.isAdmin,
      status: viewer.status,
    },
    viewer,
  };
}

/**
 * Session + fresh viewer of the current page request; errors propagate. Never renews the session
 * (see the file comment). Deduplicated per render with React cache().
 */
const pageUser = cache(async (): Promise<CurrentUser | null> =>
  currentUserFrom(await headers(), true),
);

/**
 * The signed-in user of the current page request with a fresh viewer, or null (signed out, user
 * deleted, or an error). Users in `grace` are returned with status 'grace': pages that only need
 * "is someone signed in" must still check `viewer.status === 'active'` (requireUser does).
 */
export const getViewer = cache(async (): Promise<CurrentUser | null> => {
  try {
    return await pageUser();
  } catch (err) {
    // headers() bails out of prerendering by throwing; that must reach Next, not become "signed out".
    unstable_rethrow(err);
    return null;
  }
});

/**
 * For pages: the signed-in, active user, else redirect('/login'). Users in `grace` have had their
 * sessions deleted by offboarding, but are guarded anyway — so the login page must treat an inactive
 * viewer as signed out (use getViewer and check the status), or the two would redirect in a loop.
 * A database failure is thrown (the error boundary shows it), not taken for "signed out": an outage
 * must not send everyone to the login page.
 */
export async function requireUser(): Promise<CurrentUser> {
  const current = await pageUser();
  if (!current || current.viewer.status !== 'active') redirect('/login');
  return current;
}

/**
 * The <title> of an admin page: `<section> · Admin · <hub>` for an active admin; for everyone else the
 * title of the 404 they get, so the tab doesn't admit the page exists (requireAdmin answers 404).
 */
export async function adminMetadata(section: string | null): Promise<Metadata> {
  const hubName = getConfig().hubName;
  const current = await getViewer();
  if (current?.viewer.status !== 'active' || !current.viewer.isAdmin) {
    return { title: `Page not found · ${hubName}` };
  }
  return { title: section ? `${section} · Admin · ${hubName}` : `Admin · ${hubName}` };
}

/** For admin pages: requireUser, then notFound() for non-admins (admin pages don't admit they exist). */
export async function requireAdmin(): Promise<CurrentUser> {
  const current = await requireUser();
  if (!current.viewer.isAdmin) notFound();
  return current;
}

/**
 * For route handlers (inside handleApi): the signed-in, active user of `request`, else throws
 * ApiError 401 `unauthorized`. Reads the cookie from `request.headers` (works outside a Next request
 * scope, e.g. in tests). Renews a session older than a day, and Next puts the renewed cookie on this
 * route's response. A database failure propagates (handleApi → 503), so a client never mistakes an
 * outage for being signed out.
 */
export async function requireApiUser(request: Request): Promise<CurrentUser> {
  const current = await currentUserFrom(request.headers);
  if (!current || current.viewer.status !== 'active') {
    throw new ApiError(401, 'unauthorized', 'Sign in to the hub first.');
  }
  return current;
}

/**
 * Like requireApiUser but returns null instead of throwing; errors (database down) propagate.
 * `disableRefresh`: see sessionFrom (the live stream's heartbeat passes true).
 */
export async function getApiUser(
  request: Request | Headers,
  opts: { disableRefresh?: boolean } = {},
): Promise<CurrentUser | null> {
  const h = request instanceof Headers ? request : request.headers;
  const current = await currentUserFrom(h, opts.disableRefresh ?? false);
  return current && current.viewer.status === 'active' ? current : null;
}
