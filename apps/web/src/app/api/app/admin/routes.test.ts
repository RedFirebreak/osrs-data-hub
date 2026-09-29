/**
 * The admin API (handoff §12 Admin): who gets through (401 signed out, 403 non-admins, 403 for a
 * foreign Origin on mutations), and each route's happy path against seeded data.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_GUILD_FEED_FILTER, setConfigForTests } from '@hub/core';
import { auditLog, devices, rawPayloads, session, users } from '@hub/db';
import { getGuildFeedFilter, isDecommissioned } from '@hub/server';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getAuditLog } from './audit-log/route';
import { PUT as putDecommission } from './decommission/route';
import { DELETE as revokeDevice } from './devices/[id]/route';
import { PUT as putGuildFeed } from './guild-feed/route';
import { GET as getRawPayload } from './raw-payloads/[id]/route';
import { POST as offboard } from './users/[id]/offboard/route';
import { POST as restore } from './users/[id]/restore/route';

let ctx: WebTestContext;
let adminId: string;
let adminCookie: string;
let memberCookie: string;

const GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'adminapi', env: { OFFBOARD_GRACE_DAYS: String(GRACE_DAYS) } });
  adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  adminCookie = await ctx.signIn(adminId);
  memberCookie = await ctx.signIn(await ctx.seedUser({ name: 'Member' }));
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string };
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorBody).error.code;
}

type Caller = (cookie: string | undefined, opts?: { origin?: string | null }) => Promise<Response>;

/** Request options for a mutation: the hub's Origin unless `origin` says otherwise (null = none). */
function originOpts(origin: string | null | undefined): {
  headers: Record<string, string>;
  sameOrigin: boolean;
} {
  return { headers: origin ? { origin } : {}, sameOrigin: origin === undefined };
}

