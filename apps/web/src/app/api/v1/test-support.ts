/**
 * Helpers for the /api/v1 route tests (imported by *.test.ts only).
 *
 * Data goes in the way production gets it: plugin fixture payloads through handleIngest (with the
 * app's ingestDeps and a chosen receive time), keys through createApiKey. The read models run on the
 * real clock, so payloads are received shortly before "now".
 *
 * Each test file must stub `connection()` (withApiKey calls it; it needs a Next request scope):
 *
 *   vi.mock('next/server', async (importOriginal) => ({
 *     ...(await importOriginal<Record<string, unknown>>()),
 *     connection: () => Promise.resolve(),
 *   }));
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, type Audience, type Category } from '@hub/core';
import { accountSharing, events, osrsAccounts } from '@hub/db';
import { createApiKey, createApiLimits, handleIngest, type ApiKeyInfo } from '@hub/server';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { z } from 'zod';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { ingestDeps } from '@/lib/deps';
import type { WebTestContext } from '@/lib/test-utils';

// @hub/fixtures isn't a dependency of the web app; read its payload files directly.
const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../packages/fixtures/payloads',
);

/** A fixture body as a mutable object (the wire shape). */
export type Wire = Record<string, unknown> & {
  player?: Record<string, unknown> & {
    name?: string;
    accountHash?: string;
    health?: { current: number; max: number };
    stats?: { skills: Record<string, { xp: number; level: number }> };
  };
  events?: Record<string, unknown>[];
  timestamp?: number;
};

/** A fixture re-keyed to another account, with fresh event ids. */
export function fixture(name: string, opts: { hash?: string; name?: string } = {}): Wire {
  const body = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Wire;
  if (body.player) {
    if (opts.hash !== undefined) body.player.accountHash = opts.hash;
    if (opts.name !== undefined) body.player.name = opts.name;
  }
  for (const e of body.events ?? []) e.eventId = randomUUID();
  return body;
}

/** A fresh 56-hex account hash (like the plugin's salted SHA-224). */
export function newHash(): string {
  return randomBytes(28).toString('hex');
}

/**
 * Sends `body` as the plugin would, received at `at`: the root timestamp 1 s and event timestamps
 * 2 s before it. Throws unless the hub answers 200.
 */
