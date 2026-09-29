/**
 * Helpers for the web app's route tests (vitest project "web"; imported by *.test.ts only).
 *
 *   let ctx: WebTestContext;
 *   beforeAll(async () => { ctx = await withTestDb(); });
 *   afterAll(() => ctx.cleanup());
 *
 *   const userId = await ctx.seedUser();
 *   const cookie = await ctx.signIn(userId);
 *   const res = await POST(ctx.request('/api/app/x', { method: 'POST', cookie, json: { … } }));
 *
 * withTestDb() clones the migrated template database (createTestDatabase), points DATABASE_URL and
 * the config at it, and resets every process-wide singleton the routes read (globalThis, D-37): the
 * DB handle (set to the test database's own pool), the config, Better Auth, the plugin rate limiters,
 * the decommission cache, the live hub and its LISTEN connection, and the logger (silent). Call it
 * once per test file (beforeAll) and cleanup() in afterAll; test files run in separate workers.
 *
 * signIn() writes a Better Auth session row directly and signs its token the way Better Auth does
 * (`<token>.<base64 HMAC-SHA256(token, secret)>`, better-auth/crypto makeSignature, the same as its
 * own test-utils plugin), under the cookie name Better Auth derives from APP_URL. Going through the
 * Discord OAuth flow isn't possible in tests, and internalAdapter.createSession would run the hub's
 * session hook, which expects the Discord member snapshot of a real sign-in.
 *
 * Better Auth switches its Origin/CSRF check off by itself when NODE_ENV is 'test' (vitest sets it):
 * withTestDb switches it back on, so POSTs through /api/auth/* are checked as in production (a
 * cookie-carrying POST without a trusted Origin gets 403; `request()` sends the hub's Origin).
 *
 * Route handlers are called directly (`await POST(ctx.request(…))`), outside a Next request scope:
 * requireApiUser reads `request.headers`, so it works; `headers()`/`cookies()` from next/headers don't.
 * A handler that calls `connection()` needs it stubbed at the top of the test file (see
 * app/api/health/route.test.ts):
 *
 *   vi.mock('next/server', async (importOriginal) => ({
 *     ...(await importOriginal<Record<string, unknown>>()),
 *     connection: () => Promise.resolve(),
 *   }));
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  generateDeviceToken,
  parseConfig,
  setConfigForTests,
  sha256Hex,
  type HubConfig,
} from '@hub/core';
import { devices, session, users, type DbHandle, type UserStatus } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import {
  clearDecommissionedCache,
  silentLogger,
  type LiveHub,
  type LiveListener,
  type Logger,
} from '@hub/server';
import { makeSignature } from 'better-auth/crypto';
import { getAuth } from './auth';
import { resetPluginLimitsForTests } from './deps';

/** The origin tests run the hub under (APP_URL). http, so cookies carry no __Secure- prefix. */
export const TEST_APP_ORIGIN = 'http://hub.test';
/** AUTH_SECRET in tests (Better Auth wants ≥ 32 characters). */
export const TEST_AUTH_SECRET = 'test-auth-secret-0123456789abcdefghijklmnop';

const g = globalThis as unknown as {
  __hubDb?: DbHandle;
  __hubAuth?: unknown;
  __hubLiveHub?: LiveHub;
  __hubLiveListener?: LiveListener;
  __hubLogger?: Logger;
};

export interface SeedUserOptions {
  name?: string;
  status?: UserStatus;
  isAdmin?: boolean;
  /** Default: a unique 18-digit id (users.discord_id is unique). */
  discordId?: string;
}

export interface RequestOptions extends Omit<RequestInit, 'headers' | 'body'> {
  headers?: Record<string, string>;
  /** Cookie header, e.g. from signIn(). */
  cookie?: string;
  /** JSON body (sets content-type). */
  json?: unknown;
  /** Raw body; a ReadableStream is sent chunked (no Content-Length). */
  body?: BodyInit | null;
  /** Adds `Origin: <APP_URL origin>` (what a browser sends; assertSameOrigin passes). Default true. */
  sameOrigin?: boolean;
}

export interface WebTestContext {
  /** The test database (drizzle db, pool, url). */
  t: TestDatabase;
  /** The config the routes see (getConfig()). */
  config: HubConfig;
  /** Inserts an active, non-admin user unless told otherwise; returns its id. */
  seedUser(opts?: SeedUserOptions): Promise<string>;
  /** Inserts a paired device for the user; `token` is the raw X-Osrs-Token. */
  seedDevice(userId: string, opts?: { label?: string }): Promise<{ id: string; token: string }>;
  /** Creates a session for the user; returns the Cookie header value (`name=value`). */
  signIn(userId: string): Promise<string>;
  /** A Request for `path` on the test origin (see RequestOptions). */
  request(path: string, opts?: RequestOptions): Request;
  /** Stops the live listener, drops the database and resets the singletons. */
  cleanup(): Promise<void>;
}

