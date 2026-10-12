/**
 * Invite a friend (D-117): POST /api/app/friends and DELETE /api/app/friends/[id]. Inviting (201,
 * normalised), the refusals with their status (400, 403, 409), removing (a waiting invite, another
 * member's is 404), session auth and the Origin check.
 */
import { friendInvites, users } from '@hub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { DELETE } from './[id]/route';
import { GET, POST } from './route';

let ctx: WebTestContext;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'appfriends' });
});
afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; message: string };
}

async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const userId = await ctx.seedUser();
  return { userId, cookie: await ctx.signIn(userId) };
}

function invite(cookie: string | undefined, body: unknown, opts: { origin?: string } = {}) {
  return POST(
    ctx.request('/api/app/friends', {
      method: 'POST',
      cookie,
      json: body,
      headers: opts.origin ? { origin: opts.origin } : {},
      sameOrigin: opts.origin === undefined,
    }),
  );
}

function remove(cookie: string | undefined, id: string, opts: { origin?: string } = {}) {
  return DELETE(
    ctx.request(`/api/app/friends/${id}`, {
      method: 'DELETE',
      cookie,
      headers: opts.origin ? { origin: opts.origin } : {},
      sameOrigin: opts.origin === undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('POST /api/app/friends', () => {
  it('invites a Discord username: 201 with the friend, normalised', async () => {
    const { cookie } = await signedIn();
    const res = await invite(cookie, { username: ' @Some.Friend ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { friend: { id: string; username: string } };
    expect(body.friend).toMatchObject({ username: 'some.friend', joinedAt: null, friend: null });
  });

  it('answers each refusal with its status and a message for the member', async () => {
    const { cookie } = await signedIn();
    const bad = await invite(cookie, { username: 'not a name' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.code).toBe('invalid');

    await invite(cookie, { username: 'taken.name' });
    const other = await signedIn();
    const taken = await invite(other.cookie, { username: 'taken.name' });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as ErrorBody).error.message).toBe(
      'taken.name is already invited.',
    );

    for (const name of ['two.a', 'two.b']) {
      expect((await invite(cookie, { username: name })).status).toBe(201);
    }
    const full = await invite(cookie, { username: 'one.too.many' });
    expect(full.status).toBe(409);
    expect(((await full.json()) as ErrorBody).error.code).toBe('limit');

    expect((await invite(cookie, { username: 'x.y', extra: 1 })).status).toBe(400);
  });

  it('refuses an invited friend with 403 (no friends of friends)', async () => {
    const { userId, cookie } = await signedIn();
    await ctx.t.db.update(users).set({ access: 'friend' }).where(eq(users.id, userId));
    const res = await invite(cookie, { username: 'friend.of.friend' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.message).toBe(
      'Only members of the guild can invite friends.',
    );
  });

  it('needs a session and the hub as Origin', async () => {
    expect((await invite(undefined, { username: 'no.session' })).status).toBe(401);
    const { cookie } = await signedIn();
    const foreign = await invite(
      cookie,
      { username: 'no.origin' },
      { origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
    expect(
      await ctx.t.db.select().from(friendInvites).where(eq(friendInvites.username, 'no.origin')),
    ).toEqual([]);
  });
});

describe('GET /api/app/friends', () => {
  it("lists the user's friends with the settings, and needs a session", async () => {
    const { cookie } = await signedIn();
    await invite(cookie, { username: 'listed.friend' });
    const res = await GET(ctx.request('/api/app/friends', { cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access: 'member',
      invitedBy: null,
      enabled: true,
      maxPerMember: 3,
      friends: [{ username: 'listed.friend', joinedAt: null, friend: null }],
    });
    expect((await GET(ctx.request('/api/app/friends'))).status).toBe(401);
  });
});

describe('DELETE /api/app/friends/[id]', () => {
  it("removes the member's own invite, and answers 404 for another's or a malformed id", async () => {
    const owner = await signedIn();
    const created = (await (await invite(owner.cookie, { username: 'to.remove' })).json()) as {
      friend: { id: string };
    };
    const id = created.friend.id;
    const other = await signedIn();
    expect((await remove(other.cookie, id)).status).toBe(404);
    expect((await remove(owner.cookie, 'not-a-uuid')).status).toBe(404);
    expect((await remove(owner.cookie, id, { origin: 'https://evil.test' })).status).toBe(403);
    const res = await remove(owner.cookie, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, offboarded: false });
    expect((await remove(owner.cookie, id)).status).toBe(404);
  });
});
