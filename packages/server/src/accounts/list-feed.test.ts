import { events } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT, listFeed } from './list-feed';
import {
  deathData,
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from './test-support';

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let alpha: SeededAccount;
let secret: SeededAccount;
let seasonal: SeededAccount;
/** Seqs visible to `member`, newest first. */
let visibleSeqs: number[];

async function bulkEvents(accountId: number, count: number, type = 'loot'): Promise<number[]> {
  const at = new Date('2026-09-28T10:00:00Z');
  const rows = await t.db
    .insert(events)
    .values(
      Array.from({ length: count }, (_, i) => ({
        pluginEventId: randomUUID(),
        accountId,
        type,
        occurredAt: at,
        receivedAt: at,
        valueGp: i,
        data: { type, data: {}, eventId: 'x', timestamp: 0 },
      })),
    )
    .returning({ seq: events.seq });
  return rows.map((r) => r.seq);
}

beforeAll(async () => {
  t = await createTestDatabase('accounts-feed');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  alpha = await seedAccount(t.db, { name: 'Alpha', owner: owner.id });
  secret = await seedAccount(t.db, { name: 'Secret', owner: owner.id });
  await seedSharing(t.db, secret.id, 'events', 'private');
  seasonal = await seedAccount(t.db, { name: 'Seasonal', owner: owner.id });

  const seqs: number[] = [];
  seqs.push(...(await bulkEvents(alpha.id, 150)));
  await bulkEvents(secret.id, 10);
  seqs.push(...(await bulkEvents(alpha.id, 3, 'death')));
  seqs.push((await seedEvent(t.db, seasonal.id, { type: 'loot', specialWorld: true })).seq);
  seqs.push(...(await bulkEvents(alpha.id, 60)));
  visibleSeqs = seqs.sort((a, b) => b - a);
});

afterAll(async () => {
  await t.drop();
});

describe('listFeed', () => {
  it('returns the newest 50 visible events by default, newest first', async () => {
    const feed = await listFeed(t.db, member.viewer);
    expect(feed).toHaveLength(FEED_DEFAULT_LIMIT);
    expect(feed.map((e) => e.seq)).toEqual(visibleSeqs.slice(0, FEED_DEFAULT_LIMIT));
  });

  it('pages with beforeSeq without gaps or overlaps', async () => {
    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await listFeed(t.db, member.viewer, { limit: 40, beforeSeq: before });
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.seq));
      before = page.at(-1)?.seq;
    }
    expect(seen).toEqual(visibleSeqs);
  });

  it('clamps the limit to 1…200', async () => {
    expect(await listFeed(t.db, member.viewer, { limit: 0 })).toHaveLength(1);
    expect(await listFeed(t.db, member.viewer, { limit: 5000 })).toHaveLength(FEED_MAX_LIMIT);
    expect(await listFeed(t.db, member.viewer, { limit: Number.NaN })).toHaveLength(
      FEED_DEFAULT_LIMIT,
    );
  });

  it('filters by type (an empty list is no filter)', async () => {
    const deaths = await listFeed(t.db, member.viewer, { types: ['death'] });
    expect(deaths.map((e) => e.type)).toEqual(['death', 'death', 'death']);
    expect(await listFeed(t.db, member.viewer, { types: [] })).toHaveLength(FEED_DEFAULT_LIMIT);
  });

  it('filters by account, and gives [] for an account whose events are hidden', async () => {
    const own = await listFeed(t.db, member.viewer, { accountPublicId: seasonal.publicId });
    expect(own).toHaveLength(1);
    expect(await listFeed(t.db, member.viewer, { accountPublicId: secret.publicId })).toEqual([]);
    expect(await listFeed(t.db, member.viewer, { accountPublicId: 'missing' })).toEqual([]);
    expect(await listFeed(t.db, owner.viewer, { accountPublicId: secret.publicId })).toHaveLength(
      10,
    );
  });

  it('includes special-world events, flagged', async () => {
    const [event] = await listFeed(t.db, member.viewer, { accountPublicId: seasonal.publicId });
    expect(event).toMatchObject({
      type: 'loot',
      specialWorld: true,
      account: { publicId: seasonal.publicId, name: 'Seasonal' },
      title: 'Loot',
      icon: 'gift',
    });
    expect(event?.line.startsWith('Seasonal received')).toBe(true);
  });

  it('describes the redacted event', async () => {
    await seedEvent(t.db, alpha.id, { type: 'death', data: deathData() });
    const [death] = await listFeed(t.db, member.viewer, { types: ['death'], limit: 1 });
    expect(death?.title).toBe('Death');
    expect(JSON.stringify(death)).not.toContain('3858');
  });

  it('ignores a beforeSeq that is not an integer', async () => {
    const feed = await listFeed(t.db, member.viewer, { beforeSeq: 1.5, limit: 3 });
    expect(feed).toHaveLength(3);
  });
});
