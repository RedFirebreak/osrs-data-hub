import { randomUUID } from 'node:crypto';
import { auditLog, devices } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { DELETE, PATCH } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appdevices' });
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function rename(
  cookie: string | undefined,
  id: string,
  body: unknown,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  return PATCH(
    ctx.request(`/api/app/devices/${id}`, {
      method: 'PATCH',
      cookie,
      json: body,
      headers,
      sameOrigin: opts.origin === undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

function revoke(
  cookie: string | undefined,
  id: string,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  return DELETE(
    ctx.request(`/api/app/devices/${id}`, {
      method: 'DELETE',
      cookie,
      headers,
      sameOrigin: opts.origin === undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function deviceRow(id: string) {
  const [row] = await ctx.t.db.select().from(devices).where(eq(devices.id, id));
  return row;
}

describe('PATCH /api/app/devices/[id]', () => {
  it('renames an own device and answers with the label as stored', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId, { label: 'old' });
    const res = await rename(cookie, device.id, { label: '  Laptop\u0007 upstairs  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ device: { id: device.id, label: 'Laptop  upstairs' } });
    expect((await deviceRow(device.id))?.label).toBe('Laptop  upstairs');

    const cleared = await rename(cookie, device.id, { label: null });
    expect(await cleared.json()).toEqual({ device: { id: device.id, label: null } });
    expect((await deviceRow(device.id))?.label).toBeNull();

    const long = await rename(cookie, device.id, { label: 'x'.repeat(100) });
    expect(((await long.json()) as { device: { label: string } }).device.label).toHaveLength(64);
  });

  it("404 for another user's device, an unknown id and a malformed id; nothing changes", async () => {
    const owner = await signedIn();
    const device = await ctx.seedDevice(owner.userId, { label: 'mine' });
    const other = await signedIn();
    for (const id of [device.id, randomUUID(), 'nope']) {
      const res = await rename(other.cookie, id, { label: 'stolen' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
    }
    expect((await deviceRow(device.id))?.label).toBe('mine');
  });

  it('400 for invalid bodies', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId, { label: 'keep' });
    for (const body of [
      {},
      { label: 5 },
      { label: 'x', other: 1 },
      [],
      { label: 'x'.repeat(300) },
    ]) {
      const res = await rename(cookie, device.id, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_request');
    }
    expect((await deviceRow(device.id))?.label).toBe('keep');
  });

  it('403 without the hub Origin and 401 without a session; nothing changes', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId, { label: 'keep' });
    const foreign = await rename(
      cookie,
      device.id,
      { label: 'x' },
      { origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
    expect((await rename(cookie, device.id, { label: 'x' }, { origin: null })).status).toBe(403);
    expect((await rename(undefined, device.id, { label: 'x' })).status).toBe(401);
    expect((await deviceRow(device.id))?.label).toBe('keep');
  });
});

describe('DELETE /api/app/devices/[id]', () => {
  it('revokes an own device (reason user, audited), and again is still 200', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId);
    const res = await revoke(cookie, device.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await deviceRow(device.id);
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.revokedReason).toBe('user');
    const firstRevokedAt = row?.revokedAt?.getTime();

    const again = await revoke(cookie, device.id);
    expect(again.status).toBe(200);
    expect((await deviceRow(device.id))?.revokedAt?.getTime()).toBe(firstRevokedAt);

    const audits = await ctx.t.db.select().from(auditLog).where(eq(auditLog.targetId, device.id));
    expect(audits.map((a) => a.action)).toEqual(['device.revoked']);
  });

  it("404 for another user's device, and it stays active", async () => {
    const owner = await signedIn();
    const device = await ctx.seedDevice(owner.userId);
    const other = await signedIn();
    for (const id of [device.id, randomUUID(), 'nope']) {
      expect((await revoke(other.cookie, id)).status).toBe(404);
    }
    expect((await deviceRow(device.id))?.revokedAt).toBeNull();
  });

  it('403 without the hub Origin and 401 without a session; the device stays active', async () => {
    const { userId, cookie } = await signedIn();
    const device = await ctx.seedDevice(userId);
    expect((await revoke(cookie, device.id, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await revoke(cookie, device.id, { origin: null })).status).toBe(403);
    expect((await revoke(undefined, device.id)).status).toBe(401);
    const graceUser = await ctx.seedUser({ status: 'grace' });
    const graceDevice = await ctx.seedDevice(graceUser);
    expect((await revoke(await ctx.signIn(graceUser), graceDevice.id)).status).toBe(401);
    expect((await deviceRow(device.id))?.revokedAt).toBeNull();
    expect((await deviceRow(graceDevice.id))?.revokedAt).toBeNull();
  });
});
