/**
 * The MCP endpoint's sign-in for assistants that only connect with OAuth (D-137), end to end inside
 * one process: discovery from the 401, dynamic registration, authorization with a member signed in,
 * the consent page's answer, the token exchange, and the token acting as the key the consent made,
 * on the MCP endpoint only. Deny, a forged request, and revoking the key on the API keys page. And
 * no open redirect: a self-registered client can't use the hub to bounce a browser to its site
 * (AUTH-16).
 */
import { createHash, randomBytes } from 'node:crypto';
import { AI_ASSISTANT_CATEGORIES } from '@hub/core';
import { apiKeys } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as authServerRoute from '@/app/.well-known/oauth-authorization-server/[[...path]]/route';
import * as authRoute from '@/app/api/auth/[...all]/route';
import * as resourceRoute from '@/app/.well-known/oauth-protected-resource/[[...path]]/route';
import * as keyRoute from '@/app/api/app/api-keys/[id]/route';
import * as consentRoute from '@/app/api/app/oauth/consent/route';
import { getAuth } from '@/lib/auth';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import * as meRoute from './me/route';
import * as mcpRoute from './mcp/route';
import { freshLimits, idParams, seedWorld, type World } from './test-support';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let ctx: WebTestContext;
let world: World;
let cookie: string;
let resource: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'mcpoauth' });
  world = await seedWorld(ctx);
  cookie = await ctx.signIn(world.memberId);
  resource = `${ctx.config.appOrigin}/api/v1/mcp`;
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

function mcp(token?: string) {
  const headers: Record<string, string> = {
    'x-forwarded-for': '192.0.2.20',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return mcpRoute.POST(
    ctx.request('/api/v1/mcp', {
      method: 'POST',
      headers,
      json: { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'hub://me' } },
      sameOrigin: false,
    }),
  );
}

function auth(path: string, opts: Parameters<WebTestContext['request']>[1] = {}) {
  return getAuth().handler(ctx.request(`/api/auth${path}`, opts));
}

