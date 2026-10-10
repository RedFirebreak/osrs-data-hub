/**
 * The admin service-key routes (D-88, D-111): who gets through (401 signed out, 403 non-admins, 403
 * for a foreign Origin), creating a key (shown once, audited, no user), editing it (the same key
 * reads the new categories), revoking, deleting a revoked key, and that the key then authenticates
 * on /api/v1 as a service principal.
 */
import { apiKeys, auditLog } from '@hub/db';
import { authenticateApiKey, listServiceKeys } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { POST as remove } from './[id]/delete/route';
import { PATCH as edit, DELETE as revoke } from './[id]/route';
import { POST as create } from './route';

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

function editCall(id: string, body: unknown): Caller {
  return (cookie, opts = {}) =>
    edit(
      ctx.request(`/api/app/admin/service-keys/${id}`, {
        method: 'PATCH',
        cookie,
        json: body,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id }) },
    );
}

function removeCall(id: string): Caller {
  return (cookie, opts = {}) =>
    remove(
      ctx.request(`/api/app/admin/service-keys/${id}/delete`, {
        method: 'POST',
        cookie,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id }) },
    );
}

async function expectGuarded(call: Caller): Promise<void> {
  expect((await call(undefined)).status).toBe(401);
  const member = await call(memberCookie);
  expect(member.status).toBe(403);
  expect(((await member.json()) as ErrorBody).error.code).toBe('forbidden');
  const foreign = await call(adminCookie, { origin: 'https://evil.test' });
  expect(foreign.status).toBe(403);
  expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
  expect((await call(adminCookie, { origin: null })).status).toBe(403);
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
    await expectGuarded(createCall(valid));
  });
});

describe('DELETE /api/app/admin/service-keys/[id]', () => {
  it('revokes a service key (idempotent, audited)', async () => {
    const first = (await (
      await createCall({ ...valid, name: 'First' })(adminCookie)
    ).json()) as Created;

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
    const after = await listServiceKeys(ctx.t.db);
    expect(after.find((k) => k.id === first.info.id)?.status).toBe('revoked');
  });

  it('404 for unknown ids and non-uuids; the route is guarded', async () => {
    expect((await revokeCall('not-a-uuid')(adminCookie)).status).toBe(404);
    expect((await revokeCall('00000000-0000-7000-8000-000000000000')(adminCookie)).status).toBe(
      404,
    );
    const created = (await (await createCall(valid)(adminCookie)).json()) as Created;
    await expectGuarded(revokeCall(created.info.id));
    expect((await authenticateApiKey(ctx.t.db, `Bearer ${created.key}`)).ok).toBe(true);
  });
});

describe('PATCH /api/app/admin/service-keys/[id]', () => {
  it('adds a category to the same key, audited; 409 once revoked', async () => {
    const created = (await (await createCall(valid)(adminCookie)).json()) as Created;
    const res = await editCall(created.info.id, {
      categories: ['activity', 'location_live', 'hiscores'],
    })(adminCookie);
    expect(res.status).toBe(200);
    const { info } = (await res.json()) as { info: Created['info'] & { categories: string[] } };
    expect(info).toMatchObject({
      id: created.info.id,
      prefix: created.info.prefix,
      categories: ['activity', 'location_live', 'hiscores'],
      createdBy: { id: adminId, name: 'Admin' },
    });
    const auth = await authenticateApiKey(ctx.t.db, `Bearer ${created.key}`);
    expect(auth.ok && auth.principal.categories.has('hiscores')).toBe(true);
    const audits = await ctx.t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, created.info.id));
    expect(audits.map((a) => a.action)).toEqual(['service_key.created', 'service_key.updated']);

    const bad = await editCall(created.info.id, { rateLimitPerMinute: 0 })(adminCookie);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.details?.[0]?.path).toBe('rateLimitPerMinute');
    await revokeCall(created.info.id)(adminCookie);
    expect((await editCall(created.info.id, { name: 'x' })(adminCookie)).status).toBe(409);
  });

  it('404 for unknown ids; the route is guarded', async () => {
    expect((await editCall('not-a-uuid', { name: 'x' })(adminCookie)).status).toBe(404);
    const created = (await (await createCall(valid)(adminCookie)).json()) as Created;
    await expectGuarded(editCall(created.info.id, { name: 'x' }));
  });
});

describe('POST /api/app/admin/service-keys/[id]/delete', () => {
  it('deletes a revoked key (audited), 409 while active, 404 after', async () => {
    const created = (await (await createCall(valid)(adminCookie)).json()) as Created;
    expect((await removeCall(created.info.id)(adminCookie)).status).toBe(409);
    await revokeCall(created.info.id)(adminCookie);
    await expectGuarded(removeCall(created.info.id));
    const res = await removeCall(created.info.id)(adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await removeCall(created.info.id)(adminCookie)).status).toBe(404);
    expect((await listServiceKeys(ctx.t.db)).some((k) => k.id === created.info.id)).toBe(false);
    const audits = await ctx.t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, created.info.id));
    expect(audits.map((a) => a.action)).toEqual([
      'service_key.created',
      'service_key.revoked',
      'service_key.deleted',
    ]);
  });
});
