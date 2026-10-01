/**
 * GET /api/v1/members/{discord_id} (D-100): a service key gets a 200 verdict for every well-formed
 * id (a member with name and admin flag, or `member: false` for an unknown id and a user in grace
 * alike) and a 400 for a malformed one; a user key gets the catch-all's 404, as if the endpoint
 * didn't exist; the service key keeps answering after the admin who created it is offboarded.
 */
import { createServiceKey, offboardUser, type ServiceKeyInfo } from '@hub/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getUnknownPath } from './[[...rest]]/route';
import { GET as getMember } from './members/[discord_id]/route';
import {
  expectCors,
  expectShape,
  freshLimits,
  makeKey,
  v1Request,
  type TestKey,
} from './test-support';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;
let adminId: string;
let serviceKey: { key: string; info: ServiceKeyInfo };
let memberKey: TestKey;
let adminKey: TestKey;

const ADMIN_DISCORD_ID = '100000000000000001';
const MEMBER_DISCORD_ID = '100000000000000002';
const GRACE_DISCORD_ID = '100000000000000003';
const UNKNOWN_DISCORD_ID = '100000000000000099';

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1members' });
  adminId = await ctx.seedUser({ name: 'Ada Admin', isAdmin: true, discordId: ADMIN_DISCORD_ID });
  const memberId = await ctx.seedUser({ name: 'Molly Member', discordId: MEMBER_DISCORD_ID });
  await ctx.seedUser({
    name: 'Lenny Leaver',
    isAdmin: true,
    status: 'grace',
    discordId: GRACE_DISCORD_ID,
  });
  serviceKey = await createServiceKey(ctx.t.db, {
    actor: { userId: adminId, status: 'active', isAdmin: true },
    input: { name: 'Guild live map', categories: ['activity', 'location_live'] },
  });
  memberKey = await makeKey(ctx, memberId);
  adminKey = await makeKey(ctx, adminId);
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

/** The request as Next routes it: the path segment decoded into the route's params. */
function member(discordId: string, key?: string): Promise<Response> {
  return getMember(v1Request(ctx, `/members/${encodeURIComponent(discordId)}`, { key }), {
    params: Promise.resolve({ discord_id: discordId }),
  });
}

describe('GET /api/v1/members/{discord_id} with a service key', () => {
  it('answers 200 with exactly the documented shape for a member', async () => {
    const res = await member(MEMBER_DISCORD_ID, serviceKey.key);
    expect(res.status).toBe(200);
    expectCors(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-ratelimit-limit')).toMatch(/^\d+$/);
    const body = expectShape(MemberResponse, await res.json());
    expect(body).toEqual({
      data: {
        discord_id: MEMBER_DISCORD_ID,
        member: true,
        is_admin: false,
        name: 'Molly Member',
      },
      meta: { generated_at: expect.any(String) as string },
    });
    expect(Object.keys(body.data)).toEqual(['discord_id', 'member', 'is_admin', 'name']);
  });

  it('reports an admin’s stored admin flag', async () => {
    const res = await member(ADMIN_DISCORD_ID, serviceKey.key);
    expect(res.status).toBe(200);
    expect(expectShape(MemberResponse, await res.json()).data).toEqual({
      discord_id: ADMIN_DISCORD_ID,
      member: true,
      is_admin: true,
      name: 'Ada Admin',
    });
  });

  it('answers 200 `member: false` for an unknown id and a user in grace, indistinguishably', async () => {
    const unknown = await member(UNKNOWN_DISCORD_ID, serviceKey.key);
    expect(unknown.status).toBe(200);
    const unknownBody = expectShape(MemberResponse, await unknown.json());
    expect(unknownBody.data).toEqual({
      discord_id: UNKNOWN_DISCORD_ID,
      member: false,
      is_admin: false,
      name: null,
    });
    const grace = await member(GRACE_DISCORD_ID, serviceKey.key);
    expect(grace.status).toBe(200);
    const graceBody = expectShape(MemberResponse, await grace.json());
    expect(graceBody.data).toEqual({ ...unknownBody.data, discord_id: GRACE_DISCORD_ID });
  });

  it.each([
    ['14 digits', '1'.repeat(14)],
    ['23 digits', '1'.repeat(23)],
    ['a name', 'Molly Member'],
    ['letters among the digits', '10000000000000000x'],
    ['a NUL byte', `${MEMBER_DISCORD_ID}\u0000`],
  ])('answers 400 invalid_request for %s, never 404', async (_label, value) => {
    const res = await member(value, serviceKey.key);
    expect(res.status).toBe(400);
    expectCors(res);
    expect(await res.json()).toEqual({
      error: { code: 'invalid_request', message: expect.stringContaining('discord_id') as string },
    });
  });
});

describe('GET /api/v1/members/{discord_id} without a service key', () => {
  it('answers a user key with the 404 of an unknown path, whoever its creator and whatever the id', async () => {
    const unknownPath = await getUnknownPath();
    expect(unknownPath.status).toBe(404);
    const noSuchEndpoint: unknown = await unknownPath.json();
    expect(noSuchEndpoint).toEqual({
      error: { code: 'not_found', message: expect.any(String) as string },
    });
    for (const key of [memberKey.key, adminKey.key]) {
      for (const id of [MEMBER_DISCORD_ID, UNKNOWN_DISCORD_ID, 'not-an-id']) {
        const res = await member(id, key);
        expect(res.status, id).toBe(404);
        expectCors(res);
        expect(await res.json(), id).toEqual(noSuchEndpoint);
      }
    }
  });

  it('answers 401 without a key, like every authenticated endpoint', async () => {
    const res = await member(MEMBER_DISCORD_ID);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });
});

// Last: it offboards the admin, which revokes their own user key above.
describe('GET /api/v1/members/{discord_id} after an offboarding', () => {
  it('keeps answering after the admin who created the key is offboarded', async () => {
    await offboardUser(ctx.t.db, { userId: adminId, reason: 'admin', graceDays: 30 });
    const res = await member(MEMBER_DISCORD_ID, serviceKey.key);
    expect(res.status).toBe(200);
    expect(expectShape(MemberResponse, await res.json()).data).toMatchObject({ member: true });
    // The offboarded admin is in grace now: no longer a member, and no admin flag shows.
    const gone = await member(ADMIN_DISCORD_ID, serviceKey.key);
    expect(expectShape(MemberResponse, await gone.json()).data).toEqual({
      discord_id: ADMIN_DISCORD_ID,
      member: false,
      is_admin: false,
      name: null,
    });
  });
});
