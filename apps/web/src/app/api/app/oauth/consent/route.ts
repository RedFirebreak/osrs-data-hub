/**
 * The member's answer on the consent page of an MCP client's sign-in (D-137).
 *
 * POST `{ oauthQuery, accept }` → 200 `{ url }`, where the browser goes next: back to the client with
 * an authorization code, or with `access_denied`. Allowing first makes the key the client's tokens
 * will act as (createOAuthKey: the AI assistant categories, every account the member can see; a key
 * this client already had is replaced), then lets the provider record the consent. At most 10 active
 * keys: 409 `limit`, with nothing granted. A request whose signature doesn't hold or has expired is
 * 400. Audited (the key).
 *
 * The Origin check first (403, D-36), then session auth (401); the body is capped at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { createOAuthKey, revokeApiKey } from '@hub/server';
import { z } from 'zod';
import { getConfig } from '@hub/core';
import { CLIENT_IP_HEADER, getAuth } from '@/lib/auth';
import { ApiError, assertSameOrigin, clientIp, handleApi, json, readJson } from '@/lib/http';
import { readConsentRequest } from '@/lib/mcp/consent';
import { requireApiUser } from '@/lib/session';

const ConsentBody = z.object({ oauthQuery: z.string().max(8192), accept: z.boolean() });

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const body = ConsentBody.parse(await readJson(request));
    const { db } = getDb();
    const consent = await readConsentRequest(db, body.oauthQuery);
    if (!consent) {
      throw new ApiError(
        400,
        'invalid_request',
        'This sign-in request has expired. Start connecting again from your assistant.',
      );
    }
    const key = body.accept
      ? await createOAuthKey(db, {
          userId: user.id,
          clientId: consent.client.clientId,
          clientName: consent.client.name,
        })
      : null;
    try {
      const url = await answerProvider(request, body.accept, consent.oauthQuery);
      return json(200, { url });
    } catch (err) {
      // Nothing granted after all: the key the tokens would have used goes too.
      if (key) await revokeApiKey(db, { userId: user.id, keyId: key.id });
      throw err;
    }
  });
}

/**
 * Hands the answer to the provider's consent endpoint, through Better Auth's handler as the browser
 * would: the endpoint carries on with the authorization itself and needs a request for that (an
 * `auth.api` call has none). A fresh request from the original's headers (cookie, Origin), never a
 * copy of the original (NEXT-13). Returns where the browser goes next.
 */
async function answerProvider(
  request: Request,
  accept: boolean,
  oauthQuery: string,
): Promise<string> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  for (const name of ['cookie', 'origin', 'user-agent']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const ip = clientIp(request);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  const res = await getAuth().handler(
    new Request(`${getConfig().appOrigin}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    }),
  );
  const answer = (await res.json().catch(() => null)) as { url?: unknown } | null;
  if (!res.ok || typeof answer?.url !== 'string') {
    throw new ApiError(
      res.status === 401 ? 401 : 400,
      res.status === 401 ? 'unauthorized' : 'invalid_request',
      res.status === 401
        ? 'Sign in to the hub first.'
        : 'This sign-in request has expired. Start connecting again from your assistant.',
    );
  }
  return answer.url;
}
