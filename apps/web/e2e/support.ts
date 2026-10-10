/**
 * Helpers of the wizard end-to-end tests: Discord sign-in in the browser, the plugin's requests, and
 * the payload fixtures.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { HUB_URL } from './env';

/** Discord handles the fake Discord knows (e2e/mock-discord.mjs); the handle is the OAuth code. */
export type DiscordHandle = 'alice' | 'bob' | 'carol';

/**
 * A made-up client address for one test. The server trusts one proxy hop (TRUST_PROXY_HOPS=1), so
 * X-Forwarded-For names the client, and every test gets its own rate-limit buckets: Better Auth
 * allows 3 sign-ins per 10 s per client, the hub 10 pairing attempts per 10 min (handoff §6.2.7),
 * and all tests run from 127.0.0.1.
 */
export function newClientIp(): string {
  const byte = () => 1 + Math.floor(Math.random() * 254);
  return `10.${byte()}.${byte()}.${byte()}`;
}

/** Sends every request of the page's browser context as coming from `ip`. */
export async function actAsClient(page: Page, ip: string): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip });
}

/**
 * Stands in for Discord's consent screen: Better Auth sends the browser to
 * https://discord.com/api/oauth2/authorize?…&state=S&redirect_uri=…, and Discord would redirect
 * back to redirect_uri with ?code=…&state=S. Avatars from Discord's CDN are refused, so no test
 * reaches the internet (the header falls back to initials). Returns the authorize URLs seen.
 */
async function fakeDiscordConsent(page: Page, handle: DiscordHandle): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route(/^https:\/\/discord\.com\/(api\/)?oauth2\/authorize/, async (route) => {
    const authorize = new URL(route.request().url());
    seen.push(authorize);
    const back = new URL(authorize.searchParams.get('redirect_uri') ?? `${HUB_URL}/invalid`);
    back.searchParams.set('code', handle);
    back.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.route('https://cdn.discordapp.com/**', (route) => route.abort('blockedbyclient'));
  return seen;
}

/** The hub page a sign-in ends on: Home, or /login?error=… when it was refused. */
function isSignInResult(url: URL): boolean {
  if (url.origin !== HUB_URL || url.pathname.startsWith('/api/')) return false;
  return url.pathname !== '/login' || url.searchParams.has('error');
}

/**
 * Signs in on /login with "Sign in with Discord" as `handle`. Resolves once the browser is back on
 * the hub after the OAuth callback: on Home for members, on /login?error=… otherwise.
 */
export async function signInWithDiscord(page: Page, handle: DiscordHandle): Promise<void> {
  const authorizeUrls = await fakeDiscordConsent(page, handle);
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const callback = page.waitForResponse((res) =>
    res.url().startsWith(`${HUB_URL}/api/auth/callback/discord?`),
  );
  await page.getByRole('button', { name: 'Sign in with Discord' }).click();
  await page.waitForURL(isSignInResult);

  // What Better Auth asked Discord for (lib/auth.ts): exactly these scopes (AUTH-3), our callback.
  expect(authorizeUrls).toHaveLength(1);
  const authorize = authorizeUrls[0] as URL;
  expect(authorize.searchParams.get('client_id')).toBe('test');
  expect(authorize.searchParams.get('scope')).toBe('identify guilds.members.read');
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${HUB_URL}/api/auth/callback/discord`);
  expect(authorize.searchParams.get('state')).toBeTruthy();
  // The callback always redirects (to Home, or to /login?error=…), never renders.
  expect((await callback).status()).toBe(302);
}

/** A payload fixture (packages/fixtures/payloads, wire-exact plugin v1.5 bodies) as an object. */
export function payloadFixture(name: string): Record<string, unknown> {
  const file = path.join(
    import.meta.dirname,
    '../../../packages/fixtures/payloads',
    `${name}.json`,
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * A fixture as the plugin would send it now: the payload's and its events' timestamps set to `now`
 * (a toast is only shown for events younger than 15 minutes) and fresh event ids (a resent id is a
 * duplicate and ignored, which a retried test would otherwise hit).
 */
export function freshPayload(name: string, now = Date.now()): Record<string, unknown> {
  const body = payloadFixture(name);
  body.timestamp = now;
  if (Array.isArray(body.events)) {
    body.events = body.events.map((event: Record<string, unknown>) => ({
      ...event,
      eventId: randomUUID(),
      timestamp: now,
    }));
  }
  return body;
}

/** The HA Exporter plugin (OkHttp) talking to the hub from `ip`. */
export class FakePlugin {
  private readonly request: APIRequestContext;
  private readonly ip: string;

  constructor(request: APIRequestContext, ip: string) {
    this.request = request;
    this.ip = ip;
  }

  private headers(version: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-osrs-exporter-version': version,
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'okhttp/3.14.9',
      'x-forwarded-for': this.ip,
      ...extra,
    };
  }

  /** POST /api/osrs-data/pair with the 5-digit code, as the plugin's pairing panel does. */
  pair(code: string, version: string): Promise<APIResponse> {
    return this.request.post('/api/osrs-data/pair', {
      headers: this.headers(version),
      data: JSON.stringify({ code }),
      maxRedirects: 0,
    });
  }

  /** POST /api/osrs-data/events with the device token. */
  send(token: string, body: unknown, version = '1.5'): Promise<APIResponse> {
    return this.request.post('/api/osrs-data/events', {
      headers: this.headers(version, { 'x-osrs-token': token }),
      data: JSON.stringify(body),
      maxRedirects: 0,
    });
  }
}