async function register(name = 'Claude'): Promise<string> {
  const res = await auth('/oauth2/register', {
    method: 'POST',
    sameOrigin: false,
    json: {
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Authorizes as the signed-in member; returns the consent page's query and the PKCE verifier. */
async function authorize(clientId: string): Promise<{ query: string; verifier: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'mcp offline_access',
    state: 'st8',
    resource,
  });
  const res = await auth(`/oauth2/authorize?${params}`, {
    cookie,
    sameOrigin: false,
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '', ctx.config.appOrigin);
  expect(location.pathname).toBe('/oauth/consent');
  return { query: location.search.slice(1), verifier };
}

function consent(oauthQuery: string, accept: boolean) {
  return consentRoute.POST(
    ctx.request('/api/app/oauth/consent', { method: 'POST', cookie, json: { oauthQuery, accept } }),
  );
}

async function token(clientId: string, code: string, verifier: string) {
  const res = await auth('/oauth2/token', {
    method: 'POST',
    sameOrigin: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

describe('discovery', () => {
  it('starts at the 401 and leads to the authorization server', async () => {
    const res = await mcp();
    expect(res.status).toBe(401);
    const url = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
    expect(url).toBe(`${ctx.config.appOrigin}/.well-known/oauth-protected-resource/api/v1/mcp`);

    const meta = await resourceRoute.GET(new Request(url!), {
      params: Promise.resolve({ path: ['api', 'v1', 'mcp'] }),
    });
    const doc = (await meta.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(resource);
    expect(meta.headers.get('access-control-allow-origin')).toBe('*');

    const server = await authServerRoute.GET(new Request(`${ctx.config.appOrigin}/x`), {
      params: Promise.resolve({ path: ['api', 'auth'] }),
    });
    const as = (await server.json()) as Record<string, unknown>;
    // The provider insists on an https issuer for any host but localhost (APP_URL is https in
    // production); the resource names the same one.
    expect(doc.authorization_servers).toEqual(['https://hub.test/api/auth']);
    expect(as).toMatchObject({
      issuer: 'https://hub.test/api/auth',
      authorization_endpoint: `${ctx.config.appOrigin}/api/auth/oauth2/authorize`,
      token_endpoint: `${ctx.config.appOrigin}/api/auth/oauth2/token`,
      registration_endpoint: `${ctx.config.appOrigin}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('answers 404 for another resource or issuer path', async () => {
    const other = await resourceRoute.GET(new Request(`${ctx.config.appOrigin}/x`), {
      params: Promise.resolve({ path: ['api', 'v1', 'snapshot'] }),
    });
    expect(other.status).toBe(404);
    const root = await resourceRoute.GET(new Request(`${ctx.config.appOrigin}/x`), {
      params: Promise.resolve({ path: undefined }),
    });
    expect(root.status).toBe(200);
    const issuer = await authServerRoute.GET(new Request(`${ctx.config.appOrigin}/x`), {
      params: Promise.resolve({ path: ['nope'] }),
    });
    expect(issuer.status).toBe(404);
  });
});

describe('connecting', () => {
  it('allow makes a key, and the token acts as it on /mcp only', async () => {
    const clientId = await register('Claude');
    const { query, verifier } = await authorize(clientId);

    const res = await consent(query, true);
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { url: string }).url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st8');
    const tokens = await token(clientId, back.searchParams.get('code') ?? '', verifier);
    expect(tokens.access_token).toMatch(/^ohat_/);
    expect(tokens.refresh_token).toMatch(/^ohrt_/);

    const [key] = await ctx.t.db.select().from(apiKeys).where(eq(apiKeys.oauthClientId, clientId));
    expect(key).toMatchObject({
      userId: world.memberId,
      name: 'Claude',
      categories: [...AI_ASSISTANT_CATEGORIES],
      accountScope: 'all_visible',
      revokedAt: null,
    });

    const me = await mcp(tokens.access_token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { result: { contents: { text: string }[] } };
    expect(JSON.parse(body.result.contents[0]!.text)).toMatchObject({
      key: { kind: 'user', name: 'Claude' },
    });

    // Elsewhere on /api/v1 the token is no key.
    const rest = await meRoute.GET(
      ctx.request('/api/v1/me', {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'x-forwarded-for': '192.0.2.21',
        },
        sameOrigin: false,
      }),
    );
    expect(rest.status).toBe(401);

    // Revoking the key on the API keys page disconnects the assistant.
    const revoked = await keyRoute.DELETE(
      ctx.request(`/api/app/api-keys/${key!.id}`, { method: 'DELETE', cookie }),
      idParams(key!.id),
    );
    expect(revoked.status).toBe(204);
    expect((await mcp(tokens.access_token)).status).toBe(401);
  });

  it('deny sends the browser back with access_denied and makes no key', async () => {
    const clientId = await register('Cursor');
    const { query } = await authorize(clientId);
    const res = await consent(query, false);
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { url: string }).url);
    expect(back.searchParams.get('error')).toBe('access_denied');
    const keys = await ctx.t.db.select().from(apiKeys).where(eq(apiKeys.oauthClientId, clientId));
    expect(keys).toEqual([]);
  });

  it('refuses a request the hub did not sign', async () => {
    const clientId = await register('Forged');
    const { query } = await authorize(clientId);
    const forged = new URLSearchParams(query);
    forged.set('redirect_uri', 'https://evil.example/cb');
    const res = await consent(forged.toString(), true);
    expect(res.status).toBe(400);
    const keys = await ctx.t.db.select().from(apiKeys).where(eq(apiKeys.oauthClientId, clientId));
    expect(keys).toEqual([]);
  });

  it('answers 401 signed out and 403 from another origin', async () => {
    const signedOut = await consentRoute.POST(
      ctx.request('/api/app/oauth/consent', {
        method: 'POST',
        json: { oauthQuery: 'x', accept: true },
      }),
    );
    expect(signedOut.status).toBe(401);
    const crossSite = await consentRoute.POST(
      ctx.request('/api/app/oauth/consent', {
        method: 'POST',
        cookie,
        headers: { origin: 'https://evil.example' },
        json: { oauthQuery: 'x', accept: true },
      }),
    );
    expect(crossSite.status).toBe(403);
  });
});

describe('no open redirect (AUTH-16)', () => {
  const EVIL = 'https://evil.example/cb';

  async function evilClient(): Promise<string> {
    const res = await auth('/oauth2/register', {
      method: 'POST',
      sameOrigin: false,
      json: {
        client_name: 'Discord',
        redirect_uris: [EVIL],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  function authorizeUrl(clientId: string, extra: Record<string, string>): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: EVIL,
      state: 'st8',
      scope: 'mcp',
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      resource,
      ...extra,
    });
    return `/api/auth/oauth2/authorize?${params}`;
  }

  const navigate = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

  it('Better Auth alone sends a signed-out browser straight to the client with prompt=none', async () => {
    // The trap itself: if this starts failing, the provider stopped doing it and AUTH-16 can say so.
    const url = authorizeUrl(await evilClient(), { prompt: 'none' });
    const res = await auth(url.replace('/api/auth', ''), {
      sameOrigin: false,
      headers: navigate,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(
      /^https:\/\/evil\.example\/cb\?error=login_required/,
    );
  });

  it('through the hub, prompt=none signed out lands on the login page', async () => {
    const res = await authRoute.GET(
      ctx.request(authorizeUrl(await evilClient(), { prompt: 'none' }), {
        sameOrigin: false,
        headers: navigate,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ctx.config.appOrigin}/login?error=login_required`);
  });

  it('through the hub, a bad scope signed in lands on the login page', async () => {
    const res = await authRoute.GET(
      ctx.request(authorizeUrl(await evilClient(), { scope: 'nope' }), {
        cookie,
        sameOrigin: false,
        headers: navigate,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ctx.config.appOrigin}/login?error=invalid_scope`);
  });

  it('through the hub, a request without PKCE lands on the login page', async () => {
    const url = new URL(authorizeUrl(await evilClient(), {}), ctx.config.appOrigin);
    url.searchParams.delete('code_challenge');
    url.searchParams.delete('code_challenge_method');
    const res = await authRoute.GET(
      ctx.request(`${url.pathname}${url.search}`, { sameOrigin: false, headers: navigate }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ctx.config.appOrigin}/login?error=invalid_request`);
  });

  it('through the hub, a good request still reaches the consent page', async () => {
    const res = await authRoute.GET(
      ctx.request(authorizeUrl(await evilClient(), {}), {
        cookie,
        sameOrigin: false,
        headers: navigate,
      }),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '', ctx.config.appOrigin).pathname).toBe(
      '/oauth/consent',
    );
  });
});
