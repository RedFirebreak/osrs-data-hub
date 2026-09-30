/**
 * The admin service-key routes (D-88): who gets through (401 signed out, 403 non-admins, 403 for a
 * foreign Origin on mutations), creating a key (shown once, audited, no user), listing, revoking,
 * and that the key then authenticates on /api/v1 as a service principal.
 */
import { apiKeys, auditLog } from '@hub/db';
import { authenticateApiKey } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { DELETE as revoke } from './[id]/route';
import { GET as list, POST as create } from './route';

let ctx: WebTestContext;
let adminId: string;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'adminsvckeys' });
  adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  adminCookie = await ctx.signIn(adminId);
  memberCookie = await ctx.signIn(await ctx.seedUser({ name: 'Member' }));
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

type Caller = (cookie: string | undefined, opts?: { origin?: string | null }) => Promise<Response>;

function originOpts(origin: string | null | undefined): {
  headers: Record<string, string>;
  sameOrigin: boolean;
} {
  return { headers: origin ? { origin } : {}, sameOrigin: origin === undefined };
}

const valid = { name: 'Guild live map', categories: ['activity', 'location_live'] };

function createCall(body: unknown): Caller {
  return (cookie, opts = {}) =>
    create(
      ctx.request('/api/app/admin/service-keys', {
        method: 'POST',
        cookie,
        json: body,
        ...originOpts(opts.origin),
      }),
    );
}

function listCall(): Caller {
  return (cookie) => list(ctx.request('/api/app/admin/service-keys', { cookie }));
}

function revokeCall(id: string): Caller {
  return (cookie, opts = {}) =>
    revoke(
      ctx.request(`/api/app/admin/service-keys/${id}`, {
        method: 'DELETE',
        cookie,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id }) },
    );
}

async function expectGuarded(call: Caller, opts: { mutation: boolean }): Promise<void> {
  expect((await call(undefined)).status).toBe(401);
  const member = await call(memberCookie);
  expect(member.status).toBe(403);
  expect(((await member.json()) as ErrorBody).error.code).toBe('forbidden');
  if (opts.mutation) {
    const foreign = await call(adminCookie, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
    expect((await call(adminCookie, { origin: null })).status).toBe(403);
  }
}

interface Created {
  key: string;
  info: { id: string; prefix: string; kind: string; rateLimitPerMinute: number; status: string };
}

describe('POST /api/app/admin/service-keys', () => {
  it('creates a service key shown once, audited, that authenticates as a service principal', async () => {
    const res = await createCall({ ...valid, rateLimitPerMinute: 1200 })(adminCookie);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Created;
    expect(body.key).toMatch(/^ohub_[0-9A-Za-z]{10}_[0-9A-Za-z]{43}$/);
    expect(body.info).toMatchObject({
      kind: 'service',
      name: 'Guild live map',
      categories: ['activity', 'location_live'],
      accountScope: 'all_visible',
      accounts: null,
      rateLimitPerMinute: 1200,
      status: 'active',
      createdBy: { id: adminId, name: 'Admin' },
    });
    expect(JSON.stringify(body.info)).not.toContain(body.key.slice(16));

    const [row] = await ctx.t.db.select().from(apiKeys).where(eq(apiKeys.id, body.info.id));
    expect(row).toMatchObject({ kind: 'service', userId: null, createdByUserId: adminId });
    const audits = await ctx.t.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.targetId, body.info.id));
    expect(audits).toEqual([{ action: 'service_key.created', actor: adminId }]);

    const auth = await authenticateApiKey(ctx.t.db, `Bearer ${body.key}`);
    expect(auth.ok && auth.principal).toMatchObject({
      kind: 'service',
      userId: null,
      viewer: { kind: 'guild_audience' },
      rateLimitPerMinute: 1200,
    });
  });

  it('400 with field details for a bad body; 413 over 64 KiB', async () => {
    const bad = await createCall({ ...valid, rateLimitPerMinute: 0, categories: [] })(adminCookie);
    expect(bad.status).toBe(400);
    const { error } = (await bad.json()) as ErrorBody;
    expect(error.code).toBe('invalid_request');
    expect(error.details?.map((d) => d.path).sort()).toEqual(['categories', 'rateLimitPerMinute']);
    const scoped = await createCall({ ...valid, accountScope: 'list' })(adminCookie);
    expect(scoped.status).toBe(400);
    const huge = await createCall({ ...valid, name: 'x'.repeat(70_000) })(adminCookie);
    expect(huge.status).toBe(413);
  });

  it('is guarded', async () => {
    await expectGuarded(createCall(valid), { mutation: true });
  });
});

describe('GET and DELETE', () => {
  it('lists every service key newest first and revokes one (idempotent, audited)', async () => {
    const first = (await (
      await createCall({ ...valid, name: 'First' })(adminCookie)
    ).json()) as Created;
    const second = (await (
      await createCall({ ...valid, name: 'Second' })(adminCookie)
    ).json()) as Created;
    const listed = await listCall()(adminCookie);
    expect(listed.status).toBe(200);
    const { keys } = (await listed.json()) as { keys: { id: string; kind: string }[] };
    const ids = keys.map((k) => k.id);
    expect(ids.indexOf(second.info.id)).toBeLessThan(ids.indexOf(first.info.id));
    expect(keys.every((k) => k.kind === 'service')).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(first.key.slice(16));

    const revoked = await revokeCall(first.info.id)(adminCookie);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
    expect((await revokeCall(first.info.id)(adminCookie)).status).toBe(200);
    expect((await authenticateApiKey(ctx.t.db, `Bearer ${first.key}`)).ok).toBe(false);
    const audits = await ctx.t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, first.info.id));
    expect(audits.map((a) => a.action)).toEqual(['service_key.created', 'service_key.revoked']);
    const after = (await (await listCall()(adminCookie)).json()) as {
      keys: { id: string; status: string }[];
    };
    expect(after.keys.find((k) => k.id === first.info.id)?.status).toBe('revoked');
  });

  it('404 for unknown ids and non-uuids; both routes are guarded', async () => {
    expect((await revokeCall('not-a-uuid')(adminCookie)).status).toBe(404);
    expect((await revokeCall('00000000-0000-7000-8000-000000000000')(adminCookie)).status).toBe(
      404,
    );
    await expectGuarded(listCall(), { mutation: false });
    const created = (await (await createCall(valid)(adminCookie)).json()) as Created;
    await expectGuarded(revokeCall(created.info.id), { mutation: true });
    expect((await authenticateApiKey(ctx.t.db, `Bearer ${created.key}`)).ok).toBe(true);
  });
});