/**
 * Resets the singletons the web routes read from globalThis. Doesn't close the old DB pool (its
 * owner does); the live listener is stopped.
 */
export async function resetWebSingletons(): Promise<void> {
  const listener = g.__hubLiveListener;
  delete g.__hubLiveListener;
  await listener?.stop();
  delete g.__hubLiveHub;
  delete g.__hubAuth;
  delete g.__hubDb;
  setConfigForTests(undefined);
  resetPluginLimitsForTests();
  clearDecommissionedCache();
}

/**
 * A fresh test database wired into every singleton (see the file comment). `env` overrides or adds
 * config variables (e.g. `{ METRICS_TOKEN: 'x', TRUST_PROXY_HOPS: '2' }`); DATABASE_URL, APP_URL and
 * AUTH_SECRET default to the test values. process.env.DATABASE_URL is set too (ensureLiveListener and
 * getDb() read it).
 */
export async function withTestDb(
  opts: { label?: string; env?: Record<string, string | undefined> } = {},
): Promise<WebTestContext> {
  await resetWebSingletons();
  const t = await createTestDatabase(opts.label ?? 'web');
  process.env.DATABASE_URL = t.url;
  const config = parseConfig({
    APP_URL: TEST_APP_ORIGIN,
    HUB_NAME: 'Test Hub',
    DATABASE_URL: t.url,
    AUTH_SECRET: TEST_AUTH_SECRET,
    DISCORD_GUILD_ID: '100000000000000001',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    TRUST_PROXY_HOPS: '1',
    ...opts.env,
  });
  setConfigForTests(config);
  // getDb() hands out the test database's own pool; t.drop() ends it.
  g.__hubDb = { db: t.db, pool: t.pool };
  g.__hubLogger = silentLogger();
  // Better Auth defaults skipOriginCheck to true under NODE_ENV=test; production checks Origin.
  (await getAuth().$context).skipOriginCheck = false;

  let seq = 0;
  const seedUser: WebTestContext['seedUser'] = async (o = {}) => {
    const id = `user-${++seq}-${randomUUID().slice(0, 8)}`;
    const discordId = o.discordId ?? `1${String(seq).padStart(17, '0')}`;
    await t.db.insert(users).values({
      id,
      name: o.name ?? `User ${seq}`,
      email: `${discordId}@discord.invalid`,
      discordId,
      status: o.status ?? 'active',
      isAdmin: o.isAdmin ?? false,
    });
    return id;
  };

  const seedDevice: WebTestContext['seedDevice'] = async (userId, o = {}) => {
    const token = generateDeviceToken();
    const [row] = await t.db
      .insert(devices)
      .values({ userId, tokenHash: sha256Hex(token), label: o.label ?? 'test device' })
      .returning({ id: devices.id });
    if (!row) throw new Error('seedDevice: no row');
    return { id: row.id, token };
  };

  const signIn: WebTestContext['signIn'] = async (userId) => {
    const ctx = await getAuth().$context;
    const token = randomBytes(24).toString('base64url');
    const now = new Date();
    await t.db.insert(session).values({
      id: randomUUID(),
      token,
      userId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      userAgent: 'vitest',
    });
    const signed = `${token}.${await makeSignature(token, ctx.secret)}`;
    return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
  };

  const request: WebTestContext['request'] = (path, o = {}) => {
    const { headers: extra, cookie, json, body, sameOrigin = true, ...init } = o;
    const headers = new Headers(extra);
    if (cookie !== undefined) headers.set('cookie', cookie);
    if (sameOrigin && !headers.has('origin')) headers.set('origin', config.appOrigin);
    let payload: BodyInit | null | undefined = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const streamed = typeof ReadableStream !== 'undefined' && payload instanceof ReadableStream;
    return new Request(new URL(path, config.appOrigin), {
      ...init,
      headers,
      body: payload,
      ...(streamed ? { duplex: 'half' } : {}),
    } as RequestInit);
  };

  const cleanup: WebTestContext['cleanup'] = async () => {
    const listener = g.__hubLiveListener;
    delete g.__hubLiveListener;
    await listener?.stop();
    await t.drop();
    await resetWebSingletons();
    delete process.env.DATABASE_URL;
  };

  return { t, config, seedUser, seedDevice, signIn, request, cleanup };
}

/**
 * Reads a streamed Response (e.g. SSE) until `until(text so far)` holds or `timeoutMs` passes;
 * returns the text read. The reader stays usable for further reads.
 */
export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`readUntil: timed out; got ${JSON.stringify(text)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), left);
    });
    const next = await Promise.race([reader.read(), timeout]);
    clearTimeout(timer);
    if (next === 'timeout') throw new Error(`readUntil: timed out; got ${JSON.stringify(text)}`);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}
