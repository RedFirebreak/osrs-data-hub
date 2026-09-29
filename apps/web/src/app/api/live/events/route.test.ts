import { randomUUID } from 'node:crypto';
import { accountSharing, events, osrsAccounts } from '@hub/db';
import type { LiveEventMessage } from '@hub/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './route';

let ctx: WebTestContext;
let cookie: string;
const seqs: Record<'old' | 'a' | 'b' | 'young' | 'private', number> = {
  old: 0,
  a: 0,
  b: 0,
  young: 0,
  private: 0,
};

async function seedAccount(name: string): Promise<number> {
  const [row] = await ctx.t.db
    .insert(osrsAccounts)
    .values({
      publicId: randomUUID().replace(/-/g, '').slice(0, 12),
      accountHash: randomUUID(),
      currentName: name,
      nameNormalized: name.toLowerCase(),
    })
    .returning({ id: osrsAccounts.id });
  return row!.id;
}

/** An event row received and inserted `agoMs` before now. */
async function seedEvent(accountId: number, agoMs: number): Promise<number> {
  const at = new Date(Date.now() - agoMs);
  const [row] = await ctx.t.db
    .insert(events)
    .values({
      pluginEventId: randomUUID(),
      accountId,
      type: 'level_up',
      skill: 'Attack',
      level: 99,
      occurredAt: at,
      receivedAt: at,
      insertedAt: at,
      data: { type: 'levelUp', data: { skills: { Attack: 99 } } },
    })
    .returning({ seq: events.seq });
  return row!.seq;
}

beforeAll(async () => {
  ctx = await withTestDb({ label: 'liveevents' });
  cookie = await ctx.signIn(await ctx.seedUser());
  const visible = await seedAccount('Zezima');
  const hidden = await seedAccount('Secret');
  // events shared with nobody but the (absent) owner.
  await ctx.t.db
    .insert(accountSharing)
    .values({ accountId: hidden, category: 'events', audience: 'private' });
  seqs.old = await seedEvent(visible, 3 * 60_000);
  seqs.a = await seedEvent(visible, 40_000);
  seqs.private = await seedEvent(hidden, 35_000);
  seqs.b = await seedEvent(visible, 30_000);
  // Inserted just now: may still be overtaken by a slower transaction (DB-4), so not served yet.
  seqs.young = await seedEvent(visible, 0);
});
afterAll(() => ctx.cleanup());

async function poll(query: string) {
  const res = await GET(ctx.request(`/api/live/events${query}`, { cookie }));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return (await res.json()) as { events: LiveEventMessage[]; cursor: number };
}

describe('GET /api/live/events', () => {
  it('401 without a session', async () => {
    const res = await GET(ctx.request('/api/live/events?after=1'));
    expect(res.status).toBe(401);
  });

  it('first poll (no cursor): no events, the settled cursor', async () => {
    for (const query of ['', '?after=', '?after=abc', '?after=-5', '?after=1.5']) {
      const body = await poll(query);
      expect(body.events).toEqual([]);
      // The newest settled seq: past the older rows, before the one inserted just now.
      expect(body.cursor).toBe(Math.max(seqs.b, seqs.private));
      expect(body.cursor).toBeLessThan(seqs.young);
    }
  });

  it('after=<seq>: the visible events after it from the last 5 minutes, and the next cursor', async () => {
    const body = await poll(`?after=${seqs.old}`);
    expect(body.events.map((m) => m.event.seq)).toEqual([seqs.a, seqs.b]);
    expect(body.events[0]?.event.account.name).toBe('Zezima');
    expect(typeof body.events[0]?.toast).toBe('boolean');
    expect(body.cursor).toBe(seqs.b);

    // Nothing new that has settled: the cursor stays where it was.
    const next = await poll(`?after=${body.cursor}`);
    expect(next.events).toEqual([]);
    expect(next.cursor).toBe(seqs.b);
  });

  it('after=0 is a cursor, not "none": a hub without events hands out 0 and must still deliver its first ones', async () => {
    const body = await poll('?after=0');
    expect(body.events.map((m) => m.event.seq)).toEqual([seqs.old, seqs.a, seqs.b]);
    expect(body.cursor).toBe(seqs.b);
  });
});
