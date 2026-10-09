/**
 * GET/PATCH /api/app/accounts/[publicId]/sharing: who may read the settings, who may change them,
 * each action of the PATCH body, CSRF (403 bad_origin) and body validation (400).
 */
import { CATEGORIES } from '@hub/core';
import { accountLinks, accountShareGrants, accountSharing, auditLog, osrsAccounts } from '@hub/db';
import type { SharingSettings } from '@hub/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { accountSeeder, type AccountSeeder, type SeededAccount } from '../../test-seed';
import { GET, PATCH } from './route';

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'sharingroute' });
  seed = accountSeeder(ctx.t.db);
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

interface User {
  userId: string;
  cookie: string;
}

async function signedIn(opts: Parameters<WebTestContext['seedUser']>[0] = {}): Promise<User> {
  const userId = await ctx.seedUser(opts);
  return { userId, cookie: await ctx.signIn(userId) };
}

function params(publicId: string) {
  return { params: Promise.resolve({ publicId }) };
}

function get(publicId: string, cookie?: string) {
  return GET(ctx.request(`/api/app/accounts/${publicId}/sharing`, { cookie }), params(publicId));
}

function patch(
  publicId: string,
  cookie: string | undefined,
  body: unknown,
  opts: { origin?: string | null; raw?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.raw !== undefined) headers['content-type'] = 'application/json';
  return PATCH(
    ctx.request(`/api/app/accounts/${publicId}/sharing`, {
      method: 'PATCH',
      cookie,
      ...(opts.raw !== undefined ? { body: opts.raw } : { json: body }),
      headers,
      sameOrigin: opts.origin === undefined,
    }),
    params(publicId),
  );
}

async function sharingOf(res: Response): Promise<SharingSettings> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { sharing: SharingSettings }).sharing;
}

async function audits(publicId: string, action: string): Promise<number> {
  const rows = await ctx.t.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, publicId), eq(auditLog.action, action)));
  return rows.length;
}

describe('GET /api/app/accounts/[publicId]/sharing', () => {
  let owner: User;
  let contributor: User;
  let account: SeededAccount;

  beforeAll(async () => {
    owner = await signedIn({ name: 'Owner' });
    contributor = await signedIn({ name: 'Contributor' });
    account = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
  });

  it('401 without a session', async () => {
    expect((await get(account.publicId)).status).toBe(401);
  });

  it('the owner reads every category with its defaults (D-96), and the contributors', async () => {
    const sharing = await sharingOf(await get(account.publicId, owner.cookie));
    expect(sharing.canManage).toBe(true);
    expect(sharing.categories.map((c) => [c.category, c.audience, c.isDefault])).toEqual([
      ['stats', 'guild', true],
      ['events', 'guild', true],
      ['activity', 'guild', true],
      ['location_live', 'guild', true],
      ['location_history', 'guild', true],
      ['equipment', 'guild', true],
      ['inventory', 'guild', true],
    ]);
    expect(sharing.contributors.map((c) => [c.name, c.role])).toEqual([
      ['Owner', 'owner'],
      ['Contributor', 'contributor'],
    ]);
  });

  it('a contributor reads it without canManage; a plain member and a stranger get 404', async () => {
    const sharing = await sharingOf(await get(account.publicId, contributor.cookie));
    expect(sharing.canManage).toBe(false);
    const member = await signedIn();
    const res = await get(account.publicId, member.cookie);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
    expect((await get('Unknown00000', member.cookie)).status).toBe(404);
  });

  it('an admin reads and may manage any account', async () => {
    const admin = await signedIn({ isAdmin: true });
    expect((await sharingOf(await get(account.publicId, admin.cookie))).canManage).toBe(true);
  });
});

