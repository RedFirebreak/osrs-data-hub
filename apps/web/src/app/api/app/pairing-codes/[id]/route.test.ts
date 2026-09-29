import { randomUUID } from 'node:crypto';
import { accountLinks, deviceAccounts, osrsAccounts, pairingCodes } from '@hub/db';
import { createPairingCode } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'pairingstatus' });
});
afterAll(() => ctx.cleanup());

interface StatusBody {
  code: {
    id: string;
    code: string;
    status: 'active' | 'consumed' | 'expired';
    expiresAt: string;
    deviceId: string | null;
    outdatedAttemptAt: string | null;
    outdatedVersion: string | null;
  };
  device: {
    account: { publicId: string; name: string; accountType: number | null };
    role: 'owner' | 'contributor';
    ownerName: string | null;
  } | null;
}

async function signedIn(name?: string): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser({ name });
  return { userId, cookie: await ctx.signIn(userId) };
}

function status(cookie: string | undefined, id: string): Promise<Response> {
  return GET(ctx.request(`/api/app/pairing-codes/${id}`, { cookie }), {
    params: Promise.resolve({ id }),
  });
}

async function newCode(userId: string, ttlSeconds = 300) {
  return createPairingCode(ctx.t.db, { userId, ttlSeconds });
}

/** Marks the code consumed by a new device of its user, as pairing would. */
async function consume(userId: string, codeId: string): Promise<string> {
  const device = await ctx.seedDevice(userId, { label: 'PC' });
  await ctx.t.db
    .update(pairingCodes)
    .set({ consumedAt: new Date(), deviceId: device.id })
    .where(eq(pairingCodes.id, codeId));
  return device.id;
}

/** An account the device reported, owned by `ownerUserId` (null: unclaimed). */
async function report(
  deviceId: string,
  name: string,
  ownerUserId: string | null,
  accountType: number | null = null,
) {
  const publicId = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await ctx.t.db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: randomUUID(),
      currentName: name,
      nameNormalized: name.toLowerCase(),
      accountType,
      ownerUserId,
    })
    .returning({ id: osrsAccounts.id });
  const accountId = row!.id;
  if (ownerUserId) {
    await ctx.t.db.insert(accountLinks).values({ accountId, userId: ownerUserId, role: 'owner' });
  }
  await ctx.t.db.insert(deviceAccounts).values({ deviceId, accountId });
  return { accountId, publicId };
}

describe('GET /api/app/pairing-codes/[id]', () => {
  it('the state of an own active code, without a device yet', async () => {
    const { userId, cookie } = await signedIn();
    const created = await newCode(userId);
    const res = await status(cookie, created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      code: {
        id: created.id,
        code: created.code,
        status: 'active',
        expiresAt: created.expiresAt.toISOString(),
        deviceId: null,
        outdatedAttemptAt: null,
        outdatedVersion: null,
      },
      device: null,
    });
  });

  it("404 for another user's code, an unknown id and a malformed id", async () => {
    const owner = await signedIn();
    const created = await newCode(owner.userId);
    const other = await signedIn();
    for (const id of [created.id, randomUUID(), 'not-a-uuid', '12345']) {
      const res = await status(other.cookie, id);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it('401 without a session', async () => {
    const { userId } = await signedIn();
    const created = await newCode(userId);
    expect((await status(undefined, created.id)).status).toBe(401);
  });

  it('reports an attempt from an outdated plugin, and an expired code', async () => {
    const { userId, cookie } = await signedIn();
    const created = await newCode(userId);
    const at = new Date();
    await ctx.t.db
      .update(pairingCodes)
      .set({ lastOutdatedAttemptAt: at, lastOutdatedVersion: '1.4' })
      .where(eq(pairingCodes.id, created.id));
    const outdated = (await (await status(cookie, created.id)).json()) as StatusBody;
    expect(outdated.code).toMatchObject({
      status: 'active',
      outdatedAttemptAt: at.toISOString(),
      outdatedVersion: '1.4',
    });

    await ctx.t.db
      .update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(pairingCodes.id, created.id));
    const expired = (await (await status(cookie, created.id)).json()) as StatusBody;
    expect(expired.code.status).toBe('expired');
    expect(expired.device).toBeNull();
  });

  it('a consumed code: the device, then its first account with the owner role', async () => {
    const { userId, cookie } = await signedIn('Alice');
    const created = await newCode(userId);
    const deviceId = await consume(userId, created.id);

    const waiting = (await (await status(cookie, created.id)).json()) as StatusBody;
    expect(waiting.code).toMatchObject({ status: 'consumed', deviceId });
    expect(waiting.device).toBeNull();

    const { publicId } = await report(deviceId, 'Zezima', userId, 1);
    const body = (await (await status(cookie, created.id)).json()) as StatusBody;
    expect(body.device).toEqual({
      account: { publicId, name: 'Zezima', accountType: 1 },
      role: 'owner',
      ownerName: 'Alice',
    });
  });

  it("a contributor to someone else's account learns the owner's name", async () => {
    const owner = await ctx.seedUser({ name: 'Bob' });
    const { userId, cookie } = await signedIn('Carol');
    const created = await newCode(userId);
    const deviceId = await consume(userId, created.id);
    await report(deviceId, 'Shared Main', owner);
    const body = (await (await status(cookie, created.id)).json()) as StatusBody;
    expect(body.device).toMatchObject({
      account: { name: 'Shared Main' },
      role: 'contributor',
      ownerName: 'Bob',
    });
  });
});
