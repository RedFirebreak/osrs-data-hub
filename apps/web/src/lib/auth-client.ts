'use client';
/**
 * Better Auth in the browser. The client talks to `/api/auth` on the page's own origin: APP_URL is
 * an origin without a path (D-26), so no base URL needs to reach the bundle.
 */
import { inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { Auth } from './auth';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [inferAdditionalFields<Auth>()],
});

/** The origin relative paths are resolved against to check they stay on it. */
const PROBE_ORIGIN = 'http://hub.invalid';

/**
 * `/x/y?z` stays; anything that isn't a path on this site becomes '/': `//evil`, `https://…`, a
 * backslash (`/\\evil`), an encoded slash in the path (`/%2F/evil`), and control characters (browsers
 * drop tabs and newlines from URLs, so `/<TAB>/evil` navigates to `//evil`). The same rules as Better
 * Auth's callbackURL check, so a sign-in never fails on a path this lets through.
 */
export function safeCallbackPath(path: string): string {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\\u0000-\u001f\u007f-\u009f]/.test(path)
  ) {
    return '/';
  }
  const end = path.search(/[?#]/);
  if (/%2f|%5c/i.test(end === -1 ? path : path.slice(0, end))) return '/';
  try {
    return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN ? path : '/';
  } catch {
    return '/';
  }
}

/** Better Auth's client answers `{ data, error }` and doesn't throw on an HTTP error; this does. */
function throwIfFailed(action: string, result: { error?: unknown }): void {
  const error = result.error as { status?: number; message?: string } | null | undefined;
  if (!error) return;
  throw new Error(
    `${action} failed (${error.status ?? 'network'}): ${error.message ?? 'no details'}`,
  );
}

/**
 * Starts Discord sign-in; the browser leaves for Discord and comes back to `callbackPath`. A refused
 * sign-in (not in the guild, missing role, Discord down) lands on /login?error=<code>. Throws when the
 * sign-in could not even start (rate limited, hub unavailable, offline), so the caller can say so.
 */
export async function signInWithDiscord(callbackPath = '/'): Promise<void> {
  const result = await authClient.signIn.social({
    provider: 'discord',
    callbackURL: safeCallbackPath(callbackPath),
    errorCallbackURL: '/login',
  });
  throwIfFailed('Sign-in', result);
}

/**
 * Ends this browser's session, then does a full navigation to `redirectTo` (clears client state).
 * Throws, without navigating, when the hub didn't end the session: the user is still signed in.
 */
export async function signOut(redirectTo = '/login'): Promise<void> {
  throwIfFailed('Sign-out', await authClient.signOut());
  window.location.assign(safeCallbackPath(redirectTo));
}
