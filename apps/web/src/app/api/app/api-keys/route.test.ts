/**
 * The API keys routes (D-69, D-76): POST /api/app/api-keys and DELETE /api/app/api-keys/[id].
 * Create (201, the key shown once and working on /api/v1, never in the list), validation errors with
 * field details, the active-key limit (409), idempotent revoke, another user's key (404), session
 * auth and the Origin check.
 */
import { auditLog } from '@hub/db';
import { MAX_ACTIVE_KEYS, listApiKeys, type ApiKeyInfo } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getMe } from '@/app/api/v1/me/route';
import { freshLimits, seedWorld, v1Request, type World } from '@/app/api/v1/test-support';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { DELETE } from './[id]/route';
import { POST } from './route';

// /api/v1/me (to check a created key works) calls connection().
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;
let world: World;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appapikeys' });
  world = await seedWorld(ctx);
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function create(
  cookie: string | undefined,
  body: unknown,
  opts: { origin?: string } = {},
): Promise<Response> {
  return POST(
    ctx.request('/api/app/api-keys', {
      method: 'POST',
      cookie,
      json: body,
      headers: opts.origin ? { origin: opts.origin } : {},
      sameOrigin: opts.origin === undefined,
    }),
  );
}

function revoke(cookie: string | undefined, id: string, opts: { origin?: string } = {}) {
  return DELETE(
    ctx.request(`/api/app/api-keys/${id}`, {
      method: 'DELETE',
      cookie,
      headers: opts.origin ? { origin: opts.origin } : {},
      sameOrigin: opts.origin === undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

const valid = {
  name: 'Home Assistant',
  categories: ['stats', 'activity'],
  accountScope: 'all_visible',
};

describe('POST /api/app/api-keys', () => {
  it('creates a key: 201, shown once, no-store, and it works on /api/v1', async () => {
    const owner = await ctx.signIn(world.ownerId);
    const res = await create(owner, {
      name: '  Discord bot ',
      categories: ['events', 'stats', 'events'],
      accountScope: 'list',
      accountPublicIds: [world.main.id],
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { key: string; info: ApiKeyInfo };
    expect(body.key).toMatch(/^ohub_[0-9A-Za-z]{10}_[0-9A-Za-z]{43}$/);
    expect(body.info).toMatchObject({
      name: 'Discord bot',
      prefix: body.key.slice(5, 15),
      categories: ['stats', 'events'],
      accountScope: 'list',
      accounts: [{ publicId: world.main.id, name: world.main.name, visible: true }],
      status: 'active',
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(Date.parse(body.info.expiresAt ?? '') - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const me = await getMe(v1Request(ctx, '/me', { key: body.key }));
    expect(me.status).toBe(200);

    // The list the page renders never contains the secret.
    const text = JSON.stringify(await listApiKeys(ctx.t.db, world.ownerId));
    expect(text).toContain(body.info.id);
    expect(text).not.toContain(body.key.slice(16));

    const [audited] = await ctx.t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, body.info.id));
    expect(audited?.action).toBe('api_key.created');
  });

  it('400 with field details for an invalid body', async () => {
    const { cookie } = await signedIn();
    const cases: [unknown, string][] = [
      [{ ...valid, name: '   ' }, 'name'],
      [{ ...valid, name: 'x'.repeat(65) }, 'name'],
      [{ ...valid, categories: [] }, 'categories'],
      [{ ...valid, categories: ['everything'] }, 'categories'],
      [{ ...valid, accountScope: 'list' }, 'accountPublicIds'],
      [{ ...valid, accountPublicIds: ['abc'] }, 'accountPublicIds'],
      [{ ...valid, expiresInDays: 400 }, 'expiresInDays'],
      [{ ...valid, extra: true }, ''],
    ];
    for (const [body, path] of cases) {
      const res = await create(cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const { error } = (await res.json()) as ErrorBody;
      expect(error.code).toBe('invalid_request');
      expect(error.details?.[0]?.path.split('.')[0], JSON.stringify(body)).toBe(path);
    }
  });

  it('400 for a list naming an account the user can’t see', async () => {
    const { cookie } = await signedIn();
    const res = await create(cookie, {
      ...valid,
      categories: ['equipment'],
      accountScope: 'list',
      accountPublicIds: ['Zz9Zz9Zz9Zz9'],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.details?.[0]?.path).toBe('accountPublicIds');
  });

  it('400 for a body that isn’t JSON', async () => {
    const { cookie } = await signedIn();
    const res = await POST(
      ctx.request('/api/app/api-keys', { method: 'POST', cookie, body: '{nope' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_json');
  });

  it(`409 limit once ${MAX_ACTIVE_KEYS} keys are active; revoking one frees a place`, async () => {
    const { cookie } = await signedIn();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      const res = await create(cookie, { ...valid, name: `key ${i}` });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { info: ApiKeyInfo }).info.id);
    }
    const over = await create(cookie, valid);
    expect(over.status).toBe(409);
    expect(((await over.json()) as ErrorBody).error.code).toBe('limit');
    expect((await revoke(cookie, ids[0] ?? '')).status).toBe(204);
    expect((await create(cookie, valid)).status).toBe(201);
  });

  it('401 without a session, 403 from another origin', async () => {
    expect((await create(undefined, valid)).status).toBe(401);
    const { cookie } = await signedIn();
    const foreign = await create(cookie, valid, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
  });
});

describe('DELETE /api/app/api-keys/[id]', () => {
  it('revokes: 204, idempotent, and the key stops working', async () => {
    const owner = await ctx.signIn(world.ownerId);
    const created = (await (await create(owner, valid)).json()) as {
      key: string;
      info: ApiKeyInfo;
    };
    expect((await getMe(v1Request(ctx, '/me', { key: created.key }))).status).toBe(200);

    const res = await revoke(owner, created.info.id);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect((await revoke(owner, created.info.id)).status).toBe(204);
    expect((await getMe(v1Request(ctx, '/me', { key: created.key }))).status).toBe(401);

    const keys = await listApiKeys(ctx.t.db, world.ownerId);
    expect(keys.find((k) => k.id === created.info.id)?.status).toBe('revoked');
  });

  it('404 for another user’s key and for ids that aren’t keys', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const created = (await (await create(a.cookie, valid)).json()) as { info: ApiKeyInfo };
    const other = await revoke(b.cookie, created.info.id);
    expect(other.status).toBe(404);
    expect(((await other.json()) as ErrorBody).error.code).toBe('not_found');
    expect((await revoke(b.cookie, 'not-a-uuid')).status).toBe(404);
    expect((await revoke(b.cookie, '0192f0e2-8d3c-7cc4-a4f4-0123456789ab')).status).toBe(404);
    // Still active for its owner.
    const keys = await listApiKeys(ctx.t.db, a.userId);
    expect(keys[0]?.status).toBe('active');
  });

  it('401 without a session, 403 from another origin', async () => {
    const { cookie } = await signedIn();
    const created = (await (await create(cookie, valid)).json()) as { info: ApiKeyInfo };
    expect((await revoke(undefined, created.info.id)).status).toBe(401);
    expect((await revoke(cookie, created.info.id, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
  });
});