function offboardCall(userId: string): Caller {
  return (cookie, opts = {}) =>
    offboard(
      ctx.request(`/api/app/admin/users/${userId}/offboard`, {
        method: 'POST',
        cookie,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
}

function restoreCall(userId: string): Caller {
  return (cookie, opts = {}) =>
    restore(
      ctx.request(`/api/app/admin/users/${userId}/restore`, {
        method: 'POST',
        cookie,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
}

function revokeCall(deviceId: string): Caller {
  return (cookie, opts = {}) =>
    revokeDevice(
      ctx.request(`/api/app/admin/devices/${deviceId}`, {
        method: 'DELETE',
        cookie,
        ...originOpts(opts.origin),
      }),
      { params: Promise.resolve({ id: deviceId }) },
    );
}

function decommissionCall(body: unknown): Caller {
  return (cookie, opts = {}) =>
    putDecommission(
      ctx.request('/api/app/admin/decommission', {
        method: 'PUT',
        cookie,
        json: body,
        ...originOpts(opts.origin),
      }),
    );
}

/**
 * The viewer's GET. Headers as a browser sends them: `Origin` of the hub by default (as any
 * same-origin request may carry), or exactly `headers` (then no Origin unless given).
 */
function rawPayloadCall(
  id: string,
  receivedAt: string | null,
  headers?: Record<string, string>,
): Caller {
  const qs = receivedAt === null ? '' : `?receivedAt=${encodeURIComponent(receivedAt)}`;
  return (cookie) =>
    getRawPayload(
      ctx.request(`/api/app/admin/raw-payloads/${id}${qs}`, {
        cookie,
        ...(headers ? { headers, sameOrigin: false } : {}),
      }),
      { params: Promise.resolve({ id }) },
    );
}

function auditLogCall(query = ''): Caller {
  return (cookie) => getAuditLog(ctx.request(`/api/app/admin/audit-log${query}`, { cookie }));
}

/** 401 signed out, 403 `forbidden` for a member, and (mutations) 403 `bad_origin` for an admin. */
async function expectGuarded(call: Caller, opts: { mutation: boolean }): Promise<void> {
  expect((await call(undefined)).status).toBe(401);
  const member = await call(memberCookie);
  expect(member.status).toBe(403);
  expect(await errorCode(member)).toBe('forbidden');
  if (opts.mutation) {
    const foreign = await call(adminCookie, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('bad_origin');
    expect((await call(adminCookie, { origin: null })).status).toBe(403);
  }
}

function guildFeedCall(body: unknown): Caller {
  return (cookie, opts = {}) =>
    putGuildFeed(
      ctx.request('/api/app/admin/guild-feed', {
        method: 'PUT',
        cookie,
        json: body,
        ...originOpts(opts.origin),
      }),
    );
}

async function userRow(id: string) {
  const [row] = await ctx.t.db.select().from(users).where(eq(users.id, id));
  return row;
}

async function deviceRow(id: string) {
  const [row] = await ctx.t.db.select().from(devices).where(eq(devices.id, id));
  return row;
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await ctx.t.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.targetId, targetId))
    .orderBy(auditLog.id);
  return rows.map((r) => r.action);
}

describe('admin gate', () => {
  it('reads the admin flag fresh: a demoted admin gets 403 at once', async () => {
    const formerAdmin = await ctx.seedUser({ isAdmin: true });
    const cookie = await ctx.signIn(formerAdmin);
    expect((await auditLogCall()(cookie)).status).toBe(200);
    await ctx.t.db.update(users).set({ isAdmin: false }).where(eq(users.id, formerAdmin));
    expect((await auditLogCall()(cookie)).status).toBe(403);
  });

  it('turns away an admin in grace whose session survived (401), before any change', async () => {
    const graceAdmin = await ctx.seedUser({ isAdmin: true });
    const cookie = await ctx.signIn(graceAdmin);
    await ctx.t.db.update(users).set({ status: 'grace' }).where(eq(users.id, graceAdmin));
    const target = await ctx.seedUser();
    expect((await auditLogCall()(cookie)).status).toBe(401);
    expect((await offboardCall(target)(cookie)).status).toBe(401);
    expect(
      (await decommissionCall({ decommissioned: true, confirm: 'Test Hub' })(cookie)).status,
    ).toBe(401);
    expect((await userRow(target))?.status).toBe('active');
    expect(await isDecommissioned(ctx.t.db)).toBe(false);
  });
});

describe('POST /api/app/admin/users/[id]/offboard', () => {
  it('offboards with reason admin: grace for OFFBOARD_GRACE_DAYS, devices and sessions gone', async () => {
    const target = await ctx.seedUser({ name: 'Leaving' });
    const device = await ctx.seedDevice(target);
    await ctx.signIn(target);
    const before = Date.now();

    const res = await offboardCall(target)(adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      transferred: 0,
      hidden: 0,
      revokedDevices: 1,
      deletedSessions: 1,
    });

    const row = await userRow(target);
    expect(row?.status).toBe('grace');
    expect(row?.offboardReason).toBe('admin');
    const graceMs = (row?.graceUntil?.getTime() ?? 0) - before;
    expect(graceMs).toBeGreaterThanOrEqual(GRACE_DAYS * DAY_MS - 1_000);
    expect(graceMs).toBeLessThanOrEqual(GRACE_DAYS * DAY_MS + 60_000);
    expect((await deviceRow(device.id))?.revokedAt).toBeInstanceOf(Date);
    const sessions = await ctx.t.db.select().from(session).where(eq(session.userId, target));
    expect(sessions).toHaveLength(0);
    expect(await auditActions(target)).toContain('user.offboarded');
  });

  it('400 for the admin themselves, 404 for an unknown user', async () => {
    const self = await offboardCall(adminId)(adminCookie);
    expect(self.status).toBe(400);
    expect(await errorCode(self)).toBe('invalid');
    expect((await userRow(adminId))?.status).toBe('active');
    const unknown = await offboardCall('no-such-user')(adminCookie);
    expect(unknown.status).toBe(404);
  });

  it('is guarded, and a refused request offboards nobody', async () => {
    const target = await ctx.seedUser();
    await expectGuarded(offboardCall(target), { mutation: true });
    expect((await userRow(target))?.status).toBe('active');
  });
});

describe('POST /api/app/admin/users/[id]/restore', () => {
  it('brings a user in grace back; an active user is a no-op', async () => {
    const target = await ctx.seedUser({ name: 'Returning' });
    expect((await offboardCall(target)(adminCookie)).status).toBe(200);
    expect((await userRow(target))?.status).toBe('grace');

    const res = await restoreCall(target)(adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unhidden: 0 });
    const row = await userRow(target);
    expect(row?.status).toBe('active');
    expect(row?.graceUntil).toBeNull();
    expect(row?.offboardReason).toBeNull();
    expect(await auditActions(target)).toEqual(['user.offboarded', 'user.restored']);

    const again = await restoreCall(target)(adminCookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, unhidden: 0 });
    expect((await restoreCall('no-such-user')(adminCookie)).status).toBe(404);
  });

  it('is guarded, and a refused request restores nobody', async () => {
    const target = await ctx.seedUser({ status: 'grace' });
    await expectGuarded(restoreCall(target), { mutation: true });
    expect((await userRow(target))?.status).toBe('grace');
  });
});

describe('DELETE /api/app/admin/devices/[id]', () => {
  it("revokes any user's device with reason admin, idempotently", async () => {
    const owner = await ctx.seedUser();
    const device = await ctx.seedDevice(owner);
    const res = await revokeCall(device.id)(adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await deviceRow(device.id);
    expect(row?.revokedReason).toBe('admin');
    const revokedAt = row?.revokedAt?.getTime();
    expect(revokedAt).toBeTypeOf('number');

    expect((await revokeCall(device.id)(adminCookie)).status).toBe(200);
    expect((await deviceRow(device.id))?.revokedAt?.getTime()).toBe(revokedAt);
    const [entry] = await ctx.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, device.id), eq(auditLog.action, 'device.revoked')));
    expect(entry?.actorUserId).toBe(adminId);
    expect(entry?.meta).toMatchObject({ reason: 'admin', ownerUserId: owner, asAdmin: true });
  });

  it('404 for an unknown or malformed id', async () => {
    expect((await revokeCall(randomUUID())(adminCookie)).status).toBe(404);
    expect((await revokeCall('nope')(adminCookie)).status).toBe(404);
  });

  it('is guarded, and the device stays active', async () => {
    const device = await ctx.seedDevice(await ctx.seedUser());
    await expectGuarded(revokeCall(device.id), { mutation: true });
    expect((await deviceRow(device.id))?.revokedAt).toBeNull();
  });
});