describe('PATCH /api/app/accounts/[publicId]/sharing', () => {
  it('audience: changes a category and returns the new settings, audited once', async () => {
    const owner = await signedIn();
    const account = await seed.account({ owner: owner.userId });
    const sharing = await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'audience',
        category: 'inventory',
        audience: 'private',
      }),
    );
    expect(sharing.categories.find((c) => c.category === 'inventory')).toMatchObject({
      audience: 'private',
      isDefault: false,
    });
    // The same change again succeeds without another audit entry.
    await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'audience',
        category: 'inventory',
        audience: 'private',
      }),
    );
    expect(await audits(account.publicId, 'sharing.audience_changed')).toBe(1);
  });

  it('grant and revoke: selected people see a category only with a grant', async () => {
    const owner = await signedIn();
    const friend = await signedIn({ name: 'Friend' });
    const account = await seed.account({ owner: owner.userId });
    await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'audience',
        category: 'equipment',
        audience: 'selected',
      }),
    );
    const granted = await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'grant',
        category: 'equipment',
        userId: friend.userId,
      }),
    );
    expect(granted.categories.find((c) => c.category === 'equipment')?.grants).toEqual([
      { userId: friend.userId, name: 'Friend' },
    ]);
    const revoked = await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'revoke',
        category: 'equipment',
        userId: friend.userId,
      }),
    );
    expect(revoked.categories.find((c) => c.category === 'equipment')?.grants).toEqual([]);
    const rows = await ctx.t.db
      .select()
      .from(accountShareGrants)
      .where(eq(accountShareGrants.accountId, account.id));
    expect(rows).toHaveLength(0);
  });

  it('grant: 400 when the grantee is not an active member', async () => {
    const owner = await signedIn();
    const gone = await ctx.seedUser({ status: 'grace' });
    const account = await seed.account({ owner: owner.userId });
    const res = await patch(account.publicId, owner.cookie, {
      action: 'grant',
      category: 'stats',
      userId: gone,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('invalid');
  });

  it('block, unblock and remove a contributor; the owner cannot be blocked', async () => {
    const owner = await signedIn();
    const contributor = await signedIn();
    const account = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });

    const blocked = await sharingOf(
      await patch(account.publicId, owner.cookie, { action: 'block', userId: contributor.userId }),
    );
    expect(blocked.contributors.find((c) => c.userId === contributor.userId)?.blocked).toBe(true);
    // A blocked contributor is refused removal (the block would go with the link, D-52).
    const refused = await patch(account.publicId, owner.cookie, {
      action: 'remove',
      userId: contributor.userId,
    });
    expect(refused.status).toBe(400);

    const unblocked = await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'unblock',
        userId: contributor.userId,
      }),
    );
    expect(unblocked.contributors.find((c) => c.userId === contributor.userId)?.blocked).toBe(
      false,
    );
    const removed = await sharingOf(
      await patch(account.publicId, owner.cookie, { action: 'remove', userId: contributor.userId }),
    );
    expect(removed.contributors.map((c) => c.userId)).toEqual([owner.userId]);

    const self = await patch(account.publicId, owner.cookie, {
      action: 'block',
      userId: owner.userId,
    });
    expect(self.status).toBe(400);
  });

  it('transfer: the contributor becomes the owner and the old owner loses canManage', async () => {
    const owner = await signedIn();
    const contributor = await signedIn();
    const account = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
    const after = await sharingOf(
      await patch(account.publicId, owner.cookie, {
        action: 'transfer',
        userId: contributor.userId,
      }),
    );
    expect(after.canManage).toBe(false);
    expect(after.contributors.find((c) => c.role === 'owner')?.userId).toBe(contributor.userId);
    const [row] = await ctx.t.db
      .select({ owner: osrsAccounts.ownerUserId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, account.id));
    expect(row?.owner).toBe(contributor.userId);
    // The old owner can no longer change anything.
    const res = await patch(account.publicId, owner.cookie, {
      action: 'audience',
      category: 'stats',
      audience: 'private',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe('forbidden');
  });

  it('claim: a contributor claims an account without an owner; a member may not', async () => {
    const contributor = await signedIn();
    const member = await signedIn();
    const account = await seed.account({ owner: null, contributors: [contributor.userId] });
    const denied = await patch(account.publicId, member.cookie, { action: 'claim' });
    expect(denied.status).toBe(403);
    const claimed = await sharingOf(
      await patch(account.publicId, contributor.cookie, { action: 'claim' }),
    );
    expect(claimed.canManage).toBe(true);
    const again = await patch(account.publicId, contributor.cookie, { action: 'claim' });
    expect(again.status).toBe(400);
    const links = await ctx.t.db
      .select({ role: accountLinks.role })
      .from(accountLinks)
      .where(eq(accountLinks.accountId, account.id));
    expect(links).toEqual([{ role: 'owner' }]);
  });

  it('403 forbidden for a contributor and a member; 404 for an account they cannot see', async () => {
    const owner = await signedIn();
    const contributor = await signedIn();
    const member = await signedIn();
    const account = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
    const change = { action: 'audience', category: 'stats', audience: 'private' };
    expect((await patch(account.publicId, contributor.cookie, change)).status).toBe(403);
    expect((await patch(account.publicId, member.cookie, change)).status).toBe(403);

    const secret = await seed.account({ owner: owner.userId });
    for (const category of CATEGORIES) {
      await seed.sharing(secret.id, category, 'private');
    }
    const res = await patch(secret.publicId, member.cookie, change);
    expect(res.status).toBe(404);
    expect((await patch('Unknown00000', member.cookie, change)).status).toBe(404);
  });

  it('an admin overrides: changes sharing of an account they do not own', async () => {
    const owner = await signedIn();
    const admin = await signedIn({ isAdmin: true });
    const account = await seed.account({ owner: owner.userId });
    await sharingOf(
      await patch(account.publicId, admin.cookie, {
        action: 'audience',
        category: 'stats',
        audience: 'private',
      }),
    );
    const rows = await ctx.t.db
      .select({ audience: accountSharing.audience })
      .from(accountSharing)
      .where(eq(accountSharing.accountId, account.id));
    expect(rows).toEqual([{ audience: 'private' }]);
  });

  it('hide: only the players see the account until it is shown again (D-104), audited once each', async () => {
    const owner = await signedIn();
    const contributor = await signedIn();
    const member = await signedIn();
    const account = await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
    const hidden = await sharingOf(
      await patch(account.publicId, owner.cookie, { action: 'hide', hidden: true }),
    );
    expect(hidden.hiddenFromGuild).toBe(true);
    await sharingOf(await patch(account.publicId, owner.cookie, { action: 'hide', hidden: true }));
    expect((await sharingOf(await get(account.publicId, contributor.cookie))).hiddenFromGuild).toBe(
      true,
    );
    // A contributor may not change it; a member doesn't learn the account exists.
    expect(
      (await patch(account.publicId, contributor.cookie, { action: 'hide', hidden: false })).status,
    ).toBe(403);
    expect(
      (await patch(account.publicId, member.cookie, { action: 'hide', hidden: false })).status,
    ).toBe(404);
    const shown = await sharingOf(
      await patch(account.publicId, owner.cookie, { action: 'hide', hidden: false }),
    );
    expect(shown.hiddenFromGuild).toBe(false);
    expect(await audits(account.publicId, 'sharing.hidden_from_guild_changed')).toBe(2);
  });

  it('400 invalid_request for malformed bodies, and nothing changes', async () => {
    const owner = await signedIn();
    const account = await seed.account({ owner: owner.userId });
    const cases: [unknown, string][] = [
      [{ action: 'audience', category: 'stats', audience: 'everyone' }, 'audience'],
      [{ action: 'audience', category: 'bank', audience: 'guild' }, 'category'],
      [{ action: 'grant', category: 'stats' }, 'userId'],
      [{ action: 'transfer', userId: '' }, 'userId'],
      [{ action: 'claim', userId: 'x' }, ''],
      [{ action: 'hide' }, 'hidden'],
      [{ action: 'hide', hidden: 'yes' }, 'hidden'],
      [{ action: 'explode' }, 'action'],
      [{}, 'action'],
    ];
    for (const [body, path] of cases) {
      const res = await patch(account.publicId, owner.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const err = (await res.json()) as ErrorBody;
      expect(err.error.code).toBe('invalid_request');
      expect(
        err.error.details?.map((d) => d.path),
        JSON.stringify(body),
      ).toContain(path);
    }
    for (const body of [null, [], 'claim']) {
      expect((await patch(account.publicId, owner.cookie, body)).status).toBe(400);
    }
    const bad = await patch(account.publicId, owner.cookie, null, { raw: '{"action":' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.code).toBe('invalid_json');
    const rows = await ctx.t.db
      .select()
      .from(accountSharing)
      .where(eq(accountSharing.accountId, account.id));
    expect(rows).toHaveLength(0);
  });

  it('403 bad_origin from another origin or without an Origin, before anything else', async () => {
    const owner = await signedIn();
    const account = await seed.account({ owner: owner.userId });
    const change = { action: 'audience', category: 'stats', audience: 'private' };
    const foreign = await patch(account.publicId, owner.cookie, change, {
      origin: 'https://evil.test',
    });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe('bad_origin');
    expect((await patch(account.publicId, owner.cookie, change, { origin: null })).status).toBe(
      403,
    );
    // Even signed out, a cross-origin request is refused as such.
    expect(
      (await patch(account.publicId, undefined, change, { origin: 'https://evil.test' })).status,
    ).toBe(403);
    const rows = await ctx.t.db
      .select()
      .from(accountSharing)
      .where(eq(accountSharing.accountId, account.id));
    expect(rows).toHaveLength(0);
  });

  it('401 without a session', async () => {
    const res = await patch('Unknown00000', undefined, { action: 'claim' });
    expect(res.status).toBe(401);
  });

  it('404 for a public id that cannot exist (a NUL byte is not a database error)', async () => {
    const owner = await signedIn();
    const res = await patch('abc\u0000def', owner.cookie, { action: 'claim' });
    expect(res.status).toBe(404);
    expect((await get('abc\u0000def', owner.cookie)).status).toBe(404);
    // CSRF is still checked first.
    const foreign = await patch(
      'abc\u0000def',
      owner.cookie,
      { action: 'claim' },
      {
        origin: 'https://evil.test',
      },
    );
    expect(foreign.status).toBe(403);
  });
});
