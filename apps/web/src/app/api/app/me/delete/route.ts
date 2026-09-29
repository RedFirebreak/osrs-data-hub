/**
 * POST /api/app/me/delete `{ confirm: "delete" }` → 200 `{ graceUntil }` (ISO): "Delete my data"
 * (Settings, D-78). Runs deleteMyData: the offboarding pipeline for the user themself, reason
 * 'self_delete', with a 7-day undo window. Devices and API keys are revoked, owned accounts pass to a
 * co-player or are hidden, and every session is deleted, so the response also expires Better Auth's
 * cookies (the browser then goes to /login?deleted=<graceUntil>). Signing in again before graceUntil
 * cancels it.
 *
 * Origin check (403, D-36), session auth (401), a body capped at 64 KiB (413) and parsed strictly
 * (400). 400 `invalid` when `confirm` isn't the word "delete" (trimmed, any case) or the user isn't
 * active (SelfDeleteError).
 */
import { getDb } from '@hub/db';
import { deleteMyData } from '@hub/server';
import { z } from 'zod';
import { getAuth } from '@/lib/auth';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

const BodySchema = z.strictObject({ confirm: z.string().max(64) });

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { confirm } = BodySchema.parse(await readJson(request));
    const result = await deleteMyData(getDb().db, { userId: user.id, confirm });
    const headers = new Headers();
    for (const cookie of await expiredAuthCookies()) headers.append('set-cookie', cookie);
    return json(200, { graceUntil: result.graceUntil.toISOString() }, headers);
  });
}

interface AuthCookie {
  name: string;
  attributes: {
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    partitioned?: boolean;
  };
}

/**
 * Set-Cookie values that expire Better Auth's session cookies (the token, its cookie cache and the
 * "don't remember me" flag, as its own sign-out does), under the names and attributes it derives
 * from APP_URL (the __Secure- prefix and Secure on https). The session rows are already gone; this
 * only keeps a dead cookie from being sent on every request. A cookie set on the response wins over
 * a renewed one the session read may have queued through nextCookies (Next applies those first).
 */
async function expiredAuthCookies(): Promise<string[]> {
  const { authCookies } = await getAuth().$context;
  return [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken].map(
    expiredCookie,
  );
}

function expiredCookie({ name, attributes: a }: AuthCookie): string {
  const parts = [
    `${name}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    `Path=${a.path ?? '/'}`,
  ];
  if (a.domain) parts.push(`Domain=${a.domain}`);
  if (a.httpOnly) parts.push('HttpOnly');
  if (a.secure) parts.push('Secure');
  if (a.sameSite) {
    parts.push(
      `SameSite=${a.sameSite.charAt(0).toUpperCase()}${a.sameSite.slice(1).toLowerCase()}`,
    );
  }
  if (a.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}