describe('GET /api/app/admin/raw-payloads/[id]', () => {
  const body = '{"player":{"name":"Kree\\u0027arra"},"location":{"x":3200,"y":3200}}';
  let payload: { id: string; receivedAt: Date };

  beforeAll(async () => {
    const [row] = await ctx.t.db
      .insert(rawPayloads)
      .values({
        receivedAt: new Date(Date.now() - 60_000),
        deviceId: randomUUID(),
        status: 200,
        pluginVersion: '1.5',
        body,
      })
      .returning({ id: rawPayloads.id, receivedAt: rawPayloads.receivedAt });
    if (!row) throw new Error('no row');
    payload = row;
  });

  it('returns the body as stored, no-store, and audits the view', async () => {
    const res = await rawPayloadCall(payload.id, payload.receivedAt.toISOString())(adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      payload: { id: payload.id, receivedAt: payload.receivedAt.toISOString(), body },
    });
    const [entry] = await ctx.t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, payload.id))
      .orderBy(desc(auditLog.id));
    expect(entry?.action).toBe('raw_payload.viewed');
    expect(entry?.actorUserId).toBe(adminId);
  });

  it('400 without a valid receivedAt; 404 for another time or an unknown id', async () => {
    for (const receivedAt of [null, 'yesterday', '2026-09-29']) {
      const res = await rawPayloadCall(payload.id, receivedAt)(adminCookie);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_request');
    }
    const otherTime = new Date(payload.receivedAt.getTime() + 1).toISOString();
    expect((await rawPayloadCall(payload.id, otherTime)(adminCookie)).status).toBe(404);
    const iso = payload.receivedAt.toISOString();
    expect((await rawPayloadCall(randomUUID(), iso)(adminCookie)).status).toBe(404);
    expect((await rawPayloadCall('nope', iso)(adminCookie)).status).toBe(404);
  });

  it('is guarded, and a refused request is not audited as a view', async () => {
    const views = async () =>
      (await ctx.t.db.select().from(auditLog).where(eq(auditLog.targetId, payload.id))).length;
    const before = await views();
    await expectGuarded(rawPayloadCall(payload.id, payload.receivedAt.toISOString()), {
      mutation: false,
    });
    expect(await views()).toBe(before);
  });

  it('requires the same origin before reading or auditing anything (D-80)', async () => {
    const views = async () =>
      (await ctx.t.db.select().from(auditLog).where(eq(auditLog.targetId, payload.id))).length;
    const iso = payload.receivedAt.toISOString();
    const before = await views();
    // A foreign page with the admin's cookie: a fetch or form (Origin), or an <img>/link (no Origin,
    // Sec-Fetch-Site cross-site); and a request with neither header.
    const foreign: Record<string, string>[] = [
      { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      {},
    ];
    for (const headers of foreign) {
      const res = await rawPayloadCall(payload.id, iso, headers)(adminCookie);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await errorCode(res)).toBe('bad_origin');
    }
    expect(await views()).toBe(before);

    // The viewer's own same-origin fetch: no Origin on a GET, Sec-Fetch-Site same-origin.
    const res = await rawPayloadCall(payload.id, iso, { 'sec-fetch-site': 'same-origin' })(
      adminCookie,
    );
    expect(res.status).toBe(200);
    expect(await views()).toBe(before + 1);
  });
});

