import { pairingCodes } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_APP_ORIGIN, withTestDb, type WebTestContext } from '@/lib/test-utils';
import { POST } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'pairingcodes' });
});
afterAll(() => ctx.cleanup());

interface Created {
  id: string;
  code: string;
  expiresAt: string;
  baseUrl: string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string }[] };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function create(
  cookie: string | undefined,
  body?: unknown,
  opts: { origin?: string | null; raw?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.raw !== undefined) headers['content-type'] = 'application/json';
  return POST(
    ctx.request('/api/app/pairing-codes', {
      method: 'POST',
      cookie,
      json: body,
      body: opts.raw,
      headers,
      sameOrigin: opts.origin === undefined,
    }),
  );
}

async function codesOf(userId: string) {
  return ctx.t.db.select().from(pairingCodes).where(eq(pairingCodes.userId, userId));
}

describe('POST /api/app/pairing-codes', () => {
  it('201 with the code, its expiry and the exact base URL, and stores the label', async () => {
    const { userId, cookie } = await signedIn();
    const before = Date.now();
    const res = await create(cookie, { label: '  Desktop PC  ' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Created;
    expect(Object.keys(body).sort()).toEqual(['baseUrl', 'code', 'expiresAt', 'id']);
    expect(body.code).toMatch(/^[0-9]{5}$/);
    expect(typeof body.code).toBe('string');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    // APP_URL's origin, never the request's bind address (NEXT-2).
    expect(body.baseUrl).toBe(TEST_APP_ORIGIN);
    const ttlMs = ctx.config.pairingCodeTtlSeconds * 1000;
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ttlMs + 1_000);

    const rows = await codesOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.id, code: body.code, label: 'Desktop PC' });
  });

  it('accepts an empty body and a null label (no device label)', async () => {
    const { userId, cookie } = await signedIn();
    expect((await create(cookie)).status).toBe(201);
    expect((await create(cookie, undefined, { raw: '' })).status).toBe(201);
    expect((await create(cookie, {})).status).toBe(201);
    expect((await create(cookie, { label: null })).status).toBe(201);
    expect((await create(cookie, { label: '   ' })).status).toBe(201);
    const rows = await codesOf(userId);
    expect(rows.map((r) => r.label)).toEqual([null, null, null, null, null]);
  });

  it('413 for a body over the cap', async () => {
    const { cookie } = await signedIn();
    const res = await create(cookie, { label: 'x', padding: 'y'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it('keeps at most 3 active codes per user: a new one retires the oldest', async () => {
    const { userId, cookie } = await signedIn();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await create(cookie, {});
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as Created).id);
    }
    const now = Date.now();
    const active = (await codesOf(userId))
      .filter((r) => r.consumedAt === null && r.expiresAt.getTime() > now)
      .map((r) => r.id)
      .sort();
    expect(active).toEqual(ids.slice(1).sort());
  });

  it('403 bad_origin from another origin or without an Origin, and creates nothing', async () => {
    const { userId, cookie } = await signedIn();
    const foreign = await create(cookie, {}, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
    const missing = await create(cookie, {}, { origin: null });
    expect(missing.status).toBe(403);
    expect(await codesOf(userId)).toHaveLength(0);
  });

  it('401 without a session, and for a user in grace', async () => {
    const res = await create(undefined, {});
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('unauthorized');

    const graceUser = await ctx.seedUser({ status: 'grace' });
    const grace = await create(await ctx.signIn(graceUser), {});
    expect(grace.status).toBe(401);
    expect(await codesOf(graceUser)).toHaveLength(0);
  });

  it('400 for invalid bodies', async () => {
    const { userId, cookie } = await signedIn();
    for (const body of [
      { label: 5 },
      { label: 'x', extra: true },
      [],
      'x',
      { label: 'x'.repeat(300) },
    ]) {
      const res = await create(cookie, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_request');
    }
    const broken = await create(cookie, undefined, { raw: '{"label":' });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as ErrorBody).error.code).toBe('invalid_json');
    expect(await codesOf(userId)).toHaveLength(0);
  });
});