export async function ingest(token: string, body: Wire, at: Date = new Date()): Promise<void> {
  body.timestamp = at.getTime() - 1_000;
  for (const e of body.events ?? []) e.timestamp = at.getTime() - 2_000;
  const text = JSON.stringify(body);
  const res = await handleIngest(
    { ...ingestDeps(), now: () => at },
    {
      token,
      versionHeader: '1.5',
      ip: '203.0.113.9',
      readBody: () => Promise.resolve(text),
    },
  );
  if (res.status !== 200) throw new Error(`ingest: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Marks every stored event as settled: inserted well before the feed's 10 s margin (D-73). */
export async function settleEvents(ctx: WebTestContext): Promise<void> {
  await ctx.t.db.update(events).set({ insertedAt: new Date(Date.now() - 60_000) });
}

export interface TestKey {
  key: string;
  info: ApiKeyInfo;
}

/** A key for `userId` (every category, all visible accounts, unless overridden). */
export async function makeKey(
  ctx: WebTestContext,
  userId: string,
  input: {
    name?: string;
    categories?: Category[];
    accountScope?: 'all_visible' | 'list';
    accountPublicIds?: string[];
    expiresInDays?: number | null;
  } = {},
  now?: Date,
): Promise<TestKey> {
  return createApiKey(
    ctx.t.db,
    userId,
    { name: 'test key', categories: [...CATEGORIES], accountScope: 'all_visible', ...input },
    now,
  );
}

/**
 * Fresh API limiters on a clock the test moves (`advance`), so the 1/s snapshot limit and the
 * failed-auth window are deterministic. Call in beforeEach.
 */
export function freshLimits(): { advance(ms: number): void } {
  const clock = { t: Date.now() };
  setApiLimitsForTests(createApiLimits({ clock: { now: () => clock.t } }));
  return {
    advance(ms: number) {
      clock.t += ms;
    },
  };
}

export interface V1RequestOptions {
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
  headers?: Record<string, string>;
  method?: string;
  /** X-Forwarded-For (TRUST_PROXY_HOPS is 1 in tests); default 192.0.2.10. */
  ip?: string;
}

/** A request for `/api/v1<path>` as an API client sends it (no Origin, no cookie). */
export function v1Request(ctx: WebTestContext, pathAndQuery: string, opts: V1RequestOptions = {}) {
  const headers: Record<string, string> = {
    'x-forwarded-for': opts.ip ?? '192.0.2.10',
    ...opts.headers,
  };
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  return ctx.request(`/api/v1${pathAndQuery}`, {
    method: opts.method ?? 'GET',
    headers,
    sameOrigin: false,
  });
}

/** The route context of a `[id]` route. */
export function idParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/**
 * Parses `body` with the endpoint's response schema and checks nothing was stripped: z.object drops
 * unknown keys, so equality means the response has exactly the documented keys (no camelCase left
 * over, nothing undocumented).
 */
export function expectShape<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed as z.output<S>;
}

/** The CORS headers every /api/v1 response carries (D-71). */
export function expectCors(res: Response): void {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('access-control-expose-headers')).toBe(
    'ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  );
  expect(res.headers.get('access-control-allow-credentials')).toBeNull();
}

/** The body of the one account 404 (D-70). */
export const ACCOUNT_404 = { error: { code: 'not_found', message: 'Account not found.' } };

/** An id that looks like a public id but belongs to nothing. */
export const RANDOM_ID = 'Zz9Zz9Zz9Zz9';

/** Attack XP added by the second snapshot of the main account. */
export const ATTACK_GAIN = 5_000;

export interface World {
  ownerId: string;
  memberId: string;
  device: { id: string; token: string };
  /** snapshot-normal twice (Attack + ATTACK_GAIN) with a loot event, the last 30 s ago. */
  main: { id: string; hash: string; name: string };
  /** snapshot-no-sections 40 min ago: no location, inventory or equipment ever sent. */
  alt: { id: string; hash: string; name: string };
}

async function publicIdOf(ctx: WebTestContext, hash: string): Promise<string> {
  const [row] = await ctx.t.db
    .select({ publicId: osrsAccounts.publicId })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, hash));
  if (!row) throw new Error('account missing');
  return row.publicId;
}

/** Sets one category's audience of the account with `hash`, as the sharing settings would. */
export async function setAudience(
  ctx: WebTestContext,
  hash: string,
  category: Category,
  audience: Audience,
): Promise<void> {
  const [row] = await ctx.t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, hash));
  if (!row) throw new Error('account missing');
  await ctx.t.db
    .insert(accountSharing)
    .values({ accountId: row.id, category, audience })
    .onConflictDoUpdate({
      target: [accountSharing.accountId, accountSharing.category],
      set: { audience },
    });
}

/**
 * Two accounts owned (first reporter) by `ownerId` through one device, with the default sharing
 * (every category → guild, D-96), and a plain guild member `memberId`.
 */
export async function seedWorld(ctx: WebTestContext): Promise<World> {
  const ownerId = await ctx.seedUser({ name: 'Owner' });
  const memberId = await ctx.seedUser({ name: 'Member' });
  const device = await ctx.seedDevice(ownerId);
  const now = Date.now();

  const mainHash = newHash();
  const mainName = 'Alpha Main';
  await ingest(
    device.token,
    fixture('snapshot-normal', { hash: mainHash, name: mainName }),
    new Date(now - 50 * 60_000),
  );

  const altHash = newHash();
  const altName = 'Bravo Alt';
  await ingest(
    device.token,
    fixture('snapshot-no-sections', { hash: altHash, name: altName }),
    new Date(now - 40 * 60_000),
  );

  const later = fixture('snapshot-normal', { hash: mainHash, name: mainName });
  const attack = later.player?.stats?.skills.Attack;
  if (!attack) throw new Error('fixture without Attack');
  attack.xp += ATTACK_GAIN;
  later.events = fixture('event-loot').events ?? [];
  await ingest(device.token, later, new Date(now - 30_000));

  return {
    ownerId,
    memberId,
    device,
    main: { id: await publicIdOf(ctx, mainHash), hash: mainHash, name: mainName },
    alt: { id: await publicIdOf(ctx, altHash), hash: altHash, name: altName },
  };
}