describe('GET /api/app/admin/audit-log', () => {
  it('pages newest first with nextBefore', async () => {
    await ctx.t.db.insert(auditLog).values(
      ['a.one', 'a.two', 'a.three'].map((action) => ({
        action,
        actorLabel: 'system',
        meta: { n: action },
      })),
    );
    const first = await auditLogCall('?limit=2')(adminCookie);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      entries: { id: number; action: string; at: string; actorLabel: string | null }[];
      nextBefore: number | null;
    };
    expect(page.entries.map((e) => e.action)).toEqual(['a.three', 'a.two']);
    expect(page.entries[0]?.actorLabel).toBe('system');
    expect(Number.isFinite(Date.parse(page.entries[0]?.at ?? ''))).toBe(true);
    expect(page.nextBefore).toBe(page.entries[1]?.id);

    const second = await auditLogCall(`?before=${page.nextBefore}&limit=2`)(adminCookie);
    const next = (await second.json()) as { entries: { id: number; action: string }[] };
    expect(next.entries[0]?.action).toBe('a.one');
    expect(next.entries.every((e) => e.id < (page.nextBefore ?? 0))).toBe(true);

    const all = await auditLogCall('?limit=200')(adminCookie);
    const rest = (await all.json()) as { entries: unknown[]; nextBefore: number | null };
    expect(rest.entries.length).toBeLessThan(200);
    expect(rest.nextBefore).toBeNull();
  });

  it('400 for a malformed query', async () => {
    for (const query of ['?before=abc', '?before=0', '?limit=0', '?limit=201', '?limit=-1']) {
      const res = await auditLogCall(query)(adminCookie);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_request');
    }
  });

  it('is guarded', async () => {
    await expectGuarded(auditLogCall(), { mutation: false });
  });
});

