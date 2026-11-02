/**
 * `item=` and `npc=` on /events (D-136), in the feed and in a time range: any item of a drop (not
 * only the most valuable one), the NPC of loot, deaths and superiors, case and LIKE characters,
 * paging without gaps with a filter on, access, and migration 0019's backfill giving the rows
 * ingest writes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lootItemRows } from '@hub/core';
import { events, lootItems } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { asc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
} from '../accounts/test-support';
import { ApiError } from './errors';
import { apiEvents, apiEventsInRange } from './events';
import { makeKey, type TestKey } from './test-support';

const NOW = new Date('2026-10-20T12:00:00Z');
const RANGE = { from: new Date('2026-10-20T00:00:00Z'), to: NOW };

let t: TestDatabase;
let gary: SeededAccount;
let pete: SeededAccount;
let memberKey: TestKey;
let ownerKey: TestKey;
const ids: Record<string, string> = {};

/** An event as ingest stores it: the row, and its items in loot_items. */
async function stored(
  name: string,
  account: SeededAccount,
  minute: number,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const occurredAt = new Date(RANGE.from.getTime() + minute * 60_000);
  const raw = { type, data, eventId: name, timestamp: occurredAt.getTime() };
  const { id, seq } = await seedEvent(t.db, account.id, {
    type,
    occurredAt,
    receivedAt: occurredAt,
    insertedAt: new Date(occurredAt.getTime() - 60_000),
    data: raw,
  });
  const items = lootItemRows(type, raw);
  if (items.length > 0) {
    await t.db
      .insert(lootItems)
      .values(items.map((i) => ({ eventSeq: seq, accountId: account.id, ...i })));
  }
  ids[name] = id;
}

const item = (name: string, id = 1) => ({ name, id, quantity: 1, gePrice: 10 });

beforeAll(async () => {
  t = await createTestDatabase('api-events-search');
  const owner = await seedUser(t.db, { name: 'Owner' });
  const member = await seedUser(t.db, { name: 'Member' });
  gary = await seedAccount(t.db, { name: 'Guild Gary', owner: owner.id });
  pete = await seedAccount(t.db, { name: 'Private Pete', owner: owner.id });
  await seedSharing(t.db, pete.id, 'events', 'private');
  memberKey = await makeKey(t.db, member.id, {}, NOW);
  ownerKey = await makeKey(t.db, owner.id, {}, NOW);

  await stored('zulrah', gary, 1, 'loot', {
    items: [item("Zulrah's scales", 12934), item('Tanzanite fang', 12922)],
    highestValueItem: item('Tanzanite fang', 12922),
    source: { text: 'Zulrah' },
  });
  await stored('vorkath', gary, 2, 'loot', {
    items: [item('Dragon bones'), item('Superior dragon bones')],
    source: { text: 'Vorkath' },
  });
  await stored('pk', gary, 3, 'pk_loot', {
    items: [item('Rune dart'), item('100%_off coupon')],
    source: { text: 'Some Player' },
  });
  await stored('death', gary, 4, 'death', { killerName: 'Zulrah', lostItems: [item('Shark')] });
  await stored('superior', gary, 5, 'superior_spawn', { name: 'Nechryarch', npcId: 7411 });
  await stored('clog', gary, 6, 'collection_log', { itemName: 'Tanzanite fang', itemId: 12922 });
  await stored('private', pete, 7, 'loot', {
    items: [item('Tanzanite fang', 12922)],
    source: { text: 'Zulrah' },
  });
});

afterAll(async () => {
  await t?.drop();
});

const names = (list: { id: string }[]) =>
  list.map((e) => Object.keys(ids).find((k) => ids[k] === e.id));

