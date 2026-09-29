/**
 * GET /api/app/feed (the events timeline's and the guild feed's "load more") and GET
 * /api/app/members (the grant picker).
 */
import type { ActiveMember, FeedEvent } from '@hub/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { accountSeeder, type AccountSeeder, type SeededAccount } from '../accounts/test-seed';
import { GET as getMembers } from '../members/route';
import { GET as getFeed } from './route';

let ctx: WebTestContext;
let seed: AccountSeeder;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'feedroute' });
  seed = accountSeeder(ctx.t.db);
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

interface FeedBody {
  events: FeedEvent[];
  nextBefore: number | null;
}

async function signedIn(opts: Parameters<WebTestContext['seedUser']>[0] = {}) {
  const userId = await ctx.seedUser(opts);
  return { userId, cookie: await ctx.signIn(userId) };
}

async function feed(query: string, cookie?: string): Promise<Response> {
  return getFeed(ctx.request(`/api/app/feed${query}`, { cookie }));
}

async function feedBody(query: string, cookie: string): Promise<FeedBody> {
  const res = await feed(query, cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as FeedBody;
}

describe('GET /api/app/feed', () => {
  let owner: { userId: string; cookie: string };
  let member: { userId: string; cookie: string };
  let open: SeededAccount;
  let secret: SeededAccount;
  const seqs: number[] = [];

  beforeAll(async () => {
    owner = await signedIn();
    member = await signedIn();
    open = await seed.account({ owner: owner.userId, name: 'Open' });
    secret = await seed.account({ owner: owner.userId, name: 'Secret' });
    await seed.sharing(secret.id, 'events', 'private');
    for (let i = 0; i < 5; i++) {
      const type = i % 2 === 0 ? 'loot' : 'level_up';
      seqs.push((await seed.event(open.id, { type, valueGp: 1_000 * (i + 1) })).seq);
    }
    await seed.event(secret.id, {
      type: 'death',
      data: {
        type: 'death',
        eventId: 'e1',
        timestamp: 0,
        data: { valueLost: 1, location: { x: 1, y: 2, plane: 0 } },
      },
    });
  });

  it('401 without a session', async () => {
    const res = await feed('');
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('unauthorized');
  });

  it("the viewer's feed, newest first; private events stay out", async () => {
    const body = await feedBody('', member.cookie);
    expect(body.events.map((e) => e.seq)).toEqual([...seqs].reverse());
    expect(body.events.every((e) => e.account.publicId === open.publicId)).toBe(true);
    expect(body.nextBefore).toBeNull();
    // The owner sees both accounts.
    const own = await feedBody('', owner.cookie);
    expect(own.events.map((e) => e.account.name)).toContain('Secret');
  });

  it('pages with before + limit; nextBefore is the last seq of a full page', async () => {
    const first = await feedBody('?limit=2', member.cookie);
    expect(first.events.map((e) => e.seq)).toEqual([seqs[4], seqs[3]]);
    expect(first.nextBefore).toBe(seqs[3]);
    const second = await feedBody(`?limit=2&before=${first.nextBefore}`, member.cookie);
    expect(second.events.map((e) => e.seq)).toEqual([seqs[2], seqs[1]]);
    const last = await feedBody(`?limit=2&before=${second.nextBefore}`, member.cookie);
    expect(last.events.map((e) => e.seq)).toEqual([seqs[0]]);
    expect(last.nextBefore).toBeNull();
  });

  it('filters by account and by type', async () => {
    const byAccount = await feedBody(`?account=${open.publicId}&types=loot`, member.cookie);
    expect(byAccount.events.map((e) => e.seq)).toEqual([seqs[4], seqs[2], seqs[0]]);
    const both = await feedBody('?types=loot,level_up', member.cookie);
    expect(both.events).toHaveLength(5);
    const empty = await feedBody('?types=', member.cookie);
    expect(empty.events).toHaveLength(5);
  });

  it('an invisible or unknown account gives an empty feed (existence never leaks)', async () => {
    expect((await feedBody(`?account=${secret.publicId}`, member.cookie)).events).toEqual([]);
    expect((await feedBody('?account=Nothing00000', member.cookie)).events).toEqual([]);
  });

  it('redacts event locations for viewers without a location category', async () => {
    const shared = await seed.account({ owner: owner.userId });
    // No location category for the member: live location isn't shared (it is by default, D-82).
    await seed.sharing(shared.id, 'location_live', 'private');
    await seed.event(shared.id, {
      type: 'death',
      data: {
        type: 'death',
        eventId: 'e2',
        timestamp: 0,
        data: { valueLost: 5, location: { x: 3068, y: 3858, plane: 0 } },
      },
    });
    const [ev] = (await feedBody(`?account=${shared.publicId}`, member.cookie)).events;
    expect(JSON.stringify(ev?.data)).not.toContain('3068');
    const [own] = (await feedBody(`?account=${shared.publicId}`, owner.cookie)).events;
    expect(JSON.stringify(own?.data)).toContain('3068');
  });

  it('400 with field errors for a malformed query', async () => {
    const cases: [string, string][] = [
      ['?before=0', 'before'],
      ['?before=-3', 'before'],
      ['?before=abc', 'before'],
      ['?limit=0', 'limit'],
      ['?limit=201', 'limit'],
      ['?limit=2.5', 'limit'],
      ['?types=loot,drop%20table', 'types.1'],
      ['?account=has-dash', 'account'],
    ];
    for (const [query, path] of cases) {
      const res = await feed(query, member.cookie);
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe('invalid_request');
      expect(
        body.error.details?.map((d) => d.path),
        query,
      ).toContain(path);
    }
  });
});

describe('GET /api/app/members', () => {
  let owner: { userId: string; cookie: string };

  beforeAll(async () => {
    owner = await signedIn({ name: 'Mid Viewer' });
    await seed.account({ owner: owner.userId, name: 'Owned' });
  });

  async function members(cookie?: string): Promise<Response> {
    return getMembers(ctx.request('/api/app/members', { cookie }));
  }

  it('401 without a session', async () => {
    expect((await members()).status).toBe(401);
  });

  it('403 forbidden unless the viewer can manage the sharing of an account (D-80)', async () => {
    // A plain member, and a contributor of an account someone else owns: they see the sharing
    // panel of that account, but read-only, without the grant picker.
    const plain = await signedIn();
    const contributor = await signedIn();
    await seed.account({ owner: owner.userId, contributors: [contributor.userId] });
    for (const viewer of [plain, contributor]) {
      const res = await members(viewer.cookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code).toBe('forbidden');
    }
    // The owner of an account that is hidden (an owner in grace can't sign in; no override) can't.
    const hiddenOwner = await signedIn();
    await seed.account({ owner: hiddenOwner.userId, status: 'hidden' });
    expect((await members(hiddenOwner.cookie)).status).toBe(403);
  });

  it('an admin gets the list through the admin override, without owning an account', async () => {
    const admin = await signedIn({ isAdmin: true });
    expect((await members(admin.cookie)).status).toBe(200);
  });

  it('lists active members by name, without members in grace', async () => {
    await ctx.seedUser({ name: 'aardvark' });
    await ctx.seedUser({ name: 'Zulu' });
    await ctx.seedUser({ name: 'Gone', status: 'grace' });
    const res = await members(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { members: list } = (await res.json()) as { members: ActiveMember[] };
    const names = list.map((m) => m.name);
    expect(names).not.toContain('Gone');
    // By name, case-insensitively.
    const order = ['aardvark', 'Mid Viewer', 'Zulu'].map((n) => names.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['image', 'name', 'userId']);
  });
});