describe('PUT /api/app/admin/decommission', () => {
  it('needs the hub name typed to turn on; turns off without it', async () => {
    const db = ctx.t.db;
    for (const body of [
      { decommissioned: true },
      { decommissioned: true, confirm: 'test hub' },
      { decommissioned: true, confirm: 'Test Hub!' },
    ]) {
      const res = await decommissionCall(body)(adminCookie);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('confirmation_mismatch');
    }
    expect(await isDecommissioned(db)).toBe(false);

    const on = await decommissionCall({ decommissioned: true, confirm: ' Test Hub ' })(adminCookie);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ decommissioned: true });
    expect(await isDecommissioned(db)).toBe(true);

    const off = await decommissionCall({ decommissioned: false })(adminCookie);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ decommissioned: false });
    expect(await isDecommissioned(db)).toBe(false);

    const entries = await db
      .select({ meta: auditLog.meta, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.decommissioned'))
      .orderBy(auditLog.id);
    expect(entries).toEqual([
      { meta: { value: true }, actor: adminId },
      { meta: { value: false }, actor: adminId },
    ]);
  });

  it('accepts the name as the page shows it when HUB_NAME was cut off at a space', async () => {
    // parseConfig trims HUB_NAME, then cuts it to 64 characters: the cut can end on a space, which
    // nobody can type into the (trimmed) confirmation.
    const hubName = `${'A'.repeat(63)} `;
    setConfigForTests({ ...ctx.config, hubName });
    try {
      const res = await decommissionCall({ decommissioned: true, confirm: 'A'.repeat(63) })(
        adminCookie,
      );
      expect(res.status).toBe(200);
      expect(await isDecommissioned(ctx.t.db)).toBe(true);
      const wrong = await decommissionCall({ decommissioned: true, confirm: 'A'.repeat(62) })(
        adminCookie,
      );
      expect(wrong.status).toBe(400);
    } finally {
      setConfigForTests(ctx.config);
      expect((await decommissionCall({ decommissioned: false })(adminCookie)).status).toBe(200);
    }
  });

  it('400 for an invalid body', async () => {
    for (const body of [{}, { decommissioned: 'yes' }, { decommissioned: false, extra: 1 }, []]) {
      const res = await decommissionCall(body)(adminCookie);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_request');
    }
  });

  it('is guarded, and a refused request changes nothing', async () => {
    await expectGuarded(decommissionCall({ decommissioned: true, confirm: 'Test Hub' }), {
      mutation: true,
    });
    expect(await isDecommissioned(ctx.t.db)).toBe(false);
  });
});

describe('PUT /api/app/admin/guild-feed', () => {
  it('stores the guild feed filter and audits it (D-81)', async () => {
    const filter = { minLootValue: 250_000, showVirtualLevels: true };
    const res = await guildFeedCall(filter)(adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(filter);
    expect(await getGuildFeedFilter(ctx.t.db)).toEqual(filter);
    const [entry] = await ctx.t.db
      .select({ meta: auditLog.meta, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.guild_feed_changed'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry).toEqual({ meta: filter, actor: adminId });

    const back = await guildFeedCall(DEFAULT_GUILD_FEED_FILTER)(adminCookie);
    expect(back.status).toBe(200);
    expect(await getGuildFeedFilter(ctx.t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });

  it('refuses a malformed body with 400 and changes nothing', async () => {
    for (const body of [
      {},
      { minLootValue: 1_000 },
      { minLootValue: -1, showVirtualLevels: false },
      { minLootValue: 1.5, showVirtualLevels: false },
      { minLootValue: 2 ** 31 + 1, showVirtualLevels: false },
      { minLootValue: '1000', showVirtualLevels: false },
      { minLootValue: 1_000, showVirtualLevels: false, extra: true },
    ]) {
      expect((await guildFeedCall(body)(adminCookie)).status).toBe(400);
    }
    expect(await getGuildFeedFilter(ctx.t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });

  it('is guarded, and a refused request changes nothing', async () => {
    await expectGuarded(guildFeedCall({ minLootValue: 5, showVirtualLevels: true }), {
      mutation: true,
    });
    expect(await getGuildFeedFilter(ctx.t.db)).toEqual(DEFAULT_GUILD_FEED_FILTER);
  });
});