describe('item=', () => {
  it('finds a drop by any of its items, case-insensitive, in the feed and in a range', async () => {
    const feed = await apiEvents(t.db, memberKey.principal, { item: 'SCALES' }, NOW);
    expect(names(feed.events)).toEqual(['zulrah']);
    const range = await apiEventsInRange(
      t.db,
      memberKey.principal,
      { ...RANGE, item: 'bones' },
      NOW,
    );
    expect(names(range.events)).toEqual(['vorkath']);
    // The collection log slot and the death's lost items are no loot.
    const fang = await apiEventsInRange(t.db, memberKey.principal, { ...RANGE, item: 'fang' }, NOW);
    expect(names(fang.events)).toEqual(['zulrah']);
  });

  it('takes % and _ literally', async () => {
    const coupon = await apiEvents(t.db, memberKey.principal, { item: '100%_off' }, NOW);
    expect(names(coupon.events)).toEqual(['pk']);
    expect((await apiEvents(t.db, memberKey.principal, { item: '%%' }, NOW)).events).toEqual([]);
  });

  it('only reads accounts whose events the key reads', async () => {
    const asOwner = await apiEventsInRange(
      t.db,
      ownerKey.principal,
      { ...RANGE, item: 'fang' },
      NOW,
    );
    expect(names(asOwner.events)).toEqual(['private', 'zulrah']);
  });
});

describe('npc=', () => {
  it('matches the source of loot, the killer of a death and a superior', async () => {
    const zulrah = await apiEventsInRange(t.db, memberKey.principal, { ...RANGE, npc: 'zul' }, NOW);
    expect(names(zulrah.events)).toEqual(['death', 'zulrah']);
    const nech = await apiEvents(t.db, memberKey.principal, { npc: 'nechry' }, NOW);
    expect(names(nech.events)).toEqual(['superior']);
  });

  it('combines with item and types', async () => {
    const both = await apiEvents(t.db, memberKey.principal, { npc: 'zulrah', item: 'fang' }, NOW);
    expect(names(both.events)).toEqual(['zulrah']);
    const deaths = await apiEvents(
      t.db,
      memberKey.principal,
      { npc: 'zulrah', types: ['death'] },
      NOW,
    );
    expect(names(deaths.events)).toEqual(['death']);
  });
});

describe('paging with a filter on', () => {
  it('walks a range one event at a time without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await apiEventsInRange(
        t.db,
        ownerKey.principal,
        { ...RANGE, npc: 'zulrah', limit: 1, ...(cursor ? { cursor } : {}) },
        NOW,
      );
      seen.push(...(names(page.events) as string[]));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['private', 'death', 'zulrah']);
  });

  it('follows the feed one event at a time, and the cursor passes what the filter leaves out', async () => {
    const start = await apiEvents(t.db, memberKey.principal, { cursor: 'now' }, NOW);
    const first = await apiEvents(t.db, memberKey.principal, { npc: 'zulrah', limit: 1 }, NOW);
    expect(names(first.events)).toEqual(['death']);
    // From the very start of the feed, the matching events in order, one per page.
    let cursor = 'djE6MA'; // seq 0
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await apiEvents(
        t.db,
        memberKey.principal,
        { npc: 'zulrah', limit: 1, cursor },
        NOW,
      );
      seen.push(...(names(page.events) as string[]));
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['zulrah', 'death']);
    expect(cursor).toBe(start.nextCursor);
  });
});

describe('parameters', () => {
  it('refuses a search too short or too long', async () => {
    for (const params of [{ item: 'a' }, { npc: ' b ' }, { item: 'x'.repeat(65) }]) {
      await expect(apiEvents(t.db, memberKey.principal, params, NOW)).rejects.toBeInstanceOf(
        ApiError,
      );
      await expect(
        apiEventsInRange(t.db, memberKey.principal, { ...RANGE, ...params }, NOW),
      ).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('migration 0019', () => {
  it('backfills the same rows ingest writes', async () => {
    const before = await t.db
      .select()
      .from(lootItems)
      .orderBy(asc(lootItems.eventSeq), asc(lootItems.idx));
    expect(before.length).toBe(7);
    await t.db.delete(lootItems);
    const file = readFileSync(
      path.resolve(import.meta.dirname, '../../../db/drizzle/0019_loot_items.sql'),
      'utf8',
    );
    const backfill = file.slice(file.indexOf('INSERT INTO "loot_items"'));
    await t.db.execute(sql.raw(backfill));
    const after = await t.db
      .select()
      .from(lootItems)
      .orderBy(asc(lootItems.eventSeq), asc(lootItems.idx));
    expect(after).toEqual(before);
    // And an event deleted takes its items with it.
    await t.db.delete(events).where(sql`${events.id} = ${ids.vorkath}`);
    expect((await t.db.select().from(lootItems)).filter((r) => r.name.includes('dragon'))).toEqual(
      [],
    );
  });
});
